import { strict as assert } from "node:assert";
import { ingredientAccepts } from "../src/recipe-queries.ts";
import { cancelDrag, gestureContextPath, movedPositions } from "../src/ui/gestures.ts";

const input = { type: "item" as const, id: "#forge:ingots", alternatives: ["minecraft:iron_ingot"] };
assert.equal(ingredientAccepts(input, { type: "item", id: "minecraft:iron_ingot" }), true);
assert.equal(ingredientAccepts(input, { type: "item", id: "#forge:ingots" }), true);
assert.equal(ingredientAccepts(input, { type: "fluid", id: "minecraft:iron_ingot" }), false);
assert.equal(ingredientAccepts(input, { type: "item", id: "minecraft:gold_ingot" }), false);
assert.deepEqual(movedPositions({ a: { x: 2, y: 3 } }, ["a"], { x: 0, y: 0 }, { x: 10, y: 4 }, 2), { a: { x: 7, y: 5 } });
const state = { plant: "edited", positions: { a: { x: 9, y: 9 } }, portOrder: {}, selected: "a", selectedIds: ["a"] };
assert.deepEqual(cancelDrag({ kind: "move", origins: { a: { x: 2, y: 3 } } }, state).positions, { a: { x: 2, y: 3 } });
assert.equal(cancelDrag({ kind: "duplicate", initialPlant: "original", initialSelected: "old", initialSelectedIds: ["old"] }, state).plant, "original");
const element = { closest: (selector: string) => selector === "g[data-component]" ? { classList: { contains: () => false } } : null };
assert.deepEqual(gestureContextPath(element as unknown as Element), ["boundary", "component", "canvas"]);

// Exercise the shared acceptance rule through plant inspection and editing.
const { inspectPlant } = await import("../src/plant-analysis.ts");
const { ensurePlantOutputDestinations } = await import("../src/core/plant-editing.ts");
const output = { type: "item" as const, id: "minecraft:iron_ingot" };
const recipe = { id: "r", inputs: [{ ...input, amount: 1 }], outputs: [{ resource: output, amount: 1 }], output, outputAmount: 1 };
const plant = { id: "p", components: [{ id: "p1", kind: "process" as const, recipeId: "r" }], connections: [{ id: "loop", from: { componentId: "p1", direction: "output" as const, resource: output }, to: { componentId: "p1", direction: "input" as const, resource: output } }], constraints: [] };
assert.equal(inspectPlant(plant, () => recipe as never).valid, true);
assert.deepEqual(ensurePlantOutputDestinations(plant, { createId: () => "new", findRecipe: () => recipe as never }).removedConnectionIds, []);
const badRecipe = { ...recipe, inputs: [{ ...input, alternatives: ["minecraft:gold_ingot"], amount: 1 }] };
assert.ok(inspectPlant(plant, () => badRecipe as never).issues.some(({ code }) => code === "invalid-port"));
assert.deepEqual(ensurePlantOutputDestinations(plant, { createId: () => "new", findRecipe: () => badRecipe as never }).removedConnectionIds, ["loop"]);

const { addPlantRecipeAtPort } = await import("../src/core/plant-editing.ts");
const { resourcesMatch } = await import("../src/recipe-queries.ts");
const sourceChoice = { type: "item" as const, id: "#source", alternatives: ["iron"] };
const inputChoice = { type: "item" as const, id: "#input", alternatives: ["iron"], amount: 1 };
const choicePlant = { id: "choice", components: [{ id: "s", kind: "supply" as const, resource: sourceChoice }], connections: [], constraints: [] };
const choiceRecipe = { id: "choice-recipe", inputs: [inputChoice], output, outputAmount: 1, outputs: [{ resource: output, amount: 1 }] };
let nextId = 0;
const choiceResult = addPlantRecipeAtPort(choicePlant, choiceRecipe as never, { componentId: "s", direction: "output", resource: sourceChoice }, { createId: (prefix) => `${prefix}-${nextId++}`, resourcesMatch: (a, b) => resourcesMatch(a, b, {}, {}) });
assert.equal(inspectPlant(choiceResult.plant, () => choiceRecipe as never).valid, true);
assert.equal(ingredientAccepts(inputChoice, { type: "item", id: "#other", alternatives: ["gold"] }), false);
