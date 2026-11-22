import { strict as assert } from "node:assert";
import { validateConstraintSet } from "../src/core/constraint-validation.ts";
import { inspectPlant } from "../src/plant-analysis.ts";
import { recipeOutputPorts, recipeOutputs } from "../src/recipe-queries.ts";
import type { Plant, PlantConstraint } from "../src/plant.ts";
import type { Recipe } from "../src/recipes.ts";

const resource = { type: "item" as const, id: "minecraft:iron_ingot" };
const legacy = { output: resource, outputAmount: 2 } as Recipe;
assert.equal(recipeOutputs(legacy)[0].amount, 2);
const recipe = { ...legacy, outputs: [{ resource, amount: 2, chance: 0.5 }, { resource, amount: 3, chance: 0.25 }] };
assert.equal(recipeOutputPorts(recipe)[0].amount, 1.75);
assert.equal(recipeOutputPorts(recipe)[0].outcomes.length, 2);
assert.throws(() => validateConstraintSet(undefined, 3, 3, true, true), /no allowed/);
assert.throws(() => validateConstraintSet(Infinity, undefined, undefined, false, false), /finite/);
validateConstraintSet(4, 3, 5, true, true);
const target = { kind: "machine-count" as const, componentId: "process" };
const bound = (id: string, value: number): PlantConstraint => ({ id, target, kind: "bound", relation: "equals", value });
const plant: Plant = { id: "p", components: [{ id: "process", kind: "process", recipeId: "r" }], connections: [], constraints: [bound("a", 2), bound("b", 3)] };
const known = { ...recipe, id: "r", inputs: [] } as Recipe;
assert.ok(inspectPlant(plant, () => known).issues.some(({ message }) => message.includes("conflicting constraints")));
plant.constraints = [bound("a", 1.5)];
assert.ok(inspectPlant(plant, () => known).issues.some(({ message }) => message.includes("integer")));
plant.constraints = [bound("a", 4)];
assert.equal(inspectPlant(plant, () => known).valid, true);

const { analyzePlantRates } = await import("../src/plant-analysis.ts");
const port = (componentId: string, direction: "input" | "output") => ({ componentId, direction, resource });
const surplusPlant: Plant = { id: "surplus", components: [
  { id: "supply", kind: "supply", resource }, { id: "process", kind: "process", recipeId: "r" }, { id: "demand", kind: "demand", resource },
], connections: [
  { id: "in", from: port("supply", "output"), to: port("process", "input") },
  { id: "out", from: port("process", "output"), to: port("demand", "input") },
], constraints: [
  { id: "integer", kind: "integer", target: { kind: "port-rate", port: port("process", "input") } },
  { id: "demand", kind: "bound", relation: "equals", value: 1.5, target: { kind: "port-rate", port: port("demand", "input") } },
] };
const withOutputs = { id: "r", inputs: [{ ...resource, amount: 1 }], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] } as Recipe;
const legacyOutput = { ...withOutputs, outputs: [] };
const analyze = (current: Recipe) => analyzePlantRates(surplusPlant, { findRecipe: () => current, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
const explicitResult = analyze(withOutputs);
const legacyResult = analyze(legacyOutput);
assert.deepEqual(legacyResult, explicitResult);
const outputRate = legacyResult.portRates.find(({ port }) => port.componentId === "process" && port.direction === "output")?.rate;
assert.ok(outputRate && outputRate.state !== "conflict" && outputRate.surplus === 0.5);

const choiceInput = { type: "item" as const, id: "#choice", alternatives: [resource.id] };
const overlappingRecipe = { id: "overlap", inputs: [{ ...resource, amount: 5 }, { ...choiceInput, amount: 7 }], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] } as Recipe;
const overlapPlant: Plant = { id: "overlap", components: [
  { id: "s1", kind: "supply", resource }, { id: "s2", kind: "supply", resource: choiceInput }, { id: "p", kind: "process", recipeId: "overlap" }, { id: "d", kind: "demand", resource },
], connections: [
  { id: "in1", from: port("s1", "output"), to: port("p", "input") },
  { id: "in2", from: { componentId: "s2", direction: "output", resource: choiceInput }, to: { componentId: "p", direction: "input", resource: choiceInput } },
  { id: "out", from: port("p", "output"), to: port("d", "input") },
], constraints: [
  { id: "r1", kind: "bound", relation: "equals", value: 5, target: { kind: "port-rate", port: port("p", "input") } },
  { id: "r2", kind: "bound", relation: "equals", value: 7, target: { kind: "port-rate", port: { componentId: "p", direction: "input", resource: choiceInput } } },
] };
const overlapResult = analyzePlantRates(overlapPlant, { findRecipe: () => overlappingRecipe, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
assert.notEqual(overlapResult.status, "conflicting", overlapResult.issues.join(", "));
assert.notEqual(overlapResult.status, "invalid", overlapResult.issues.join(", "));

const stressPlant: Plant = { id: "stress", components: [{ id: "stress-process", kind: "process", recipeId: "stress-recipe" }, { id: "stress-sink", kind: "demand", resource }], connections: [{ id: "stress-flow", from: port("stress-process", "output"), to: port("stress-sink", "input") }], constraints: [
  { id: "rpm", kind: "bound", relation: "equals", value: 1, target: { kind: "rpm", componentId: "stress-process" } },
  { id: "stress", kind: "bound", relation: "at-most", value: 1.9, target: { kind: "stress", componentId: "stress-process" } },
] };
const stressRecipe = { id: "stress-recipe", inputs: [], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] } as Recipe;
const stressResult = analyzePlantRates(stressPlant, { findRecipe: () => stressRecipe, requiredOperatingConditions: () => ["rpm"], stressImpactPerMachine: () => 0.5, calculateTiming: () => ({ batchesPerMinute: 1, runsPerCycle: 1 } as never) });
const stressRate = stressResult.portRates.find(({ port }) => port.componentId === "stress-process" && port.direction === "output")?.rate;
assert.ok(stressRate?.state === "underconstrained");
assert.equal(stressRate.maximum, 3);

const fractionalOutputRecipe = { ...withOutputs, outputAmount: 0.1, outputs: [{ resource, amount: 0.1 }] };
const roundedPlant: Plant = { ...surplusPlant, constraints: [
  { id: "integer", kind: "integer", target: { kind: "port-rate", port: port("process", "input") } },
  { id: "output", kind: "bound", relation: "equals", value: 0.3, target: { kind: "port-rate", port: port("demand", "input") } },
] };
const roundedResult = analyzePlantRates(roundedPlant, { findRecipe: () => fractionalOutputRecipe, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
assert.equal(roundedResult.status, "balanced", roundedResult.issues.join(", "));
const roundedInput = roundedResult.portRates.find(({ port }) => port.componentId === "process" && port.direction === "input")?.rate;
assert.ok(roundedInput && (roundedInput.state === "derived" || roundedInput.state === "constrained"));
assert.equal(roundedInput.perMinute, 3);
assert.throws(() => validateConstraintSet(3.0000000001, undefined, undefined, true, false), /integer/);

const boundedPlant: Plant = { ...roundedPlant, constraints: roundedPlant.constraints.map((constraint) => constraint.id === "output" && constraint.kind === "bound" ? { ...constraint, relation: "at-most", value: 0.3 } : constraint) };
const analyzeBounded = (plant: Plant) => analyzePlantRates(plant, { findRecipe: () => fractionalOutputRecipe, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
const boundResult = analyzeBounded(boundedPlant);
const boundInput = boundResult.portRates.find(({ port }) => port.componentId === "process" && port.direction === "input")?.rate;
assert.ok(boundInput?.state === "underconstrained");
assert.equal(boundInput.maximum, 3);
const explicitLimit: Plant = { ...boundedPlant, constraints: [...boundedPlant.constraints, { id: "explicit-max", kind: "bound", relation: "at-most", value: 2.999999999, target: { kind: "port-rate", port: port("process", "input") } }] };
const explicitInput = analyzeBounded(explicitLimit).portRates.find(({ port }) => port.componentId === "process" && port.direction === "input")?.rate;
assert.ok(explicitInput?.state === "underconstrained");
assert.equal(explicitInput.maximum, 2);

const exactStressPlant: Plant = { ...stressPlant, constraints: stressPlant.constraints.map((constraint) => constraint.id === "stress" && constraint.kind === "bound" ? { ...constraint, relation: "equals", value: 0.3 } : constraint) };
const exactStressResult = analyzePlantRates(exactStressPlant, { findRecipe: () => stressRecipe, requiredOperatingConditions: () => ["rpm"], stressImpactPerMachine: () => 0.1, calculateTiming: () => ({ batchesPerMinute: 1, runsPerCycle: 1 } as never) });
assert.notEqual(exactStressResult.status, "conflicting", exactStressResult.issues.join(", "));
const fractionalStressPlant: Plant = { ...exactStressPlant, constraints: exactStressPlant.constraints.map((constraint) => constraint.id === "stress" && constraint.kind === "bound" ? { ...constraint, value: 0.31 } : constraint) };
const fractionalStressResult = analyzePlantRates(fractionalStressPlant, { findRecipe: () => stressRecipe, requiredOperatingConditions: () => ["rpm"], stressImpactPerMachine: () => 0.1, calculateTiming: () => ({ batchesPerMinute: 1, runsPerCycle: 1 } as never) });
assert.ok(fractionalStressResult.issues.some((issue) => issue.includes("fractional machine count")));

const tinyGraph: Plant = { id: "tiny", components: [{ id: "s", kind: "supply", resource }, { id: "d", kind: "demand", resource }], connections: [{ id: "tiny-flow", from: port("s", "output"), to: port("d", "input") }], constraints: [{ id: "tiny-rate", kind: "bound", relation: "equals", value: 1e-9, target: { kind: "connection-rate", connectionId: "tiny-flow" } }] };
const tinyResult = analyzePlantRates(tinyGraph, { findRecipe: () => undefined, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
assert.equal(tinyResult.status, "balanced");
assert.deepEqual(tinyResult.connectionRates[0].rate, { state: "constrained", perMinute: 1e-9 });
assert.ok(tinyResult.portRates.every(({ rate }) => (rate.state === "derived" || rate.state === "constrained") && rate.perMinute === 1e-9));
const nearFraction: Plant = { ...roundedPlant, constraints: roundedPlant.constraints.map((constraint) => constraint.id === "output" && constraint.kind === "bound" ? { ...constraint, value: 0.3000000001 } : constraint) };
const nearFractionResult = analyzePlantRates(nearFraction, { findRecipe: () => fractionalOutputRecipe, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
assert.notEqual(nearFractionResult.status, "balanced");
const tinyOutputRecipe = { ...withOutputs, outputAmount: 1e-10, outputs: [{ resource, amount: 1e-10 }] };
const tinyOutputPlant: Plant = { ...roundedPlant, constraints: [{ id: "output", kind: "bound", relation: "equals", value: 1e-9, target: { kind: "port-rate", port: port("demand", "input") } }] };
const tinyOutputResult = analyzePlantRates(tinyOutputPlant, { findRecipe: () => tinyOutputRecipe, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
const tinyInput = tinyOutputResult.portRates.find(({ port }) => port.componentId === "process" && port.direction === "input")?.rate;
assert.ok(tinyInput && (tinyInput.state === "derived" || tinyInput.state === "constrained"));
assert.equal(tinyInput.perMinute, 10);

const negativeFlow: Plant = { id: "negative", components: [
  { id: "a", kind: "supply", resource }, { id: "b", kind: "supply", resource }, { id: "pool", kind: "pool", resource }, { id: "d", kind: "demand", resource },
], connections: [
  { id: "a-flow", from: port("a", "output"), to: port("pool", "input") }, { id: "b-flow", from: port("b", "output"), to: port("pool", "input") }, { id: "pool-flow", from: port("pool", "output"), to: port("d", "input") },
], constraints: [
  { id: "a-rate", kind: "bound", relation: "equals", value: 3e-9, target: { kind: "connection-rate", connectionId: "a-flow" } },
  { id: "pool-rate", kind: "bound", relation: "equals", value: 2e-9, target: { kind: "connection-rate", connectionId: "pool-flow" } },
] };
const negativeResult = analyzePlantRates(negativeFlow, { findRecipe: () => undefined, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
assert.equal(negativeResult.status, "conflicting");

const hugeFlow: Plant = { id: "huge", components: [{ id: "s", kind: "supply", resource }, { id: "d1", kind: "demand", resource }, { id: "d2", kind: "demand", resource }], connections: [
  { id: "a", from: port("s", "output"), to: port("d1", "input") }, { id: "b", from: port("s", "output"), to: port("d2", "input") },
], constraints: [
  { id: "supply", kind: "bound", relation: "equals", value: 1e308, target: { kind: "port-rate", port: port("s", "output") } },
  ...(["a", "b"] as const).map((id) => ({ id: `rate-${id}`, kind: "bound" as const, relation: "equals" as const, value: 1e308, target: { kind: "connection-rate" as const, connectionId: id } })),
] };
const hugeResult = analyzePlantRates(hugeFlow, { findRecipe: () => undefined, requiredOperatingConditions: () => [], stressImpactPerMachine: () => 0, calculateTiming: () => { throw new Error("not needed"); } });
assert.equal(hugeResult.status, "conflicting");
