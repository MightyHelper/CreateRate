import { strict as assert } from "node:assert";
import { collectRecipeItems } from "../src/recipe-queries.ts";
import type { Recipe } from "../src/recipes.ts";

const recipe = { inputs: [{ type: "fluid", id: "#liquids", alternatives: ["shared", "fluid:oil"], amount: 1 }, { type: "item", id: "shared", amount: 1 }], output: { type: "fluid", id: "fluid:output" }, outputAmount: 1, outputs: [] } as Recipe;
const resources = collectRecipeItems([recipe], { items: ["item:tagged"] }, { liquids: ["fluid:tagged"] });
assert.deepEqual(new Set(resources.map(({ type, id }) => `${type}:${id}`)), new Set(["fluid:shared", "fluid:fluid:oil", "item:shared", "fluid:fluid:output", "item:item:tagged", "fluid:fluid:tagged"]));

const elements = new Map<string, any>();
const element = (selector: string) => {
  if (!elements.has(selector)) elements.set(selector, { handlers: {} as Record<string, (event: any) => void>, addEventListener(name: string, handler: (event: any) => void) { this.handlers[name] = handler; }, showModal() {}, close() {}, focus() {}, innerHTML: "", value: "" });
  return elements.get(selector);
};
(globalThis as any).document = { querySelector: element };
const { createPickers } = await import("../src/ui/pickers.ts");
let picked: { type: string; id: string } | undefined;
const pickers = createPickers({ getRecipes: () => [], getItems: () => resources, renderResourceIcon: () => undefined, renderRecipePreview: () => "", addItem: (_kind, item) => { picked = item; }, setStatus: () => {} });
pickers.openItemPicker({ x: 0, y: 0 }, resources);
assert.match(element("#item-options").innerHTML, /data-item-type="fluid" data-item-id="shared"/);
element("#item-options").handlers.click({ target: { closest: () => ({ dataset: { itemKind: "supply", itemType: "fluid", itemId: "shared" } }) } });
assert.deepEqual(picked, { type: "fluid", id: "shared" });

const displayChoice = { type: "item" as const, id: "item:iron or item:gold", alternatives: ["item:iron", "item:gold"], amount: 1 };
const choiceRecipe = { ...recipe, inputs: [displayChoice, { type: "item" as const, id: "item:single", alternatives: ["item:single"], amount: 1 }] };
const choices = collectRecipeItems([choiceRecipe], {}, {});
assert.ok(!choices.some(({ id }) => id === displayChoice.id));
assert.ok(choices.some(({ id }) => id === "item:iron"));
assert.ok(choices.some(({ id }) => id === "item:gold"));
assert.ok(choices.some(({ id }) => id === "item:single"));

const paintVariants = ["yellow", "green"].map((Color) => ({ type: "fluid" as const, id: "railways:paint", nbt: { Color } }));
pickers.openItemPicker({ x: 0, y: 0 }, paintVariants);
assert.match(element("#item-options").innerHTML, /yellow/);
assert.match(element("#item-options").innerHTML, /green/);
const { resourceKey } = await import("../src/plant.ts");
element("#item-options").handlers.click({ target: { closest: () => ({ dataset: { itemKind: "supply", itemType: "fluid", itemId: "railways:paint", itemKey: resourceKey(paintVariants[1]) } }) } });
assert.deepEqual(picked, paintVariants[1]);
