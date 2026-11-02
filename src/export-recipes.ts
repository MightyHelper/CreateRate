import { writeFileSync } from "node:fs";
import { listItemAnimations, listItemIcons, listMachineModelIds, listMachineModels, listMachineLayoutRules, listRecipes, listResourceTags } from "./recipes.ts";

const recipes = listRecipes().map(({ id, method, machine, machineUnits, heatRequirement, inputs, outputs, output, outputAmount, durationTicks }) => ({
  id, method, machine, machineUnits, heatRequirement, inputs, outputs, output, outputAmount, durationTicks,
}));
writeFileSync(new URL("./browser-recipes.json", import.meta.url), JSON.stringify({ recipes, itemIcons: listItemIcons(), itemAnimations: listItemAnimations(), machineModelIds: listMachineModelIds(), machineModels: listMachineModels(), machineLayoutRules: listMachineLayoutRules(), ...listResourceTags() }));
