import { addPlantConstraint, removePlantConstraint, resourceKey } from "../plant.ts";
import type { Plant, PlantComponent, PlantConstraint, PlantQuantityRef, Resource } from "../plant.ts";
import type { Recipe } from "../recipes.ts";

export function constraintTargetsFor(component: PlantComponent, recipe?: Recipe): PlantQuantityRef[] {
  if (component.kind !== "process") {
    return [{ kind: "port-rate", port: { componentId: component.id, direction: component.kind === "supply" ? "output" : "input", resource: component.resource } }];
  }
  const targets: PlantQuantityRef[] = [
    { kind: "rpm", componentId: component.id },
    { kind: "machine-count", componentId: component.id },
    { kind: "stress", componentId: component.id },
  ];
  if (["encased_fan", "crushing_wheels", "mechanical_saw"].includes(recipe?.machine ?? "")) targets.push({ kind: "stack-size", componentId: component.id });
  for (const input of recipe?.inputs ?? []) targets.push({ kind: "port-rate", port: { componentId: component.id, direction: "input", resource: input } });
  for (const output of recipe?.outputs ?? (recipe ? [{ resource: recipe.output, amount: recipe.outputAmount }] : [])) {
    targets.push({ kind: "port-rate", port: { componentId: component.id, direction: "output", resource: output.resource } });
  }
  return targets;
}

export function replacePlantConstraints(plant: Plant, target: PlantQuantityRef, replacements: PlantConstraint[]): Plant {
  let next = plant;
  for (const constraint of plant.constraints.filter((item) => samePlantQuantity(target, item.target))) next = removePlantConstraint(next, constraint.id);
  for (const constraint of replacements) next = addPlantConstraint(next, constraint);
  return next;
}

export function savePlantConstraintSet(plant: Plant, target: PlantQuantityRef, values: {
  exact?: number; minimum?: number; maximum?: number; integer: boolean; powerOfTwo: boolean;
}, createId: (prefix: string) => string): Plant {
  const integer = values.integer || isDiscretePlantQuantity(target);
  validateConstraintSet(values.exact, values.minimum, values.maximum, integer, values.powerOfTwo);
  return replacePlantConstraints(plant, target, [
    ...(values.exact === undefined ? [] : [{ id: createId("constraint"), target, kind: "bound" as const, relation: "equals" as const, value: values.exact }]),
    ...(values.minimum === undefined ? [] : [{ id: createId("constraint"), target, kind: "bound" as const, relation: "at-least" as const, value: values.minimum }]),
    ...(values.maximum === undefined ? [] : [{ id: createId("constraint"), target, kind: "bound" as const, relation: "at-most" as const, value: values.maximum }]),
    ...(integer ? [{ id: createId("constraint"), target, kind: "integer" as const }] : []),
    ...(values.powerOfTwo ? [{ id: createId("constraint"), target, kind: "power-of-two" as const }] : []),
  ]);
}

export function isDiscretePlantQuantity(target: PlantQuantityRef): boolean {
  return target.kind === "machine-count" || target.kind === "stack-size";
}

export function validateConstraintSet(exact: number | undefined, minimum: number | undefined, maximum: number | undefined, integer: boolean, powerOfTwo: boolean): void {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error("GEQ cannot exceed LEQ");
  if (exact !== undefined && ((minimum !== undefined && exact < minimum) || (maximum !== undefined && exact > maximum))) {
    throw new Error("Equality must fit within the GEQ and LEQ bounds");
  }
  const valid = (value: number) => (!integer && !powerOfTwo || Number.isInteger(value)) && (!powerOfTwo || isPowerOfTwo(value));
  if (exact !== undefined && !valid(exact)) throw new Error("Equality violates the selected integer or power-of-two restriction");
  if (exact === undefined && (integer || powerOfTwo)) {
    const lowest = powerOfTwo ? 2 ** Math.ceil(Math.log2(Math.max(minimum ?? 0, 1))) : Math.ceil(minimum ?? 0);
    const highest = maximum === undefined ? undefined : Math.floor(maximum);
    if (highest !== undefined && lowest > highest) throw new Error("Bounds contain no allowed integer or power-of-two value");
  }
}

export function samePlantQuantity(a: PlantQuantityRef, b: PlantQuantityRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "port-rate" && b.kind === "port-rate") return a.port.componentId === b.port.componentId && a.port.direction === b.port.direction && resourceKey(a.port.resource) === resourceKey(b.port.resource);
  if (a.kind === "connection-rate" && b.kind === "connection-rate") return a.connectionId === b.connectionId;
  return "componentId" in a && "componentId" in b && a.componentId === b.componentId;
}

export function constraintUnit(target: PlantQuantityRef, plant: Plant): string {
  if (target.kind === "rpm") return "RPM";
  if (target.kind === "machine-count") return "machines";
  if (target.kind === "stack-size") return "items/stack";
  if (target.kind === "stress") return "SU";
  const resource: Resource | undefined = target.kind === "port-rate" ? target.port.resource
    : target.kind === "connection-rate" ? plant.connections.find(({ id }) => id === target.connectionId)?.from.resource
      : undefined;
  return resource?.type === "fluid" ? "mB/min" : "items/min";
}

function isPowerOfTwo(value: number): boolean { return Number.isInteger(value) && value > 0 && 2 ** Math.round(Math.log2(value)) === value; }
