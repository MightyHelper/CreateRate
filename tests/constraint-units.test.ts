import { strict as assert } from "node:assert";
import type { Plant, PlantQuantityRef } from "../src/plant.ts";

const elements = new Map<string, any>();
function element(selector: string) {
  if (!elements.has(selector)) elements.set(selector, {
    value: "", checked: false, hidden: false, disabled: false, textContent: "", innerHTML: "",
    handlers: {} as Record<string, (event?: unknown) => void>,
    addEventListener(name: string, handler: (event?: unknown) => void) { this.handlers[name] = handler; },
    showModal() {}, close() {}, focus() {},
  });
  return elements.get(selector);
}
(globalThis as any).document = { querySelector: element };
(globalThis as any).localStorage = { getItem: () => null, setItem() {} };
const { createConstraintUi } = await import("../src/ui/constraints.ts");
const { setRateDisplayUnits } = await import("../src/ui/rate-display.ts");
const resource = { type: "item" as const, id: "minecraft:iron_ingot" };
const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: "source", direction: "output", resource } };
let plant: Plant = { id: "plant", components: [{ id: "source", kind: "supply", resource }], connections: [], constraints: [] };
let counter = 0;
const ui = createConstraintUi({
  getPlant: () => plant, setPlant: (next) => { plant = next; }, getRecipe: () => undefined,
  save() {}, render() {}, setStatus() {}, nextId: (prefix) => `${prefix}-${counter++}`,
  dispatchGesture() {}, closeDialog() {},
});

// A failure in a later field must not partially convert an earlier field.
ui.open(target);
element("#constraint-equals").value = "120";
element("#constraint-minimum").value = "-1";
element("#constraint-period-unit").value = "second";
assert.doesNotThrow(() => element("#constraint-period-unit").handlers.change());
assert.equal(element("#constraint-period-unit").value, "minute");
assert.equal(element("#constraint-equals").value, "120");
assert.equal(element("#constraint-minimum").value, "-1");
assert.equal(element("#constraint-error").hidden, false);
element("#constraint-minimum").value = "";
element("#constraint-period-unit").value = "second";
element("#constraint-period-unit").handlers.change();
assert.equal(Number(element("#constraint-equals").value), 2);
ui.save();
assert.ok(plant.constraints.some((constraint) => constraint.kind === "bound" && constraint.relation === "equals" && constraint.value === 120));

// Amount changes must provide the same atomic behavior.
setRateDisplayUnits({ amount: "items", period: "minute" });
plant = { ...plant, constraints: [] };
ui.open(target);
element("#constraint-equals").value = "128";
element("#constraint-maximum").value = "-1";
element("#constraint-amount-unit").value = "stacks";
assert.doesNotThrow(() => element("#constraint-amount-unit").handlers.change());
assert.equal(element("#constraint-amount-unit").value, "items");
assert.equal(element("#constraint-equals").value, "128");
assert.equal(element("#constraint-maximum").value, "-1");
element("#constraint-maximum").value = "";
element("#constraint-amount-unit").value = "stacks";
element("#constraint-amount-unit").handlers.change();
assert.equal(Number(element("#constraint-equals").value), 2);
ui.save();
assert.ok(plant.constraints.some((constraint) => constraint.kind === "bound" && constraint.relation === "equals" && constraint.value === 128));
