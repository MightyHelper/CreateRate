import { readFileSync } from "node:fs";

export type Ingredient = {
  type: "item" | "fluid";
  id: string;
  amount: number;
  alternatives?: string[];
};

export type RecipeOutput = {
  resource: Omit<Ingredient, "amount">;
  amount: number;
  chance?: number;
};

export type Recipe = {
  id: string;
  source?: string;
  conditional?: boolean;
  adaptedFrom?: string;
  compatibilityConfig?: string;
  output: Omit<Ingredient, "amount">;
  outputAmount: number;
  outputs: RecipeOutput[];
  method: string;
  machine?: string;
  heatRequirement?: string;
  durationTicks?: number;
  machineUnits?: number;
  inputs: Ingredient[];
  loops?: number;
  sequence?: RecipeStep[];
};

export type RecipeStep = {
  method: string;
  machine?: string;
  inputs: Ingredient[];
  outputs: RecipeOutput[];
};

export type UnresolvedRecipe = { id: string; type: string; source?: string; reason: string };

type RawRecipe = Record<string, any>;
type Adaptation = {
  method: string;
  machine: string;
  config?: string;
  filter?: "single_ingredient_square";
};
type ExportData = {
  minecraftVersion?: string;
  createVersion?: string;
  fluidUnitsPerMillibucket?: number;
  recipes: { id: string; source?: string; active?: boolean | null; recipe: RawRecipe }[];
  itemTags?: Record<string, string[]>;
  fluidTags?: Record<string, string[]>;
};
type AdaptationData = Record<string, Adaptation[]>;
type MachineData = Record<string, string>;

const exported = JSON.parse(readFileSync(new URL("../data/modpack-recipes.json", import.meta.url), "utf8")) as ExportData;
const adaptations = JSON.parse(readFileSync(new URL("../data/adaptations.json", import.meta.url), "utf8")) as AdaptationData;
const machineByType = JSON.parse(readFileSync(new URL("../data/machines.json", import.meta.url), "utf8")) as MachineData;

const recipesById = new Map<string, Recipe>();
const unresolvedRecipes: UnresolvedRecipe[] = [];
for (const entry of exported.recipes) {
  if (entry.active === false) continue;
  const recipe = normalizeRecipe(entry.id, entry.recipe, entry.source, entry.active === null);
  if (!recipe) {
    unresolvedRecipes.push({
      id: entry.id,
      type: String(entry.recipe.type ?? "unknown"),
      source: entry.source,
      reason: "recipe JSON does not declare its output",
    });
    continue;
  }
  recipesById.set(recipe.id, recipe);
  for (const adaptation of adaptations[entry.recipe.type] ?? []) {
    if (!matchesFilter(recipe, entry.recipe, adaptation.filter)) continue;
    const adaptedId = `createrate:adaptation/${adaptation.method}/${recipe.id.replace(":", "/")}`;
    recipesById.set(adaptedId, {
      ...recipe,
      id: adaptedId,
      adaptedFrom: recipe.id,
      method: adaptation.method,
      machine: adaptation.machine,
      durationTicks: undefined,
      compatibilityConfig: adaptation.config,
    });
  }
}
const recipes = [...recipesById.values()];

export function findRecipesProducing(item: string): Recipe[] {
  const key = resourceKey({ type: "item", id: item.startsWith("item:") ? item.slice(5) : item });
  return recipes.filter((recipe) => recipe.outputs.some((output) => resourceKey(output.resource) === key));
}

export function findRecipe(id: string): Recipe | undefined {
  return recipesById.get(id);
}

export function listRecipes(): Recipe[] {
  return recipes;
}

export function listResourceTags(): { itemTags: Record<string, string[]>; fluidTags: Record<string, string[]> } {
  return { itemTags: exported.itemTags ?? {}, fluidTags: exported.fluidTags ?? {} };
}

export function listUnresolvedRecipes(): UnresolvedRecipe[] {
  return unresolvedRecipes;
}

export function recipeSetVersion(): string {
  return `Minecraft ${exported.minecraftVersion ?? "unknown"}, Create ${exported.createVersion ?? "unknown"}`;
}

export function resourceKey(resource: Pick<Ingredient, "type" | "id">): string {
  return `${resource.type}:${resource.id}`;
}

function normalizeRecipe(id: string, raw: RawRecipe, source?: string, conditional = false): Recipe | undefined {
  const outputs = parseOutputs(raw);
  // shortcut: recipes without a directly declared result stay out of item-output queries.
  if (outputs.length === 0) return undefined;

  const primary = outputs[0];
  const method = String(raw.type ?? "unknown").split(":").at(-1)!;
  const machine = machineByType[raw.type];
  const durationTicks = number(raw.processingTime ?? raw.cookingtime);
  const loops = number(raw.loops);
  const sequence = parseSequence(raw.sequence);

  return {
    id,
    source,
    conditional,
    output: primary.resource,
    outputAmount: primary.amount * (primary.chance ?? 1),
    outputs,
    method,
    machine,
    heatRequirement: raw.heatRequirement ?? raw.heat_requirement,
    durationTicks,
    machineUnits: raw.type === "create:mechanical_crafting" ? patternUnits(raw.pattern) : undefined,
    inputs: sequence ? parseSequencedInputs(raw, sequence, loops ?? 1) : parseInputs(raw),
    loops,
    sequence,
  };
}

function parseOutputs(raw: RawRecipe): RecipeOutput[] {
  const entries = Array.isArray(raw.results) ? raw.results : raw.result === undefined ? [] : [raw.result];
  return entries.flatMap((entry: unknown) => {
    const resource = parseResource(entry);
    if (!resource) return [];
    const rawAmount = number((entry as RawRecipe).count ?? (entry as RawRecipe).amount ?? (entry as RawRecipe)["railways:amount"] ?? raw.count) ?? 1;
    const amount = normalizeFluidAmount(rawAmount, resource.type);
    const chance = number((entry as RawRecipe).chance);
    return [{ resource, amount, ...(chance === undefined ? {} : { chance }) }];
  });
}

function parseInputs(raw: RawRecipe): Ingredient[] {
  const counted = new Map<string, Ingredient>();
  const add = (entry: unknown) => {
    const resource = parseResource(entry);
    if (!resource) return;
    const rawAmount = entry && typeof entry === "object"
      ? (entry as RawRecipe).amount ?? (entry as RawRecipe).count ?? (entry as RawRecipe)["railways:amount"]
      : undefined;
    const amount = normalizeFluidAmount(number(rawAmount) ?? 1, resource.type);
    const key = resourceKey(resource);
    const current = counted.get(key);
    if (current) current.amount += amount;
    else counted.set(key, { ...resource, amount });
  };

  if (Array.isArray(raw.pattern) && raw.key && typeof raw.key === "object") {
    const counts = new Map<string, number>();
    for (const row of raw.pattern) {
      for (const symbol of String(row)) {
        if (symbol !== " ") counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
      }
    }
    for (const [symbol, amount] of counts) {
      const ingredient = raw.key[symbol];
      for (let copy = 0; copy < amount; copy++) add(ingredient);
    }
  } else {
    const entries = Array.isArray(raw.ingredients) ? raw.ingredients
      : raw.ingredient !== undefined ? [raw.ingredient]
      : [raw.template, raw.base, raw.addition].filter((entry) => entry !== undefined);
    for (const entry of entries) add(entry);
  }

  return [...counted.values()];
}

function normalizeFluidAmount(amount: number, type: "item" | "fluid"): number {
  return type === "fluid" ? amount / (exported.fluidUnitsPerMillibucket ?? 1) : amount;
}

function parseResource(value: unknown): Omit<Ingredient, "amount"> | undefined {
  if (Array.isArray(value)) {
    const choices = value.flatMap((entry) => {
      const resource = parseResource(entry);
      return resource ? resource.alternatives ?? [resource.id] : [];
    });
    const alternatives = [...new Set(choices)];
    if (alternatives.length === 0) return undefined;
    return { type: "item", id: alternatives.join(" or "), alternatives };
  }
  if (typeof value === "string") return { type: "item", id: value };
  if (!value || typeof value !== "object") return undefined;

  const raw = value as RawRecipe;
  if (typeof raw.item === "string") return { type: "item", id: raw.item };
  if (typeof raw.tag === "string") return resourceFromTag("item", raw.tag, exported.itemTags);
  if (typeof raw.fluid === "string") return { type: "fluid", id: raw.fluid };
  if (typeof raw.fluidTag === "string") return resourceFromTag("fluid", raw.fluidTag, exported.fluidTags);
  return undefined;
}

function resourceFromTag(type: "item" | "fluid", tag: string, tags: Record<string, string[]> | undefined) {
  const alternatives = tags?.[tag];
  return alternatives?.length === 1
    ? { type, id: alternatives[0], alternatives }
    : { type, id: `#${tag}`, alternatives };
}

function number(value: unknown): number | undefined {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function matchesFilter(recipe: Recipe, raw: RawRecipe, filter: Adaptation["filter"]): boolean {
  if (!filter) return true;
  if (filter !== "single_ingredient_square" || recipe.inputs.length !== 1) return false;
  const rows = raw.pattern as unknown[] | undefined;
  if (!rows?.length || !rows.every((row) => typeof row === "string")) return false;
  const width = Math.max(...rows.map((row) => String(row).length));
  const height = rows.length;
  return width === height && (width === 2 || width === 3) && recipe.inputs[0].amount === width * height;
}

function patternUnits(pattern: unknown): number | undefined {
  if (!Array.isArray(pattern)) return undefined;
  const units = pattern.reduce((sum, row) => sum + [...String(row)].filter((symbol) => symbol !== " ").length, 0);
  return units > 0 ? units : undefined;
}

function parseSequence(value: unknown): RecipeStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw: RawRecipe) => ({
    method: String(raw.type ?? "unknown").split(":").at(-1)!,
    machine: machineByType[raw.type],
    inputs: parseInputs(raw),
    outputs: parseOutputs(raw),
  }));
}

function parseSequencedInputs(raw: RawRecipe, sequence: RecipeStep[], loops: number): Ingredient[] {
  const counted = new Map<string, Ingredient>();
  const add = (input: Ingredient, multiplier: number) => {
    const key = resourceKey(input);
    const current = counted.get(key);
    if (current) current.amount += input.amount * multiplier;
    else counted.set(key, { ...input, amount: input.amount * multiplier });
  };

  for (const input of parseInputs({ ingredient: raw.ingredient })) add(input, 1);
  const transitional = parseResource(raw.transitionalItem);
  const transitionalKey = transitional && resourceKey(transitional);
  for (const step of sequence) {
    for (const input of step.inputs) {
      if (transitionalKey && resourceKey(input) === transitionalKey) continue;
      add(input, loops);
    }
  }
  return [...counted.values()];
}
