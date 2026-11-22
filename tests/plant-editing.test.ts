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
  const expanded = expandPlantBoundary(graph, "junction", { id: "recipe", inputs: [{ ...resource, amount: 1 }], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] } as never, { createId, resourcesMatch: (a, b) => a.type === b.type && a.id === b.id, findRecipe: () => ({ inputs: [{ ...resource, amount: 1 }] } as never) });
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

const separateInputs: Plant = { id: "separate", components: [
  { id: "up1", kind: "process", recipeId: "up" }, { id: "up2", kind: "process", recipeId: "up" }, { id: "consumer", kind: "process", recipeId: "consumer" },
], connections: [
  { id: "first", from: port("up1", "output"), to: port("consumer", "input") },
  { id: "second", from: port("up2", "output"), to: { componentId: "consumer", direction: "input", resource: choice } },
], constraints: [
  { id: "first-rate", kind: "bound", relation: "equals", value: 5, target: { kind: "port-rate", port: port("consumer", "input") } },
  { id: "second-rate", kind: "bound", relation: "equals", value: 7, target: { kind: "port-rate", port: { componentId: "consumer", direction: "input", resource: choice } } },
] };
const separateResult = deletePlantSelection(separateInputs, ["consumer"], createId);
const firstConstraint = separateResult.plant.constraints.find(({ id }) => id === "first-rate")!;
const secondConstraint = separateResult.plant.constraints.find(({ id }) => id === "second-rate")!;
assert.ok(firstConstraint.target.kind === "port-rate" && secondConstraint.target.kind === "port-rate");
assert.notEqual(firstConstraint.target.port.componentId, secondConstraint.target.port.componentId);

const overlappingRecipe = { id: "consumer", inputs: [{ ...resource, amount: 1 }, { ...choice, amount: 1, alternatives: [resource.id] }], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] };
const overlappingRecipes = new Map(recipes);
overlappingRecipes.set("consumer", overlappingRecipe);
const overlappingCopy = duplicatePlantSelection(variantGraph, ["producer", "consumer"], { createId, findRecipe: (id) => overlappingRecipes.get(id) as never });
const overlappingConsumer = overlappingCopy.componentIdMap.get("consumer")!;
const copiedInputs = overlappingCopy.plant.connections.filter((edge) => edge.to.componentId === overlappingConsumer);
assert.equal(copiedInputs.length, 2);
assert.deepEqual(new Set(copiedInputs.map((edge) => edge.to.resource.id)), new Set([resource.id, choice.id]));

const { addPlantRecipeAtPort, addPlantRecipeAtBoundary } = await import("../src/core/plant-editing.ts");
const { resourcesMatch } = await import("../src/recipe-queries.ts");
const inputA = { type: "item" as const, id: "#a", alternatives: [resource.id], amount: 1 };
const inputB = { type: "item" as const, id: "#b", alternatives: [resource.id, gold.id], amount: 1 };
const recipeWithOverlap = { id: "overlap", inputs: [inputA, inputB], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] };
const goldSource: Plant = { id: "source", components: [{ id: "gold-source", kind: "supply", resource: gold }], connections: [], constraints: [] };
const matchDependencies = { createId, resourcesMatch: (a: typeof resource, b: typeof resource) => resourcesMatch(a, b, {}, {}), findRecipe: (id: string) => ({ inputs: [{ ...(id === "downstream" ? ironOnly : tagged), amount: 1 }] } as never) };
const insertedAtPort = addPlantRecipeAtPort(goldSource, recipeWithOverlap as never, { componentId: "gold-source", direction: "output", resource: gold }, matchDependencies);
const insertedAtSource = addPlantRecipeAtBoundary(goldSource, "gold-source", recipeWithOverlap as never, matchDependencies);
for (const result of [insertedAtPort, insertedAtSource]) {
  const inputs = result.plant.connections.filter((edge) => edge.to.componentId === result.processId);
  assert.equal(inputs.filter((edge) => edge.to.resource.id === inputA.id).length, 1);
  assert.equal(inputs.filter((edge) => edge.to.resource.id === inputB.id).length, 1);
  assert.equal(inputs.find((edge) => edge.to.resource.id === inputB.id)?.from.componentId, "gold-source");
}
const goldDemand: Plant = { id: "demand", components: [{ id: "up", kind: "process", recipeId: "up" }, { id: "gold-demand", kind: "demand", resource: gold }], connections: [{ id: "gold-flow", from: { componentId: "up", direction: "output", resource: gold }, to: { componentId: "gold-demand", direction: "input", resource: gold } }], constraints: [] };
const expandedOverlap = expandPlantBoundary(goldDemand, "gold-demand", recipeWithOverlap as never, matchDependencies);
const expandedInputs = expandedOverlap.plant.connections.filter((edge) => edge.to.componentId === expandedOverlap.processId);
assert.equal(expandedInputs.filter((edge) => edge.to.resource.id === inputA.id).length, 1);
assert.equal(expandedInputs.filter((edge) => edge.to.resource.id === inputB.id).length, 1);
assert.equal(expandedInputs.find((edge) => edge.to.resource.id === inputB.id)?.id, "gold-flow");
const choiceSource: Plant = { id: "choice-source", components: [{ id: "choice-source", kind: "supply", resource: inputB }], connections: [], constraints: [] };
const insertedChoice = addPlantRecipeAtBoundary(choiceSource, "choice-source", recipeWithOverlap as never, matchDependencies);
assert.equal(insertedChoice.plant.connections.find((edge) => edge.from.componentId === "choice-source")?.to.resource.id, inputB.id);

const { addPlantBoundaryAtPort, canAttachPlantResource } = await import("../src/core/plant-editing.ts");
const tagged = { type: "item" as const, id: "#metal", alternatives: [resource.id] };
const taggedSource: Plant = { id: "tagged", components: [{ id: "tagged-source", kind: "supply", resource: tagged }], connections: [], constraints: [] };
const taggedOutput = { componentId: "tagged-source", direction: "output" as const, resource: tagged };
assert.equal(canAttachPlantResource(taggedSource, resource, taggedOutput, matchDependencies.findRecipe), false);
assert.throws(() => addPlantBoundaryAtPort(taggedSource, "demand", resource, taggedOutput, matchDependencies), /Choose an item/);
const processGraph: Plant = { id: "process", components: [{ id: "process", kind: "process", recipeId: "r" }], connections: [], constraints: [] };
const processChoice = { componentId: "process", direction: "input" as const, resource: tagged };
assert.equal(canAttachPlantResource(processGraph, resource, processChoice, matchDependencies.findRecipe), true);
assert.equal(addPlantBoundaryAtPort(processGraph, "supply", resource, processChoice, matchDependencies).plant.connections.length, 1);

const selfLoop: Plant = { id: "loop", components: [{ id: "loop-process", kind: "process", recipeId: "r" }], connections: [{ id: "loop-edge", from: port("loop-process", "output"), to: port("loop-process", "input") }], constraints: [{ id: "loop-rate", kind: "bound", relation: "equals", value: 5, target: { kind: "connection-rate", connectionId: "loop-edge" } }] };
const removedLoop = deletePlantSelection(selfLoop, ["loop-process"], createId).plant;
assert.deepEqual(removedLoop.components, []);
assert.deepEqual(removedLoop.connections, []);
assert.deepEqual(removedLoop.constraints, []);
const loopAndExternal: Plant = { ...selfLoop, components: [...selfLoop.components, { id: "upstream-loop", kind: "process", recipeId: "up" }, { id: "downstream-loop", kind: "process", recipeId: "down" }], connections: [
  ...selfLoop.connections,
  { id: "external-in", from: port("upstream-loop", "output"), to: port("loop-process", "input") },
  { id: "external-out", from: port("loop-process", "output"), to: port("downstream-loop", "input") },
] };
const removedMixed = deletePlantSelection(loopAndExternal, ["loop-process"], createId).plant;
assert.deepEqual(new Set(removedMixed.connections.map(({ id }) => id)), new Set(["external-in", "external-out"]));
assert.equal(removedMixed.constraints.length, 0);
assert.equal(removedMixed.components.filter((component) => component.kind === "demand").length, 1);
assert.equal(removedMixed.components.filter((component) => component.kind === "supply").length, 1);

const { recipesForPlantBoundary } = await import("../src/core/plant-editing.ts");
const taggedDemand = { id: "tag-demand", kind: "demand" as const, resource: tagged };
const taggedDemandPlant: Plant = { id: "tagged-demand", components: [taggedDemand], connections: [], constraints: [] };
const ironRecipe = { id: "iron", inputs: [], output: resource, outputAmount: 1, outputs: [{ resource, amount: 1 }] };
assert.equal(recipesForPlantBoundary([ironRecipe as never], taggedDemand, matchDependencies.resourcesMatch, "produce").length, 0);
assert.throws(() => addPlantRecipeAtBoundary(taggedDemandPlant, taggedDemand.id, ironRecipe as never, matchDependencies), /does not match/);
assert.throws(() => addPlantRecipeAtPort(taggedDemandPlant, ironRecipe as never, { componentId: taggedDemand.id, direction: "input", resource: tagged }, matchDependencies), /does not match/);
const matchingTagRecipe = { ...ironRecipe, output: tagged, outputs: [{ resource: tagged, amount: 1 }] };
assert.equal(recipesForPlantBoundary([matchingTagRecipe as never], taggedDemand, matchDependencies.resourcesMatch, "produce").length, 1);
assert.equal(addPlantRecipeAtBoundary(taggedDemandPlant, taggedDemand.id, matchingTagRecipe as never, matchDependencies).plant.connections.length, 1);
const processInputGraph: Plant = { id: "target-process", components: [{ id: "target", kind: "process", recipeId: "r" }], connections: [], constraints: [] };
assert.equal(addPlantRecipeAtPort(processInputGraph, ironRecipe as never, { componentId: "target", direction: "input", resource: tagged }, matchDependencies).plant.connections.length, 1);
const broadSource = { id: "broad-source", kind: "supply" as const, resource: { type: "item" as const, id: "#broad", alternatives: [resource.id, gold.id] } };
const ironOnly = { type: "item" as const, id: "#iron-only", alternatives: [resource.id] };
const restrictedGraph: Plant = { id: "restricted", components: [broadSource, { id: "downstream", kind: "process", recipeId: "downstream" }], connections: [{ id: "restricted-flow", from: { componentId: broadSource.id, direction: "output", resource: broadSource.resource }, to: { componentId: "downstream", direction: "input", resource: ironOnly } }], constraints: [] };
const goldRecipe = { ...ironRecipe, id: "gold", output: gold, outputs: [{ resource: gold, amount: 1 }] };
const canProduceForExistingFlows = (candidate: typeof resource) => matchDependencies.resourcesMatch(candidate, broadSource.resource) && restrictedGraph.connections.every((edge) => canAttachPlantResource(restrictedGraph, candidate, edge.to, matchDependencies.findRecipe));
assert.equal(recipesForPlantBoundary([ironRecipe as never, goldRecipe as never], broadSource, matchDependencies.resourcesMatch, "produce", canProduceForExistingFlows).length, 1);
assert.throws(() => expandPlantBoundary(restrictedGraph, broadSource.id, goldRecipe as never, matchDependencies), /does not match/);
assert.ok(expandPlantBoundary(restrictedGraph, broadSource.id, ironRecipe as never, matchDependencies).plant.connections.some(({ id }) => id === "restricted-flow"));

const { mergePlantResourceComponents } = await import("../src/core/plant-editing.ts");
for (const kind of ["supply", "demand"] as const) {
  const direction = kind === "supply" ? "output" as const : "input" as const;
  const source = { id: "merge-a", kind, resource }, target = { id: "merge-b", kind, resource };
  const targetPort = { componentId: target.id, direction, resource };
  const constrained: Plant = { id: "merge", components: [source, target], connections: [], constraints: [{ id: "rate", kind: "bound", relation: "equals", value: 5, target: { kind: "port-rate", port: targetPort } }] };
  assert.throws(() => mergePlantResourceComponents(constrained, source.id, target.id, createId), /port-rate constraints/);
  assert.throws(() => mergePlantResourceComponents(constrained, target.id, source.id, createId), /port-rate constraints/);
  assert.equal(constrained.components.length, 2);
}
const mergePlant: Plant = { id: "merge-flow", components: [{ id: "a", kind: "supply", resource }, { id: "b", kind: "supply", resource }, { id: "d", kind: "demand", resource }], connections: [{ id: "flow", from: port("a", "output"), to: port("d", "input") }], constraints: [{ id: "flow-limit", kind: "bound", relation: "at-most", value: 5, target: { kind: "connection-rate", connectionId: "flow" } }] };
const merged = mergePlantResourceComponents(mergePlant, "a", "b", createId);
assert.equal(merged.connections[0].from.componentId, "b");
assert.deepEqual(merged.constraints, mergePlant.constraints);
assert.equal(mergePlantResourceComponents(mergePlant, "a", "a", createId), mergePlant);

const standalone = { id: "standalone", kind: "supply" as const, resource };
const standaloneConstraint: Plant["constraints"][number] = { id: "standalone-rate", kind: "bound", relation: "equals", value: 8, target: { kind: "port-rate", port: port("standalone", "output") } };
const withStandalone: Plant = { ...plant, components: [...plant.components, standalone], constraints: [standaloneConstraint] };
const noOp = deletePlantSelection(withStandalone, [], createId);
assert.deepEqual(noOp.plant, withStandalone);
const blockedDelete = deletePlantSelection({ ...bypassed.plant, components: [...bypassed.plant.components, standalone], constraints: [standaloneConstraint] }, ["sink"], createId);
assert.equal(blockedDelete.deleted, 0);
assert.ok(blockedDelete.plant.components.some(({ id }) => id === "standalone"));
assert.ok(blockedDelete.plant.constraints.some(({ id }) => id === "standalone-rate"));
const { deletePlantFlow: deleteFlow } = await import("../src/core/plant-editing.ts");
const flowGraph: Plant = { id: "flow", components: [{ id: "source", kind: "supply", resource }, { id: "sink-flow", kind: "demand", resource }, standalone], connections: [{ id: "flow-to-delete", from: port("source", "output"), to: port("sink-flow", "input") }], constraints: [standaloneConstraint] };
const flowDeleted = deleteFlow(flowGraph, "flow-to-delete");
assert.deepEqual(flowDeleted.plant.components.map(({ id }) => id), ["standalone"]);
assert.deepEqual(flowDeleted.plant.constraints, [standaloneConstraint]);

const mixedSources: Plant = { id: "mixed-sources", components: [
  { id: "upstream", kind: "process", recipeId: "up" }, { id: "supply", kind: "supply", resource }, { id: "consumer", kind: "process", recipeId: "down" },
], connections: [
  { id: "process-in", from: port("upstream", "output"), to: port("consumer", "input") },
  { id: "supply-in", from: port("supply", "output"), to: port("consumer", "input") },
], constraints: [{ id: "aggregate", kind: "bound", relation: "equals", value: 10, target: { kind: "port-rate", port: port("consumer", "input") } }] };
assert.throws(() => deletePlantSelection(mixedSources, ["consumer"], createId), /only some of its flows/);
assert.equal(mixedSources.connections.length, 2);
const mixedDestinations: Plant = { id: "mixed-destinations", components: [
  { id: "producer", kind: "process", recipeId: "up" }, { id: "downstream", kind: "process", recipeId: "down" }, { id: "demand", kind: "demand", resource },
], connections: [
  { id: "process-out", from: port("producer", "output"), to: port("downstream", "input") },
  { id: "demand-out", from: port("producer", "output"), to: port("demand", "input") },
], constraints: [{ id: "aggregate", kind: "bound", relation: "equals", value: 10, target: { kind: "port-rate", port: port("producer", "output") } }] };
assert.throws(() => deletePlantSelection(mixedDestinations, ["producer"], createId), /only some of its flows/);

const constrainedFlow: Plant = { ...chained, constraints: [
  { id: "flow-exact", kind: "bound", relation: "equals", value: 5, target: { kind: "connection-rate", connectionId: "link" } },
  { id: "flow-integer", kind: "integer", target: { kind: "connection-rate", connectionId: "link" } },
] };
const constrainedSplit = splitPlantConnection(constrainedFlow, "link", createId);
for (const connectionId of [constrainedSplit.firstConnectionId, constrainedSplit.secondConnectionId]) {
  const constraints = constrainedSplit.plant.constraints.filter((constraint) => constraint.target.kind === "connection-rate" && constraint.target.connectionId === connectionId);
  assert.ok(constraints.some((constraint) => constraint.kind === "bound" && constraint.relation === "equals" && constraint.value === 5));
  assert.ok(constraints.some((constraint) => constraint.kind === "integer"));
}
assert.equal(new Set(constrainedSplit.plant.constraints.map(({ id }) => id)).size, constrainedSplit.plant.constraints.length);
