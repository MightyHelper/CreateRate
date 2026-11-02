import type { Recipe, MachineLayoutRules } from "../recipes.ts";

export type MachineLayout = { parts: Array<{ model: string; position: [number, number, number] }>; machineCountMultiplier: number };

export function machineLayoutForRecipe(recipe: Recipe, machineModelIds: Record<string, string>, rules: MachineLayoutRules): MachineLayout {
  const heaterModel = recipe.heatRequirement ? rules.heaterModels[recipe.heatRequirement] : undefined;
  const needsBasin = rules.basinMethods.includes(recipe.method) || !!heaterModel;
  const basinModel = needsBasin ? rules.basinModel : undefined;
  const basinY = basinModel && heaterModel ? rules.blockStep : 0;
  const parts: MachineLayout["parts"] = [];
  if (heaterModel) parts.push({ model: heaterModel, position: [0, 0, 0] });
  if (basinModel) parts.push({ model: basinModel, position: [0, basinY, 0] });
  const sequenceCounts = new Map<string, number>();
  for (const step of recipe.sequence ?? []) {
    if (step.machine) sequenceCounts.set(step.machine, (sequenceCounts.get(step.machine) ?? 0) + 1);
  }
  const loops = recipe.loops ?? 1;
  const machineCountMultiplier = [...sequenceCounts.values()].reduce((total, count) => total + count * loops, 0) || 1;
  if (sequenceCounts.size > 0) {
    for (const machine of sequenceCounts.keys()) {
      const model = machineModelIds[machine];
      if (model) parts.push({ model, position: [0, parts.length * rules.blockStep, 0] });
    }
  } else {
    const machineModel = recipe.machine ? machineModelIds[recipe.machine] : undefined;
    if (machineModel) parts.push({ model: machineModel, position: [0, basinModel ? basinY + rules.blockStep : 0, 0] });
  }
  return { parts, machineCountMultiplier };
}
