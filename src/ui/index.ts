import {
  addPlantComponent,
  addPlantRecipe,
  analyzePlantRates,
  canonicalizePlantResources,
  collectRecipeItems,
  connectPlantPorts,
  createPlant,
  deletePlantProcess,
  duplicatePlantSelection,
  ensurePlantOutputDestinations,
  expandPlantBoundary,
  isLastPlantProcessOutputDestination,
  loadBrowserRecipeCatalog,
  mergePlantResourceComponents,
  removeDisconnectedPlantBoundaries,
  recipesForPlantBoundary,
  removePlantComponent,
  recipeOutputs,
  resourceKey,
  resourcesMatch,
  plantProcessMetrics,
  splitPlantConnection,
} from "../core/index.ts";
import type { Plant, PlantComponent, PlantConnection, PlantConstraint, Resource } from "../core/index.ts";
import type { Recipe } from "../recipes.ts";
import type { PlantRateAnalysis } from "../plant-analysis.ts";
import { createConstraintUi } from "./constraints.ts";
import { createPickers } from "./pickers.ts";
import { orderedPorts, portPoint, processGeometry, renderCanvas, renderCanvasInteractionPreview, updateEdgeTooltip } from "./canvas.ts";
import type { CanvasState } from "./canvas.ts";

type Point = { x: number; y: number };
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const svg = $("#plant-canvas");
const world = $("#world");
const interactionPreview = $("#interaction-preview");
const recipes: Recipe[] = [];
let recipesById = new Map<string, Recipe>();
let itemTags: Record<string, string[]> = {};
let fluidTags: Record<string, string[]> = {};
let itemAnimations: CanvasState["itemAnimations"] = {};
let machineModelIds: CanvasState["machineModelIds"] = {};
let machineModels: CanvasState["machineModels"] = {};
let machineLayoutRules: CanvasState["machineLayoutRules"] = { blockStep: 16, basinMethods: [], basinModel: "", heaterModels: {} };
let itemIcons: Record<string, string> = {};
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
let lastCanvasTap: { time: number; point: Point; shiftKey: boolean } | undefined;
let lastBoundaryTap: { time: number; point: Point; componentId: string } | undefined;
const pointers = new Map<number, Point>();
let gesture: { kind: "pan" | "move" | "duplicate" | "pending" | "pinch" | "box-select" | "port-action" | "port-reorder"; id?: string; ids?: string[]; origins?: Record<string, Point>; port?: PortRef; pointerType?: string; start: Point; origin: Point; timer?: number; moved?: boolean; shiftKey?: boolean; pinchDistance?: number; pinchScale?: number } | undefined;

const constraintUi = createConstraintUi({
  getPlant: () => plant,
  setPlant: (next) => { plant = next; },
  getRecipe: (id) => recipesById.get(id),
  save,
  render,
  setStatus,
  nextId,
});
const pickers = createPickers({
  getRecipes: () => recipes,
  getItems: () => knownItems,
  getItemIcon: (id) => itemIcons[id],
  addItem: addItemBoundary,
  setStatus,
});

loadBrowserRecipeCatalog().then((catalog) => {
  recipes.push(...catalog.recipes);
  itemTags = catalog.itemTags;
  fluidTags = catalog.fluidTags;
  itemIcons = catalog.itemIcons;
  itemAnimations = catalog.itemAnimations;
  machineModelIds = catalog.machineModelIds;
  machineModels = catalog.machineModels;
  machineLayoutRules = catalog.machineLayoutRules;
  knownItems = collectRecipeItems(recipes, itemTags);
  recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  plant = canonicalizePlantResources(plant, itemTags, fluidTags);
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
$("#plant-canvas").addEventListener("pointerdown", pointerDown);
$("#plant-canvas").addEventListener("pointermove", pointerMove);
$("#plant-canvas").addEventListener("pointerup", pointerUp);
$("#plant-canvas").addEventListener("pointercancel", pointerCancel);
$("#plant-canvas").addEventListener("contextmenu", (event) => {
  const edge = (event.target as Element).closest<SVGElement>("[data-edge]");
  if (!edge) return;
  event.preventDefault(); splitConnection(edge.dataset.edge!, toWorld(screenPoint(event)));
});
$("#plant-canvas").addEventListener("wheel", (event) => {
  event.preventDefault(); zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, screenPoint(event));
}, { passive: false });
window.addEventListener("resize", render);

function addRecipe(recipe: Recipe) {
  const result = addPlantRecipe(plant, recipe, nextId);
  plant = result.plant;
  const position = { x: 80 - view.x / view.scale, y: 80 - view.y / view.scale };
  positions[result.processId] = position;
  placeRecipeBoundaries(result.createdComponents, result.processId, position);
  selected = result.processId; selectedIds.clear(); selectedIds.add(result.processId); save(); render(); setStatus("Process added");
}

function expandBoundary(component: Extract<PlantComponent, { kind: "supply" | "demand" }>) {
  const matchResource = (a: Resource, b: Resource) => resourcesMatch(a, b, itemTags, fluidTags);
  const matchingRecipes = recipesForPlantBoundary(recipes, component, matchResource);
  const action = component.kind === "supply" ? "Produce" : "Use";
  pickers.openRecipePicker(`${action} ${short(component.resource.id)}`, matchingRecipes, (recipe) => {
    const oldPosition = positions[component.id] ?? { x: 0, y: 0 };
    const result = expandPlantBoundary(plant, component.id, recipe, { createId: nextId, resourcesMatch: matchResource });
    plant = result.plant;
    for (const id of result.removedComponentIds) delete positions[id];
    const position = { x: oldPosition.x + (component.kind === "supply" ? -260 : 260), y: oldPosition.y };
    positions[result.processId] = position;
    placeRecipeBoundaries(result.createdComponents, result.processId, position);
    selected = result.processId; selectedIds.clear(); selectedIds.add(result.processId);
    save(); render();
  });
}

function placeRecipeBoundaries(components: PlantComponent[], processId: string, position: Point) {
  let inputIndex = 0, outputIndex = 0;
  for (const component of components) {
    if (component.kind === "supply") positions[component.id] = { x: position.x - 210, y: position.y + inputIndex++ * 92 };
    else if (component.kind === "demand") positions[component.id] = { x: position.x + 360, y: position.y + outputIndex++ * 92 };
  }
}

function render() {
  rateAnalysis = recipes.length > 0 ? analyzePlantRates(plant, recipesById) : undefined;
  renderCanvas(canvasState());
  const components = new Map(plant.components.map((component) => [component.id, component]));
  const picked = components.get(selected);
  const pickedConnection = plant.connections.find(({ id }) => id === selected);
  const info = $("#selection-info");
  info.hidden = !picked && !pickedConnection && selectedIds.size === 0;
  $("#delete-selected").hidden = !picked && selectedIds.size === 0;
  $("#selection-label").textContent = selectedIds.size > 1 ? `${selectedIds.size} nodes selected` : picked
    ? picked.kind === "process" ? `Process · ${picked.recipeId}` : `${picked.kind === "supply" ? "Infinite input" : "Infinite output"} · ${picked.resource.id}`
    : pickedConnection ? `Flow · ${pickedConnection.from.resource.id}` : "";
  $("#selection-controls").innerHTML = selectedIds.size > 1 ? "" : picked ? constraintUi.controlsFor(picked)
    : pickedConnection ? constraintUi.controlFor({ kind: "connection-rate", connectionId: pickedConnection.id }, `Flow rate · ${pickedConnection.from.resource.id}`, rateUnit(pickedConnection.from.resource))
    : "";
  const problems = rateAnalysis?.issues ?? [];
  if (problems.length) setStatus(`${rateAnalysis?.status}: ${problems[0]}`);
  else if (rateAnalysis?.status === "underconstrained" && $("#status").textContent?.startsWith("invalid:")) setStatus("Rates are underconstrained");
}

function canvasState(): CanvasState {
  return {
    svg, world, interactionPreview, plant, recipesById, itemIcons, itemAnimations, machineModelIds, machineModels, machineLayoutRules, rateAnalysis, positions, portOrder, view, selected, selectedIds,
    pendingPort, previewPoint, reorderingPort: gesture?.kind === "port-reorder" ? gesture.port : undefined,
  };
}

function rateUnit(resource: Resource): string { return resource.type === "fluid" ? "mB/min" : "items/min"; }
function deleteSelectedProcess() {
  const component = plant.components.find(({ id }) => id === selected);
  if (component?.kind !== "process") return;
  const position = positions[component.id] ?? { x: 0, y: 0 };
  const result = deletePlantProcess(plant, component.id, nextId);
  plant = result.plant;
  for (const id of result.removedComponentIds) {
    delete positions[id];
    delete portOrder[id];
    selectedIds.delete(id);
  }
  result.createdInputs.forEach((input, index) => { positions[input.id] = { x: position.x, y: position.y + index * 92 }; });
  result.createdOutputs.forEach((output, index) => { positions[output.id] = { x: position.x + 360, y: position.y + index * 92 }; });
  selected = "";
  save(); render();
  setStatus(result.incomingProcessConnections
    ? `Process deleted; ${result.outputSourceCount} output source${result.outputSourceCount === 1 ? "" : "s"} retained for downstream processes`
    : result.inputMaterialCount ? "Process deleted; upstream outputs retained as material demands" : "Process deleted");
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
  return isLastPlantProcessOutputDestination(plant, componentId);
}

function pruneDisconnectedBoundaries() {
  const result = removeDisconnectedPlantBoundaries(plant);
  plant = result.plant;
  for (const id of result.removedComponentIds) { delete positions[id]; selectedIds.delete(id); }
}

function ensureOutputDestinations() {
  const result = ensurePlantOutputDestinations(plant, { createId: nextId, findRecipe: (id) => recipesById.get(id) });
  plant = result.plant;
  for (const sink of result.createdComponents) {
    if (sink.kind !== "demand") continue;
    const edge = plant.connections.find((candidate) => candidate.to.componentId === sink.id);
    const process = edge && plant.components.find((candidate) => candidate.id === edge.from.componentId);
    if (process?.kind !== "process") continue;
    const recipe = recipesById.get(process.recipeId);
    const index = recipeOutputs(recipe).findIndex((output) => resourceKey(output.resource) === resourceKey(sink.resource));
    const position = positions[process.id] ?? { x: 0, y: 0 };
    positions[sink.id] = { x: position.x + 360, y: position.y + Math.max(index, 0) * 92 };
  }
  save();
  if (result.removedConnectionIds.length) setStatus(`Removed ${result.removedConnectionIds.length} saved self-connection${result.removedConnectionIds.length === 1 ? "" : "s"}; restored process output destinations`);
}

function duplicateSelection(componentIds: string[]): string[] {
  const result = duplicatePlantSelection(plant, componentIds, { createId: nextId, findRecipe: (id) => recipesById.get(id) });
  plant = result.plant;
  const reverseIdMap = new Map([...result.componentIdMap].map(([originalId, copyId]) => [copyId, originalId]));
  for (const [originalId, copyId] of result.componentIdMap) {
    const order = portOrder[originalId];
    if (order) portOrder[copyId] = {
      ...(order.input ? { input: [...order.input] } : {}),
      ...(order.output ? { output: [...order.output] } : {}),
    };
    if (positions[originalId]) positions[copyId] = { ...positions[originalId] };
  }
  for (const id of result.createdComponentIds) {
    if (reverseIdMap.has(id)) continue;
    const component = plant.components.find(({ id: candidate }) => candidate === id);
    const edge = component?.kind === "supply"
      ? plant.connections.find((candidate) => candidate.from.componentId === id)
      : plant.connections.find((candidate) => candidate.to.componentId === id);
    const processId = component?.kind === "supply" ? edge?.to.componentId : edge?.from.componentId;
    const process = processId && plant.components.find(({ id: candidate }) => candidate === processId);
    if (!component || process?.kind !== "process") continue;
    const originalProcessId = reverseIdMap.get(process.id);
    const origin = positions[originalProcessId ?? ""] ?? { x: 0, y: 0 };
    const recipe = recipesById.get(process.recipeId);
    const list = component.kind === "supply" ? recipe?.inputs ?? [] : recipeOutputs(recipe);
    const index = list.findIndex((item) => resourceKey("resource" in item ? item.resource : item) === resourceKey(component.resource));
    positions[id] = { x: origin.x + (component.kind === "supply" ? -210 : 360), y: origin.y + Math.max(index, 0) * 92 };
  }
  return result.createdComponentIds;
}

function mergeBoundaries(sourceId: string, targetId: string) {
  const source = plant.components.find(({ id }) => id === sourceId);
  const target = plant.components.find(({ id }) => id === targetId);
  if (!source || !target || source.kind === "process" || target.kind === "process") return;
  try { plant = mergePlantResourceComponents(plant, sourceId, targetId, nextId); }
  catch { return; }
  if (source.kind === target.kind) {
    delete positions[sourceId];
    selectedIds.delete(sourceId); selected = targetId; selectedIds.add(targetId);
    pruneDisconnectedBoundaries(); save(); render(); setStatus("Resource squares merged");
    return;
  }
  pruneDisconnectedBoundaries(); save(); render(); setStatus("Source connected to sink");
}

function splitConnection(connectionId: string, at: Point) {
  let result: ReturnType<typeof splitPlantConnection>;
  try { result = splitPlantConnection(plant, connectionId, nextId); }
  catch { return; }
  plant = result.plant;
  const { demandId, supplyId } = result;
  positions[demandId] = { x: at.x - 40, y: at.y + 24 };
  positions[supplyId] = { x: at.x + 40, y: at.y - 94 };
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
  if (event.pointerType === "mouse") updateEdgeTooltip(event, svg, view);
  const point = screenPoint(event);
  if (!pointers.has(event.pointerId)) {
    if (pendingPort) { previewPoint = toWorld(point); renderCanvasInteractionPreview(canvasState()); }
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
    if (pendingPort) { previewPoint = toWorld(point); renderCanvasInteractionPreview(canvasState()); }
    return;
  }
  if (gesture.kind === "port-action" && distance(point, gesture.start) > 7) {
    gesture.kind = "port-reorder"; gesture.moved = true;
    setStatus(`Reordering ${gesture.port?.direction}`);
  }
  if (gesture.kind === "port-reorder") { previewPoint = toWorld(point); renderCanvasInteractionPreview(canvasState()); return; }
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
      const h = component.kind === "process" ? processGeometry(recipe ? short(recipe.id) : component.recipeId, Math.max(recipe?.inputs.length ?? 0, recipeOutputs(recipe).length)).height : 70;
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
    gesture = undefined; previewPoint = undefined; renderCanvasInteractionPreview(canvasState()); save(); return;
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
    window.setTimeout(() => shiftKey ? pickers.openItemPicker(location) : pickers.openRecipePicker("Add a process", recipes, addRecipe), 0);
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
function pointerCancel(event: PointerEvent) { pointers.delete(event.pointerId); clearTimeout(gesture?.timer); $("#marquee").hidden = true; gesture = undefined; previewPoint = undefined; renderCanvasInteractionPreview(canvasState()); }

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
    const component = plant.components.find(({ id }) => id === port.componentId);
    if (!component) return;
    previewPoint = portPoint(canvasState(), component, port.direction, port.resource);
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

function connect(current: Plant, fromId: string, fromDirection: "input" | "output", resource: Resource, toId: string, toDirection: "input" | "output"): Plant {
  const edge: PlantConnection = { id: nextId("flow"), from: { componentId: fromId, direction: fromDirection, resource }, to: { componentId: toId, direction: toDirection, resource } };
  return connectPlantPorts(current, edge);
}
function reorderPort(port: PortRef, point: Point) {
  const component = plant.components.find(({ id }) => id === port.componentId);
  if (component?.kind !== "process") return;
  const recipe = recipesById.get(component.recipeId);
  if (!recipe) return;
  const ports = port.direction === "input" ? recipe.inputs : recipeOutputs(recipe);
  const ordered = orderedPorts(portOrder, component.id, port.direction, ports);
  const keys = ordered.map((item) => resourceKey("resource" in item ? item.resource : item));
  const sourceIndex = keys.indexOf(resourceKey(port.resource));
  if (sourceIndex < 0 || keys.length < 2) return;
  const processPosition = positions[component.id] ?? { x: 0, y: 0 };
  const targetIndex = Math.max(0, Math.min(keys.length - 1, Math.round((point.y - processPosition.y - processGeometry(short(recipe.id), Math.max(recipe.inputs.length, recipeOutputs(recipe).length)).portTop) / 44)));
  if (targetIndex === sourceIndex) return;
  const [moved] = keys.splice(sourceIndex, 1);
  keys.splice(targetIndex, 0, moved);
  portOrder[component.id] = { ...portOrder[component.id], [port.direction]: keys };
  save(); render(); setStatus(`${port.direction === "input" ? "Inputs" : "Outputs"} reordered`);
}
function addItemBoundary(kind: "supply" | "demand", item: Resource, position: Point) {
  const id = nextId(kind === "supply" ? "source" : "sink");
  plant = addPlantComponent(plant, { id, kind, resource: item });
  positions[id] = { x: position.x - 35, y: position.y - 35 };
  selected = id; selectedIds.clear(); selectedIds.add(id);
  save(); render(); setStatus(`${kind === "supply" ? "Infinite input" : "Infinite output"} added: ${item.id}`);
}
function fitView() {
  if (!plant.components.length) { view = { x: 0, y: 0, scale: 1 }; render(); return; }
  const boxes = plant.components.map((component) => {
    const p = positions[component.id] ?? { x: 0, y: 0 };
    if (component.kind !== "process") return { left: p.x, top: p.y, right: p.x + 70, bottom: p.y + 96 };
    const recipe = recipesById.get(component.recipeId);
    const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputs(recipe).length);
    return { left: p.x, top: p.y, right: p.x + 320, bottom: p.y + processGeometry(short(recipe?.id ?? component.recipeId), rows).height };
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
