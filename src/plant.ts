import type { Ingredient } from "./recipes.ts";

export type Resource = Pick<Ingredient, "type" | "id">;
export type PortRef = { componentId: string; direction: "input" | "output"; resource: Resource };

export type PlantComponent =
  | { id: string; kind: "process"; recipeId: string }
  | { id: string; kind: "supply"; resource: Resource }
  | { id: string; kind: "demand"; resource: Resource };

export type PlantConnection = { id: string; from: PortRef; to: PortRef };
export type PlantQuantityRef =
  | { kind: "port-rate"; port: PortRef }
  | { kind: "connection-rate"; connectionId: string }
  | { kind: "rpm" | "stack-size" | "machine-count" | "stress"; componentId: string };
export type PlantConstraint = {
  id: string;
  target: PlantQuantityRef;
} & (
  | { kind: "bound"; relation: "equals" | "at-least" | "at-most"; value: number }
  | { kind: "integer" | "power-of-two" }
);

export type Plant = {
  id: string;
  components: PlantComponent[];
  connections: PlantConnection[];
  constraints: PlantConstraint[];
};

export function createPlant(id: string): Plant {
  if (!id.trim()) throw new Error("Plant id cannot be empty");
  return { id, components: [], connections: [], constraints: [] };
}

export function addPlantComponent(plant: Plant, component: PlantComponent): Plant {
  if (plant.components.some((existing) => existing.id === component.id)) {
    throw new Error(`Plant component already exists: ${component.id}`);
  }
  return { ...plant, components: [...plant.components, component] };
}

export function removePlantComponent(plant: Plant, componentId: string): Plant {
  const removedConnections = new Set(plant.connections
    .filter((connection) => connection.from.componentId === componentId || connection.to.componentId === componentId)
    .map(({ id }) => id));
  return {
    ...plant,
    components: plant.components.filter((component) => component.id !== componentId),
    connections: plant.connections.filter(({ id }) => !removedConnections.has(id)),
    constraints: plant.constraints.filter((constraint) =>
      !constraintTargets(constraint, componentId) &&
      !(constraint.target.kind === "connection-rate" && removedConnections.has(constraint.target.connectionId))),
  };
}

export function connectPlantPorts(plant: Plant, connection: PlantConnection): Plant {
  if (plant.connections.some((existing) => existing.id === connection.id)) {
    throw new Error(`Plant connection already exists: ${connection.id}`);
  }
  if (connection.from.direction !== "output" || connection.to.direction !== "input") {
    throw new Error("Plant connections must go from an output port to an input port");
  }
  if (connection.from.componentId === connection.to.componentId) {
    throw new Error("A process cannot connect to itself");
  }
  if (!plant.components.some(({ id }) => id === connection.from.componentId) ||
      !plant.components.some(({ id }) => id === connection.to.componentId)) {
    throw new Error("Both connected components must exist in the plant");
  }
  if (resourceKey(connection.from.resource) !== resourceKey(connection.to.resource)) {
    throw new Error("Connected ports must carry the same resource");
  }
  return { ...plant, connections: [...plant.connections, connection] };
}

export function redirectPlantConnectionTarget(plant: Plant, connectionId: string, target: PortRef): Plant {
  const connection = plant.connections.find(({ id }) => id === connectionId);
  if (!connection) throw new Error(`Unknown plant connection: ${connectionId}`);
  if (target.direction !== "input") throw new Error("A connection target must be an input port");
  if (!plant.components.some(({ id }) => id === target.componentId)) throw new Error("Target component must exist in the plant");
  if (resourceKey(connection.from.resource) !== resourceKey(target.resource)) throw new Error("Connected ports must carry the same resource");
  return {
    ...plant,
    connections: plant.connections.map((current) => current.id === connectionId ? { ...current, to: target } : current),
  };
}

export function disconnectPlantPorts(plant: Plant, connectionId: string): Plant {
  return {
    ...plant,
    connections: plant.connections.filter(({ id }) => id !== connectionId),
    constraints: plant.constraints.filter((constraint) =>
      constraint.target.kind !== "connection-rate" || constraint.target.connectionId !== connectionId),
  };
}

export function addPlantConstraint(plant: Plant, constraint: PlantConstraint): Plant {
  if (plant.constraints.some((existing) => existing.id === constraint.id)) {
    throw new Error(`Plant constraint already exists: ${constraint.id}`);
  }
  validateConstraint(constraint);
  return { ...plant, constraints: [...plant.constraints, constraint] };
}

export function updatePlantConstraint(plant: Plant, constraint: PlantConstraint): Plant {
  if (!plant.constraints.some(({ id }) => id === constraint.id)) {
    throw new Error(`Unknown plant constraint: ${constraint.id}`);
  }
  validateConstraint(constraint);
  return {
    ...plant,
    constraints: plant.constraints.map((existing) => existing.id === constraint.id ? constraint : existing),
  };
}

export function removePlantConstraint(plant: Plant, constraintId: string): Plant {
  return { ...plant, constraints: plant.constraints.filter(({ id }) => id !== constraintId) };
}

export function resourceKey(resource: Resource): string {
  return `${resource.type}:${resource.id}`;
}

function constraintTargets(constraint: PlantConstraint, componentId: string): boolean {
  if (constraint.target.kind === "port-rate") return constraint.target.port.componentId === componentId;
  if (constraint.target.kind === "connection-rate") return false;
  return constraint.target.componentId === componentId;
}

function validateConstraint(constraint: PlantConstraint): void {
  if (constraint.kind !== "bound") return;
  if (!Number.isFinite(constraint.value) || constraint.value < 0) {
    throw new Error("Plant constraint value must be a finite, non-negative number");
  }
}
