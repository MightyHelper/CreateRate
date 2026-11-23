import { strict as assert } from "node:assert";
import { renderCanvas } from "../src/ui/canvas.ts";
import type { CanvasState } from "../src/ui/canvas.ts";
const resource = { type: "item" as const, id: "iron" };
const node = () => ({ innerHTML: "", setAttribute() {}, hidden: false });
const world = node(), preview = node(), grid = node(), hint = node();
(globalThis as any).document = { querySelector: (selector: string) => selector === "#grid" ? grid : hint };
const state = { plant: { id: "plant", components: [{ id: "same", kind: "supply", resource }, { id: "sink", kind: "demand", resource }], connections: [{ id: "same", from: { componentId: "same", direction: "output", resource }, to: { componentId: "sink", direction: "input", resource } }], constraints: [] }, world, interactionPreview: preview, positions: {}, view: { x: 0, y: 0, scale: 1 }, selected: "same", selectedIds: new Set<string>(), recipesById: new Map(), itemIcons: {}, itemModelIds: {}, itemModels: {}, itemAnimations: {}, portOrder: {}, rateDisplayUnits: { amount: "items", period: "minute" } } as unknown as CanvasState;
renderCanvas(state);
assert.match(world.innerHTML, /class="edge-group selected"/);
assert.doesNotMatch(world.innerHTML, /class="resource selected"/);
state.selectedIds.add("same");
renderCanvas(state);
assert.match(world.innerHTML, /class="resource selected"/);
assert.doesNotMatch(world.innerHTML, /class="edge-group selected"/);

const { resolveCanvasPort } = await import("../src/ui/canvas.ts");
const { ingredientConnectionAccepts } = await import("../src/recipe-queries.ts");
const ingredient = { type: "item" as const, id: "#ingots", alternatives: ["iron", "gold"], amount: 1 };
const recipe = { id: "r", inputs: [ingredient], output: ingredient, outputAmount: 1, outputs: [{ resource: ingredient, amount: 1 }] };
const graph = { id: "p", components: [{ id: "process", kind: "process" as const, recipeId: "r" }, { id: "pool", kind: "pool" as const, resource: ingredient }], connections: [], constraints: [] };
const catalog = new Map([["r", recipe as never]]);
for (const direction of ["input", "output"] as const) {
  const port = resolveCanvasPort(graph, catalog, { component: "process", port: direction, resource: "item:#ingots" });
  assert.deepEqual(port.resource.alternatives, ["iron", "gold"]);
}
const inputPort = resolveCanvasPort(graph, catalog, { component: "process", port: "input", resource: "item:#ingots" });
assert.equal(ingredientConnectionAccepts(recipe.inputs, inputPort.resource, { type: "item", id: "iron" }), true);
assert.equal(ingredientConnectionAccepts(recipe.inputs, inputPort.resource, { type: "item", id: "copper" }), false);
assert.deepEqual(resolveCanvasPort(graph, catalog, { component: "pool", port: "output", resource: "item:#ingots" }).resource.alternatives, ["iron", "gold"]);
assert.throws(() => resolveCanvasPort(graph, catalog, { component: "process", port: "input", resource: "item:missing" }), /Unknown canvas port/);

const { canonicalizePortOrder, orderedPorts } = await import("../src/ui/canvas.ts");
const savedOrder = { p: { input: ["item:#one", "item:gold", "item:iron", "item:#many", "fluid:#water", "item:#unknown"] } };
const normalizedOrder = canonicalizePortOrder(savedOrder, { one: ["iron"], many: ["a", "b"] }, { water: ["minecraft:water"] });
assert.deepEqual(normalizedOrder.p.input, ["item:iron", "item:gold", "item:#many", "fluid:minecraft:water", "item:#unknown"]);
assert.deepEqual(orderedPorts(normalizedOrder, "p", "input", [{ type: "item", id: "gold" }, { type: "item", id: "iron" }]).map(({ id }) => id), ["iron", "gold"]);
assert.equal(savedOrder.p.input[0], "item:#one");
for (const id of ["constructor", "toString", "__proto__"]) {
  assert.deepEqual(canonicalizePortOrder({ p: { input: [`item:#${id}`] } }, {}, {}).p.input, [`item:#${id}`]);
}
