import { strict as assert } from "node:assert";
import { deletePlantFlow, deletePlantSelection } from "../src/core/plant-editing.ts";
import type { Plant } from "../src/plant.ts";

const resource = { type: "item" as const, id: "minecraft:iron_ingot" };
const port = (componentId: string, direction: "input" | "output") => ({ componentId, direction, resource });
const plant: Plant = { id: "test", components: [
  { id: "process", kind: "process", recipeId: "recipe" },
  { id: "pool", kind: "pool", resource },
  { id: "sink", kind: "demand", resource },
], connections: [
  { id: "in", from: port("process", "output"), to: port("pool", "input") },
  { id: "out", from: port("pool", "output"), to: port("sink", "input") },
], constraints: [] };
let counter = 0;
const createId = (prefix: string) => `${prefix}-${counter++}`;
const bypassed = deletePlantSelection(plant, ["pool"], createId);
assert.equal(bypassed.mergedPools, 1);
assert.equal(bypassed.plant.connections.length, 1);
assert.equal(bypassed.plant.connections[0].to.componentId, "sink");
const blocked = deletePlantSelection(bypassed.plant, ["sink"], createId);
assert.equal(blocked.blocked, true);
assert.equal(blocked.deleted, 0);
assert.throws(() => deletePlantFlow(bypassed.plant, bypassed.plant.connections[0].id), /only destination/);
const removed = deletePlantSelection(plant, ["process"], createId);
assert.ok(removed.removedComponentIds.includes("process"));
assert.ok(!removed.plant.components.some(({ id }) => id === "process"));
const chained: Plant = { id: "chain", components: [
  { id: "upstream", kind: "process", recipeId: "up" },
  { id: "downstream", kind: "process", recipeId: "down" },
], connections: [{ id: "link", from: port("upstream", "output"), to: port("downstream", "input") }], constraints: [] };
const chainResult = deletePlantSelection(chained, ["downstream"], createId);
assert.equal(chainResult.plant.connections[0].from.componentId, "upstream");
assert.ok(chainResult.plant.components.some((component) => component.kind === "demand" && component.id === chainResult.plant.connections[0].to.componentId));
