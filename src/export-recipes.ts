import { writeFileSync } from "node:fs";
import { listRecipes, listResourceTags } from "./recipes.ts";

const recipes = listRecipes().map(({ id, method, machine, machineUnits, inputs, outputs, output, outputAmount, durationTicks }) => ({
  id, method, machine, machineUnits, inputs, outputs, output, outputAmount, durationTicks,
}));
writeFileSync(new URL("./browser-recipes.json", import.meta.url), JSON.stringify({ recipes, ...listResourceTags() }));
