import type { Resource } from "../plant.ts";
import type { Ingredient } from "../recipes.ts";
import type { Recipe } from "../recipes.ts";
import { recipeOutputPorts } from "../recipe-queries.ts";
import { tagAttributes } from "./canvas.ts";

type Dependencies = {
  getRecipes: () => Recipe[];
  getItems: () => Resource[];
  renderResourceIcon: (resource: Pick<Ingredient, "type" | "id" | "alternatives">) => string | undefined;
  renderRecipePreview: (recipe: Recipe) => string;
  addItem: (kind: "supply" | "demand" | "pool", item: Resource, position: { x: number; y: number }) => void;
  setStatus: (message: string) => void;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function createPickers(dependencies: Dependencies) {
  let recipeAction: ((recipe: Recipe) => void) | undefined;
  let recipeOptions: Recipe[] = [];
  let recipeLimit = 100;
  let itemPosition = { x: 0, y: 0 };
  let itemOptions: Resource[] = [];
  let itemKinds: readonly ("supply" | "demand" | "pool")[] = ["supply", "demand", "pool"];
  let itemLimit = 100;

  $("#recipe-search").addEventListener("input", () => { recipeLimit = 100; renderRecipes(); });
  $("#recipe-options").addEventListener("pointerover", previewRecipeFromEvent);
  $("#recipe-options").addEventListener("focusin", previewRecipeFromEvent);
  $("#item-search").addEventListener("input", () => { itemLimit = 100; renderItems(); });
  $("#item-options").addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-item-kind]");
    if (!button) return;
    const item = dependencies.getItems().find(({ id }) => id === button.dataset.itemId);
    if (!item) return;
    $("#item-picker").close();
    dependencies.addItem(button.dataset.itemKind as "supply" | "demand" | "pool", item, itemPosition);
  });

  return { openRecipePicker, openItemPicker };

  function openRecipePicker(title: string, options: Recipe[], action: (recipe: Recipe) => void) {
    $("#picker-title").textContent = title;
    recipeAction = action;
    recipeOptions = options;
    recipeLimit = 100;
    $("#recipe-search").value = "";
    $("#recipe-preview").innerHTML = "<p>Hover or focus a recipe to preview it.</p>";
    renderRecipes();
    $("#recipe-picker").showModal();
    $("#recipe-search").focus();
  }

  function openItemPicker(
    position: { x: number; y: number },
    options = dependencies.getItems(),
    allowedKinds: readonly ("supply" | "demand" | "pool")[] = ["supply", "demand", "pool"],
  ) {
    itemPosition = position;
    itemOptions = options;
    itemKinds = allowedKinds;
    itemLimit = 100;
    $("#item-search").value = "";
    renderItems();
    $("#item-picker").showModal();
    $("#item-search").focus();
  }

  function renderItems() {
    const query = $("#item-search").value.trim().toLowerCase();
    const matching = itemOptions.filter((item) => `${item.id} ${short(item.id)}`.toLowerCase().includes(query));
    const list = matching.slice(0, itemLimit);
    $("#item-options").innerHTML = list.map((item) => {
      const rendered = dependencies.renderResourceIcon(item);
      const iconMarkup = rendered
        ? `<svg class="item-option-icon" viewBox="0 0 28 28" aria-hidden="true">${rendered}</svg>`
        : `<span class="item-icon-fallback">${esc(icon(item.id))}</span>`;
      const labels = { supply: "Source", demand: "Sink", pool: "Pool" };
      return `<div class="item-option">${iconMarkup}<span>${esc(item.id)}</span>${itemKinds.map((kind) => `<button type="button" data-item-kind="${kind}" data-item-id="${esc(item.id)}">${labels[kind]}</button>`).join("")}</div>`;
    }).join("") || `<p>No matching items</p>`;
    if (matching.length > itemLimit) {
      const more = document.createElement("button");
      more.type = "button"; more.className = "recipe-option recipe-more";
      more.textContent = `Load more (${matching.length - itemLimit} remaining)`;
      more.addEventListener("click", () => { itemLimit += 100; renderItems(); });
      $("#item-options").append(more);
    }
  }

  function renderRecipes() {
    const terms = $("#recipe-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matching = recipeOptions.filter((recipe) => {
      const text = `${recipe.id} ${recipe.method} ${recipe.method === "splashing" ? "washing" : ""} ${recipe.machine ?? ""} ${recipe.inputs.map((input) => input.id).join(" ")} ${(recipe.outputs ?? [{ resource: recipe.output, amount: recipe.outputAmount }]).map((output) => output.resource.id).join(" ")}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    const list = matching.slice(0, recipeLimit);
    $("#recipe-options").innerHTML = list.map((recipe) => {
      const outputs = recipeOutputPorts(recipe);
      const inputIcons = recipe.inputs.map((resource) => dependencies.renderResourceIcon(resource));
      const outputIcons = outputs.map(({ resource }) => dependencies.renderResourceIcon(resource));
      const iconMarkup = (resource: Resource, rendered: string | undefined) => {
        const tagData = tagAttributes(resource);
        return rendered
          ? `<svg class="recipe-option-resource-icon" ${tagData} viewBox="0 0 28 28" role="img" aria-label="${esc(resource.id)}" title="${esc(resource.id)}">${rendered}</svg>`
          : `<span class="recipe-option-icon-fallback" ${tagData} title="${esc(resource.id)}">${esc(icon(resource.id))}</span>`;
      };
      const minHeight = Math.max(64, Math.max(Math.ceil(inputIcons.length / 2), Math.ceil(outputIcons.length / 2)) * 30 + 20);
      return `<button class="recipe-option" style="min-height:${minHeight}px" type="button" data-recipe="${esc(recipe.id)}"><span class="recipe-option-input-icons">${recipe.inputs.map((resource, index) => iconMarkup(resource, inputIcons[index])).join("")}</span><span class="recipe-option-copy"><span>${esc(recipe.id)}</span><small>${esc(recipe.method)}${recipe.machine ? ` · ${esc(recipe.machine)}` : ""} · ${recipe.inputs.length} inputs</small></span><span class="recipe-option-output-icons">${outputs.map(({ resource }, index) => iconMarkup(resource, outputIcons[index])).join("")}</span></button>`;
    }).join("") || `<p>No matching recipes</p>`;
    $("#recipe-options").querySelectorAll<HTMLButtonElement>("[data-recipe]").forEach((button) => button.addEventListener("click", () => {
      const recipe = recipeOptions.find(({ id }) => id === button.dataset.recipe);
      $("#recipe-picker").close();
      try {
        if (recipe) recipeAction?.(recipe);
        else dependencies.setStatus("Selected recipe is no longer available");
      } catch (error) {
        dependencies.setStatus(error instanceof Error ? `Could not add recipe: ${error.message}` : "Could not add recipe");
        console.error("Could not add selected recipe", error);
      }
    }));
    if (matching.length > recipeLimit) {
      const more = document.createElement("button");
      more.type = "button"; more.className = "recipe-option recipe-more";
      more.textContent = `Load more (${matching.length - recipeLimit} remaining)`;
      more.addEventListener("click", () => { recipeLimit += 100; renderRecipes(); });
      $("#recipe-options").append(more);
    }
  }

  function previewRecipeFromEvent(event: Event) {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-recipe]");
    if (!button) return;
    const recipe = recipeOptions.find(({ id }) => id === button.dataset.recipe);
    if (recipe) $("#recipe-preview").innerHTML = dependencies.renderRecipePreview(recipe);
  }
}

function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function short(id: string): string { return id.split(":").at(-1)!.replaceAll("_", " "); }
function icon(id: string): string { return short(id).split(/[- _]/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
