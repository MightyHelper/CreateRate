import { constraintTargetsFor, constraintUnit, displayToPerMinuteRate, isDiscretePlantQuantity, normalizeRateDisplayUnits, perMinuteToDisplayRate, rateDisplayUnit, ratePeriods, replacePlantConstraints, samePlantQuantity, savePlantConstraintSet } from "../core/index.ts";
import type { Plant, PlantComponent, PlantQuantityRef, Resource } from "../plant.ts";
import type { Recipe } from "../recipes.ts";
import { getRateDisplayUnits, setRateDisplayUnits } from "./rate-display.ts";

type Dependencies = {
  getPlant: () => Plant;
  setPlant: (plant: Plant) => void;
  getRecipe: (id: string) => Recipe | undefined;
  save: () => void;
  render: () => void;
  setStatus: (message: string) => void;
  nextId: (prefix: string) => string;
  dispatchGesture: (target: PlantQuantityRef) => void;
  closeDialog: () => void;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function createConstraintUi(dependencies: Dependencies) {
  let editingTarget: PlantQuantityRef | undefined;
  let editingResource: Resource | undefined;
  const amountSelect = $("#constraint-amount-unit");
  const periodSelect = $("#constraint-period-unit");
  amountSelect.innerHTML = '<option value="items">items</option><option value="stacks">stacks</option>';
  periodSelect.innerHTML = ratePeriods().map(({ id, label }) => `<option value="${id}">${esc(label)}</option>`).join("");

  $("#selection-controls").addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-constraint-target]");
    if (!button) return;
    try { dependencies.dispatchGesture(JSON.parse(button.dataset.constraintTarget!) as PlantQuantityRef); }
    catch { dependencies.setStatus("Could not open constraint editor"); }
  });
  $("#plant-canvas").addEventListener("click", (event) => {
    const target = (event.target as Element).closest<SVGElement>("[data-constraint-target]");
    if (!target) return;
    try { dependencies.dispatchGesture(JSON.parse(target.dataset.constraintTarget!) as PlantQuantityRef); }
    catch { dependencies.setStatus("Could not open constraint editor"); }
  });
  $("#constraint-apply").addEventListener("click", save);
  $("#constraint-clear").addEventListener("click", clear);
  $("#constraint-close").addEventListener("click", dependencies.closeDialog);
  $("#constraint-form").addEventListener("submit", (event) => { event.preventDefault(); save(); });
  amountSelect.addEventListener("change", changeRateUnits);
  periodSelect.addEventListener("change", changeRateUnits);

  return { controlsFor, controlFor: constraintControl, open, close, save, clear };

  function close() { editingTarget = undefined; $("#constraint-editor").close(); }

  function controlsFor(component: PlantComponent): string {
    return constraintTargetsFor(component, component.kind === "process" ? dependencies.getRecipe(component.recipeId) : undefined)
      .map((target) => constraintControl(target, controlLabel(component, target), constraintUnit(target, dependencies.getPlant())))
      .join("");
  }

  function constraintControl(target: PlantQuantityRef, label: string, unit: string): string {
    const constrained = dependencies.getPlant().constraints.some((constraint) => samePlantQuantity(constraint.target, target));
    return `<button type="button" class="constraint-button ${constrained ? "constrained" : "unset"}" data-constraint-target="${esc(JSON.stringify(target))}">${esc(label)} · ${esc(constraintSummary(target, unit))}</button>`;
  }

  function constraintSummary(target: PlantQuantityRef, unit: string): string {
    const constraints = dependencies.getPlant().constraints.filter((constraint) => samePlantQuantity(constraint.target, target));
    const parts = constraints.flatMap((constraint) => {
      if (constraint.kind === "integer") return ["integer"];
      if (constraint.kind === "power-of-two") return ["2ⁿ"];
      const symbol = constraint.relation === "equals" ? "=" : constraint.relation === "at-least" ? "≥" : "≤";
      const resource = targetResource(target, dependencies.getPlant());
      const value = editingValue(constraint.value, resource);
      return [`${symbol} ${formatValue(value)} ${resource ? rateDisplayUnit(resource, getRateDisplayUnits()) : unit}`];
    });
    if (!constraints.some(({ kind }) => kind === "bound")) {
      const resource = targetResource(target, dependencies.getPlant());
      parts.unshift(`? ${resource ? rateDisplayUnit(resource, getRateDisplayUnits()) : unit}`);
    }
    if (isDiscretePlantQuantity(target) && !constraints.some(({ kind }) => kind === "integer")) parts.push("integer");
    return parts.join(", ") || `? ${unit}`;
  }

  function open(target: PlantQuantityRef) {
    editingTarget = target;
    editingResource = targetResource(target, dependencies.getPlant());
    const current = dependencies.getPlant().constraints.filter((constraint) => samePlantQuantity(constraint.target, target));
    const valueFor = (relation: "equals" | "at-least" | "at-most") => current.find((constraint) => constraint.kind === "bound" && constraint.relation === relation)?.value;
    const units = getRateDisplayUnits();
    amountSelect.value = units.amount; periodSelect.value = units.period;
    $("#constraint-rate-units").hidden = !editingResource;
    $("#constraint-amount-unit").hidden = editingResource?.type === "fluid";
    $("#constraint-fluid-unit").hidden = editingResource?.type !== "fluid";
    setNumberInput("#constraint-equals", valueFor("equals"), editingResource, units);
    setNumberInput("#constraint-minimum", valueFor("at-least"), editingResource, units);
    setNumberInput("#constraint-maximum", valueFor("at-most"), editingResource, units);
    const integer = current.some(({ kind }) => kind === "integer") || isDiscretePlantQuantity(target);
    $("#constraint-integer").checked = integer;
    $("#constraint-integer").disabled = isDiscretePlantQuantity(target);
    $("#constraint-power-two").checked = current.some(({ kind }) => kind === "power-of-two");
    const unit = constraintUnit(target, dependencies.getPlant());
    const displayUnit = editingResource ? rateDisplayUnit(editingResource, units) : unit;
    for (const selector of ["#constraint-unit-equals", "#constraint-unit-minimum", "#constraint-unit-maximum"]) $(selector).textContent = displayUnit;
    $("#constraint-title").textContent = constraintTitle(target);
    $("#constraint-error").hidden = true;
    $("#constraint-clear").disabled = current.length === 0;
    $("#constraint-editor").showModal();
    $("#constraint-equals").focus();
  }

  function save() {
    if (!editingTarget) return;
    try {
      const units = getRateDisplayUnits();
      const exact = readNumberInput("#constraint-equals", editingResource, units);
      const minimum = readNumberInput("#constraint-minimum", editingResource, units);
      const maximum = readNumberInput("#constraint-maximum", editingResource, units);
      dependencies.setPlant(savePlantConstraintSet(dependencies.getPlant(), editingTarget, {
        exact, minimum, maximum, integer: $("#constraint-integer").checked, powerOfTwo: $("#constraint-power-two").checked,
      }, dependencies.nextId));
      $("#constraint-editor").close();
      dependencies.save(); dependencies.render(); dependencies.setStatus("Constraints saved"); editingTarget = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid constraint";
      $("#constraint-error").textContent = message;
      $("#constraint-error").hidden = false;
    }
  }

  function clear() {
    if (!editingTarget) return;
    dependencies.setPlant(replacePlantConstraints(dependencies.getPlant(), editingTarget, []));
    $("#constraint-editor").close();
    dependencies.save(); dependencies.render(); dependencies.setStatus("Constraints cleared"); editingTarget = undefined;
  }

  function changeRateUnits() {
    const previous = getRateDisplayUnits();
    const next = normalizeRateDisplayUnits({ amount: $("#constraint-amount-unit").value, period: $("#constraint-period-unit").value });
    if (editingResource) for (const selector of ["#constraint-equals", "#constraint-minimum", "#constraint-maximum"]) {
      const value = readNumberInput(selector, editingResource, previous);
      setNumberInput(selector, value, editingResource, next);
    }
    setRateDisplayUnits(next);
    if (editingResource) {
      const unit = rateDisplayUnit(editingResource, next);
      for (const selector of ["#constraint-unit-equals", "#constraint-unit-minimum", "#constraint-unit-maximum"]) $(selector).textContent = unit;
    }
    dependencies.render();
  }

}

function targetResource(target: PlantQuantityRef, plant: Plant): Resource | undefined {
  if (target.kind === "port-rate") return target.port.resource;
  if (target.kind !== "connection-rate") return undefined;
  return plant.connections.find(({ id }) => id === target.connectionId)?.from.resource;
}

function editingValue(value: number, resource: Resource | undefined): number {
  return resource ? perMinuteToDisplayRate(value, resource, getRateDisplayUnits()) : value;
}

function constraintTitle(target: PlantQuantityRef): string {
  if (target.kind === "rpm") return "Set RPM constraint";
  if (target.kind === "machine-count") return "Set machine-count constraint";
  if (target.kind === "stack-size") return "Set stack-size constraint";
  if (target.kind === "stress") return "Set stress-usage constraint";
  if (target.kind === "connection-rate") return "Set flow-rate constraint";
  return `Set ${target.port.direction} rate constraint`;
}

function setNumberInput(selector: string, value: number | undefined, resource?: Resource, units = getRateDisplayUnits()) { $(selector).value = value === undefined ? "" : String(resource ? perMinuteToDisplayRate(value, resource, units) : value); }
function readNumberInput(selector: string, resource?: Resource, units = getRateDisplayUnits()): number | undefined {
  const raw = $(selector).value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("Values must be finite and non-negative");
  return resource ? displayToPerMinuteRate(value, resource, units) : value;
}
function formatValue(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function short(id: string): string { return id.split(":").at(-1)!.replaceAll("_", " "); }

function controlLabel(component: PlantComponent, target: PlantQuantityRef): string {
  if (target.kind === "rpm") return "RPM";
  if (target.kind === "machine-count") return "Machines";
  if (target.kind === "stack-size") return "Input stack";
  if (target.kind === "stress") return "Stress";
  if (target.kind !== "port-rate") return "Flow rate";
  if (component.kind === "pool") return `Pool ${target.port.direction}`;
  if (component.kind !== "process") return `${component.kind === "supply" ? "Supply" : "Demand"} rate`;
  return `${target.port.direction === "input" ? "Input" : "Output"} ${short(target.port.resource.id)}`;
}
function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
