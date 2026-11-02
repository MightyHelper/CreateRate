import { analyzePlantRates as analyze } from "../plant-analysis.ts";
import { calculateStressImpact, calculateTiming, requiredOperatingConditions, stressImpactPerMachine } from "../timing.ts";
import type { Plant } from "../plant.ts";
import type { PlantRateAnalysis } from "../plant-analysis.ts";
import type { Recipe } from "../recipes.ts";
import { recipeOutputs } from "../recipe-queries.ts";

export function analyzePlantRates(plant: Plant, recipes: Map<string, Recipe>): PlantRateAnalysis {
  return analyze(plant, {
    findRecipe: (id) => recipes.get(id),
    requiredOperatingConditions,
    calculateTiming,
    stressImpactPerMachine,
  });
}

export function plantProcessMetrics(plant: Plant, componentId: string, recipe: Recipe | undefined, analysis?: PlantRateAnalysis) {
  const rpm = exactValue(plant, "rpm", componentId);
  const stackSize = exactValue(plant, "stack-size", componentId);
  let machineCount = exactValue(plant, "machine-count", componentId);
  let machineCountIsMinimum = false;
  const output = recipeOutputs(recipe)[0];
  if (machineCount === undefined && recipe && output) {
    const rate = analysis?.portRates.find(({ port }) => port.componentId === componentId && port.direction === "output" && port.resource.type === output.resource.type && port.resource.id === output.resource.id)?.rate;
    const targetRate = rate && (rate.state === "constrained" || rate.state === "derived" ? rate.perMinute
      : rate.state === "underconstrained" ? rate.minimum : undefined);
    if (targetRate !== undefined && targetRate > 0) {
      try {
        const capacity = calculateTiming(recipe, rpm ?? 0, stackSize ?? 1).outputPerMinute;
        if (capacity > 0) {
          machineCount = Math.ceil(targetRate / capacity);
          machineCountIsMinimum = true;
        }
      } catch { /* An unavailable operating condition leaves machine count unknown. */ }
    }
  }
  const stress = recipe && rpm !== undefined && machineCount !== undefined ? calculateStressImpact(recipe, rpm, machineCount) : undefined;
  return {
    rpm,
    machineCount,
    machineCountIsMinimum,
    stackSize,
    stress,
    requiresRpm: recipe !== undefined && recipe.processKind !== "natural",
    tracksStress: recipe !== undefined && recipe.processKind !== "natural",
  };
}

export function plantQuantityState(plant: Plant, componentId: string, kind: "rpm" | "machine-count" | "stress" | "stack-size", measured?: number) {
  const constraints = plant.constraints.filter((constraint) => "componentId" in constraint.target && constraint.target.kind === kind && constraint.target.componentId === componentId);
  return {
    constraints,
    measured,
    constrained: constraints.length > 0,
    exact: constraints.some((constraint) => constraint.kind === "bound" && constraint.relation === "equals"),
    integer: (kind === "machine-count" || kind === "stack-size") && !constraints.some((constraint) => constraint.kind === "integer"),
  };
}

function exactValue(plant: Plant, kind: "rpm" | "stack-size" | "machine-count", componentId: string): number | undefined {
  const values = plant.constraints.filter((constraint) => constraint.kind === "bound" && constraint.relation === "equals" &&
    constraint.target.kind === kind && constraint.target.componentId === componentId).map(({ value }) => value);
  return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}
