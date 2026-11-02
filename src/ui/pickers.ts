import type { Resource } from "../plant.ts";
import type { Recipe } from "../recipes.ts";

type Dependencies = {
  getRecipes: () => Recipe[];
  getItems: () => Resource[];
  getItemIcon: (id: string) => string | undefined;
  addItem: (kind: "supply" | "demand", item: Resource, position: { x: number; y: number }) => void;
  setStatus: (message: string) => void;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function createPickers(dependencies: Dependencies) {
  let recipeAction: ((recipe: Recipe) => void) | undefined;
  let recipeOptions: Recipe[] = [];
  let recipeLimit = 100;
  let itemPosition = { x: 0, y: 0 };
  let itemLimit = 100;

  $("#recipe-search").addEventListener("input", () => { recipeLimit = 100; renderRecipes(); });
  $("#item-search").addEventListener("input", () => { itemLimit = 100; renderItems(); });
  $("#item-options").addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-item-kind]");
    if (!button) return;
    const item = dependencies.getItems().find(({ id }) => id === button.dataset.itemId);
    if (!item) return;
    $("#item-picker").close();
    dependencies.addItem(button.dataset.itemKind as "supply" | "demand", item, itemPosition);
  });

  return { openRecipePicker, openItemPicker };

  function openRecipePicker(title: string, options: Recipe[], action: (recipe: Recipe) => void) {
    $("#picker-title").textContent = title;
    recipeAction = action;
    recipeOptions = options;
    recipeLimit = 100;
    $("#recipe-search").value = "";
    renderRecipes();
    $("#recipe-picker").showModal();
    $("#recipe-search").focus();
  }

  function openItemPicker(position: { x: number; y: number }) {
    itemPosition = position;
    itemLimit = 100;
    $("#item-search").value = "";
    renderItems();
    $("#item-picker").showModal();
    $("#item-search").focus();
  }

  function renderItems() {
    const query = $("#item-search").value.trim().toLowerCase();
    const matching = dependencies.getItems().filter((item) => `${item.id} ${short(item.id)}`.toLowerCase().includes(query));
    const list = matching.slice(0, itemLimit);
    $("#item-options").innerHTML = list.map((item) =>
      `<div class="item-option">${dependencies.getItemIcon(item.id) ? `<img src="${esc(dependencies.getItemIcon(item.id)!)}" alt="" loading="lazy">` : `<span class="item-icon-fallback">${esc(icon(item.id))}</span>`}<span>${esc(item.id)}</span><button type="button" data-item-kind="supply" data-item-id="${esc(item.id)}">Source</button><button type="button" data-item-kind="demand" data-item-id="${esc(item.id)}">Sink</button></div>`
    ).join("") || `<p>No matching items</p>`;
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
    $("#recipe-options").innerHTML = list.map((recipe) => `<button class="recipe-option" type="button" data-recipe="${esc(recipe.id)}"><span>${esc(recipe.id)}</span><small>${esc(recipe.method)}${recipe.machine ? ` · ${esc(recipe.machine)}` : ""} · ${recipe.inputs.length} inputs</small></button>`).join("") || `<p>No matching recipes</p>`;
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
}

function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function short(id: string): string { return id.split(":").at(-1)!.replaceAll("_", " "); }
function icon(id: string): string { return short(id).split(/[- _]/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
