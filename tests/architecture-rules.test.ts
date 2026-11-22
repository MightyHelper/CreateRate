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
