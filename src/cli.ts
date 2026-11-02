import {
  capacityForRecipe,
  getRecipe,
  recipesProducing,
  timingForRecipe,
  unresolvedRecipes,
  version,
} from "./core.ts";
import type { Recipe } from "./core.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "recipes") {
    if (args[0] === "unresolved") showUnresolvedRecipes();
    else showRecipes(required(args[0], "item id"));
  } else if (command === "time") {
    const recipe = requireRecipe(args[0]);
    const rpm = numberOption(args, "rpm", 0);
    const stackSize = numberOption(args, "stack-size", 1);
    const timing = timingForRecipe(recipe.id, rpm, stackSize);
    console.log(`${recipe.id}${heatLabel(recipe)}: first output in ${timing.firstBatchTicks} ticks (${timing.firstBatchSeconds.toFixed(2)} s)`);
    console.log(`Steady cycle: ${timing.cycleTicks} ticks (${timing.cycleSeconds.toFixed(2)} s)`);
  console.log(`Capacity: ${timing.outputPerMinute.toFixed(2)} ${formatResource(recipe.output)}/min per machine`);
  } else if (command === "capacity") {
    const recipe = requireRecipe(args[0]);
    const rpm = numberOption(args, "rpm", 0);
    const stackSize = numberOption(args, "stack-size", 1);
    const inputRates = Object.fromEntries(
      options(args, "input").map(parseRate),
    );
    const capacity = capacityForRecipe(
      recipe.id,
      rpm,
      inputRates,
      numberOption(args, "target"),
      stackSize,
    );
    showCapacity(recipe, capacity, rpm, stackSize);
  } else {
    showHelp();
    if (command !== undefined && command !== "help") process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function showRecipes(item: string): void {
  const recipes = recipesProducing(item);
  if (recipes.length === 0) throw new Error(`No known recipes produce ${item}`);

  console.log(version());
  for (const recipe of recipes) {
    const machine = recipe.machine ? `, ${recipe.machine}` : "";
    const config = recipe.compatibilityConfig ? `, requires Create config ${recipe.compatibilityConfig}` : "";
    const source = recipe.adaptedFrom ? ` from ${recipe.adaptedFrom}` : "";
    const conditional = recipe.conditional ? ", condition unknown" : "";
    console.log(`\n${recipe.id}${source} (${recipe.method}${machine}${config}${heatLabel(recipe, true)}${conditional})`);
    const outputs = recipe.outputs.map((output) => {
      const chance = output.chance === undefined ? "" : ` (${(output.chance * 100).toFixed(0)}% chance)`;
      return `${output.amount} ${formatResource(output.resource)}${chance}`;
    });
    console.log(`  ${recipe.inputs.map((input) => `${input.amount} ${formatResource(input)}`).join(" + ")} -> ${outputs.join(" + ")}`);
    if (recipe.sequence) {
      console.log(`  Sequence (${recipe.loops ?? 1} loop${recipe.loops === 1 ? "" : "s"}):`);
      recipe.sequence.forEach((step, index) => {
        const stepMachine = step.machine ? `, ${step.machine}` : "";
        const stepInputs = step.inputs.map((input) => `${input.amount} ${formatResource(input)}`).join(" + ");
        const stepOutputs = step.outputs.map((output) => `${output.amount} ${formatResource(output.resource)}`).join(" + ");
        console.log(`    ${index + 1}. ${step.method}${stepMachine}: ${stepInputs} -> ${stepOutputs}`);
      });
    }
  }
}

function showUnresolvedRecipes(): void {
  const recipes = unresolvedRecipes();
  console.log(`${recipes.length} recipes without a declared output`);
  for (const recipe of recipes) {
    console.log(`${recipe.id} (${recipe.type}${recipe.source ? `, ${recipe.source}` : ""})`);
  }
}

function showCapacity(recipe: Recipe, capacity: ReturnType<typeof capacityForRecipe>, rpm: number, stackSize: number): void {
  const operatingPoint = recipe.machine === "encased_fan" ? `${stackSize} items per input stack` : `${rpm} RPM`;
  console.log(`${recipe.id} at ${operatingPoint}${heatLabel(recipe)}`);
  console.log(`First output: ${capacity.firstBatchTicks} ticks (${capacity.firstBatchSeconds.toFixed(2)} s)`);
  console.log(`Steady cycle: ${capacity.cycleTicks} ticks (${capacity.cycleSeconds.toFixed(2)} s)`);
  console.log(`One ${recipe.machine}: ${capacity.outputPerMinute.toFixed(2)} ${formatResource(recipe.output)}/min`);
  console.log(`Available inputs support: ${capacity.inputLimitedOutputPerMinute.toFixed(2)} ${formatResource(recipe.output)}/min`);
  console.log(`Achievable with planned machines: ${capacity.achievableOutputPerMinute.toFixed(2)} ${formatResource(recipe.output)}/min`);
  console.log(`Machines for target: ${capacity.machinesForTarget}`);
  console.log(`Target is ${capacity.inputsCanMeetTarget ? "supplied" : "input-limited"}`);
  console.log("Required input rates for target:");
  for (const [key, rate] of Object.entries(capacity.targetInputRates)) {
      console.log(`  ${formatResourceFromKey(key)}: ${rate.toFixed(2)}/min`);
  }
}

function heatLabel(recipe: Recipe, withinList = false): string {
  return recipe.heatRequirement
    ? `${withinList ? ", " : "; requires a "}${recipe.heatRequirement}${withinList ? "" : " basin"}`
    : "";
}

function requireRecipe(id: string | undefined): Recipe {
  const recipeId = required(id, "recipe id");
  const recipe = getRecipe(recipeId);
  if (!recipe) throw new Error(`Unknown recipe: ${recipeId}`);
  return recipe;
}

function numberOption(args: string[], name: string, defaultValue?: number): number {
  const value = option(args, name);
  const number = value === undefined && defaultValue !== undefined ? defaultValue : Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`);
  return number;
}

function option(args: string[], name: string): string | undefined {
  const values = options(args, name);
  return values.at(-1);
}

function options(args: string[], name: string): string[] {
  const prefix = `--${name}=`;
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    else if (arg === `--${name}` && args[index + 1] !== undefined) values.push(args[++index]);
  }
  return values;
}

function parseRate(value: string): [string, number] {
  const separator = value.lastIndexOf("=");
  if (separator < 1) throw new Error(`Input rate must be item=items-per-minute: ${value}`);
  const rawResource = value.slice(0, separator);
  const item = rawResource.startsWith("fluid:") || rawResource.startsWith("item:")
    ? rawResource
    : `item:${rawResource}`;
  const rate = Number(value.slice(separator + 1));
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`Invalid input rate: ${value}`);
  return [item, rate];
}

function required(value: string | undefined, name: string): string {
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function formatResourceFromKey(key: string): string {
  const [type, id] = key.split(/:(.+)/, 2);
  return formatResource({ type: type as "item" | "fluid", id });
}

function formatResource(resource: { type: "item" | "fluid"; id: string }): string {
  if (resource.id.startsWith("#")) return `${resource.id}${resource.type === "fluid" ? " (mB)" : ""}`;
  return resource.type === "fluid" ? `${resource.id} (mB)` : resource.id;
}

function showHelp(): void {
  console.log(`CreateRate (${version()})

Commands:
  recipes <item> | recipes unresolved
  time <recipe> [--rpm <rpm>] [--stack-size <items>]
  capacity <recipe> [--rpm <rpm>] [--stack-size <items>] --input <item>=<items/min>... --target <output/min>

Example:
  make build
  ./build/create-rate.mjs recipes create:andesite_alloy
  ./build/create-rate.mjs time create:mixing/andesite_alloy --rpm 64
  ./build/create-rate.mjs capacity create:mixing/andesite_alloy --rpm 64 --input minecraft:andesite=20 --input minecraft:iron_nugget=20 --target 10
  ./build/create-rate.mjs capacity create:compacting/andesite_from_flint --rpm 64 --input minecraft:flint=40 --input minecraft:gravel=20 --input fluid:minecraft:lava=2000 --target 10`);
}
