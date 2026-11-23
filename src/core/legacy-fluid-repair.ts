import { resourceKey } from '../plant.ts';
import type { Plant, PortRef, Resource } from '../plant.ts';
import type { Recipe } from '../recipes.ts';
import { ingredientConnectionAccepts, recipeOutputPorts } from '../recipe-queries.ts';

export type LegacyFluidPort = { connectionId: string; port: PortRef; candidates: Resource[] };
export type LegacyFluidConstraint = { constraintId: string; port: PortRef; candidates: Resource[] };
type FindRecipe = (id: string) => Recipe | undefined;

function candidatesForPort(plant: Plant, port: PortRef, findRecipe: FindRecipe): Resource[] {
  if (port.resource.type !== 'fluid' || port.resource.nbt !== undefined) return [];
  const component = plant.components.find(item => item.id === port.componentId);
  if (component?.kind !== 'process') return [];
  const recipe = findRecipe(component.recipeId);
  if (!recipe) return [];
  const resources = port.direction === 'input' ? recipe.inputs : recipeOutputPorts(recipe).map(output => output.resource);
  if (resources.some(resource => resourceKey(resource) === resourceKey(port.resource))) return [];
  return resources.filter(resource => resource.type === 'fluid' && resource.id === port.resource.id && resource.nbt !== undefined)
    .map(({ type, id, nbt, alternatives }) => ({ type, id, ...(nbt !== undefined ? { nbt } : {}), ...(alternatives ? { alternatives } : {}) }));
}

/** Find old untagged process endpoints that no longer identify a current recipe port. */
export function legacyFluidPorts(plant: Plant, findRecipe: FindRecipe): LegacyFluidPort[] {
  const result: LegacyFluidPort[] = [];
  for (const edge of plant.connections) {
    for (const port of [edge.from, edge.to]) {
      const candidates = candidatesForPort(plant, port, findRecipe);
      if (candidates.length) result.push({ connectionId: edge.id, port, candidates });
    }
  }
  return result;
}

/** Find constraints that still refer to an old untagged process port. */
export function legacyFluidConstraints(plant: Plant, findRecipe: FindRecipe): LegacyFluidConstraint[] {
  return plant.constraints.flatMap(constraint => {
    if (constraint.target.kind !== 'port-rate') return [];
    const port = constraint.target.port;
    const candidates = candidatesForPort(plant, port, findRecipe);
    return candidates.length ? [{ constraintId: constraint.id, port, candidates }] : [];
  });
}

/** Rebind exactly one constraint after an explicit variant choice. */
export function repairLegacyFluidConstraint(plant: Plant, constraintId: string, replacement: Resource, findRecipe: FindRecipe): Plant {
  const legacy = legacyFluidConstraints(plant, findRecipe).find(item => item.constraintId === constraintId);
  if (!legacy || !legacy.candidates.some(candidate => resourceKey(candidate) === resourceKey(replacement))) throw new Error('Not a candidate for this legacy constraint');
  return { ...plant, constraints: plant.constraints.map(constraint => constraint.id !== constraintId || constraint.target.kind !== 'port-rate'
    ? constraint : { ...constraint, target: { ...constraint.target, port: { ...constraint.target.port, resource: replacement } } }) };
}

/** Repair one edge endpoint, without changing other edges or guessing ambiguous port constraints. */
export function repairLegacyFluidPort(plant: Plant, connectionId: string, direction: 'input' | 'output', replacement: Resource, findRecipe: FindRecipe): Plant {
  const legacy = legacyFluidPorts(plant, findRecipe).find(item => item.connectionId === connectionId && item.port.direction === direction);
  if (!legacy || !legacy.candidates.some(candidate => resourceKey(candidate) === resourceKey(replacement))) throw new Error('Not a candidate for this legacy port');
  const edge = plant.connections.find(item => item.id === connectionId)!;
  const other = direction === 'input' ? edge.from : edge.to;
  const otherComponent = plant.components.find(item => item.id === other.componentId);
  if (!otherComponent) throw new Error('Connection references a missing component');
  let updatedOther = other;
  let updatedComponent = otherComponent;
  if (otherComponent.kind !== 'process') {
    const attached = plant.connections.filter(item => item.from.componentId === other.componentId || item.to.componentId === other.componentId);
    if (attached.length !== 1 || resourceKey(other.resource) !== resourceKey(otherComponent.resource)) throw new Error('Shared resource cannot be changed safely');
    updatedOther = { ...other, resource: replacement };
    updatedComponent = { ...otherComponent, resource: replacement };
  } else {
    const otherLegacy = legacyFluidPorts(plant, findRecipe).some(item => item.connectionId === connectionId && item.port.direction === other.direction);
    if (!otherLegacy) {
      const source = direction === 'output' ? replacement : other.resource;
      const target = direction === 'input' ? replacement : other.resource;
      const targetComponent = direction === 'input' ? plant.components.find(item => item.id === legacy.port.componentId) : otherComponent;
      const recipe = targetComponent?.kind === 'process' ? findRecipe(targetComponent.recipeId) : undefined;
      if (!recipe || !ingredientConnectionAccepts(recipe.inputs, target, source)) throw new Error('Replacement is incompatible with the connected port');
    }
  }
  return {
    ...plant,
    components: plant.components.map(component => component.id === updatedComponent.id ? updatedComponent : component),
    connections: plant.connections.map(item => item.id !== connectionId ? item : {
      ...item,
      from: direction === 'output' ? { ...item.from, resource: replacement } : updatedOther,
      to: direction === 'input' ? { ...item.to, resource: replacement } : updatedOther,
    }),
    constraints: plant.constraints.map(constraint => constraint.target.kind === 'port-rate' && otherComponent.kind !== 'process' && constraint.target.port.componentId === otherComponent.id && resourceKey(constraint.target.port.resource) === resourceKey(other.resource)
      ? { ...constraint, target: { ...constraint.target, port: { ...constraint.target.port, resource: replacement } } } : constraint),
  };
}

/** Split a shared boundary explicitly, then repair only the selected connection. */
export function splitAndRepairLegacyFluidPort(plant: Plant, connectionId: string, direction: 'input' | 'output', replacement: Resource, newComponentId: string, findRecipe: FindRecipe): Plant {
  if (!newComponentId.trim() || plant.components.some(component => component.id === newComponentId)) throw new Error('New component ID must be unique');
  const legacy = legacyFluidPorts(plant, findRecipe).find(item => item.connectionId === connectionId && item.port.direction === direction);
  if (!legacy || !legacy.candidates.some(candidate => resourceKey(candidate) === resourceKey(replacement))) throw new Error('Not a candidate for this legacy port');
  const edge = plant.connections.find(item => item.id === connectionId)!;
  const other = direction === 'input' ? edge.from : edge.to;
  const boundary = plant.components.find(component => component.id === other.componentId);
  if (!boundary || boundary.kind === 'process' || resourceKey(boundary.resource) !== resourceKey(other.resource)) throw new Error('Connection does not have a matching resource boundary');
  const attached = plant.connections.filter(item => item.from.componentId === boundary.id || item.to.componentId === boundary.id);
  if (attached.length < 2) throw new Error('Resource boundary is not shared');
  const split: Plant = {
    ...plant,
    components: [...plant.components, { ...boundary, id: newComponentId }],
    connections: plant.connections.map(item => item.id !== connectionId ? item : {
      ...item,
      ...(direction === 'input' ? { from: { ...item.from, componentId: newComponentId } } : { to: { ...item.to, componentId: newComponentId } }),
    }),
  };
  return repairLegacyFluidPort(split, connectionId, direction, replacement, findRecipe);
}
