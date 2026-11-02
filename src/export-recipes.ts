import { writeFileSync } from "node:fs";
import { listItemAnimations, listItemIcons, listItemModelIds, listMachineModelIds, listMachineModels, listMachineLayoutRules, listRecipes, listResourceTags } from "./recipes.ts";

const recipes = listRecipes().map(({ id, processKind, method, machine, blockHardness, machineUnits, heatRequirement, inputs, outputs, output, outputAmount, durationTicks, loops, sequence }) => ({
  id, processKind, method, machine, blockHardness, machineUnits, heatRequirement, inputs, outputs, output, outputAmount, durationTicks, loops, sequence,
}));
writeFileSync(new URL("./browser-recipes.json", import.meta.url), JSON.stringify({ recipes, itemIcons: listItemIcons(), itemAnimations: listItemAnimations(), itemModelIds: listItemModelIds(), machineModelIds: listMachineModelIds(), machineModels: listMachineModels(), machineLayoutRules: listMachineLayoutRules(), ...listResourceTags() }));
