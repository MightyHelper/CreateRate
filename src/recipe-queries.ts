import type { Ingredient, Recipe, RecipeOutput, TextureAnimation, MachineLayoutRules, MachineModel } from "./recipes.ts";
import type { Plant, Resource } from "./plant.ts";
import { resourceKey } from "./plant.ts";

export type RecipeCatalog = { recipes: Recipe[]; itemTags: Record<string, string[]>; fluidTags: Record<string, string[]>; itemIcons: Record<string, string>; itemAnimations: Record<string, TextureAnimation>; machineModelIds: Record<string, string>; machineModels: Record<string, MachineModel>; machineLayoutRules: MachineLayoutRules };

export async function loadBrowserRecipeCatalog(): Promise<RecipeCatalog> {
  const response = await fetch("/build/browser-recipes.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Recipe catalog request failed: ${response.status}`);
  const data = await response.json() as Recipe[] | Partial<RecipeCatalog>;
  const catalog: RecipeCatalog = Array.isArray(data)
    ? { recipes: data, itemTags: {}, fluidTags: {}, itemIcons: {}, itemAnimations: {}, machineModelIds: {}, machineModels: {}, machineLayoutRules: { blockStep: 16, basinMethods: [], basinModel: "", heaterModels: {} } }
    : { recipes: data.recipes ?? [], itemTags: data.itemTags ?? {}, fluidTags: data.fluidTags ?? {}, itemIcons: data.itemIcons ?? {}, itemAnimations: data.itemAnimations ?? {}, machineModelIds: data.machineModelIds ?? {}, machineModels: data.machineModels ?? {}, machineLayoutRules: data.machineLayoutRules ?? { blockStep: 16, basinMethods: [], basinModel: "", heaterModels: {} } };
  return {
    ...catalog,
    itemIcons: Object.fromEntries(Object.entries(catalog.itemIcons).map(([id, path]) => [id, new URL(path, location.origin).href])),
  };
}

export function recipeOutputs(recipe?: Recipe): RecipeOutput[] {
  return recipe?.outputs?.length ? recipe.outputs : recipe ? [{ resource: recipe.output, amount: recipe.outputAmount }] : [];
}

export function resourcesMatch(a: Pick<Ingredient, "type" | "id" | "alternatives">, b: Pick<Ingredient, "type" | "id" | "alternatives">, itemTags: Record<string, string[]>, fluidTags: Record<string, string[]>): boolean {
  if (a.type !== b.type) return false;
  const values = (resource: typeof a) => {
    const tags = resource.type === "fluid" ? fluidTags : itemTags;
    return new Set([resource.id, ...(resource.alternatives ?? []), ...(resource.id.startsWith("#") ? tags[resource.id.slice(1)] ?? [] : [])]);
  };
  const left = values(a);
  return [...values(b)].some((value) => left.has(value));
}

export function collectRecipeItems(recipes: Recipe[], itemTags: Record<string, string[]>): Resource[] {
  const items = new Map<string, Resource>();
  const add = (resource: Pick<Ingredient, "type" | "id">) => {
    if (resource.type === "item" && !resource.id.startsWith("#")) items.set(resourceKey(resource), { type: resource.type, id: resource.id });
  };
  for (const recipe of recipes) {
    recipe.inputs.forEach(add);
    recipeOutputs(recipe).forEach(({ resource }) => add(resource));
  }
  for (const members of Object.values(itemTags)) members.forEach((id) => add({ type: "item", id }));
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function canonicalizePlantResources(plant: Plant, itemTags: Record<string, string[]>, fluidTags: Record<string, string[]>): Plant {
  const canonical = (resource: Resource): Resource => {
    if (!resource.id.startsWith("#")) return resource;
    const members = (resource.type === "fluid" ? fluidTags : itemTags)[resource.id.slice(1)];
    return members?.length === 1 ? { ...resource, id: members[0] } : resource;
  };
  return {
    ...plant,
    components: plant.components.map((component) => component.kind === "process" ? component : { ...component, resource: canonical(component.resource) }),
    connections: plant.connections.map((edge) => ({ ...edge, from: { ...edge.from, resource: canonical(edge.from.resource) }, to: { ...edge.to, resource: canonical(edge.to.resource) } })),
    constraints: plant.constraints.map((constraint) => constraint.target.kind === "port-rate"
      ? { ...constraint, target: { ...constraint.target, port: { ...constraint.target.port, resource: canonical(constraint.target.port.resource) } } }
      : constraint),
  };
}
