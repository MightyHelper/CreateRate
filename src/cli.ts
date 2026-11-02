import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { listItemIcons } from "./recipes.ts";
import {
  analyzePlantRates,
  capacityForRecipe,
  getRecipe,
  parsePlantTransferYaml,
  recipesProducing,
  timingForRecipe,
  unresolvedRecipes,
  version,
} from "./core.ts";
import type { PlantComponent, PlantRateAnalysis, Recipe } from "./core.ts";

const itemIcons = listItemIcons();
const iconCommands = new Map<string, string>();
const kittyDetection = kittyGraphicsDetection();
const kittyGraphics = kittyDetection.supported;
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const [command, ...args] = process.argv.slice(2);

try {
  if (command === "recipes") {
    if (args[0] === "unresolved") showUnresolvedRecipes();
    else showRecipes(required(args[0], "resource id"));
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
  } else if (command === "rates") {
    showRates(required(args[0], "plant YAML file"));
  } else if (command === "terminal") {
    showTerminalDiagnostics();
  } else {
    showHelp();
    if (command !== undefined && command !== "help") process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function showRates(file: string): void {
  const yaml = file === "-" ? readStdin() : readFileSync(file, "utf8");
  const document = parsePlantTransferYaml(yaml);
  const { plant } = document;
  const analysis = analyzePlantRates(plant);
  const components = new Map(plant.components.map((component) => [component.id, component]));
  const processAliases = new Map(plant.components.filter((component) => component.kind === "process").map((component, index) => [component.id, processAlias(index)]));
  let inputIndex = 0, outputIndex = 0, poolIndex = 0;
  const boundaryAliases = new Map(plant.components.flatMap((component) => {
    if (component.kind === "supply") return [[component.id, `I${++inputIndex}`] as const];
    if (component.kind === "demand") return [[component.id, `O${++outputIndex}`] as const];
    if (component.kind === "pool") return [[component.id, `P${++poolIndex}`] as const];
    return [];
  }));
  console.log(`${paint(`Plant ${plant.id} (${document.mode})`, "1;36")} — ${paint(analysis.status, statusColor(analysis.status))}`);
  for (const issue of analysis.issues) console.log(`  ${paint(issue, "31")}`);

  console.log(`\n${paint("Processes:", "1;36")}`);
  for (const component of plant.components) {
    if (component.kind === "process") console.log(`  ${processAliases.get(component.id)} = ${component.recipeId}`);
  }
  for (const [kind, label] of [["supply", "Sources:"], ["demand", "Sinks:"], ["pool", "Pools:"]] as const) {
    const boundaries = plant.components.filter((component) => component.kind === kind);
    if (boundaries.length) {
      console.log(`\n${paint(label, "1;36")}`);
      for (const component of boundaries) console.log(`  ${boundaryAliases.get(component.id)} = ${formatRateResource(component.resource)}`);
    }
  }

  console.log(`\n${paint("Connections:", "1;36")}`);
  for (const connection of plant.connections) {
    const rate = analysis.connectionRates.find(({ connectionId }) => connectionId === connection.id)?.rate;
    console.log(`  ${componentLabel(connection.from.componentId, components, processAliases, boundaryAliases)} -> ${componentLabel(connection.to.componentId, components, processAliases, boundaryAliases)} · ${formatRateResource(connection.from.resource)}: ${formatRate(rate)}`);
  }

  console.log(`\n${paint("Ports:", "1;36")}`);
  for (const { port, rate } of analysis.portRates) {
    const label = componentLabel(port.componentId, components, processAliases, boundaryAliases);
    console.log(`  ${label} ${port.direction} · ${formatRateResource(port.resource)}: ${formatRate(rate)}`);
  }
}

function componentLabel(componentId: string, components: Map<string, PlantComponent>, processAliases: Map<string, string>, boundaryAliases: Map<string, string>): string {
  const component = components.get(componentId);
  return component?.kind === "process"
    ? paint(processAliases.get(componentId)!, "1")
    : boundaryAliases.get(componentId) ?? component?.id ?? componentId;
}

function processAlias(index: number): string {
  let alias = "";
  do {
    alias = String.fromCharCode(65 + index % 26) + alias;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return alias;
}

function showTerminalDiagnostics(): void {
  const detection = kittyGraphicsDetection();
  console.log(paint("Terminal detection", "1;36"));
  console.log(`  stdout TTY: ${process.stdout.isTTY ? "yes" : "no"}`);
  console.log(`  color: ${useColor ? "enabled" : "disabled"}${!process.stdout.isTTY ? " (stdout is not a TTY)" : process.env.NO_COLOR ? " (NO_COLOR is set)" : process.env.TERM === "dumb" ? " (TERM=dumb)" : ""}`);
  console.log(`  Kitty graphics: ${detection.supported ? paint("detected", "32") : paint("not detected", "33")}`);
  console.log(`  TERM: ${process.env.TERM ?? "(unset)"}`);
  console.log(`  TERM_PROGRAM: ${process.env.TERM_PROGRAM ?? "(unset)"}`);
  console.log(`  KITTY_WINDOW_ID: ${process.env.KITTY_WINDOW_ID ?? "(unset)"}`);
  console.log(`  KITTY_PID: ${process.env.KITTY_PID ?? "(unset)"}`);
  console.log(`  WEZTERM_PANE: ${process.env.WEZTERM_PANE ?? "(unset)"}`);
  console.log(`  matching markers: ${detection.markers.join(", ") || "none"}`);
  if (detection.supported) {
    const icon = kittyIcon({ type: "item", id: "minecraft:andesite" });
    console.log(`  icon sample: ${icon || "(no exported icon found for minecraft:andesite)"}minecraft:andesite`);
  }
}

function readStdin(): string {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8");

  console.error("Paste plant YAML, then press Ctrl+D on a new line. Terminal echo is off.");
  execFileSync("stty", ["-echo"], { stdio: "inherit" });
  let echoDisabled = true;
  const restoreEcho = () => {
    if (!echoDisabled) return;
    echoDisabled = false;
    try { execFileSync("stty", ["echo"], { stdio: "inherit" }); } catch { /* terminal may already be closed */ }
  };
  const interrupt = () => { restoreEcho(); process.exit(130); };
  process.once("exit", restoreEcho);
  process.once("SIGINT", interrupt);
  try {
    return readFileSync(0, "utf8");
  } finally {
    restoreEcho();
    process.removeListener("exit", restoreEcho);
    process.removeListener("SIGINT", interrupt);
  }
}

function formatRate(rate: PlantRateAnalysis["connectionRates"][number]["rate"] | undefined): string {
  if (!rate || rate.state === "conflict") return paint("conflict", "31");
  if (rate.state === "underconstrained") {
    const maximum = rate.maximum === undefined ? "∞" : formatNumber(rate.maximum);
    return paint(`${formatNumber(rate.minimum)}–${maximum}/min (underconstrained)`, "33");
  }
  return paint(`${formatNumber(rate.perMinute)}/min (${rate.state})`, rate.state === "constrained" ? "32" : "36");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatRateResource(resource: { type: "item" | "fluid"; id: string }): string {
  return `${kittyIcon(resource)}${paint(formatResource(resource), resource.type === "item" ? "36" : "35")}`;
}

function kittyIcon(resource: { type: "item" | "fluid"; id: string }): string {
  if (!kittyGraphics || resource.type !== "item") return "";
  const cached = iconCommands.get(resource.id);
  if (cached !== undefined) return cached;
  const iconPath = itemIcons[resource.id];
  if (!iconPath) return "";
  try {
    const encoded = readFileSync(new URL(`../${iconPath}`, import.meta.url)).toString("base64");
    const chunks = encoded.match(/.{1,4096}/g) ?? [];
    const command = chunks.map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;
      const control = index === 0 ? `a=T,f=100,c=2,r=1,C=1,q=2${more ? ",m=1" : ""}` : `m=${more}`;
      return `\u001b_G${control};${chunk}\u001b\\`;
    }).join("") + "  ";
    iconCommands.set(resource.id, command);
    return command;
  } catch {
    return "";
  }
}

function kittyGraphicsDetection(): { supported: boolean; markers: string[] } {
  if (!process.stdout.isTTY) return { supported: false, markers: [] };
  const program = process.env.TERM_PROGRAM?.toLowerCase();
  const markers = [
    process.env.KITTY_WINDOW_ID !== undefined && "KITTY_WINDOW_ID",
    process.env.KITTY_PID !== undefined && "KITTY_PID",
    process.env.TERM === "xterm-kitty" && "TERM=xterm-kitty",
    process.env.TERM === "xterm-ghostty" && "TERM=xterm-ghostty",
    process.env.WEZTERM_PANE !== undefined && "WEZTERM_PANE",
    program === "wezterm" && "TERM_PROGRAM=wezterm",
    program === "ghostty" && "TERM_PROGRAM=ghostty",
  ].filter((marker): marker is string => !!marker);
  return { supported: markers.length > 0, markers };
}

function paint(text: string, code: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function statusColor(status: PlantRateAnalysis["status"]): string {
  return status === "balanced" ? "32" : status === "underconstrained" ? "33" : "31";
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
  recipes <item|fluid> | recipes unresolved
  time <recipe> [--rpm <rpm>] [--stack-size <items>]
  capacity <recipe> [--rpm <rpm>] [--stack-size <items>] --input <item>=<items/min>... --target <output/min>
  rates <plant.yaml|->  Resolve rates from a file or stdin
  terminal              Show terminal feature detection and an icon sample

Example:
  make build
  ./build/create-rate.mjs recipes create:andesite_alloy
  ./build/create-rate.mjs time create:mixing/andesite_alloy --rpm 64
  ./build/create-rate.mjs rates plant.yaml
  cat plant.yaml | ./build/create-rate.mjs rates -
  ./build/create-rate.mjs capacity create:mixing/andesite_alloy --rpm 64 --input minecraft:andesite=20 --input minecraft:iron_nugget=20 --target 10
  ./build/create-rate.mjs capacity create:compacting/andesite_from_flint --rpm 64 --input minecraft:flint=40 --input minecraft:gravel=20 --input fluid:minecraft:lava=2000 --target 10`);
}
