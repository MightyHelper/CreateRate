import type { Recipe } from "../recipes.ts";
import {
  addPlantComponent,
  addPlantConstraint,
  connectPlantPorts,
  disconnectPlantPorts,
  removePlantComponent,
  resourceKey,
} from "../plant.ts";
import type { Plant, PlantComponent, PlantConnection, PlantConstraint, PortRef, Resource } from "../plant.ts";

export type PlantEditDependencies = {
  createId: (prefix: string) => string;
  findRecipe: (id: string) => Recipe | undefined;
};

export function addPlantRecipe(plant: Plant, recipe: Recipe, createId: (prefix: string) => string) {
  const processId = createId("process");
  let next = addPlantComponent(plant, { id: processId, kind: "process", recipeId: recipe.id });
  const createdComponents: PlantComponent[] = [];
  for (const input of recipe.inputs) {
    const source: PlantComponent = { id: createId("source"), kind: "supply", resource: input };
    next = addPlantComponent(next, source);
    next = connect(next, source.id, input, processId, createId);
    createdComponents.push(source);
  }
  for (const output of recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }]) {
    const sink: PlantComponent = { id: createId("sink"), kind: "demand", resource: output.resource };
    next = addPlantComponent(next, sink);
    next = connect(next, processId, output.resource, sink.id, createId);
    createdComponents.push(sink);
  }
  return { plant: next, processId, createdComponents };
}

export function addPlantRecipeAtPort(plant: Plant, recipe: Recipe, port: PortRef, dependencies: {
  createId: (prefix: string) => string;
  resourcesMatch: (a: Resource, b: Resource) => boolean;
}) {
  const { createId, resourcesMatch } = dependencies;
  const outputs = recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }];
  const input = port.direction === "output" ? recipe.inputs.find((candidate) => resourcesMatch(candidate, port.resource)) : undefined;
  const output = port.direction === "input" ? outputs.find((candidate) => resourcesMatch(candidate.resource, port.resource)) : undefined;
  if (port.direction === "output" && !input || port.direction === "input" && !output) {
    throw new Error(`Recipe ${recipe.id} does not match ${port.resource.id}`);
  }

  const added = addPlantRecipe(plant, recipe, createId);
  let next = added.plant;
  const generatedBoundary = added.createdComponents.find((component) => port.direction === "output"
    ? component.kind === "supply" && input && resourcesMatch(component.resource, input)
    : component.kind === "demand" && output && resourcesMatch(component.resource, output.resource));
  const createdComponents = [...added.createdComponents];
  if (generatedBoundary) {
    next = removePlantComponent(next, generatedBoundary.id);
    createdComponents.splice(createdComponents.indexOf(generatedBoundary), 1);
  }

  next = connectPlantPorts(next, {
    id: createId("flow"),
    from: port.direction === "output"
      ? port
      : { componentId: added.processId, direction: "output", resource: output!.resource },
    to: port.direction === "input"
      ? port
      : { componentId: added.processId, direction: "input", resource: input! },
  });
  return { plant: next, processId: added.processId, createdComponents };
}

export function addPlantBoundaryAtPort(plant: Plant, kind: "supply" | "demand" | "pool", resource: Resource, port: PortRef, dependencies: {
  createId: (prefix: string) => string;
  resourcesMatch: (a: Resource, b: Resource) => boolean;
}) {
  const { createId, resourcesMatch } = dependencies;
  const allowed = port.direction === "output" ? kind === "demand" || kind === "pool" : kind === "supply" || kind === "pool";
  if (!allowed) throw new Error(`A ${kind} cannot connect to this ${port.direction} port`);
  if (!resourcesMatch(resource, port.resource)) throw new Error(`Choose an item matching ${port.resource.id}`);
  const componentId = createId(kind === "pool" ? "pool" : kind === "supply" ? "source" : "sink");
  let next = addPlantComponent(plant, { id: componentId, kind, resource });
  next = connectPlantPorts(next, {
    id: createId("flow"),
    from: port.direction === "output"
      ? port
      : { componentId, direction: "output", resource },
    to: port.direction === "input"
      ? port
      : { componentId, direction: "input", resource },
  });
  return { plant: next, componentId };
}

export function expandPlantBoundary(plant: Plant, componentId: string, recipe: Recipe, dependencies: {
  createId: (prefix: string) => string;
  resourcesMatch: (a: Resource, b: Resource) => boolean;
}) {
  const boundary = plant.components.find(({ id }) => id === componentId);
  if (!boundary || (boundary.kind !== "supply" && boundary.kind !== "demand")) throw new Error(`Unknown resource boundary: ${componentId}`);
  const { createId, resourcesMatch } = dependencies;
  const outputs = recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }];
  const attached = boundary.kind === "supply"
    ? plant.connections.find((edge) => edge.from.componentId === componentId)
    : plant.connections.find((edge) => edge.to.componentId === componentId);
  const replacement = boundary.kind === "supply"
    ? outputs.find(({ resource }) => resourcesMatch(resource, boundary.resource))
    : recipe.inputs.find((input) => resourcesMatch(input, boundary.resource));
  if (!replacement) throw new Error(`Recipe ${recipe.id} does not match ${boundary.resource.id}`);

  const removedComponentIds = [componentId];
  let next = removePlantComponent(plant, componentId);
  const added = addPlantRecipe(next, recipe, createId);
  next = added.plant;
  const createdComponents = [...added.createdComponents];
  const matchingResource = "resource" in replacement ? replacement.resource : replacement;
  if (attached && boundary.kind === "supply") {
    const generatedSink = createdComponents.find((component) => component.kind === "demand" && resourcesMatch(component.resource, boundary.resource));
    if (generatedSink) {
      next = removePlantComponent(next, generatedSink.id);
      createdComponents.splice(createdComponents.indexOf(generatedSink), 1);
      removedComponentIds.push(generatedSink.id);
    }
    next = connectPlantPorts(next, {
      id: createId("flow"),
      from: { componentId: added.processId, direction: "output", resource: matchingResource },
      to: attached.to,
    });
  } else if (attached) {
    const inputIndex = recipe.inputs.findIndex((input) => resourcesMatch(input, boundary.resource));
    const generatedSource = createdComponents.find((component) => component.kind === "supply" && resourcesMatch(component.resource, boundary.resource));
    if (generatedSource) {
      next = removePlantComponent(next, generatedSource.id);
      createdComponents.splice(createdComponents.indexOf(generatedSource), 1);
      removedComponentIds.push(generatedSource.id);
    }
    const input = recipe.inputs[inputIndex];
    next = connectPlantPorts(next, {
      id: createId("flow"),
      from: attached.from,
      to: { componentId: added.processId, direction: "input", resource: input },
    });
  }
  return { plant: next, processId: added.processId, createdComponents, removedComponentIds };
}

export function addPlantRecipeAtBoundary(plant: Plant, componentId: string, recipe: Recipe, dependencies: {
  createId: (prefix: string) => string;
  resourcesMatch: (a: Resource, b: Resource) => boolean;
}) {
  const boundary = plant.components.find(({ id }) => id === componentId);
  if (!boundary || (boundary.kind !== "supply" && boundary.kind !== "demand")) throw new Error(`Unknown resource boundary: ${componentId}`);
  const { createId, resourcesMatch } = dependencies;
  const outputs = recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }];
  const matchingInput = boundary.kind === "supply" ? recipe.inputs.find((input) => resourcesMatch(input, boundary.resource)) : undefined;
  const matchingOutput = boundary.kind === "demand" ? outputs.find(({ resource }) => resourcesMatch(resource, boundary.resource)) : undefined;
  if (boundary.kind === "supply" && !matchingInput || boundary.kind === "demand" && !matchingOutput) {
    throw new Error(`Recipe ${recipe.id} does not match ${boundary.resource.id}`);
  }

  const added = addPlantRecipe(plant, recipe, createId);
  let next = added.plant;
  const matchingBoundary = added.createdComponents.find((component) => boundary.kind === "supply"
    ? component.kind === "supply" && resourcesMatch(component.resource, boundary.resource)
    : component.kind === "demand" && resourcesMatch(component.resource, boundary.resource));
  const createdComponents = [...added.createdComponents];
  if (matchingBoundary) {
    next = removePlantComponent(next, matchingBoundary.id);
    createdComponents.splice(createdComponents.indexOf(matchingBoundary), 1);
  }

  if (boundary.kind === "supply" && matchingInput) {
    next = connectPlantPorts(next, {
      id: createId("flow"),
      from: { componentId, direction: "output", resource: boundary.resource },
      to: { componentId: added.processId, direction: "input", resource: matchingInput },
    });
  } else if (boundary.kind === "demand" && matchingOutput) {
    next = connectPlantPorts(next, {
      id: createId("flow"),
      from: { componentId: added.processId, direction: "output", resource: matchingOutput.resource },
      to: { componentId, direction: "input", resource: boundary.resource },
    });
  }
  return { plant: next, processId: added.processId, createdComponents };
}

export function recipesForPlantBoundary(
  recipes: Recipe[],
  boundary: Extract<PlantComponent, { kind: "supply" | "demand" }>,
  resourcesMatch: (a: Resource, b: Resource) => boolean,
  action: "produce" | "use" = boundary.kind === "supply" ? "produce" : "use",
): Recipe[] {
  return recipes.filter((recipe) => action === "produce"
    ? (recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }]).some(({ resource }) => resourcesMatch(resource, boundary.resource))
    : recipe.inputs.some((input) => resourcesMatch(input, boundary.resource)));
}

export function duplicatePlantSelection(plant: Plant, componentIds: string[], dependencies: PlantEditDependencies) {
  const { createId, findRecipe } = dependencies;
  const selected = new Set(componentIds);
  const componentIdMap = new Map(componentIds.map((id) => [id, createId("copy")]));
  const internalConnections = plant.connections.filter((edge) => selected.has(edge.from.componentId) && selected.has(edge.to.componentId));
  const connectionIdMap = new Map(internalConnections.map(({ id }) => [id, createId("flow-copy")]));
  const copies = plant.components.filter(({ id }) => selected.has(id)).map((component) => ({
    ...component,
    id: componentIdMap.get(component.id)!,
    ...(component.kind === "process" ? {} : { resource: { ...component.resource } }),
  }) as PlantComponent);

  let next = plant;
  for (const component of copies) next = addPlantComponent(next, component);
  for (const edge of internalConnections) {
    next = connectPlantPorts(next, {
      id: connectionIdMap.get(edge.id)!,
      from: { ...edge.from, componentId: componentIdMap.get(edge.from.componentId)! },
      to: { ...edge.to, componentId: componentIdMap.get(edge.to.componentId)! },
    });
  }
  for (const constraint of plant.constraints) {
    const target = remapTarget(constraint, componentIdMap, connectionIdMap);
    if (target) next = addPlantConstraint(next, { ...constraint, id: createId("constraint-copy"), target });
  }

  const createdComponentIds = copies.map(({ id }) => id);
  for (const [originalId, copyId] of componentIdMap) {
    const original = plant.components.find(({ id }) => id === originalId);
    const copy = copies.find(({ id }) => id === copyId);
    if (original?.kind !== "process" || copy?.kind !== "process") continue;
    const recipe = findRecipe(copy.recipeId);
    for (const input of recipe?.inputs ?? []) {
      if (next.connections.some((edge) => edge.to.componentId === copyId && resourceKey(edge.to.resource) === resourceKey(input))) continue;
      const sourceId = createId("copy-source");
      next = addPlantComponent(next, { id: sourceId, kind: "supply", resource: input });
      next = connect(next, sourceId, input, copyId, createId);
      createdComponentIds.push(sourceId);
    }
    const outputs = recipe?.outputs?.length ? recipe.outputs : recipe ? [{ resource: recipe.output, amount: recipe.outputAmount }] : [];
    for (const output of outputs) {
      if (next.connections.some((edge) => edge.from.componentId === copyId && resourceKey(edge.from.resource) === resourceKey(output.resource))) continue;
      const sinkId = createId("copy-sink");
      next = addPlantComponent(next, { id: sinkId, kind: "demand", resource: output.resource });
      next = connect(next, copyId, output.resource, sinkId, createId);
      createdComponentIds.push(sinkId);
    }
  }
  return { plant: next, componentIdMap, createdComponentIds };
}

export function deletePlantProcess(plant: Plant, processId: string, createId: (prefix: string) => string) {
  const process = plant.components.find(({ id }) => id === processId);
  if (process?.kind !== "process") throw new Error(`Unknown process: ${processId}`);
  const inputConstraints = plant.constraints.filter((constraint) =>
    constraint.target.kind === "port-rate" && constraint.target.port.componentId === processId && constraint.target.port.direction === "input");
  const outputConstraints = plant.constraints.filter((constraint) =>
    constraint.target.kind === "port-rate" && constraint.target.port.componentId === processId && constraint.target.port.direction === "output");
  const incoming = plant.connections.filter((edge) => edge.to.componentId === processId &&
    plant.components.some((component) => component.id === edge.from.componentId && (component.kind === "process" || component.kind === "pool")));
  const outgoing = plant.connections.filter((edge) => edge.from.componentId === processId &&
    plant.components.some((component) => component.id === edge.to.componentId && (component.kind === "process" || component.kind === "pool")));
  const materials = new Map<string, Resource>();
  for (const edge of incoming) materials.set(resourceKey(edge.to.resource), edge.to.resource);

  let next = plant;
  const createdInputs: PlantComponent[] = [];
  const demandByResource = new Map<string, string>();
  for (const resource of materials.values()) {
    const id = createId("deleted-input");
    const demand: PlantComponent = { id, kind: "demand", resource };
    next = addPlantComponent(next, demand);
    createdInputs.push(demand);
    demandByResource.set(resourceKey(resource), id);
  }
  for (const edge of incoming) {
    const demandId = demandByResource.get(resourceKey(edge.to.resource));
    if (demandId) next = redirectPlantConnectionTarget(next, edge.id, { componentId: demandId, direction: "input", resource: edge.to.resource });
  }

  const createdOutputs: PlantComponent[] = [];
  const sourceByResource = new Map<string, string>();
  for (const edge of outgoing) {
    const key = resourceKey(edge.from.resource);
    if (sourceByResource.has(key)) continue;
    const id = createId("deleted-output-source");
    sourceByResource.set(key, id);
    const source: PlantComponent = { id, kind: "supply", resource: edge.from.resource };
    next = addPlantComponent(next, source);
    createdOutputs.push(source);
  }
  const sourceByConnection = new Map(outgoing.map((edge) => [edge.id, sourceByResource.get(resourceKey(edge.from.resource))!]));
  next = {
    ...next,
    connections: next.connections.map((edge) => {
      const sourceId = sourceByConnection.get(edge.id);
      return sourceId ? { ...edge, from: { ...edge.from, componentId: sourceId } } : edge;
    }),
  };

  const attached = next.connections.filter((edge) => edge.from.componentId === processId || edge.to.componentId === processId)
    .map((edge) => edge.from.componentId === processId ? edge.to.componentId : edge.from.componentId)
    .filter((id) => next.components.some((component) => component.id === id && component.kind !== "process"));
  next = removePlantComponent(next, processId);
  const removedComponentIds = [processId];
  for (const id of attached) {
    if (next.connections.some((edge) => edge.from.componentId === id || edge.to.componentId === id)) continue;
    next = removePlantComponent(next, id);
    removedComponentIds.push(id);
  }
  for (const constraint of inputConstraints) {
    if (constraint.target.kind !== "port-rate") continue;
    const demandId = demandByResource.get(resourceKey(constraint.target.port.resource));
    if (!demandId) continue;
    next = addPlantConstraint(next, { ...constraint, target: { kind: "port-rate", port: { ...constraint.target.port, componentId: demandId, direction: "input" } } });
  }
  for (const constraint of outputConstraints) {
    if (constraint.target.kind !== "port-rate") continue;
    const sourceId = sourceByResource.get(resourceKey(constraint.target.port.resource));
    if (!sourceId) continue;
    next = addPlantConstraint(next, { ...constraint, target: { kind: "port-rate", port: { ...constraint.target.port, componentId: sourceId, direction: "output" } } });
  }
  const pruned = removeDisconnectedPlantBoundaries(next);
  return {
    plant: pruned.plant,
    createdInputs,
    createdOutputs,
    removedComponentIds: [...new Set([...removedComponentIds, ...pruned.removedComponentIds])],
    incomingProcessConnections: incoming.length,
    outputSourceCount: createdOutputs.length,
    inputMaterialCount: materials.size,
  };
}

export function mergePlantResourceComponents(plant: Plant, sourceId: string, targetId: string, createId: (prefix: string) => string): Plant {
  const source = plant.components.find(({ id }) => id === sourceId);
  const target = plant.components.find(({ id }) => id === targetId);
  if (!source || !target || source.kind === "process" || target.kind === "process" || source.kind === "pool" || target.kind === "pool") throw new Error("Only source and sink squares can be merged");
  if (resourceKey(source.resource) !== resourceKey(target.resource)) throw new Error("Resource squares must contain the same item");

  if (source.kind !== target.kind) {
    const supply = source.kind === "supply" ? source : target;
    const demand = source.kind === "demand" ? source : target;
    if (plant.connections.some((edge) => edge.from.componentId === supply.id && edge.to.componentId === demand.id)) return plant;
    return connect(plant, supply.id, supply.resource, demand.id, createId);
  }

  let next: Plant = {
    ...plant,
    connections: plant.connections.map((edge) => ({
      ...edge,
      from: edge.from.componentId === sourceId ? { ...edge.from, componentId: targetId } : edge.from,
      to: edge.to.componentId === sourceId ? { ...edge.to, componentId: targetId } : edge.to,
    })),
  };
  const movedConstraints = next.constraints.filter((constraint) => constraint.target.kind === "port-rate" && constraint.target.port.componentId === sourceId);
  next = removePlantComponent(next, sourceId);
  for (const constraint of movedConstraints) {
    if (constraint.target.kind !== "port-rate") continue;
    next = addPlantConstraint(next, { ...constraint, target: { kind: "port-rate", port: { ...constraint.target.port, componentId: targetId } } });
  }
  return next;
}

export function splitPlantConnection(plant: Plant, connectionId: string, createId: (prefix: string) => string) {
  const edge = plant.connections.find(({ id }) => id === connectionId);
  if (!edge) throw new Error(`Unknown plant connection: ${connectionId}`);
  const rateConstraints = plant.constraints.filter((constraint) => constraint.target.kind === "connection-rate" && constraint.target.connectionId === connectionId);
  const demandId = createId("split-sink"), supplyId = createId("split-source");
  let next = disconnectPlantPorts(plant, connectionId);
  next = addPlantComponent(next, { id: demandId, kind: "demand", resource: edge.from.resource });
  next = addPlantComponent(next, { id: supplyId, kind: "supply", resource: edge.to.resource });
  const firstConnectionId = createId("flow"), secondConnectionId = createId("flow");
  next = connectPlantPorts(next, { id: firstConnectionId, from: edge.from, to: { componentId: demandId, direction: "input", resource: edge.from.resource }, ...(edge.secondary ? { secondary: true } : {}) });
  next = connectPlantPorts(next, { id: secondConnectionId, from: { componentId: supplyId, direction: "output", resource: edge.to.resource }, to: edge.to, ...(edge.secondary ? { secondary: true } : {}) });
  for (const constraint of rateConstraints) next = addPlantConstraint(next, { ...constraint, target: { kind: "connection-rate", connectionId: firstConnectionId } });
  return { plant: next, demandId, supplyId, firstConnectionId, secondConnectionId };
}

export function insertPoolInPlantConnection(plant: Plant, connectionId: string, createId: (prefix: string) => string) {
  const edge = plant.connections.find(({ id }) => id === connectionId);
  if (!edge) throw new Error(`Unknown plant connection: ${connectionId}`);
  const rateConstraints = plant.constraints.filter((constraint) => constraint.target.kind === "connection-rate" && constraint.target.connectionId === connectionId);
  const poolId = createId("pool");
  let next = disconnectPlantPorts(plant, connectionId);
  next = addPlantComponent(next, { id: poolId, kind: "pool", resource: edge.from.resource });
  const firstConnectionId = createId("flow"), secondConnectionId = createId("flow");
  next = connectPlantPorts(next, { id: firstConnectionId, from: edge.from, to: { componentId: poolId, direction: "input", resource: edge.from.resource }, ...(edge.secondary ? { secondary: true } : {}) });
  next = connectPlantPorts(next, { id: secondConnectionId, from: { componentId: poolId, direction: "output", resource: edge.from.resource }, to: edge.to, ...(edge.secondary ? { secondary: true } : {}) });
  for (const constraint of rateConstraints) next = addPlantConstraint(next, { ...constraint, target: { kind: "connection-rate", connectionId: firstConnectionId } });
  return { plant: next, poolId, firstConnectionId, secondConnectionId };
}

export function bypassPlantPool(plant: Plant, poolId: string, createId: (prefix: string) => string): Plant | undefined {
  const pool = plant.components.find(({ id }) => id === poolId);
  if (pool?.kind !== "pool") throw new Error(`Unknown storage pool: ${poolId}`);
  const incoming = plant.connections.filter((edge) => edge.to.componentId === poolId);
  const outgoing = plant.connections.filter((edge) => edge.from.componentId === poolId);
  if (incoming.length !== 1 || outgoing.length !== 1) return undefined;

  const [input] = incoming, [output] = outgoing;
  const connectionId = createId("flow");
  let next = disconnectPlantPorts(plant, input.id);
  next = disconnectPlantPorts(next, output.id);
  next = connectPlantPorts(next, {
    id: connectionId,
    from: input.from,
    to: output.to,
    ...(input.secondary || output.secondary ? { secondary: true } : {}),
  });
  const movedConstraints = plant.constraints.filter((constraint) =>
    constraint.target.kind === "connection-rate" && (constraint.target.connectionId === input.id || constraint.target.connectionId === output.id) ||
    constraint.target.kind === "port-rate" && constraint.target.port.componentId === poolId);
  next = removePlantComponent(next, poolId);
  for (const constraint of movedConstraints) {
    next = addPlantConstraint(next, {
      ...constraint,
      target: { kind: "connection-rate", connectionId },
    });
  }
  return next;
}

export function removeDisconnectedPlantBoundaries(plant: Plant) {
  const removedComponentIds = plant.components.filter((component) => component.kind !== "process" &&
    !plant.connections.some((edge) => edge.from.componentId === component.id || edge.to.componentId === component.id)).map(({ id }) => id);
  let next = plant;
  for (const id of removedComponentIds) next = removePlantComponent(next, id);
  return { plant: next, removedComponentIds };
}

export function ensurePlantOutputDestinations(plant: Plant, dependencies: PlantEditDependencies) {
  const selfConnections = plant.connections.filter((edge) =>
    edge.from.componentId === edge.to.componentId && !isValidSelfConnection(edge, plant, dependencies));
  let next = plant;
  for (const edge of selfConnections) next = disconnectPlantPorts(next, edge.id);
  const createdComponents: PlantComponent[] = [];
  for (const process of next.components.filter((component): component is Extract<PlantComponent, { kind: "process" }> => component.kind === "process")) {
    const recipe = dependencies.findRecipe(process.recipeId);
    const outputs = recipe?.outputs?.length ? recipe.outputs : recipe ? [{ resource: recipe.output, amount: recipe.outputAmount }] : [];
    for (const output of outputs) {
      if (next.connections.some((edge) => edge.from.componentId === process.id && resourceKey(edge.from.resource) === resourceKey(output.resource))) continue;
      const id = dependencies.createId("output-sink");
      const component: PlantComponent = { id, kind: "demand", resource: output.resource };
      next = addPlantComponent(next, component);
      next = connect(next, process.id, output.resource, id, dependencies.createId);
      createdComponents.push(component);
    }
  }
  return { plant: next, createdComponents, removedConnectionIds: selfConnections.map(({ id }) => id) };
}

function isValidSelfConnection(edge: PlantConnection, plant: Plant, dependencies: PlantEditDependencies): boolean {
  if (edge.from.direction !== "output" || edge.to.direction !== "input") return false;
  const component = plant.components.find(({ id }) => id === edge.from.componentId);
  if (component?.kind !== "process") return false;
  const recipe = dependencies.findRecipe(component.recipeId);
  if (!recipe) return false;
  const outputs = recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }];
  return outputs.some(({ resource }) => resourceKey(resource) === resourceKey(edge.from.resource)) &&
    recipe.inputs.some((input) => resourceKey(input) === resourceKey(edge.to.resource) ||
      (input.type === edge.to.resource.type && input.alternatives?.includes(edge.to.resource.id)));
}

export function isLastPlantProcessOutputDestination(plant: Plant, componentId: string): boolean {
  const component = plant.components.find(({ id }) => id === componentId);
  if (component?.kind !== "demand" && component?.kind !== "pool") return false;
  return plant.connections.filter((edge) => edge.to.componentId === componentId).some((edge) => {
    const source = plant.components.find(({ id }) => id === edge.from.componentId);
    return source?.kind === "process" && plant.connections.filter((candidate) => candidate.from.componentId === source.id &&
      candidate.from.direction === edge.from.direction && resourceKey(candidate.from.resource) === resourceKey(edge.from.resource)).length <= 1;
  });
}

function remapTarget(constraint: PlantConstraint, componentIds: Map<string, string>, connectionIds: Map<string, string>): PlantConstraint["target"] | undefined {
  const target = constraint.target;
  if (target.kind === "port-rate" && componentIds.has(target.port.componentId)) {
    return { ...target, port: { ...target.port, componentId: componentIds.get(target.port.componentId)! } };
  }
  if (target.kind === "connection-rate" && connectionIds.has(target.connectionId)) {
    return { ...target, connectionId: connectionIds.get(target.connectionId)! };
  }
  if ("componentId" in target && componentIds.has(target.componentId)) return { ...target, componentId: componentIds.get(target.componentId)! };
  return undefined;
}

function connect(plant: Plant, fromId: string, resource: Resource, toId: string, createId: (prefix: string) => string): Plant {
  const edge: PlantConnection = { id: createId("flow"), from: { componentId: fromId, direction: "output", resource }, to: { componentId: toId, direction: "input", resource } };
  return connectPlantPorts(plant, edge);
}
