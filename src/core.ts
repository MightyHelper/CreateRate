import {
  findRecipe,
  findRecipesProducing,
  listUnresolvedRecipes,
  recipeSetVersion,
} from "./recipes.ts";
import type { Ingredient, Recipe } from "./recipes.ts";
import {
  addPlantComponent,
  addPlantConstraint,
  connectPlantPorts,
  createPlant,
  disconnectPlantPorts,
  removePlantComponent,
  removePlantConstraint,
  redirectPlantConnectionTarget,
  resourceKey,
  updatePlantConstraint,
} from "./plant.ts";
import type {
  Plant,
  PlantComponent,
  PlantConnection,
  PlantConstraint,
  PlantQuantityRef,
  PortRef,
  Resource,
} from "./plant.ts";
import { calculateTiming, requiredOperatingConditions, stressImpactPerMachine } from "./timing.ts";
import { findFeasibleTimings } from "./timing.ts";
import type { FeasibleTimingRequest, FeasibleTimingResult, OperationTiming } from "./timing.ts";
import { analyzePlantRates as analyzePlantRatesWith, inspectPlant as inspectPlantWith } from "./plant-analysis.ts";
import type { PlantInspection, PlantRateAnalysis } from "./plant-analysis.ts";

export type { Recipe } from "./recipes.ts";
export {
  addPlantComponent,
  addPlantConstraint,
  connectPlantPorts,
  createPlant,
  disconnectPlantPorts,
  removePlantComponent,
  removePlantConstraint,
  redirectPlantConnectionTarget,
  updatePlantConstraint,
};
export type { Plant, PlantComponent, PlantConnection, PlantConstraint, PlantQuantityRef, PortRef, Resource };
export type ResourceRate = { resource: Resource; perMinute: number };

export type { PlantIssue, PlantInspection, RateValue, PlantRateAnalysis } from "./plant-analysis.ts";

export type RecipeCapacity = OperationTiming & {
  inputLimitedOutputPerMinute: number;
  achievableOutputPerMinute: number;
  machinesForTarget: number;
  targetInputRates: Record<string, number>;
  inputsCanMeetTarget: boolean;
};

export function getRecipe(id: string): Recipe | undefined {
  return findRecipe(id);
}

export function recipesProducing(resource: string): Recipe[] {
  return findRecipesProducing(resource);
}

export function unresolvedRecipes() {
  return listUnresolvedRecipes();
}

export function version(): string {
  return recipeSetVersion();
}

export function timingForRecipe(recipeId: string, rpm: number, stackSize = 1): OperationTiming {
  return calculateTiming(requireRecipe(recipeId), rpm, stackSize);
}

export function feasibleTimingsForRecipe(recipeId: string, request: FeasibleTimingRequest): FeasibleTimingResult {
  return findFeasibleTimings(requireRecipe(recipeId), request);
}

export function capacityForRecipe(
  recipeId: string,
  rpm: number,
  inputRates: Record<string, number>,
  targetOutputPerMinute: number,
  stackSize = 1,
): RecipeCapacity {
  const recipe = requireRecipe(recipeId);
  const timing = calculateTiming(recipe, rpm, stackSize);
  const runsPerCycle = timing.runsPerCycle;
  if (!Number.isFinite(targetOutputPerMinute) || targetOutputPerMinute <= 0) {
    throw new Error("Target output rate must be greater than zero");
  }

  const missingInputs = recipe.inputs.filter((input) => inputRate(input, inputRates) === undefined);
  if (missingInputs.length > 0) {
    throw new Error(`Missing input rate for: ${missingInputs.map(resourceKey).join(", ")}`);
  }

  const inputLimitedBatchesPerMinute = Math.min(
    ...recipe.inputs.map((input) => inputRate(input, inputRates)! / (input.amount * runsPerCycle)),
  );
  const outputPerCycle = recipe.outputAmount * runsPerCycle;
  const inputLimitedOutputPerMinute = inputLimitedBatchesPerMinute * outputPerCycle;
  const machinesForTarget = Math.ceil(targetOutputPerMinute / timing.outputPerMinute);
  const targetBatchesPerMinute = targetOutputPerMinute / outputPerCycle;
  const targetInputRates = Object.fromEntries(
    recipe.inputs.map((input) => [resourceKey(input), input.amount * runsPerCycle * targetBatchesPerMinute]),
  );

  return {
    ...timing,
    inputLimitedOutputPerMinute,
    achievableOutputPerMinute: Math.min(inputLimitedOutputPerMinute, timing.outputPerMinute * machinesForTarget),
    machinesForTarget,
    targetInputRates,
    inputsCanMeetTarget: inputLimitedOutputPerMinute >= targetOutputPerMinute,
  };
}

export function inspectPlant(plant: Plant): PlantInspection {
  return inspectPlantWith(plant, findRecipe);
}

export function analyzePlantRates(plant: Plant): PlantRateAnalysis {
  return analyzePlantRatesWith(plant, { findRecipe, requiredOperatingConditions, calculateTiming, stressImpactPerMachine });
}

function requireRecipe(id: string): Recipe {
  const recipe = findRecipe(id);
  if (!recipe) throw new Error(`Unknown recipe: ${id}`);
  return recipe;
}

function inputRate(input: Ingredient, rates: Record<string, number>): number | undefined {
  const exact = resourceKey(input);
  if (exact in rates) return rates[exact];
  if (!input.alternatives) return undefined;
  const available = input.alternatives.filter((id) => `${input.type}:${id}` in rates);
  if (available.length === 0) return undefined;
  return available.reduce((total, id) => total + rates[`${input.type}:${id}`], 0);
}

