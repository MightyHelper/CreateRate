import { constraintTargetsFor, constraintUnit, isDiscretePlantQuantity, replacePlantConstraints, samePlantQuantity, savePlantConstraintSet } from "../core/index.ts";
import type { Plant, PlantComponent, PlantQuantityRef, Resource } from "../plant.ts";
import type { Recipe } from "../recipes.ts";

type Dependencies = {
  getPlant: () => Plant;
  setPlant: (plant: Plant) => void;
  getRecipe: (id: string) => Recipe | undefined;
  save: () => void;
  render: () => void;
  setStatus: (message: string) => void;
  nextId: (prefix: string) => string;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function createConstraintUi(dependencies: Dependencies) {
  let editingTarget: PlantQuantityRef | undefined;

  $("#selection-controls").addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-constraint-target]");
    if (!button) return;
    try { open(JSON.parse(button.dataset.constraintTarget!) as PlantQuantityRef); }
    catch { dependencies.setStatus("Could not open constraint editor"); }
  });
  $("#plant-canvas").addEventListener("click", (event) => {
    const target = (event.target as Element).closest<SVGElement>("[data-constraint-target]");
    if (!target) return;
    try { open(JSON.parse(target.dataset.constraintTarget!) as PlantQuantityRef); }
    catch { dependencies.setStatus("Could not open constraint editor"); }
  });
  $("#constraint-apply").addEventListener("click", save);
  $("#constraint-clear").addEventListener("click", clear);
  $("#constraint-close").addEventListener("click", () => { editingTarget = undefined; $("#constraint-editor").close(); });
  $("#constraint-form").addEventListener("submit", (event) => { event.preventDefault(); save(); });

  return { controlsFor, controlFor: constraintControl, open, save, clear };

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
      return [`${symbol} ${constraint.value} ${unit}`];
    });
    if (!constraints.some(({ kind }) => kind === "bound")) parts.unshift(`? ${unit}`);
    if (isDiscretePlantQuantity(target) && !constraints.some(({ kind }) => kind === "integer")) parts.push("integer");
    return parts.join(", ") || `? ${unit}`;
  }

  function open(target: PlantQuantityRef) {
    editingTarget = target;
    const current = dependencies.getPlant().constraints.filter((constraint) => samePlantQuantity(constraint.target, target));
    const valueFor = (relation: "equals" | "at-least" | "at-most") => current.find((constraint) => constraint.kind === "bound" && constraint.relation === relation)?.value;
    setNumberInput("#constraint-equals", valueFor("equals"));
    setNumberInput("#constraint-minimum", valueFor("at-least"));
    setNumberInput("#constraint-maximum", valueFor("at-most"));
    const integer = current.some(({ kind }) => kind === "integer") || isDiscretePlantQuantity(target);
    $("#constraint-integer").checked = integer;
    $("#constraint-integer").disabled = isDiscretePlantQuantity(target);
    $("#constraint-power-two").checked = current.some(({ kind }) => kind === "power-of-two");
    const unit = constraintUnit(target, dependencies.getPlant());
    for (const selector of ["#constraint-unit-equals", "#constraint-unit-minimum", "#constraint-unit-maximum"]) $(selector).textContent = unit;
    $("#constraint-title").textContent = constraintTitle(target);
    $("#constraint-error").hidden = true;
    $("#constraint-clear").disabled = current.length === 0;
    $("#constraint-editor").showModal();
    $("#constraint-equals").focus();
  }

  function save() {
    if (!editingTarget) return;
    try {
      const exact = readNumberInput("#constraint-equals");
      const minimum = readNumberInput("#constraint-minimum");
      const maximum = readNumberInput("#constraint-maximum");
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

}

function rateUnit(resource: Resource): string { return resource.type === "fluid" ? "mB/min" : "items/min"; }

function constraintTitle(target: PlantQuantityRef): string {
  if (target.kind === "rpm") return "Set RPM constraint";
  if (target.kind === "machine-count") return "Set machine-count constraint";
  if (target.kind === "stack-size") return "Set stack-size constraint";
  if (target.kind === "stress") return "Set stress-usage constraint";
  if (target.kind === "connection-rate") return "Set flow-rate constraint";
  return `Set ${target.port.direction} rate constraint`;
}

function setNumberInput(selector: string, value: number | undefined) { $(selector).value = value === undefined ? "" : String(value); }
function readNumberInput(selector: string): number | undefined {
  const raw = $(selector).value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("Values must be finite and non-negative");
  return value;
}
function short(id: string): string { return id.split(":").at(-1)!.replaceAll("_", " "); }

function controlLabel(component: PlantComponent, target: PlantQuantityRef): string {
  if (target.kind === "rpm") return "RPM";
  if (target.kind === "machine-count") return "Machines";
  if (target.kind === "stack-size") return "Input stack";
  if (target.kind === "stress") return "Stress";
  if (target.kind !== "port-rate") return "Flow rate";
  if (component.kind !== "process") return `${component.kind === "supply" ? "Supply" : "Demand"} rate`;
  return `${target.port.direction === "input" ? "Input" : "Output"} ${short(target.port.resource.id)}`;
}
function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
