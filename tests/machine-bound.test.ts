#!/usr/bin/env -S node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addPlantRecipe, analyzePlantRates, capacityForRecipe, createPlant, feasibleTimingsForRecipe, getRecipe, parsePlantTransferYaml, plantTransferYaml, timingForRecipe } from "../src/core.ts";
import { plantProcessMetrics } from "../src/core/plant-analysis.ts";

const plant = parsePlantTransferYaml(readFileSync(new URL("../tests/resources/machine-bound.yaml", import.meta.url), "utf8")).plant;
const process = plant.components.find((component) => component.kind === "process" && component.recipeId === "create:mixing/andesite_alloy");
assert.ok(process && process.kind === "process");
plant.constraints = plant.constraints.filter((constraint) => !(constraint.target.kind === "machine-count" && constraint.target.componentId === process.id));
plant.constraints.push({ id: "rate-cap", kind: "bound", relation: "at-most", value: 10,
  target: { kind: "port-rate", port: { componentId: "sink-7a4f615b-b895-4ea5-b006-27e942944425", direction: "input", resource: { type: "item", id: "create:andesite_alloy" } } } });
const recipe = getRecipe(process.recipeId);
assert.ok(recipe);
const analysis = analyzePlantRates(plant);
const metrics = plantProcessMetrics(plant, process.id, recipe, analysis);
assert.equal(metrics.machineCountIsMaximum, true);
assert.equal(metrics.machineCount, 1);

let nextId = 0;
const added = addPlantRecipe(createPlant("default-rpm"), recipe, (prefix) => `${prefix}-${nextId++}`);
assert.ok(added.plant.constraints.some((constraint) => constraint.target.kind === "rpm" && constraint.target.componentId === added.processId && constraint.kind === "bound" && constraint.relation === "equals" && constraint.value === 256));

const { calculateTiming } = await import("../src/timing.ts");
const duplicateOutcomeRecipe = { ...recipe, outputs: [
  { resource: recipe.output, amount: 1 }, { resource: recipe.output, amount: 1 },
  { resource: { type: "item" as const, id: "example:byproduct" }, amount: 20 },
], outputAmount: 1 };
const perMachine = calculateTiming(duplicateOutcomeRecipe, 256).batchesPerMinute * calculateTiming(duplicateOutcomeRecipe, 256).runsPerCycle * 2;
assert.equal(calculateTiming(duplicateOutcomeRecipe, 256).outputPerMinute, perMachine);
const outputAnalysis = { status: "balanced" as const, issues: [], connectionRates: [], portRates: [{ port: { componentId: process.id, direction: "output" as const, resource: recipe.output }, rate: { state: "derived" as const, perMinute: perMachine * 2 } }] };
const unconstrained = { ...plant, constraints: [{ id: "rpm", kind: "bound" as const, relation: "equals" as const, value: 256, target: { kind: "rpm" as const, componentId: process.id } }] };
assert.equal(plantProcessMetrics(unconstrained, process.id, duplicateOutcomeRecipe, outputAnalysis).machineCount, 2);

const crushingId = "create:crushing/amethyst_block";
const crushing = getRecipe(crushingId);
assert.ok(crushing);
const crushingTiming = timingForRecipe(crushingId, 64, 1);
assert.equal(crushingTiming.outputPerMinute, 525);
const capacity = capacityForRecipe(crushingId, 64, { "item:minecraft:amethyst_block": 150 }, 525, 1);
assert.equal(capacity.inputLimitedOutputPerMinute, 525);
assert.equal(capacity.machinesForTarget, 1);
assert.equal(capacity.targetInputRates["item:minecraft:amethyst_block"], 150);
const feasible = feasibleTimingsForRecipe(crushingId, { rpm: 64, stackSize: 1, targetOutputPerMinute: 500 });
assert.equal(feasible.status, "determined");
assert.equal(feasible.operatingPoints[0].capacityPerMachine, 525);

const paint = getRecipe("railways:mixing/palettes/dye/chartreuse_from_yellow_green");
assert.ok(paint);
assert.equal(paint.inputs.length, 2);
assert.deepEqual(paint.inputs.map(({ nbt, amount }) => [nbt, amount]), [[{ Color: "yellow" }, 125], [{ Color: "green" }, 125]]);
assert.deepEqual(paint.output.nbt, { Color: "chartreuse" });
const { ingredientAccepts, collectRecipeItems } = await import("../src/recipe-queries.ts");
assert.equal(ingredientAccepts(paint.inputs[0], { type: "fluid", id: "railways:paint", nbt: { Color: "yellow", extra: 1 } }), true);
assert.equal(ingredientAccepts(paint.inputs[0], paint.inputs[1]), false);
assert.equal(ingredientAccepts({ type: "fluid", id: "railways:paint" }, paint.inputs[0]), true);
assert.equal(collectRecipeItems([paint], {}, {}).filter(({ id }) => id === "railways:paint").length, 3);
const paintPlant = addPlantRecipe(createPlant("paint"), paint, (prefix) => `${prefix}-${nextId++}`).plant;
const paintAnalysis = analyzePlantRates(paintPlant);
assert.notEqual(paintAnalysis.status, "invalid", paintAnalysis.issues.join(", "));
assert.equal(paintAnalysis.portRates.filter(({ port }) => port.direction === "input" && port.resource.id === "railways:paint" && "nbt" in port.resource).length >= 2, true);
const roundTrip = parsePlantTransferYaml(plantTransferYaml(paintPlant, "graph", { positions: {}, portOrder: {} })).plant;
assert.deepEqual(roundTrip.components.filter((component) => component.kind === "supply").map((component) => component.kind === "supply" && component.resource.nbt), [{ Color: "yellow" }, { Color: "green" }]);
assert.deepEqual(roundTrip.components.find((component) => component.kind === "demand")?.resource.nbt, { Color: "chartreuse" });

const mixer = { ...recipe, machine: "mechanical_mixer" };
const operatingPlant = { id: "operating", components: [{ id: "mixer", kind: "process" as const, recipeId: mixer.id }], connections: [], constraints: [{ id: "rpm", kind: "bound" as const, relation: "equals" as const, value: 1, target: { kind: "rpm" as const, componentId: "mixer" } }] };
const { analyzePlantRates: analyzeWithRecipes } = await import("../src/core/plant-analysis.ts");
const invalidOperating = analyzeWithRecipes(operatingPlant, new Map([[mixer.id, mixer]]));
assert.equal(invalidOperating.status, "conflicting");
assert.ok(invalidOperating.issues.some((issue) => issue.includes("at least 32 RPM")));
const validOperating = { ...operatingPlant, constraints: [{ ...operatingPlant.constraints[0], value: 32 }] };
assert.notEqual(analyzeWithRecipes(validOperating, new Map([[mixer.id, mixer]])).status, "conflicting");
const unsupported = { ...mixer, machine: "unsupported" };
assert.notEqual(analyzeWithRecipes(operatingPlant, new Map([[unsupported.id, unsupported]])).status, "conflicting");

const wheels = { ...recipe, machine: "crushing_wheels" };
const wheelPlant = { ...operatingPlant, components: [{ id: "mixer", kind: "process" as const, recipeId: wheels.id }], constraints: [{ ...operatingPlant.constraints[0], value: 0 }] };
assert.equal(analyzeWithRecipes(wheelPlant, new Map([[wheels.id, wheels]])).status, "conflicting");
const invalidStack = { ...wheelPlant, constraints: [{ id: "stack", kind: "bound" as const, relation: "equals" as const, value: 0, target: { kind: "stack-size" as const, componentId: "mixer" } }] };
assert.equal(analyzeWithRecipes(invalidStack, new Map([[wheels.id, wheels]])).status, "conflicting");
const unknownWheel = { ...wheelPlant, constraints: [] };
assert.notEqual(analyzeWithRecipes(unknownWheel, new Map([[wheels.id, wheels]])).status, "conflicting");

const boundedRpm = (value: number) => ({ ...operatingPlant, constraints: [{ ...operatingPlant.constraints[0], relation: "at-most" as const, value }] });
assert.equal(analyzeWithRecipes(boundedRpm(1), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.equal(analyzeWithRecipes(boundedRpm(31), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(boundedRpm(32), new Map([[mixer.id, mixer]])).status, "conflicting");
const boundedStack = { ...wheelPlant, constraints: [{ id: "stack-max", kind: "bound" as const, relation: "at-most" as const, value: 0, target: { kind: "stack-size" as const, componentId: "mixer" } }] };
assert.equal(analyzeWithRecipes(boundedStack, new Map([[wheels.id, wheels]])).status, "conflicting");

const jointLimits = (count: number, stress: number) => ({ ...operatingPlant, constraints: [
  { id: "rpm-min", kind: "bound" as const, relation: "at-least" as const, value: 32, target: { kind: "rpm" as const, componentId: "mixer" } },
  { id: "count", kind: "bound" as const, relation: "equals" as const, value: count, target: { kind: "machine-count" as const, componentId: "mixer" } },
  { id: "stress-max", kind: "bound" as const, relation: "at-most" as const, value: stress, target: { kind: "stress" as const, componentId: "mixer" } },
] });
assert.equal(analyzeWithRecipes(jointLimits(2, 1), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(jointLimits(2, 256), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(jointLimits(0, 0), new Map([[mixer.id, mixer]])).status, "conflicting");

const withoutRpm = (count: number, stress: number) => ({ ...jointLimits(count, stress), constraints: jointLimits(count, stress).constraints.filter(({ id }) => id !== "rpm-min") });
assert.equal(analyzeWithRecipes(withoutRpm(2, 1), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(withoutRpm(2, 256), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(withoutRpm(0, 0), new Map([[mixer.id, mixer]])).status, "conflicting");
const withPowerMinimum = (stress: number) => ({ ...jointLimits(3, stress), constraints: [
  ...jointLimits(3, stress).constraints.map((constraint) => constraint.id === "count" ? { ...constraint, relation: "at-least" as const } : constraint),
  { id: "power", kind: "power-of-two" as const, target: { kind: "machine-count" as const, componentId: "mixer" } },
] });
assert.equal(analyzeWithRecipes(withPowerMinimum(384), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(withPowerMinimum(512), new Map([[mixer.id, mixer]])).status, "conflicting");

const upperOperating = (minimumStress: number, bounded = true) => ({ ...operatingPlant, constraints: [
  ...(bounded ? [{ id: "rpm-max", kind: "bound" as const, relation: "at-most" as const, value: 32, target: { kind: "rpm" as const, componentId: "mixer" } }] : []),
  { id: "machine-max", kind: "bound" as const, relation: "at-most" as const, value: 2, target: { kind: "machine-count" as const, componentId: "mixer" } },
  { id: "stress-min", kind: "bound" as const, relation: "at-least" as const, value: minimumStress, target: { kind: "stress" as const, componentId: "mixer" } },
] });
assert.equal(analyzeWithRecipes(upperOperating(257), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(upperOperating(256), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(upperOperating(257, false), new Map([[mixer.id, mixer]])).status, "conflicting");

const discreteRpm = (stress: number, power: boolean) => ({ ...operatingPlant, constraints: [
  { id: "rpm-min", kind: "bound" as const, relation: "at-least" as const, value: 33, target: { kind: "rpm" as const, componentId: "mixer" } },
  { id: "count", kind: "bound" as const, relation: "equals" as const, value: 1, target: { kind: "machine-count" as const, componentId: "mixer" } },
  { id: "stress-max", kind: "bound" as const, relation: "at-most" as const, value: stress, target: { kind: "stress" as const, componentId: "mixer" } },
  ...(power ? [{ id: "rpm-power", kind: "power-of-two" as const, target: { kind: "rpm" as const, componentId: "mixer" } }] : []),
] });
assert.equal(analyzeWithRecipes(discreteRpm(132, true), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(discreteRpm(256, true), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(discreteRpm(132, false), new Map([[mixer.id, mixer]])).status, "conflicting");

const discreteProduct = (stress: number) => ({ ...operatingPlant, constraints: [
  { id: "rpm-min", kind: "bound" as const, relation: "at-least" as const, value: 32, target: { kind: "rpm" as const, componentId: "mixer" } },
  { id: "rpm-max", kind: "bound" as const, relation: "at-most" as const, value: 64, target: { kind: "rpm" as const, componentId: "mixer" } },
  { id: "rpm-power", kind: "power-of-two" as const, target: { kind: "rpm" as const, componentId: "mixer" } },
  { id: "count-max", kind: "bound" as const, relation: "at-most" as const, value: 2, target: { kind: "machine-count" as const, componentId: "mixer" } },
  { id: "count-power", kind: "power-of-two" as const, target: { kind: "machine-count" as const, componentId: "mixer" } },
  { id: "stress", kind: "bound" as const, relation: "equals" as const, value: stress, target: { kind: "stress" as const, componentId: "mixer" } },
] });
assert.equal(analyzeWithRecipes(discreteProduct(192), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(discreteProduct(256), new Map([[mixer.id, mixer]])).status, "conflicting");
const integerProduct = (stress: number) => ({ ...discreteProduct(stress), constraints: discreteProduct(stress).constraints.map((constraint) => constraint.id === "rpm-power" ? { ...constraint, kind: "integer" as const } : constraint) });
assert.equal(analyzeWithRecipes(integerProduct(130), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(integerProduct(128), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.equal(analyzeWithRecipes(integerProduct(404), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(integerProduct(400), new Map([[mixer.id, mixer]])).status, "conflicting");
const stressInterval = (maximum: number) => ({ ...discreteProduct(192), constraints: [
  ...discreteProduct(192).constraints.filter(({ id }) => id !== "stress"),
  { id: "stress-min", kind: "bound" as const, relation: "at-least" as const, value: 193, target: { kind: "stress" as const, componentId: "mixer" } },
  { id: "stress-max", kind: "bound" as const, relation: "at-most" as const, value: maximum, target: { kind: "stress" as const, componentId: "mixer" } },
] });
assert.equal(analyzeWithRecipes(stressInterval(255), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(stressInterval(256), new Map([[mixer.id, mixer]])).status, "conflicting");
const integerInterval = (maximum: number) => ({ ...integerProduct(128), constraints: [
  ...integerProduct(128).constraints.filter(({ id }) => id !== "stress" && id !== "count-max"),
  { id: "count-one", kind: "bound" as const, relation: "at-most" as const, value: 1, target: { kind: "machine-count" as const, componentId: "mixer" } },
  { id: "stress-min", kind: "bound" as const, relation: "at-least" as const, value: 128.1, target: { kind: "stress" as const, componentId: "mixer" } },
  { id: "stress-max", kind: "bound" as const, relation: "at-most" as const, value: maximum, target: { kind: "stress" as const, componentId: "mixer" } },
] });
assert.equal(analyzeWithRecipes(integerInterval(131.9), new Map([[mixer.id, mixer]])).status, "conflicting");
assert.notEqual(analyzeWithRecipes(integerInterval(132), new Map([[mixer.id, mixer]])).status, "conflicting");
