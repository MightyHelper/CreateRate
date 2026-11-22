#!/usr/bin/env -S node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addPlantRecipe, analyzePlantRates, createPlant, getRecipe, parsePlantTransferYaml } from "../src/core.ts";
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
], outputAmount: 1 };
const perMachine = calculateTiming(duplicateOutcomeRecipe, 256).batchesPerMinute * calculateTiming(duplicateOutcomeRecipe, 256).runsPerCycle * 2;
const outputAnalysis = { status: "balanced" as const, issues: [], connectionRates: [], portRates: [{ port: { componentId: process.id, direction: "output" as const, resource: recipe.output }, rate: { state: "derived" as const, perMinute: perMachine * 2 } }] };
const unconstrained = { ...plant, constraints: [{ id: "rpm", kind: "bound" as const, relation: "equals" as const, value: 256, target: { kind: "rpm" as const, componentId: process.id } }] };
assert.equal(plantProcessMetrics(unconstrained, process.id, duplicateOutcomeRecipe, outputAnalysis).machineCount, 2);

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
