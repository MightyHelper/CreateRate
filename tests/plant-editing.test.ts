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

const choice = { type: "item" as const, id: "#forge:ingots" };
const alternative: Plant = { ...chained, connections: [{ ...chained.connections[0], to: { componentId: "downstream", direction: "input", resource: choice } }], constraints: [
  { id: "limit", kind: "bound", relation: "equals", value: 5, target: { kind: "port-rate", port: { componentId: "downstream", direction: "input", resource: choice } } },
] };
const alternativeResult = deletePlantSelection(alternative, ["downstream"], createId);
const redirected = alternativeResult.plant.connections[0];
assert.deepEqual(redirected.to.resource, resource);
assert.ok(alternativeResult.plant.constraints.some((constraint) => constraint.id === "limit" && constraint.target.kind === "port-rate" && constraint.target.port.componentId === redirected.to.componentId && constraint.target.port.resource.id === resource.id));
const gold = { type: "item" as const, id: "minecraft:gold_ingot" };
const multiple: Plant = { ...alternative, components: [...alternative.components, { id: "other", kind: "process", recipeId: "other" }], connections: [...alternative.connections, { id: "gold", from: { componentId: "other", direction: "output", resource: gold }, to: { componentId: "downstream", direction: "input", resource: choice } }] };
assert.throws(() => deletePlantSelection(multiple, ["downstream"], createId), /multiple alternative resources/);

const { addPlantRecipe } = await import("../src/core/plant-editing.ts");
const repeatedOutput = { id: "repeated", inputs: [], output: resource, outputAmount: 1, outputs: [{ resource, amount: 2, chance: 0.5 }, { resource, amount: 3, chance: 0.25 }] };
const repeatedResult = addPlantRecipe({ id: "empty", components: [], connections: [], constraints: [] }, repeatedOutput as never, createId);
assert.equal(repeatedResult.createdComponents.filter((component) => component.kind === "demand").length, 1);
assert.equal(repeatedResult.plant.connections.length, 1);

const { expandPlantBoundary } = await import("../src/core/plant-editing.ts");
for (const kind of ["supply", "demand"] as const) {
  const junction = { id: "junction", kind, resource };
  const ends = ["one", "two"].map((id) => ({ id, kind: "process" as const, recipeId: id }));
  const connections = ends.map(({ id }) => ({ id: `edge-${id}`, from: port(kind === "supply" ? "junction" : id, "output"), to: port(kind === "supply" ? id : "junction", "input"), secondary: id === "two" }));
  const constraints: Plant["constraints"] = connections.map(({ id }) => ({ id: `constraint-${id}`, kind: "bound", relation: "at-most", value: 10, target: { kind: "connection-rate", connectionId: id } }));
  constraints.push({ id: "port-constraint", kind: "bound", relation: "at-most", value: 20, target: { kind: "port-rate", port: port("junction", kind === "supply" ? "output" : "input") } });
  const graph: Plant = { id: kind, components: [junction, ...ends], connections, constraints };
  const expanded = expandPlantBoundary(graph, "junction", { id: "recipe", inputs: [{ ...resource, amount: 1 }], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] } as never, { createId, resourcesMatch: (a, b) => a.type === b.type && a.id === b.id });
  for (const edge of connections) {
    const kept = expanded.plant.connections.find(({ id }) => id === edge.id);
    assert.ok(kept);
    assert.equal(kept.secondary, edge.secondary);
    assert.ok(expanded.plant.constraints.some((constraint) => constraint.id === `constraint-${edge.id}`));
  }
  assert.ok(expanded.plant.constraints.some((constraint) => constraint.id === "port-constraint" && constraint.target.kind === "port-rate" && constraint.target.port.componentId === expanded.processId));
}

const { duplicatePlantSelection } = await import("../src/core/plant-editing.ts");
const variantGraph: Plant = { id: "variant", components: [
  { id: "producer", kind: "process", recipeId: "producer" },
  { id: "consumer", kind: "process", recipeId: "consumer" },
], connections: [{ id: "secondary", from: port("producer", "output"), to: port("consumer", "input"), secondary: true }], constraints: [] };
const recipes = new Map([
  ["producer", { id: "producer", inputs: [], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] }],
  ["consumer", { id: "consumer", inputs: [{ ...choice, amount: 1, alternatives: [resource.id] }], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] }],
]);
const copied = duplicatePlantSelection(variantGraph, ["producer", "consumer"], { createId, findRecipe: (id) => recipes.get(id) as never });
const copyConsumer = copied.componentIdMap.get("consumer")!;
const copyProducer = copied.componentIdMap.get("producer")!;
const copiedEdge = copied.plant.connections.find((edge) => edge.from.componentId === copyProducer && edge.to.componentId === copyConsumer);
assert.equal(copiedEdge?.secondary, true);
assert.equal(copied.plant.connections.filter((edge) => edge.to.componentId === copyConsumer).length, 1);

const { togglePlantConnection } = await import("../src/plant.ts");
const { splitPlantConnection } = await import("../src/core/plant-editing.ts");
assert.throws(() => togglePlantConnection(chained, { ...chained.connections[0], id: "toggle" }), /only destination/);
const secondFlow: Plant = { ...chained, components: [...chained.components, { id: "other-sink", kind: "demand", resource }], connections: [...chained.connections, { id: "second", from: port("upstream", "output"), to: port("other-sink", "input") }] };
assert.equal(togglePlantConnection(secondFlow, { ...chained.connections[0], id: "toggle" }).connected, false);
const split = splitPlantConnection(alternative, "link", createId);
const splitSupply = split.plant.components.find(({ id }) => id === split.supplyId);
assert.ok(splitSupply?.kind === "supply");
assert.deepEqual(splitSupply.resource, resource);
const splitDownstream = split.plant.connections.find(({ id }) => id === split.secondConnectionId)!;
assert.deepEqual(splitDownstream.from.resource, resource);
assert.deepEqual(splitDownstream.to.resource, choice);
