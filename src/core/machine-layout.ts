import type { Recipe, MachineLayoutRules } from "../recipes.ts";

export type MachineLayout = { parts: Array<{ model: string; position: [number, number, number] }> };

export function machineLayoutForRecipe(recipe: Recipe, machineModelIds: Record<string, string>, rules: MachineLayoutRules): MachineLayout {
  const heaterModel = recipe.heatRequirement ? rules.heaterModels[recipe.heatRequirement] : undefined;
  const needsBasin = rules.basinMethods.includes(recipe.method) || !!heaterModel;
  const basinModel = needsBasin ? rules.basinModel : undefined;
  const basinY = basinModel && heaterModel ? rules.blockStep : 0;
  const parts: MachineLayout["parts"] = [];
  if (heaterModel) parts.push({ model: heaterModel, position: [0, 0, 0] });
  if (basinModel) parts.push({ model: basinModel, position: [0, basinY, 0] });
  const machineModel = recipe.machine ? machineModelIds[recipe.machine] : undefined;
  if (machineModel) parts.push({ model: machineModel, position: [0, basinModel ? basinY + rules.blockStep : 0, 0] });
  return { parts };
}
