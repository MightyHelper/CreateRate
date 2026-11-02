import {
  addPlantComponent,
  addPlantConstraint,
  connectPlantPorts,
  createPlant,
  disconnectPlantPorts,
  removePlantComponent,
  removePlantConstraint,
  redirectPlantConnectionTarget,
  resourceKey,
} from "./plant.ts";
import type { Plant, PlantComponent, PlantConnection, PlantConstraint, PlantQuantityRef, Resource } from "./plant.ts";
import { analyzePlantRates } from "./plant-analysis.ts";
import type { PlantRateAnalysis, RateValue } from "./plant-analysis.ts";
import { calculateStressImpact, calculateTiming, requiredOperatingConditions, stressImpactPerMachine } from "./timing.ts";

type Recipe = {
  id: string;
  method: string;
  machine?: string;
  inputs: Array<Resource & { amount: number; alternatives?: string[] }>;
  outputs?: Array<{ resource: Resource & { alternatives?: string[] }; amount: number; chance?: number }>;
  output: Resource;
  outputAmount: number;
  machineUnits?: number;
};
type Point = { x: number; y: number };
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const svg = $("#plant-canvas");
const world = $("#world");
const interactionPreview = $("#interaction-preview");
const recipes: Recipe[] = [];
let recipesById = new Map<string, Recipe>();
let recipeSearchText = new Map<string, string>();
let itemTags: Record<string, string[]> = {};
let fluidTags: Record<string, string[]> = {};
let knownItems: Resource[] = [];
let plant: Plant = loadPlant();
let rateAnalysis: PlantRateAnalysis | undefined;
let positions: Record<string, Point> = load("positions", {});
let portOrder: Record<string, { input?: string[]; output?: string[] }> = load("port-order", {});
let view = { x: 0, y: 0, scale: 1 };
let selected = "";
let selectedIds = new Set<string>();
let pendingPort: { componentId: string; direction: "input" | "output"; resource: Resource } | undefined;
let previewPoint: Point | undefined;
let hoveredEdgeLabel: SVGTextElement | undefined;
let pickerAction: ((recipe: Recipe) => void) | undefined;
let pickerRecipes: Recipe[] = [];
let pickerLimit = 100;
let editingTarget: PlantQuantityRef | undefined;
let lastCanvasTap: { time: number; point: Point; shiftKey: boolean } | undefined;
let lastBoundaryTap: { time: number; point: Point; componentId: string } | undefined;
let itemPickerPosition: Point = { x: 0, y: 0 };
let itemPickerLimit = 100;
const pointers = new Map<number, Point>();
let gesture: { kind: "pan" | "move" | "duplicate" | "pending" | "pinch" | "box-select" | "port-action" | "port-reorder"; id?: string; ids?: string[]; origins?: Record<string, Point>; port?: PortRef; pointerType?: string; start: Point; origin: Point; timer?: number; moved?: boolean; shiftKey?: boolean; pinchDistance?: number; pinchScale?: number } | undefined;

fetch("/build/browser-recipes.json", { cache: "no-store" }).then((response) => response.json()).then((data: Recipe[] | { recipes: Recipe[]; itemTags?: Record<string, string[]>; fluidTags?: Record<string, string[]> }) => {
  const catalog = Array.isArray(data) ? { recipes: data } : data;
  recipes.push(...catalog.recipes);
  itemTags = catalog.itemTags ?? {};
  fluidTags = catalog.fluidTags ?? {};
  knownItems = collectKnownItems();
  recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  recipeSearchText = new Map(recipes.map((recipe) => [recipe.id,
    `${recipe.id} ${recipe.method} ${recipe.method === "splashing" ? "washing" : ""} ${recipe.machine ?? ""} ${recipe.inputs.map((input) => input.id).join(" ")} ${outputsOf(recipe).map((output) => output.resource.id).join(" ")}`.toLowerCase(),
  ]));
  canonicalizePlantResources();
  ensureOutputDestinations();
  render();
}).catch(() => setStatus("Could not load the generated recipe catalog; run make build"));

$("#fit-view").addEventListener("click", fitView);
$("#reset-plant").addEventListener("click", () => {
  plant = createPlant("main"); positions = {}; portOrder = {}; selected = ""; selectedIds.clear(); pendingPort = undefined;
  save(); render(); setStatus("Plant reset");
});
$("#delete-selected").addEventListener("click", deleteSelection);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingPort && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    cancelPortLink();
    return;
  }
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (selectedIds.size === 0 && selected) selectedIds.add(selected);
  if (selectedIds.size === 0) return;
  event.preventDefault(); deleteSelection();
});
$("#selection-controls").addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-constraint-target]");
  if (!button) return;
  try { openConstraintEditor(JSON.parse(button.dataset.constraintTarget!) as PlantQuantityRef); }
  catch { setStatus("Could not open constraint editor"); }
});
$("#constraint-apply").addEventListener("click", saveConstraintEditor);
$("#constraint-clear").addEventListener("click", clearConstraintEditor);
$("#constraint-close").addEventListener("click", () => { editingTarget = undefined; $("#constraint-editor").close(); });
$("#constraint-form").addEventListener("submit", (event) => { event.preventDefault(); saveConstraintEditor(); });
$("#recipe-search").addEventListener("input", () => { pickerLimit = 100; renderOptions(); });
$("#item-search").addEventListener("input", () => { itemPickerLimit = 100; renderItemOptions(); });
$("#item-options").addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-item-kind]");
  if (!button) return;
  const item = knownItems.find(({ id }) => id === button.dataset.itemId);
  if (!item) return;
  $("#item-picker").close();
  addItemBoundary(button.dataset.itemKind as "supply" | "demand", item);
});
$("#plant-canvas").addEventListener("pointerdown", pointerDown);
$("#plant-canvas").addEventListener("pointermove", pointerMove);
$("#plant-canvas").addEventListener("pointerup", pointerUp);
$("#plant-canvas").addEventListener("pointercancel", pointerCancel);
$("#plant-canvas").addEventListener("contextmenu", (event) => {
  const edge = (event.target as Element).closest<SVGElement>("[data-edge]");
  if (!edge) return;
  event.preventDefault(); splitConnection(edge.dataset.edge!, toWorld(screenPoint(event)));
});
$("#plant-canvas").addEventListener("click", (event) => {
  const target = (event.target as Element).closest<SVGElement>("[data-constraint-target]");
  if (!target) return;
  try { openConstraintEditor(JSON.parse(target.dataset.constraintTarget!) as PlantQuantityRef); }
  catch { setStatus("Could not open constraint editor"); }
});
$("#plant-canvas").addEventListener("wheel", (event) => {
  event.preventDefault(); zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, screenPoint(event));
}, { passive: false });
window.addEventListener("resize", render);

function addRecipe(recipe: Recipe) {
  const id = nextId("process");
  plant = addPlantComponent(plant, { id, kind: "process", recipeId: recipe.id });
  positions[id] = { x: 80 - view.x / view.scale, y: 80 - view.y / view.scale };
  const outputs = recipe.outputs?.length ? recipe.outputs : [{ resource: recipe.output, amount: recipe.outputAmount }];
  for (const [i, input] of recipe.inputs.entries()) {
    const supplyId = `${id}-in-${i}`;
    plant = addPlantComponent(plant, { id: supplyId, kind: "supply", resource: input });
    positions[supplyId] = { x: positions[id].x - 210, y: positions[id].y + i * 92 };
    plant = connect(plant, supplyId, "output", input, id, "input");
  }
  for (const [i, output] of outputs.entries()) {
    const demandId = `${id}-out-${i}`;
    plant = addPlantComponent(plant, { id: demandId, kind: "demand", resource: output.resource });
    positions[demandId] = { x: positions[id].x + 360, y: positions[id].y + i * 92 };
    plant = connect(plant, id, "output", output.resource, demandId, "input");
  }
  selected = id; selectedIds.clear(); selectedIds.add(id); save(); render(); setStatus("Process added");
}

function expandBoundary(component: Extract<PlantComponent, { kind: "supply" | "demand" }>) {
  if (component.kind === "supply") {
    openPicker(`Produce ${short(component.resource.id)}`, recipes.filter((r) => outputsOf(r).some((o) => resourcesMatch(o.resource, component.resource))), (recipe) => {
      const target = plant.connections.find((edge) => edge.from.componentId === component.id);
      const oldPosition = positions[component.id] ?? { x: 0, y: 0 };
      plant = removePlantComponent(plant, component.id); delete positions[component.id];
      addRecipe(recipe);
      const processId = selected;
      const delta = { x: oldPosition.x - 260 - positions[processId].x, y: oldPosition.y - positions[processId].y };
      shiftRecipeNodes(processId, delta);
      const matching = outputsOf(recipe).find((o) => resourcesMatch(o.resource, component.resource))!;
      if (target) {
        const generatedSink = plant.components.find((candidate) => candidate.kind === "demand" &&
          resourcesMatch(candidate.resource, matching.resource) && plant.connections.some((edge) => edge.from.componentId === processId && edge.to.componentId === candidate.id));
        if (generatedSink) {
          plant = removePlantComponent(plant, generatedSink.id);
          delete positions[generatedSink.id];
        }
        plant = connect(plant, processId, "output", matching.resource, target.to.componentId, "input");
      }
      save(); render();
    });
  } else {
    openPicker(`Use ${short(component.resource.id)}`, recipes.filter((r) => r.inputs.some((i) => resourcesMatch(i, component.resource))), (recipe) => {
      const source = plant.connections.find((edge) => edge.to.componentId === component.id);
      const oldPosition = positions[component.id] ?? { x: 0, y: 0 };
      plant = removePlantComponent(plant, component.id); delete positions[component.id];
      addRecipe(recipe);
      const processId = selected;
      const delta = { x: oldPosition.x + 260 - positions[processId].x, y: oldPosition.y - positions[processId].y };
      shiftRecipeNodes(processId, delta);
      const inputIndex = recipe.inputs.findIndex((i) => resourcesMatch(i, component.resource));
      const supplyId = `${processId}-in-${inputIndex}`;
      if (source) {
        plant = removePlantComponent(plant, supplyId);
        delete positions[supplyId];
        plant = connect(plant, source.from.componentId, "output", source.from.resource, processId, "input");
      }
      save(); render();
    });
  }
}

function render() {
  rateAnalysis = recipes.length > 0 ? analyzePlantRates(plant, {
    findRecipe: (id) => recipesById.get(id),
    requiredOperatingConditions,
    calculateTiming,
    stressImpactPerMachine,
  }) : undefined;
  const components = new Map(plant.components.map((c) => [c.id, c]));
  const markup: string[] = [];
  for (const edge of plant.connections) {
    const from = components.get(edge.from.componentId), to = components.get(edge.to.componentId);
    if (!from || !to) continue;
    const a = portPoint(from, edge.from.direction, edge.from.resource);
    const b = portPoint(to, edge.to.direction, edge.to.resource);
    const path = connectionPath(a, b);
    const edgeRateTarget: PlantQuantityRef = { kind: "connection-rate", connectionId: edge.id };
    const edgeRate = rateForConnection(edge.id);
    const labelX = (a.x + b.x) / 2, labelY = (a.y + b.y) / 2 - 8;
    markup.push(`<g class="edge-group ${selected === edge.id ? "selected" : ""}" tabindex="0" data-edge="${esc(edge.id)}"><path class="edge" d="${path}"/><path class="edge-hit" d="${path}"/><text class="edge-label ${rateClass(edgeRate)}" data-base-x="${labelX}" data-base-y="${labelY}" x="${labelX}" y="${labelY}" text-anchor="middle">${esc(short(edge.from.resource.id))} · ${esc(rateText(edgeRate, rateUnit(edge.from.resource)))}</text></g>`);
  }
  for (const component of plant.components) {
    const p = positions[component.id] ?? (positions[component.id] = { x: 0, y: 0 });
    if (component.kind !== "process") {
      const direction = component.kind === "supply" ? "output" : "input";
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction, resource: component.resource } };
      const rate = rateForPort(target);
      const portX = component.kind === "supply" ? 70 : 0;
      markup.push(`<g class="resource ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${p.x} ${p.y})"><rect class="resource-body" width="70" height="70" rx="10"/><text class="resource-icon" x="35" y="29">${esc(icon(component.resource.id))}</text><text class="resource-name" x="35" y="45">${esc(short(component.resource.id))}</text><circle class="port-hit" data-port="${direction}" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(component.resource))}" cx="${portX}" cy="35" r="14"/><circle class="port-dot boundary-port ${isPendingPortTarget(component.id, direction, component.resource) ? "link-active" : ""}" cx="${portX}" cy="35" r="5"/><rect class="rate-hit" data-constraint-target="${esc(JSON.stringify(target))}" x="12" y="72" width="46" height="24" rx="5"/><text class="resource-rate ${rateClass(rate)}" data-constraint-target="${esc(JSON.stringify(target))}" x="35" y="89">${esc(rateText(rate, rateUnit(component.resource)))}</text></g>`);
      continue;
    }
    const recipe = recipesById.get(component.recipeId);
    const ins = orderedPorts(component.id, "input", recipe?.inputs ?? []);
    const outs = orderedPorts(component.id, "output", outputsOf(recipe));
    const rows = Math.max(ins.length, outs.length);
    const height = Math.max(140, 96 + rows * 44);
    const primaryOutput = outs[0];
    const productionRate = primaryOutput
      ? rateText(rateForPort({ kind: "port-rate", port: { componentId: component.id, direction: "output", resource: primaryOutput.resource } }), rateUnit(primaryOutput.resource))
      : "? /min";
    const rpm = recipe ? processQuantityDisplay(component.id, "rpm", exactComponentConstraint("rpm", component.id)) : { text: "?", state: "underconstrained" };
    const machines = recipe ? processQuantityDisplay(component.id, "machine-count", machineCountValue(component, recipe, primaryOutput)) : { text: "?", state: "underconstrained" };
    const stressValue = recipe && exactComponentConstraint("rpm", component.id) !== undefined && machineCountValue(component, recipe, primaryOutput) !== undefined
      ? calculateStressImpact(recipe, exactComponentConstraint("rpm", component.id)!, machineCountValue(component, recipe, primaryOutput)!) : undefined;
    const stress = recipe ? processQuantityDisplay(component.id, "stress", stressValue) : { text: "?", state: "underconstrained" };
    const stackSize = recipe && ["encased_fan", "crushing_wheels", "mechanical_saw"].includes(recipe.machine ?? "")
      ? processQuantityDisplay(component.id, "stack-size", exactComponentConstraint("stack-size", component.id)) : undefined;
    markup.push(`<g class="process ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${p.x} ${p.y})"><rect class="process-body" width="320" height="${height}" rx="11"/><text class="process-title" x="12" y="21">${esc(recipe ? short(recipe.id.split(":").at(-1)!) : component.recipeId)}</text><text class="process-machine" x="12" y="39">${esc(recipe?.machine ?? recipe?.method ?? "process")} · ${esc(productionRate)}</text><text class="process-meta" x="12" y="53">RPM <tspan class="${rpm.state}">${esc(rpm.text)}</tspan> · Machines <tspan class="${machines.state}">${esc(machines.text)}</tspan></text><text class="process-meta" x="12" y="67">SU <tspan class="${stress.state}">${esc(stress.text)}</tspan>${stackSize ? ` · Stack <tspan class="${stackSize.state}">${esc(stackSize.text)}</tspan>` : ""}</text><text class="port-heading" x="12" y="82">INPUTS</text><text class="port-heading" x="308" y="82" text-anchor="end">OUTPUTS</text>`);
    ins.forEach((input, i) => {
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "input", resource: input } };
      const targetData = esc(JSON.stringify(target));
      const row = 98 + i * 44;
      const rate = rateForPort(target);
      markup.push(`<circle class="port-dot ${isPendingPortTarget(component.id, "input", input) ? "link-active" : ""}" cx="0" cy="${row}" r="5"/><rect class="port-hit" data-port="input" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(input))}" x="-15" y="${row - 10}" width="160" height="20"/><text class="port-label" x="12" y="${row + 4}">${esc(fitLabel(input.id))} · ${input.amount}</text><rect class="rate-hit" data-constraint-target="${targetData}" x="8" y="${row + 11}" width="140" height="22" rx="5"/><text class="port-rate ${rateClass(rate)}" data-constraint-target="${targetData}" x="12" y="${row + 27}">${esc(rateText(rate, rateUnit(input)))}</text>`);
    });
    outs.forEach((output, i) => {
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: output.resource } };
      const targetData = esc(JSON.stringify(target));
      const row = 98 + i * 44;
      const rate = rateForPort(target);
      markup.push(`<circle class="port-dot ${isPendingPortTarget(component.id, "output", output.resource) ? "link-active" : ""}" cx="320" cy="${row}" r="5"/><rect class="port-hit" data-port="output" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(output.resource))}" x="175" y="${row - 10}" width="160" height="20"/><text class="port-label" x="308" y="${row + 4}" text-anchor="end">${esc(fitLabel(output.resource.id))} · ${output.amount}</text><rect class="rate-hit" data-constraint-target="${targetData}" x="172" y="${row + 11}" width="140" height="22" rx="5"/><text class="port-rate ${rateClass(rate)}" data-constraint-target="${targetData}" x="308" y="${row + 27}" text-anchor="end">${esc(rateText(rate, rateUnit(output.resource)))}</text>`);
    });
    markup.push("</g>");
  }
  world.innerHTML = markup.join("");
  hoveredEdgeLabel = undefined;
  world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  renderInteractionPreview();
  $("#grid").setAttribute("patternTransform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  $("#empty-hint").hidden = plant.components.some((c) => c.kind === "process");
  const picked = components.get(selected);
  const pickedConnection = plant.connections.find(({ id }) => id === selected);
  const info = $("#selection-info");
  info.hidden = !picked && !pickedConnection && selectedIds.size === 0;
  $("#delete-selected").hidden = !picked && selectedIds.size === 0;
  $("#selection-label").textContent = selectedIds.size > 1 ? `${selectedIds.size} nodes selected` : picked
    ? picked.kind === "process" ? `Process · ${picked.recipeId}` : `${picked.kind === "supply" ? "Infinite input" : "Infinite output"} · ${picked.resource.id}`
    : pickedConnection ? `Flow · ${pickedConnection.from.resource.id}` : "";
  $("#selection-controls").innerHTML = selectedIds.size > 1 ? "" : picked ? constraintControlsFor(picked)
    : pickedConnection ? constraintControl({ kind: "connection-rate", connectionId: pickedConnection.id }, `Flow rate · ${pickedConnection.from.resource.id}`, rateUnit(pickedConnection.from.resource))
    : "";
  const problems = rateAnalysis?.issues ?? [];
  if (problems.length) setStatus(`${rateAnalysis?.status}: ${problems[0]}`);
  else if (rateAnalysis?.status === "underconstrained" && $("#status").textContent?.startsWith("invalid:")) setStatus("Rates are underconstrained");
}

function machineCountText(component: Extract<PlantComponent, { kind: "process" }>, recipe: Recipe, output?: { resource: Resource; amount: number }): string {
  const count = machineCountValue(component, recipe, output);
  return count === undefined ? "? machines" : `${formatNumber(count)} machines`;
}

function machineCountValue(component: Extract<PlantComponent, { kind: "process" }>, recipe: Recipe, output?: { resource: Resource; amount: number }): number | undefined {
  const explicit = exactComponentConstraint("machine-count", component.id);
  if (explicit !== undefined) return explicit;
  if (!output) return undefined;
  const outputRate = rateForPort({ kind: "port-rate", port: { componentId: component.id, direction: "output", resource: output.resource } });
  if (!outputRate || (outputRate.state !== "constrained" && outputRate.state !== "derived")) return undefined;
  const rpm = exactComponentConstraint("rpm", component.id) ?? 0;
  const stackSize = exactComponentConstraint("stack-size", component.id) ?? 1;
  try {
    const capacity = calculateTiming(recipe, rpm, stackSize).outputPerMinute;
    return capacity > 0 ? Math.ceil(outputRate.perMinute / capacity) : undefined;
  } catch { return undefined; }
}

function stressUsageText(component: Extract<PlantComponent, { kind: "process" }>, recipe: Recipe, output?: { resource: Resource; amount: number }): string {
  const explicit = exactComponentConstraint("stress", component.id);
  if (explicit !== undefined) return `${formatNumber(explicit)} SU`;
  const rpm = exactComponentConstraint("rpm", component.id);
  if (rpm !== undefined && (rpm === 0 || stressImpactPerMachine(recipe) === 0)) return "0 SU";
  const machineCount = machineCountValue(component, recipe, output);
  if (rpm === undefined || machineCount === undefined) return "? SU";
  return `${formatNumber(calculateStressImpact(recipe, rpm, machineCount))} SU`;
}

function processQuantityDisplay(
  componentId: string,
  kind: "rpm" | "machine-count" | "stress" | "stack-size",
  measured: number | undefined,
): { text: string; state: "constrained" | "derived" | "underconstrained" } {
  const constraints = plant.constraints.filter((constraint) => "componentId" in constraint.target &&
    constraint.target.kind === kind && constraint.target.componentId === componentId);
  const imposed = constraints.flatMap((constraint) => {
    if (constraint.kind === "integer") return ["int"];
    if (constraint.kind === "power-of-two") return ["2ⁿ"];
    const sign = constraint.relation === "equals" ? "=" : constraint.relation === "at-least" ? "≥" : "≤";
    return [`${sign} ${formatNumber(constraint.value)}`];
  });
  const explicitlyConstrained = constraints.length > 0;
  if (kind === "machine-count" || kind === "stack-size") {
    if (!imposed.includes("int")) imposed.push("int");
  }
  const exact = constraints.some((constraint) => constraint.kind === "bound" && constraint.relation === "equals");
  const text = explicitlyConstrained
    ? exact || measured === undefined ? imposed.join(" ") : `${formatNumber(measured)} (${imposed.join(" ")})`
    : measured === undefined ? imposed.join(" ") || "?" : `${formatNumber(measured)}${imposed.length ? ` ${imposed.join(" ")}` : ""}`;
  return { text, state: explicitlyConstrained ? "constrained" : measured === undefined ? "underconstrained" : "derived" };
}

function exactComponentConstraint(kind: "rpm" | "stack-size" | "machine-count" | "stress", componentId: string): number | undefined {
  const values = plant.constraints.filter((constraint) => constraint.kind === "bound" && constraint.relation === "equals" &&
    constraint.target.kind === kind && constraint.target.componentId === componentId).map(({ value }) => value);
  return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}

type ConstraintControl = { target: PlantQuantityRef; label: string; unit: string };

function constraintControlsFor(component: PlantComponent): string {
  const controls: ConstraintControl[] = [];
  if (component.kind === "process") {
    controls.push(
      { target: { kind: "rpm", componentId: component.id }, label: "RPM", unit: "RPM" },
      { target: { kind: "machine-count", componentId: component.id }, label: "Machines", unit: "machines" },
      { target: { kind: "stress", componentId: component.id }, label: "Stress", unit: "SU" },
    );
    const recipe = recipesById.get(component.recipeId);
    if (["encased_fan", "crushing_wheels", "mechanical_saw"].includes(recipe?.machine ?? "")) {
      controls.push({ target: { kind: "stack-size", componentId: component.id }, label: "Input stack", unit: "items/stack" });
    }
    for (const input of recipe?.inputs ?? []) controls.push({
      target: { kind: "port-rate", port: { componentId: component.id, direction: "input", resource: input } },
      label: `Input ${short(input.id)}`, unit: rateUnit(input),
    });
    for (const output of outputsOf(recipe)) controls.push({
      target: { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: output.resource } },
      label: `Output ${short(output.resource.id)}`, unit: rateUnit(output.resource),
    });
  } else {
    const direction = component.kind === "supply" ? "output" : "input";
    controls.push({
      target: { kind: "port-rate", port: { componentId: component.id, direction, resource: component.resource } },
      label: `${component.kind === "supply" ? "Supply" : "Demand"} rate`, unit: rateUnit(component.resource),
    });
  }
  return controls.map(({ target, label, unit }) => constraintControl(target, label, unit)).join("");
}

function constraintControl(target: PlantQuantityRef, label: string, unit: string): string {
  const constrained = plant.constraints.some((constraint) => sameTarget(constraint.target, target));
  const summary = constraintSummary(target, unit);
  return `<button type="button" class="constraint-button ${constrained ? "constrained" : "unset"}" data-constraint-target="${esc(JSON.stringify(target))}">${esc(label)} · ${esc(summary)}</button>`;
}

function constraintSummary(target: PlantQuantityRef, unit: string): string {
  const constraints = plant.constraints.filter((constraint) => sameTarget(constraint.target, target));
  const parts = constraints.flatMap((constraint) => {
    if (constraint.kind === "integer") return ["integer"];
    if (constraint.kind === "power-of-two") return ["2ⁿ"];
    const symbol = constraint.relation === "equals" ? "=" : constraint.relation === "at-least" ? "≥" : "≤";
    return [`${symbol} ${constraint.value} ${unit}`];
  });
  if (!constraints.some(({ kind }) => kind === "bound")) parts.unshift(`? ${unit}`);
  if ((target.kind === "machine-count" || target.kind === "stack-size") && !constraints.some(({ kind }) => kind === "integer")) parts.push("integer");
  return parts.join(", ") || `? ${unit}`;
}

function rateForPort(target: Extract<PlantQuantityRef, { kind: "port-rate" }>): RateValue | undefined {
  return rateAnalysis?.portRates.find(({ port }) => sameTarget({ kind: "port-rate", port }, target))?.rate;
}

function rateForConnection(connectionId: string): RateValue | undefined {
  return rateAnalysis?.connectionRates.find((rate) => rate.connectionId === connectionId)?.rate;
}

function rateClass(rate: RateValue | undefined): string {
  if (!rate || rate.state === "underconstrained") return "underconstrained";
  return rate.state;
}

function rateText(rate: RateValue | undefined, unit: string): string {
  if (!rate || rate.state === "underconstrained") {
    if (!rate) return `? ${unit}`;
    const minimum = rate.minimum;
    const maximum = rate.maximum;
    const range = maximum === undefined
      ? minimum > 0 ? `≥ ${formatNumber(minimum)}` : "?"
      : minimum === maximum ? formatNumber(minimum)
        : minimum === 0 ? `≤ ${formatNumber(maximum)}`
          : `${formatNumber(minimum)}–${formatNumber(maximum)}`;
    const domain = rate.powerOfTwo ? " · 2ⁿ" : rate.integer ? " · int" : "";
    return `${range} ${unit}${domain}`;
  }
  return rate.state === "conflict" ? "!" : `${formatNumber(rate.perMinute)} ${unit}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function openConstraintEditor(target: PlantQuantityRef) {
  editingTarget = target;
  const current = plant.constraints.filter((constraint) => sameTarget(constraint.target, target));
  const valueFor = (relation: "equals" | "at-least" | "at-most") =>
    current.find((constraint) => constraint.kind === "bound" && constraint.relation === relation)?.value;
  setNumberInput("#constraint-equals", valueFor("equals"));
  setNumberInput("#constraint-minimum", valueFor("at-least"));
  setNumberInput("#constraint-maximum", valueFor("at-most"));
  const integer = current.some(({ kind }) => kind === "integer") || target.kind === "machine-count" || target.kind === "stack-size";
  $("#constraint-integer").checked = integer;
  $("#constraint-integer").disabled = target.kind === "machine-count" || target.kind === "stack-size";
  $("#constraint-power-two").checked = current.some(({ kind }) => kind === "power-of-two");
  const unit = unitFor(target);
  for (const selector of ["#constraint-unit-equals", "#constraint-unit-minimum", "#constraint-unit-maximum"]) $(selector).textContent = unit;
  $("#constraint-title").textContent = constraintTitle(target);
  $("#constraint-error").hidden = true;
  $("#constraint-clear").disabled = current.length === 0;
  $("#constraint-editor").showModal();
  $("#constraint-equals").focus();
}

function saveConstraintEditor() {
  if (!editingTarget) return;
  try {
    const exact = readNumberInput("#constraint-equals");
    const minimum = readNumberInput("#constraint-minimum");
    const maximum = readNumberInput("#constraint-maximum");
    const integer = $("#constraint-integer").checked || editingTarget.kind === "machine-count" || editingTarget.kind === "stack-size";
    const powerOfTwo = $("#constraint-power-two").checked;
    validateEditorValues(exact, minimum, maximum, integer, powerOfTwo);
    replaceTargetConstraints(editingTarget, [
      ...(exact === undefined ? [] : [{ id: nextId("constraint"), target: editingTarget, kind: "bound" as const, relation: "equals" as const, value: exact }]),
      ...(minimum === undefined ? [] : [{ id: nextId("constraint"), target: editingTarget, kind: "bound" as const, relation: "at-least" as const, value: minimum }]),
      ...(maximum === undefined ? [] : [{ id: nextId("constraint"), target: editingTarget, kind: "bound" as const, relation: "at-most" as const, value: maximum }]),
      ...(integer ? [{ id: nextId("constraint"), target: editingTarget, kind: "integer" as const }] : []),
      ...(powerOfTwo ? [{ id: nextId("constraint"), target: editingTarget, kind: "power-of-two" as const }] : []),
    ]);
    $("#constraint-editor").close();
    save(); render(); setStatus("Constraints saved"); editingTarget = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid constraint";
    $("#constraint-error").textContent = message;
    $("#constraint-error").hidden = false;
  }
}

function clearConstraintEditor() {
  if (!editingTarget) return;
  replaceTargetConstraints(editingTarget, []);
  $("#constraint-editor").close();
  save(); render(); setStatus("Constraints cleared"); editingTarget = undefined;
}

function replaceTargetConstraints(target: PlantQuantityRef, replacements: PlantConstraint[]) {
  let next = plant;
  for (const constraint of next.constraints.filter((item) => sameTarget(item.target, target))) {
    next = removePlantConstraint(next, constraint.id);
  }
  for (const constraint of replacements) next = addPlantConstraint(next, constraint);
  plant = next;
}

function validateEditorValues(exact: number | undefined, minimum: number | undefined, maximum: number | undefined, integer: boolean, powerOfTwo: boolean) {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error("GEQ cannot exceed LEQ");
  if (exact !== undefined && ((minimum !== undefined && exact < minimum) || (maximum !== undefined && exact > maximum))) {
    throw new Error("Equality must fit within the GEQ and LEQ bounds");
  }
  const discrete = integer || powerOfTwo;
  const valid = (value: number) => (!discrete || Number.isInteger(value)) && (!powerOfTwo || isPowerOfTwo(value));
  if (exact !== undefined && !valid(exact)) throw new Error("Equality violates the selected integer or power-of-two restriction");
  if (exact === undefined && (discrete || powerOfTwo)) {
    const lowest = powerOfTwo ? 2 ** Math.ceil(Math.log2(Math.max(minimum ?? 0, 1))) : Math.ceil(minimum ?? 0);
    const highest = maximum === undefined ? undefined : discrete ? Math.floor(maximum) : maximum;
    if (highest !== undefined && lowest > highest) throw new Error("Bounds contain no allowed integer or power-of-two value");
  }
}

function sameTarget(a: PlantQuantityRef, b: PlantQuantityRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "port-rate" && b.kind === "port-rate") {
    return a.port.componentId === b.port.componentId && a.port.direction === b.port.direction && resourceKey(a.port.resource) === resourceKey(b.port.resource);
  }
  if (a.kind === "connection-rate" && b.kind === "connection-rate") return a.connectionId === b.connectionId;
  return "componentId" in a && "componentId" in b && a.componentId === b.componentId;
}

function unitFor(target: PlantQuantityRef): string {
  if (target.kind === "rpm") return "RPM";
  if (target.kind === "machine-count") return "machines";
  if (target.kind === "stack-size") return "items/stack";
  if (target.kind === "stress") return "SU";
  const resource = target.kind === "port-rate" ? target.port.resource : plant.connections.find(({ id }) => id === target.connectionId)?.from.resource;
  return resource?.type === "fluid" ? "mB/min" : "items/min";
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

function setNumberInput(selector: string, value: number | undefined) {
  $(selector).value = value === undefined ? "" : String(value);
}

function readNumberInput(selector: string): number | undefined {
  const raw = $(selector).value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("Values must be finite and non-negative");
  return value;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && 2 ** Math.round(Math.log2(value)) === value;
}

function deleteSelectedProcess() {
  const component = plant.components.find((item) => item.id === selected);
  if (!component || component.kind !== "process") return;
  const oldPosition = positions[component.id] ?? { x: 0, y: 0 };
  const inputConstraints = plant.constraints.filter((constraint) =>
    constraint.target.kind === "port-rate" && constraint.target.port.componentId === component.id && constraint.target.port.direction === "input");
  const outputConstraints = plant.constraints.filter((constraint) =>
    constraint.target.kind === "port-rate" && constraint.target.port.componentId === component.id && constraint.target.port.direction === "output");
  const incomingFromProcesses = plant.connections.filter((edge) => {
    const source = plant.components.find(({ id }) => id === edge.from.componentId);
    return edge.to.componentId === component.id && source?.kind === "process";
  });
  const outgoingToProcesses = plant.connections.filter((edge) => {
    const target = plant.components.find(({ id }) => id === edge.to.componentId);
    return edge.from.componentId === component.id && target?.kind === "process";
  });
  const recipe = recipesById.get(component.recipeId);
  const materials = new Map<string, Resource>();
  for (const edge of incomingFromProcesses) materials.set(resourceKey(edge.to.resource), edge.to.resource);

  const demandByResource = new Map<string, string>();
  for (const [index, resource] of [...materials.values()].entries()) {
    const id = nextId("deleted-input");
    plant = addPlantComponent(plant, { id, kind: "demand", resource });
    positions[id] = { x: oldPosition.x, y: oldPosition.y + index * 92 };
    demandByResource.set(resourceKey(resource), id);
  }
  for (const edge of incomingFromProcesses) {
    const demandId = demandByResource.get(resourceKey(edge.to.resource));
    if (demandId) plant = redirectPlantConnectionTarget(plant, edge.id, {
      componentId: demandId, direction: "input", resource: edge.to.resource,
    });
  }

  const sourceByResource = new Map<string, string>();
  for (const edge of outgoingToProcesses) {
    const key = resourceKey(edge.from.resource);
    let sourceId = sourceByResource.get(key);
    if (!sourceId) {
      sourceId = nextId("deleted-output-source");
      sourceByResource.set(key, sourceId);
      plant = addPlantComponent(plant, { id: sourceId, kind: "supply", resource: edge.from.resource });
      const index = sourceByResource.size - 1;
      positions[sourceId] = { x: oldPosition.x + 360, y: oldPosition.y + index * 92 };
    }
  }
  const sourceByConnection = new Map(outgoingToProcesses.map((edge) => [edge.id, sourceByResource.get(resourceKey(edge.from.resource))!]));
  plant = {
    ...plant,
    connections: plant.connections.map((edge) => {
      const sourceId = sourceByConnection.get(edge.id);
      return sourceId ? { ...edge, from: { ...edge.from, componentId: sourceId } } : edge;
    }),
  };

  const attachedBoundaries = plant.connections
    .filter((edge) => edge.from.componentId === selected || edge.to.componentId === selected)
    .map((edge) => edge.from.componentId === selected ? edge.to.componentId : edge.from.componentId)
    .filter((id) => plant.components.some((item) => item.id === id && item.kind !== "process"));
  plant = removePlantComponent(plant, selected);
  delete positions[selected];
  delete portOrder[selected];
  for (const id of attachedBoundaries) {
    if (!plant.connections.some((edge) => edge.from.componentId === id || edge.to.componentId === id)) {
      plant = removePlantComponent(plant, id);
      delete positions[id];
    }
  }
  for (const constraint of inputConstraints) {
    if (constraint.target.kind !== "port-rate") continue;
    const demandId = demandByResource.get(resourceKey(constraint.target.port.resource));
    if (!demandId) continue;
    plant = addPlantConstraint(plant, {
      ...constraint,
      target: { kind: "port-rate", port: { componentId: demandId, direction: "input", resource: constraint.target.port.resource } },
    });
  }
  for (const constraint of outputConstraints) {
    if (constraint.target.kind !== "port-rate") continue;
    const sourceId = sourceByResource.get(resourceKey(constraint.target.port.resource));
    if (!sourceId) continue;
    plant = addPlantConstraint(plant, {
      ...constraint,
      target: { kind: "port-rate", port: { componentId: sourceId, direction: "output", resource: constraint.target.port.resource } },
    });
  }
  selected = ""; selectedIds.delete(component.id);
  pruneDisconnectedBoundaries();
  save(); render();
  setStatus(outgoingToProcesses.length
    ? `Process deleted; ${sourceByResource.size} output source${sourceByResource.size === 1 ? "" : "s"} retained for downstream processes`
    : materials.size ? "Process deleted; upstream outputs retained as material demands" : "Process deleted");
}

function deleteSelection() {
  const ids = selectedIds.size ? [...selectedIds] : selected ? [selected] : [];
  let deleted = 0;
  for (const id of ids) {
    const component = plant.components.find((item) => item.id === id);
    if (!component) continue;
    if (component.kind === "process") {
      selected = id; deleteSelectedProcess(); deleted++; continue;
    }
    if (component.kind === "demand" && isLastProcessOutputDestination(id)) {
      setStatus("Cannot delete the only destination of a process output"); continue;
    }
    plant = removePlantComponent(plant, id); delete positions[id]; selectedIds.delete(id); deleted++;
  }
  selected = selectedIds.values().next().value ?? "";
  pruneDisconnectedBoundaries(); save(); render();
  if (deleted > 0) setStatus(`Deleted ${deleted} selected node${deleted === 1 ? "" : "s"}`);
}

function isLastProcessOutputDestination(componentId: string): boolean {
  const component = plant.components.find(({ id }) => id === componentId);
  if (component?.kind !== "demand") return false;
  const incoming = plant.connections.filter((edge) => edge.to.componentId === componentId);
  return incoming.some((edge) => {
    const from = plant.components.find(({ id }) => id === edge.from.componentId);
    return from?.kind === "process" && plant.connections.filter((candidate) =>
      candidate.from.componentId === from.id && candidate.from.direction === edge.from.direction &&
      resourceKey(candidate.from.resource) === resourceKey(edge.from.resource)).length <= 1;
  });
}

function pruneDisconnectedBoundaries() {
  for (const component of [...plant.components]) {
    if (component.kind === "process") continue;
    if (plant.connections.some((edge) => edge.from.componentId === component.id || edge.to.componentId === component.id)) continue;
    plant = removePlantComponent(plant, component.id); delete positions[component.id]; selectedIds.delete(component.id);
  }
}

function ensureOutputDestinations() {
  const selfConnections = plant.connections.filter((edge) => edge.from.componentId === edge.to.componentId);
  for (const edge of selfConnections) plant = disconnectPlantPorts(plant, edge.id);
  for (const process of plant.components.filter((component): component is Extract<PlantComponent, { kind: "process" }> => component.kind === "process")) {
    const recipe = recipesById.get(process.recipeId);
    for (const [index, output] of outputsOf(recipe).entries()) {
      const connected = plant.connections.some((edge) => edge.from.componentId === process.id && resourceKey(edge.from.resource) === resourceKey(output.resource));
      if (connected) continue;
      const id = nextId("output-sink");
      plant = addPlantComponent(plant, { id, kind: "demand", resource: output.resource });
      const p = positions[process.id] ?? { x: 0, y: 0 };
      positions[id] = { x: p.x + 360, y: p.y + 72 + index * 92 };
      plant = connect(plant, process.id, "output", output.resource, id, "input");
    }
  }
  save();
  if (selfConnections.length) setStatus(`Removed ${selfConnections.length} saved self-connection${selfConnections.length === 1 ? "" : "s"}; restored process output destinations`);
}

function duplicateSelection(componentIds: string[]): string[] {
  const originals = new Set(componentIds);
  const idMap = new Map(componentIds.map((id) => [id, nextId("copy")]));
  const originalConnections = plant.connections.filter((edge) => originals.has(edge.from.componentId) && originals.has(edge.to.componentId));
  const connectionIdMap = new Map(originalConnections.map(({ id }) => [id, nextId("flow-copy")]));
  const clones: PlantComponent[] = plant.components.filter(({ id }) => originals.has(id)).map((component) => ({
    ...component,
    id: idMap.get(component.id)!,
    ...(component.kind === "process" ? {} : { resource: { ...component.resource } }),
  }) as PlantComponent);

  for (const clone of clones) plant = addPlantComponent(plant, clone);
  for (const edge of originalConnections) {
    const id = connectionIdMap.get(edge.id)!;
    plant = connectPlantPorts(plant, {
      id,
      from: { ...edge.from, componentId: idMap.get(edge.from.componentId)! },
      to: { ...edge.to, componentId: idMap.get(edge.to.componentId)! },
    });
  }
  for (const constraint of [...plant.constraints]) {
    let target = constraint.target;
    if (target.kind === "port-rate" && idMap.has(target.port.componentId)) {
      target = { ...target, port: { ...target.port, componentId: idMap.get(target.port.componentId)! } };
    } else if (target.kind === "connection-rate" && connectionIdMap.has(target.connectionId)) {
      target = { ...target, connectionId: connectionIdMap.get(target.connectionId)! };
    } else if ("componentId" in target && idMap.has(target.componentId)) {
      target = { ...target, componentId: idMap.get(target.componentId)! };
    } else continue;
    plant = addPlantConstraint(plant, { ...constraint, id: nextId("constraint-copy"), target });
  }

  const createdIds = clones.map(({ id }) => id);
  for (const [oldId, newId] of idMap) {
    const order = portOrder[oldId];
    if (order) portOrder[newId] = {
      ...(order.input ? { input: [...order.input] } : {}),
      ...(order.output ? { output: [...order.output] } : {}),
    };
    const original = plant.components.find(({ id }) => id === oldId);
    const clone = clones.find(({ id }) => id === newId);
    if (original?.kind !== "process" || clone?.kind !== "process") continue;
    const recipe = recipesById.get(clone.recipeId);
    const position = positions[oldId] ?? { x: 0, y: 0 };
    for (const [index, input] of (recipe?.inputs ?? []).entries()) {
      const connected = plant.connections.some((edge) => edge.to.componentId === newId && resourceKey(edge.to.resource) === resourceKey(input));
      if (connected) continue;
      const sourceId = nextId("copy-source");
      plant = addPlantComponent(plant, { id: sourceId, kind: "supply", resource: input });
      positions[sourceId] = { x: position.x - 210, y: position.y + index * 92 };
      plant = connect(plant, sourceId, "output", input, newId, "input");
      createdIds.push(sourceId);
    }
    for (const [index, output] of outputsOf(recipe).entries()) {
      const connected = plant.connections.some((edge) => edge.from.componentId === newId && resourceKey(edge.from.resource) === resourceKey(output.resource));
      if (connected) continue;
      const sinkId = nextId("copy-sink");
      plant = addPlantComponent(plant, { id: sinkId, kind: "demand", resource: output.resource });
      positions[sinkId] = { x: position.x + 360, y: position.y + index * 92 };
      plant = connect(plant, newId, "output", output.resource, sinkId, "input");
      createdIds.push(sinkId);
    }
  }
  for (const [oldId, newId] of idMap) {
    if (!positions[oldId]) continue;
    positions[newId] = { ...positions[oldId] };
  }
  return createdIds;
}

function canonicalizePlantResources() {
  const canonical = (resource: Resource): Resource => {
    if (!resource.id.startsWith("#")) return resource;
    const tags = resource.type === "fluid" ? fluidTags : itemTags;
    const members = tags[resource.id.slice(1)];
    return members?.length === 1 ? { ...resource, id: members[0] } : resource;
  };
  plant = {
    ...plant,
    components: plant.components.map((component) => component.kind === "process"
      ? component
      : { ...component, resource: canonical(component.resource) }),
    connections: plant.connections.map((edge) => ({
      ...edge,
      from: { ...edge.from, resource: canonical(edge.from.resource) },
      to: { ...edge.to, resource: canonical(edge.to.resource) },
    })),
    constraints: plant.constraints.map((constraint) => constraint.target.kind === "port-rate"
      ? { ...constraint, target: { ...constraint.target, port: { ...constraint.target.port, resource: canonical(constraint.target.port.resource) } } }
      : constraint),
  };
}

function mergeBoundaries(sourceId: string, targetId: string) {
  const source = plant.components.find(({ id }) => id === sourceId);
  const target = plant.components.find(({ id }) => id === targetId);
  if (!source || !target || source.kind === "process" || target.kind === "process") return;
  if (resourceKey(source.resource) !== resourceKey(target.resource)) return;
  if (source.kind === target.kind) {
    plant = {
      ...plant,
      connections: plant.connections.map((edge) => ({
        ...edge,
        from: edge.from.componentId === sourceId ? { ...edge.from, componentId: targetId } : edge.from,
        to: edge.to.componentId === sourceId ? { ...edge.to, componentId: targetId } : edge.to,
      })),
    };
    const movedConstraints = plant.constraints.filter((constraint) => constraint.target.kind === "port-rate" && constraint.target.port.componentId === sourceId);
    plant = removePlantComponent(plant, sourceId); delete positions[sourceId];
    for (const constraint of movedConstraints) {
      const port = constraint.target.kind === "port-rate" ? constraint.target.port : undefined;
      if (!port) continue;
      plant = addPlantConstraint(plant, { ...constraint, target: { kind: "port-rate", port: { ...port, componentId: targetId } } });
    }
    selectedIds.delete(sourceId); selected = targetId; selectedIds.add(targetId);
    pruneDisconnectedBoundaries(); save(); render(); setStatus("Resource squares merged");
    return;
  }
  const supply = source.kind === "supply" ? source : target;
  const demand = source.kind === "demand" ? source : target;
  if (plant.connections.some((edge) => edge.from.componentId === supply.id && edge.to.componentId === demand.id)) return;
  plant = connect(plant, supply.id, "output", supply.resource, demand.id, "input");
  pruneDisconnectedBoundaries(); save(); render(); setStatus("Source connected to sink");
}

function splitConnection(connectionId: string, at: Point) {
  const edge = plant.connections.find(({ id }) => id === connectionId);
  if (!edge) return;
  const rateConstraints = plant.constraints.filter((constraint) => constraint.target.kind === "connection-rate" && constraint.target.connectionId === connectionId);
  const demandId = nextId("split-sink"), supplyId = nextId("split-source");
  plant = disconnectPlantPorts(plant, connectionId);
  plant = addPlantComponent(plant, { id: demandId, kind: "demand", resource: edge.from.resource });
  plant = addPlantComponent(plant, { id: supplyId, kind: "supply", resource: edge.to.resource });
  positions[demandId] = { x: at.x - 40, y: at.y + 24 };
  positions[supplyId] = { x: at.x + 40, y: at.y - 94 };
  const firstId = nextId("flow"), secondId = nextId("flow");
  plant = connectPlantPorts(plant, { id: firstId, from: edge.from, to: { componentId: demandId, direction: "input", resource: edge.from.resource } });
  plant = connectPlantPorts(plant, { id: secondId, from: { componentId: supplyId, direction: "output", resource: edge.to.resource }, to: edge.to });
  for (const constraint of rateConstraints) plant = addPlantConstraint(plant, { ...constraint, target: { kind: "connection-rate", connectionId: firstId } });
  selected = ""; selectedIds.clear(); save(); render(); setStatus("Flow split into an output sink and input source");
}

function pointerDown(event: PointerEvent) {
  const point = screenPoint(event); pointers.set(event.pointerId, point);
  if (pointers.size === 2) {
    svg.setPointerCapture(event.pointerId);
    clearTimeout(gesture?.timer); const [a, b] = [...pointers.values()];
    gesture = { kind: "pinch", start: midpoint(a, b), origin: { ...view }, pinchDistance: distance(a, b), pinchScale: view.scale };
    return;
  }
  if (event.shiftKey) {
    svg.setPointerCapture(event.pointerId);
    gesture = { kind: "box-select", start: point, origin: point, shiftKey: true };
    const box = $("#marquee"); box.hidden = false; box.setAttribute("x", String(point.x)); box.setAttribute("y", String(point.y)); box.setAttribute("width", "0"); box.setAttribute("height", "0");
    event.preventDefault(); return;
  }
  const constraintTarget = (event.target as Element).closest<SVGElement>("[data-constraint-target]");
  if (constraintTarget) return;
  const portElement = (event.target as Element).closest<SVGElement>("[data-port]");
  if (portElement && event.pointerType !== "mouse") { handlePort(portFromElement(portElement), true); return; }
  if (portElement && event.ctrlKey) {
    svg.setPointerCapture(event.pointerId);
    gesture = { kind: "port-action", port: portFromElement(portElement), start: point, origin: point };
    event.preventDefault(); return;
  }
  const target = (event.target as Element).closest<SVGElement>("[data-component], [data-edge]");
  if (target?.dataset.component) {
    const component = plant.components.find(({ id }) => id === target!.dataset.component)!;
    const worldPoint = toWorld(point);
    svg.setPointerCapture(event.pointerId);
    if (!selectedIds.has(component.id)) { selectedIds.clear(); selectedIds.add(component.id); }
    selected = component.id;
    if (event.pointerType === "mouse") {
      gesture = { kind: event.altKey ? "duplicate" : "move", id: component.id, ids: event.altKey ? [...selectedIds] : undefined, pointerType: event.pointerType, start: point, origin: positions[component.id] ?? worldPoint };
    } else {
      gesture = { kind: "pending", id: component.id, pointerType: event.pointerType, start: point, origin: positions[component.id] ?? worldPoint, timer: window.setTimeout(() => {
        if (gesture?.kind === "pending" && gesture.id === component.id) { gesture.kind = "move"; setStatus(`Moving ${component.kind === "process" ? "process" : "resource"}`); }
      }, 420) };
    }
    event.preventDefault(); return;
  }
  if (target?.dataset.edge) { selected = target.dataset.edge; selectedIds.clear(); render(); return; }
  svg.setPointerCapture(event.pointerId);
  gesture = { kind: "pan", start: point, origin: { x: view.x, y: view.y } };
}

function pointerMove(event: PointerEvent) {
  if (event.pointerType === "mouse") updateEdgeTooltip(event);
  const point = screenPoint(event);
  if (!pointers.has(event.pointerId)) {
    if (pendingPort) { previewPoint = toWorld(point); renderInteractionPreview(); }
    return;
  }
  pointers.set(event.pointerId, point);
  if (pendingPort && gesture?.kind !== "port-reorder") previewPoint = toWorld(point);
  if (pointers.size >= 2 && gesture?.kind === "pinch") {
    const [a, b] = [...pointers.values()]; const mid = midpoint(a, b);
    const scale = Math.max(.35, Math.min(2.5, gesture.pinchScale! * distance(a, b) / gesture.pinchDistance!));
    const worldAtMid = { x: (gesture.start.x - gesture.origin.x) / gesture.pinchScale!, y: (gesture.start.y - gesture.origin.y) / gesture.pinchScale! };
    view = { scale, x: mid.x - worldAtMid.x * scale, y: mid.y - worldAtMid.y * scale }; render(); return;
  }
  if (!gesture) {
    if (pendingPort) { previewPoint = toWorld(point); renderInteractionPreview(); }
    return;
  }
  if (gesture.kind === "port-action" && distance(point, gesture.start) > 7) {
    gesture.kind = "port-reorder"; gesture.moved = true;
    setStatus(`Reordering ${gesture.port?.direction}`);
  }
  if (gesture.kind === "port-reorder") { previewPoint = toWorld(point); renderInteractionPreview(); return; }
  if (gesture.kind === "box-select") {
    if (distance(point, gesture.start) > 4) gesture.moved = true;
    const box = $("#marquee");
    box.setAttribute("x", String(Math.min(gesture.start.x, point.x)));
    box.setAttribute("y", String(Math.min(gesture.start.y, point.y)));
    box.setAttribute("width", String(Math.abs(point.x - gesture.start.x)));
    box.setAttribute("height", String(Math.abs(point.y - gesture.start.y)));
    const a = toWorld(gesture.start), b = toWorld(point);
    const rect = { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
    selectedIds = new Set(plant.components.filter((component) => {
      const p = positions[component.id] ?? { x: 0, y: 0 };
      const recipe = component.kind === "process" ? recipesById.get(component.recipeId) : undefined;
      const h = component.kind === "process" ? Math.max(140, 96 + Math.max(recipe?.inputs.length ?? 0, outputsOf(recipe).length) * 44) : 70;
      const w = component.kind === "process" ? 320 : 70;
      return p.x <= rect.right && p.x + w >= rect.left && p.y <= rect.bottom && p.y + h >= rect.top;
    }).map(({ id }) => id));
    selected = selectedIds.values().next().value ?? "";
    render(); return;
  }
  if (gesture.kind === "pending" && distance(point, gesture.start) > 9) { clearTimeout(gesture.timer); gesture.moved = true; return; }
  if (gesture.kind === "duplicate") {
    if (!gesture.moved && distance(point, gesture.start) > 4) {
      gesture.ids = duplicateSelection(gesture.ids ?? []);
      gesture.origins = Object.fromEntries(gesture.ids.map((id) => [id, { ...(positions[id] ?? { x: 0, y: 0 }) }]));
      gesture.moved = true;
      selectedIds = new Set(gesture.ids);
      selected = gesture.ids[0] ?? "";
      setStatus(`Duplicating ${gesture.ids.length} nodes`);
    }
    if (gesture.moved && gesture.ids && gesture.origins) {
      const dx = (point.x - gesture.start.x) / view.scale;
      const dy = (point.y - gesture.start.y) / view.scale;
      for (const id of gesture.ids) {
        const origin = gesture.origins[id];
        if (origin) positions[id] = { x: origin.x + dx, y: origin.y + dy };
      }
      render();
    }
    return;
  }
  if (gesture.kind === "move" && gesture.id) {
    if (distance(point, gesture.start) > 4) gesture.moved = true;
    positions[gesture.id] = { x: gesture.origin.x + (point.x - gesture.start.x) / view.scale, y: gesture.origin.y + (point.y - gesture.start.y) / view.scale }; render();
  } else if (gesture.kind === "pan") {
    if (distance(point, gesture.start) > 6) gesture.moved = true;
    view.x = gesture.origin.x + point.x - gesture.start.x; view.y = gesture.origin.y + point.y - gesture.start.y; render();
  }
}

function pointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId); clearTimeout(gesture?.timer);
  if (gesture?.kind === "port-action") {
    if (gesture.port) handlePort(gesture.port);
    gesture = undefined; save(); return;
  }
  if (gesture?.kind === "port-reorder") {
    if (gesture.port) reorderPort(gesture.port, toWorld(screenPoint(event)));
    gesture = undefined; previewPoint = undefined; renderInteractionPreview(); save(); return;
  }
  if (gesture?.kind === "box-select") {
    $("#marquee").hidden = true;
    if (!gesture.moved) handleBackgroundTap(screenPoint(event), gesture.shiftKey ?? false);
    else render();
    gesture = undefined; save(); return;
  }
  if (gesture?.kind === "pending" && !gesture.moved) {
    const component = plant.components.find(({ id }) => id === gesture!.id);
    if (component) selectTappedComponent(component, screenPoint(event));
  }
  if (gesture?.kind === "move" && gesture.pointerType === "mouse" && !gesture.moved) {
    const component = plant.components.find(({ id }) => id === gesture!.id);
    if (component) selectTappedComponent(component, screenPoint(event));
  }
  if (gesture?.kind === "pan" && !gesture.moved) {
    handleBackgroundTap(screenPoint(event), false);
  }
  if (gesture?.kind === "move" && gesture.moved && gesture.id) {
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<SVGElement>("[data-component]");
    const targetId = element?.dataset.component;
    if (targetId && targetId !== gesture.id) mergeBoundaries(gesture.id, targetId);
  }
  if (gesture?.kind === "duplicate" && gesture.moved) setStatus(`Duplicated ${gesture.ids?.length ?? 0} nodes`);
  gesture = undefined; save();
}
function handleBackgroundTap(point: Point, shiftKey: boolean) {
  const now = performance.now();
  lastBoundaryTap = undefined;
  selected = ""; selectedIds.clear(); render();
  if (lastCanvasTap && lastCanvasTap.shiftKey === shiftKey && now - lastCanvasTap.time < 360 && distance(point, lastCanvasTap.point) < 24) {
    lastCanvasTap = undefined;
    const location = toWorld(point);
    window.setTimeout(() => shiftKey ? openItemPicker(location) : openPicker("Add a process", recipes, addRecipe), 0);
  } else lastCanvasTap = { time: now, point, shiftKey };
}
function selectTappedComponent(component: PlantComponent, point: Point) {
  selected = component.id;
  selectedIds.clear(); selectedIds.add(component.id);
  render();
  if (component.kind === "process") {
    lastBoundaryTap = undefined;
    setStatus("Process selected");
    return;
  }
  const now = performance.now();
  if (lastBoundaryTap?.componentId === component.id && now - lastBoundaryTap.time < 420 && distance(point, lastBoundaryTap.point) < 24) {
    lastBoundaryTap = undefined;
    window.setTimeout(() => expandBoundary(component), 0);
  } else {
    lastBoundaryTap = { time: now, point, componentId: component.id };
    setStatus(`Double-tap to ${component.kind === "supply" ? "produce" : "use"} ${short(component.resource.id)}`);
  }
}
function pointerCancel(event: PointerEvent) { pointers.delete(event.pointerId); clearTimeout(gesture?.timer); $("#marquee").hidden = true; gesture = undefined; previewPoint = undefined; renderInteractionPreview(); }

function portFromElement(target: SVGElement): PortRef {
  const [type, ...idParts] = target.dataset.resource!.split(":");
  return {
    componentId: target.dataset.component!,
    direction: target.dataset.port as "input" | "output",
    resource: { type, id: idParts.join(":") } as Resource,
  };
}

function samePort(a: PortRef, b: PortRef): boolean {
  return a.componentId === b.componentId && a.direction === b.direction && resourceKey(a.resource) === resourceKey(b.resource);
}

function handlePort(port: PortRef, touch = false) {
  if (pendingPort && samePort(pendingPort, port)) {
    cancelPortLink();
    return;
  }
  if (!pendingPort) {
    pendingPort = port;
    previewPoint = portPoint(plant.components.find(({ id }) => id === port.componentId)!, port.direction, port.resource);
    render();
    setStatus(`Selected ${port.direction} ${short(port.resource.id)}; ${touch ? "tap" : "Ctrl-click"} matching ${port.direction === "output" ? "input" : "output"}`);
    return;
  }
  const from = pendingPort.direction === "output" ? pendingPort : port;
  const to = pendingPort.direction === "input" ? pendingPort : port;
  try {
    if (resourceKey(from.resource) !== resourceKey(to.resource)) throw new Error("Choose ports for the same material");
    plant = connect(plant, from.componentId, "output", from.resource, to.componentId, "input");
    pendingPort = undefined; previewPoint = undefined; pruneDisconnectedBoundaries(); save(); render(); setStatus("Flow connected");
  } catch (error) { pendingPort = undefined; previewPoint = undefined; render(); setStatus(error instanceof Error ? error.message : "Could not connect ports"); }
}

function cancelPortLink() {
  pendingPort = undefined;
  previewPoint = undefined;
  render();
  setStatus("Link cancelled");
}

function renderInteractionPreview() {
  const preview: string[] = [];
  if (pendingPort && previewPoint) {
    const component = plant.components.find(({ id }) => id === pendingPort!.componentId);
    if (component) {
      const terminal = portPoint(component, pendingPort.direction, pendingPort.resource);
      const from = pendingPort.direction === "output" ? terminal : previewPoint;
      const to = pendingPort.direction === "output" ? previewPoint : terminal;
      preview.push(`<path class="edge-ghost" d="${connectionPath(from, to)}"/>`);
    }
  }
  if (gesture?.kind === "port-reorder" && gesture.port && previewPoint) {
    const port = gesture.port;
    const component = plant.components.find(({ id }) => id === port.componentId);
    if (component?.kind === "process") {
      const position = positions[component.id] ?? { x: 0, y: 0 };
      const recipe = recipesById.get(component.recipeId);
      const ports = port.direction === "input" ? recipe?.inputs ?? [] : outputsOf(recipe);
      const targetIndex = Math.max(0, Math.min(ports.length - 1, Math.round((previewPoint.y - position.y - 98) / 44)));
      const dropY = position.y + 98 + targetIndex * 44;
      preview.push(`<line class="reorder-ghost-line" x1="${position.x + 8}" y1="${dropY}" x2="${position.x + 312}" y2="${dropY}"/><g class="reorder-ghost" transform="translate(${previewPoint.x + 12} ${previewPoint.y + 8})"><rect width="150" height="30" rx="7"/><text x="10" y="20">${esc(short(port.resource.id))}</text></g>`);
    }
  }
  interactionPreview.innerHTML = preview.join("");
  interactionPreview.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
}

function connectionPath(from: Point, to: Point): string {
  const bend = Math.max(50, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function updateEdgeTooltip(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : undefined;
  const group = target?.closest<SVGGElement>(".edge-group");
  const path = group?.querySelector<SVGPathElement>(".edge");
  const label = group?.querySelector<SVGTextElement>(".edge-label");
  if (!path || !label) {
    if (hoveredEdgeLabel?.isConnected) {
      hoveredEdgeLabel.setAttribute("x", hoveredEdgeLabel.dataset.baseX ?? "0");
      hoveredEdgeLabel.setAttribute("y", hoveredEdgeLabel.dataset.baseY ?? "0");
    }
    hoveredEdgeLabel = undefined;
    return;
  }
  if (hoveredEdgeLabel && hoveredEdgeLabel !== label && hoveredEdgeLabel.isConnected) {
    hoveredEdgeLabel.setAttribute("x", hoveredEdgeLabel.dataset.baseX ?? "0");
    hoveredEdgeLabel.setAttribute("y", hoveredEdgeLabel.dataset.baseY ?? "0");
  }
  hoveredEdgeLabel = label;

  const cursor = toWorld(screenPoint(event));
  const length = path.getTotalLength();
  const samples = Math.min(180, Math.max(24, Math.ceil(length / 5)));
  let closest = path.getPointAtLength(0);
  let closestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const point = path.getPointAtLength(length * i / samples);
    const dx = point.x - cursor.x, dy = point.y - cursor.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < closestDistance) { closest = point; closestDistance = distanceSquared; }
  }
  label.setAttribute("x", String(closest.x));
  label.setAttribute("y", String(closest.y - 8));
}

function isPendingPortTarget(componentId: string, direction: "input" | "output", resource: Resource): boolean {
  return !!pendingPort && pendingPort.componentId !== componentId && pendingPort.direction !== direction &&
    resourceKey(pendingPort.resource) === resourceKey(resource);
}

function connect(current: Plant, fromId: string, fromDirection: "input" | "output", resource: Resource, toId: string, toDirection: "input" | "output"): Plant {
  const edge: PlantConnection = { id: nextId("flow"), from: { componentId: fromId, direction: fromDirection, resource }, to: { componentId: toId, direction: toDirection, resource } };
  return connectPlantPorts(current, edge);
}
function orderedPorts<T extends Resource | { resource: Resource }>(componentId: string, direction: "input" | "output", ports: T[]): T[] {
  const savedOrder = portOrder[componentId]?.[direction] ?? [];
  const keyOf = (port: T) => resourceKey("resource" in port ? port.resource : port);
  return ports.map((port, index) => ({ port, index, savedIndex: savedOrder.indexOf(keyOf(port)) }))
    .sort((a, b) => (a.savedIndex < 0 ? savedOrder.length + a.index : a.savedIndex) -
      (b.savedIndex < 0 ? savedOrder.length + b.index : b.savedIndex))
    .map(({ port }) => port);
}
function reorderPort(port: PortRef, point: Point) {
  const component = plant.components.find(({ id }) => id === port.componentId);
  if (component?.kind !== "process") return;
  const recipe = recipesById.get(component.recipeId);
  if (!recipe) return;
  const ports = port.direction === "input" ? recipe.inputs : outputsOf(recipe);
  const ordered = orderedPorts(component.id, port.direction, ports);
  const keys = ordered.map((item) => resourceKey("resource" in item ? item.resource : item));
  const sourceIndex = keys.indexOf(resourceKey(port.resource));
  if (sourceIndex < 0 || keys.length < 2) return;
  const processPosition = positions[component.id] ?? { x: 0, y: 0 };
  const targetIndex = Math.max(0, Math.min(keys.length - 1, Math.round((point.y - processPosition.y - 98) / 44)));
  if (targetIndex === sourceIndex) return;
  const [moved] = keys.splice(sourceIndex, 1);
  keys.splice(targetIndex, 0, moved);
  portOrder[component.id] = { ...portOrder[component.id], [port.direction]: keys };
  save(); render(); setStatus(`${port.direction === "input" ? "Inputs" : "Outputs"} reordered`);
}
function shiftRecipeNodes(processId: string, delta: Point) {
  for (const component of plant.components) {
    if (component.id === processId || component.id.startsWith(`${processId}-in-`) || component.id.startsWith(`${processId}-out-`)) {
      const p = positions[component.id];
      if (p) positions[component.id] = { x: p.x + delta.x, y: p.y + delta.y };
    }
  }
}
function openPicker(title: string, options: Recipe[], action: (recipe: Recipe) => void) {
  $("#picker-title").textContent = title; pickerAction = action; pickerRecipes = options; pickerLimit = 100; $("#recipe-search").value = "";
  renderOptions(); $("#recipe-picker").showModal(); $("#recipe-search").focus();
}
function openItemPicker(position: Point) {
  itemPickerPosition = position;
  itemPickerLimit = 100;
  $("#item-search").value = "";
  renderItemOptions();
  $("#item-picker").showModal();
  $("#item-search").focus();
}
function renderItemOptions() {
  const terms = $("#item-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = knownItems.filter((item) => {
    const text = `${item.id} ${short(item.id).replaceAll("_", " ")}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const options = matches.slice(0, itemPickerLimit).map((item) =>
    `<div class="item-option"><span>${esc(item.id)}</span><button type="button" data-item-kind="supply" data-item-id="${esc(item.id)}">Source</button><button type="button" data-item-kind="demand" data-item-id="${esc(item.id)}">Sink</button></div>`).join("");
  $("#item-options").innerHTML = options || `<p>No matching items</p>`;
  if (matches.length > itemPickerLimit) {
    const more = document.createElement("button");
    more.type = "button"; more.className = "recipe-option recipe-more";
    more.textContent = `Load more (${matches.length - itemPickerLimit} remaining)`;
    more.addEventListener("click", () => { itemPickerLimit += 100; renderItemOptions(); });
    $("#item-options").append(more);
  }
}
function collectKnownItems(): Resource[] {
  const items = new Map<string, Resource>();
  const add = (item: Resource) => {
    if (item.type === "item" && !item.id.startsWith("#")) items.set(resourceKey(item), { type: item.type, id: item.id });
  };
  for (const recipe of recipes) {
    recipe.inputs.forEach(add);
    outputsOf(recipe).forEach(({ resource }) => add(resource));
  }
  for (const members of Object.values(itemTags)) members.forEach((id) => add({ type: "item", id }));
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function addItemBoundary(kind: "supply" | "demand", item: Resource) {
  const id = nextId(kind === "supply" ? "source" : "sink");
  plant = addPlantComponent(plant, { id, kind, resource: item });
  positions[id] = { x: itemPickerPosition.x - 35, y: itemPickerPosition.y - 35 };
  selected = id; selectedIds.clear(); selectedIds.add(id);
  save(); render(); setStatus(`${kind === "supply" ? "Infinite input" : "Infinite output"} added: ${item.id}`);
}
function renderOptions() {
  const terms = $("#recipe-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = pickerRecipes.filter((recipe) => {
    const text = recipeSearchText.get(recipe.id) ?? "";
    return terms.every((term) => text.includes(term));
  });
  const list = matching.slice(0, pickerLimit);
  $("#recipe-options").innerHTML = list.map((r) => `<button class="recipe-option" type="button" data-recipe="${esc(r.id)}"><span>${esc(r.id)}</span><small>${esc(r.method)}${r.machine ? ` · ${esc(r.machine)}` : ""} · ${r.inputs.length} inputs</small></button>`).join("") || `<p>No matching recipes</p>`;
  $("#recipe-options").querySelectorAll<HTMLButtonElement>("[data-recipe]").forEach((button) => button.addEventListener("click", () => {
    const recipe = pickerRecipes.find(({ id }) => id === button.dataset.recipe);
    $("#recipe-picker").close();
    try {
      if (recipe) pickerAction?.(recipe);
      else setStatus("Selected recipe is no longer available");
    } catch (error) {
      setStatus(error instanceof Error ? `Could not add recipe: ${error.message}` : "Could not add recipe");
      console.error("Could not add selected recipe", error);
    }
  }));
  if (matching.length > pickerLimit) {
    const more = document.createElement("button");
    more.type = "button"; more.className = "recipe-option recipe-more";
    more.textContent = `Load more (${matching.length - pickerLimit} remaining)`;
    more.addEventListener("click", () => { pickerLimit += 100; renderOptions(); });
    $("#recipe-options").append(more);
  }
}
function outputsOf(recipe?: Recipe) { return recipe?.outputs?.length ? recipe.outputs : recipe ? [{ resource: recipe.output, amount: recipe.outputAmount }] : []; }
function resourcesMatch(a: Resource & { alternatives?: string[] }, b: Resource & { alternatives?: string[] }): boolean {
  if (a.type !== b.type) return false;
  const values = (resource: Resource & { alternatives?: string[] }) => {
    const tags = resource.type === "fluid" ? fluidTags : itemTags;
    return new Set([
      resource.id,
      ...(resource.alternatives ?? []),
      ...(resource.id.startsWith("#") ? tags[resource.id.slice(1)] ?? [] : []),
    ]);
  };
  const aValues = values(a);
  return [...values(b)].some((value) => aValues.has(value));
}
function portPoint(component: PlantComponent, direction: "input" | "output", resource: Resource): Point {
  const p = positions[component.id] ?? { x: 0, y: 0 };
  if (component.kind !== "process") return { x: p.x + (component.kind === "supply" ? 70 : 0), y: p.y + 35 };
  const recipe = recipesById.get(component.recipeId);
  const list = direction === "input" ? orderedPorts(component.id, direction, recipe?.inputs ?? [])
    : orderedPorts(component.id, direction, outputsOf(recipe).map((o) => ({ ...o.resource, amount: o.amount })));
  const index = Math.max(0, list.findIndex((item) => resourceKey(item) === resourceKey(resource)));
  return { x: p.x + (direction === "input" ? 0 : 320), y: p.y + 98 + index * 44 };
}
function fitView() {
  if (!plant.components.length) { view = { x: 0, y: 0, scale: 1 }; render(); return; }
  const boxes = plant.components.map((component) => {
    const p = positions[component.id] ?? { x: 0, y: 0 };
    if (component.kind !== "process") return { left: p.x, top: p.y, right: p.x + 70, bottom: p.y + 96 };
    const recipe = recipesById.get(component.recipeId);
    const rows = Math.max(recipe?.inputs.length ?? 0, outputsOf(recipe).length);
    return { left: p.x, top: p.y, right: p.x + 320, bottom: p.y + Math.max(140, 96 + rows * 44) };
  });
  const minX = Math.min(...boxes.map((box) => box.left)), maxX = Math.max(...boxes.map((box) => box.right));
  const minY = Math.min(...boxes.map((box) => box.top)), maxY = Math.max(...boxes.map((box) => box.bottom));
  const rect = svg.getBoundingClientRect(); view.scale = Math.max(.35, Math.min(1.5, Math.min((rect.width - 80) / (maxX - minX), (rect.height - 80) / (maxY - minY))));
  view.x = (rect.width - (maxX - minX) * view.scale) / 2 - minX * view.scale;
  view.y = (rect.height - (maxY - minY) * view.scale) / 2 - minY * view.scale; render();
}
function zoomAt(factor: number, point: Point) {
  const scale = Math.max(.35, Math.min(2.5, view.scale * factor));
  const worldPoint = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
  view = { scale, x: point.x - worldPoint.x * scale, y: point.y - worldPoint.y * scale }; render();
}
function screenPoint(event: MouseEvent | WheelEvent): Point { const rect = svg.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
function toWorld(p: Point): Point { return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale }; }
function center(): Point { return { x: svg.clientWidth / 2, y: svg.clientHeight / 2 }; }
function midpoint(a: Point, b: Point): Point { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function short(id: string): string { return id.split(":").at(-1)!.replaceAll("_", " "); }
function fitLabel(id: string): string { const label = short(id); return label.length > 19 ? `${label.slice(0, 18)}…` : label; }
function icon(id: string): string { return short(id).split(/[- _]/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function nextId(prefix: string): string {
  const id = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}
function setStatus(message: string) { $("#status").textContent = message; }
function load<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(`createrate:${key}`) ?? "null") ?? fallback; } catch { return fallback; } }
function loadPlant(): Plant {
  const stored = load<Plant>("plant", createPlant("main"));
  return {
    ...stored,
    constraints: (stored.constraints ?? []).map((constraint) =>
      "kind" in constraint ? constraint : { ...constraint, kind: "bound" as const }) as PlantConstraint[],
  };
}
function save() {
  localStorage.setItem("createrate:plant", JSON.stringify(plant));
  localStorage.setItem("createrate:positions", JSON.stringify(positions));
  localStorage.setItem("createrate:port-order", JSON.stringify(portOrder));
}
