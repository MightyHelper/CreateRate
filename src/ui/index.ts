import {
  addPlantComponent,
  addPlantBoundaryAtPort,
  addPlantRecipe,
  addPlantRecipeAtPort,
  addPlantRecipeAtBoundary,
  bypassPlantPool,
  analyzePlantRates,
  canonicalizePlantResources,
  collectRecipeItems,
  createPlant,
  deletePlantConnection,
  deletePlantProcess,
  duplicatePlantSelection,
  ensurePlantOutputDestinations,
  expandPlantBoundary,
  isLastPlantProcessOutputDestination,
  insertPoolInPlantConnection,
  loadBrowserRecipeCatalog,
  mergePlantResourceComponents,
  removeDisconnectedPlantBoundaries,
  recipesForPlantBoundary,
  removePlantComponent,
  recipeOutputPorts,
  resourceKey,
  resourcesMatch,
  parsePlantTransferYaml,
  plantTransferYaml,
  plantProcessMetrics,
  splitPlantConnection,
  setPlantConnectionSecondary,
  togglePlantConnection,
} from "../core/index.ts";
import type { Plant, PlantComponent, PlantConstraint, PlantQuantityRef, PlantTransferMode, PortRef, Resource } from "../core/index.ts";
import type { Recipe } from "../recipes.ts";
import type { PlantRateAnalysis } from "../plant-analysis.ts";
import { createConstraintUi } from "./constraints.ts";
import { createPickers } from "./pickers.ts";
import { connectionLanes, orderedPorts, portPoint, processGeometry, renderCanvas, renderCanvasInteractionPreview, renderCanvasMovement, renderRecipePreview, renderResourceIcon, updateCanvasView, updateEdgeTooltip } from "./canvas.ts";
import type { CanvasState } from "./canvas.ts";
import { getRateDisplayUnits } from "./rate-display.ts";
import { rateDisplayUnit } from "../core/rate-units.ts";
import { createGestureFramework, gestureContextPath as resolveGestureContext } from "./gestures.ts";
import type { GestureContext, GestureModality, GestureState } from "./gestures.ts";

type Point = { x: number; y: number };
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const svg = $("#plant-canvas");
const world = $("#world");
const interactionPreview = $("#interaction-preview");
const menuToggle = $("#menu-toggle");
const menuItems = $("#canvas-menu-items");
const recipes: Recipe[] = [];
let recipesById = new Map<string, Recipe>();
let itemTags: Record<string, string[]> = {};
let fluidTags: Record<string, string[]> = {};
let itemAnimations: CanvasState["itemAnimations"] = {};
let itemModelIds: CanvasState["itemModelIds"] = {};
let itemModels: CanvasState["itemModels"] = {};
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
let scheduledDragRender: number | undefined;
let pendingRenderAnalysis = false;
let scheduledNodeMoveFrame: number | undefined;
let pendingMovedIds = new Set<string>();
let selected = "";
let selectedIds = new Set<string>();
let pendingPort: { componentId: string; direction: "input" | "output"; resource: Resource } | undefined;
let previewPoint: Point | undefined;
let lastCanvasTap: { time: number; point: Point; shiftKey: boolean } | undefined;
let lastBoundaryTap: { time: number; point: Point; componentId: string; ctrlKey: boolean } | undefined;
const pointers = new Map<number, Point>();
let gesture: { kind: "pan" | "move" | "duplicate" | "pending" | "pinch" | "box-select" | "port-action" | "port-reorder"; id?: string; ids?: string[]; origins?: Record<string, Point>; port?: PortRef; pointerType?: string; button?: number; start: Point; origin: Point; timer?: number; moved?: boolean; shiftKey?: boolean; pinchDistance?: number; pinchScale?: number; constraintTarget?: PlantQuantityRef; initialPlant?: Plant; initialPositions?: Record<string, Point>; initialPortOrder?: typeof portOrder; initialSelected?: string; initialSelectedIds?: string[] } | undefined;

let dispatchGesture!: (id: string, payload?: unknown) => void;
const constraintUi = createConstraintUi({
  getPlant: () => plant,
  setPlant: (next) => { plant = next; },
  getRecipe: (id) => recipesById.get(id),
  save,
  render,
  setStatus,
  nextId,
  dispatchGesture: (target) => dispatchGesture("constraint.edit", target),
  closeDialog: () => dispatchGesture("dialog.close"),
});
const pickers = createPickers({
  getRecipes: () => recipes,
  getItems: () => knownItems,
  renderResourceIcon: (resource) => renderResourceIcon(resource, canvasState(), 28),
  renderRecipePreview: (recipe) => renderRecipePreview(recipe, canvasState()),
  addItem: addItemBoundary,
  setStatus,
});
const gestureFramework = createGestureFramework({
  "canvas.select-all": selectAllNodes,
  "selection.delete": deleteSelection,
  "canvas.cancel-link": cancelPortLink,
  "canvas.zoom": (payload: { factor?: number; point?: Point; event?: PointerEvent; points?: [Point, Point] }) => {
    if (payload.factor !== undefined && payload.point) zoomAt(payload.factor, payload.point);
    else if (payload.event && payload.points) startCanvasPinch(payload.event, payload.points);
  },
  "canvas.pan-middle": startCanvasPan,
  "background.pan": startCanvasPan,
  "background.deselect": deselectCanvas,
  "background.add-process": ({ location }: { location: Point }) => openBackgroundPicker(false, location),
  "background.add-item": ({ location }: { location: Point }) => openBackgroundPicker(true, location),
  "component.select": ({ component, point, ctrlKey, pointerType }: { component: PlantComponent; point: Point; ctrlKey: boolean; pointerType: string }) => selectTappedComponent(component, point, ctrlKey, pointerType),
  "component.move": startComponentMove,
  "component.cancel-drag": cancelNodeDrag,
  "component.duplicate": startComponentDuplicate,
  "component.box-select": startBoxSelect,
  "process.reorder-input-output": startPortAction,
  "port.connect": ({ port, touch }: { port: PortRef; touch: boolean }) => handlePort(port, touch),
  "boundary.expand": ({ component }: { component: Extract<PlantComponent, { kind: "supply" | "demand" }> }) => expandBoundary(component, false),
  "boundary.expand-reverse": ({ component }: { component: Extract<PlantComponent, { kind: "supply" | "demand" }> }) => expandBoundary(component, true),
  "boundary.merge": ({ sourceId, targetId }: { sourceId: string; targetId: string }) => mergeBoundaries(sourceId, targetId),
  "pool.connect": ({ port, touch }: { port: PortRef; touch: boolean }) => handlePort(port, touch),
  "arrow.select": ({ id }: { id: string }) => { selected = id; selectedIds.clear(); render(); },
  "arrow.insert-pool": ({ id, at }: { id: string; at: Point }) => insertPoolInConnection(id, at),
  "arrow.split": ({ id, at }: { id: string; at: Point }) => splitConnection(id, at),
  "selection.secondary": toggleSelectedSecondary,
  "controls.menu": ({ open }: { open: boolean }) => setMenuOpen(open),
  "controls.dismiss-menu": () => setMenuOpen(false),
  "controls.fit-view": () => { setMenuOpen(false); fitView(); },
  "controls.reset": resetPlant,
  "controls.export-full": () => { setMenuOpen(false); copyPlantYaml("full"); },
  "controls.export-graph": () => { setMenuOpen(false); copyPlantYaml("graph"); },
  "controls.import": importPlantFromClipboard,
  "constraint.edit": (target: PlantQuantityRef) => {
    selectConstraintOwner(target);
    constraintUi.open(target);
  },
  "constraint.move-node": startComponentMove,
  "dialog.close": () => {
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (dialog?.id === "constraint-editor") constraintUi.close();
    else dialog?.close();
  },
});
dispatchGesture = (id, payload) => gestureFramework.dispatch(id, payload);
new MutationObserver(() => updateGestureHelp()).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
document.querySelectorAll<HTMLButtonElement>("dialog button[value='cancel']").forEach((button) => {
  button.addEventListener("click", (event) => { event.preventDefault(); gestureFramework.dispatch("dialog.close"); });
});
let helpPath: GestureContext[] = ["background", "canvas"];
let helpModality: GestureModality = matchMedia("(pointer: coarse)").matches ? "touch" : "mouse";
let helpPointer: Point | undefined;
let lastGestureHelpMarkup = "";

loadBrowserRecipeCatalog().then((catalog) => {
  recipes.push(...catalog.recipes);
  itemTags = catalog.itemTags;
  fluidTags = catalog.fluidTags;
  itemIcons = catalog.itemIcons;
  itemAnimations = catalog.itemAnimations;
  itemModelIds = catalog.itemModelIds;
  itemModels = catalog.itemModels;
  machineModelIds = catalog.machineModelIds;
  machineModels = catalog.machineModels;
  machineLayoutRules = catalog.machineLayoutRules;
  knownItems = collectRecipeItems(recipes, itemTags);
  recipesById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  plant = canonicalizePlantResources(plant, itemTags, fluidTags);
  ensureOutputDestinations();
  render();
}).catch(() => setStatus("Could not load the generated recipe catalog; run make build"));

menuToggle.addEventListener("click", () => gestureFramework.dispatch("controls.menu", { open: menuItems.hidden }));
document.addEventListener("pointermove", (event) => {
  helpPointer = { x: event.clientX, y: event.clientY };
  updateGestureHelp(document.elementFromPoint(event.clientX, event.clientY), event.pointerType === "touch" ? "touch" : "mouse");
}, { passive: true });
document.addEventListener("pointerdown", (event) => {
  helpPointer = { x: event.clientX, y: event.clientY };
  updateGestureHelp(document.elementFromPoint(event.clientX, event.clientY), event.pointerType === "touch" ? "touch" : "mouse");
}, { passive: true });
const tagPreview = $("#tag-preview");
let tagPreviewIdentity = "";
let tagPreviewHideTimer = 0;
document.addEventListener("pointerover", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-tag-alternatives]");
  if (!target) return;
  window.clearTimeout(tagPreviewHideTimer);
  const tagId = target.dataset.tagId;
  const type = target.dataset.tagType === "fluid" ? "fluid" : "item";
  let alternatives: unknown;
  try { alternatives = JSON.parse(target.dataset.tagAlternatives ?? "[]"); } catch { return; }
  if (!tagId || !Array.isArray(alternatives) || !alternatives.every((id) => typeof id === "string")) return;
  const identity = `${type}:${tagId}:${alternatives.join("|")}`;
  if (identity !== tagPreviewIdentity) {
    tagPreviewIdentity = identity;
    tagPreview.innerHTML = `<strong class="tag-preview-title">${escapeHtml(tagId)} · ${alternatives.length} matching resources</strong><div class="tag-preview-items">${alternatives.map((id) => {
      const resource = { type, id } as Resource;
      const icon = renderResourceIcon(resource, canvasState(), 28);
      return `<span class="tag-preview-item" title="${escapeHtml(id)}"><span class="tag-preview-icon">${icon ? `<svg viewBox="0 0 28 28">${icon}</svg>` : `<span class="tag-preview-fallback">${escapeHtml(tagFallback(id))}</span>`}</span><span>${escapeHtml(id)}</span></span>`;
    }).join("")}</div>`;
  }
  if (!tagPreview.matches(":popover-open")) tagPreview.showPopover();
  tagPreview.setAttribute("aria-hidden", "false");
  positionTagPreview(event);
});
document.addEventListener("pointermove", (event) => {
  if (tagPreview.matches(":popover-open")) positionTagPreview(event);
});
document.addEventListener("pointerout", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-tag-alternatives]");
  if (!target) return;
  if (event.relatedTarget instanceof Element && target.contains(event.relatedTarget)) return;
  window.clearTimeout(tagPreviewHideTimer);
  tagPreviewHideTimer = window.setTimeout(() => {
    if (tagPreview.matches(":popover-open")) tagPreview.hidePopover();
    tagPreview.setAttribute("aria-hidden", "true");
    tagPreviewIdentity = "";
  }, 80);
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as Element).closest(".canvas-menu") && !menuItems.hidden) gestureFramework.dispatch("controls.dismiss-menu");
});
document.addEventListener("visibilitychange", updateAnimationPlayback);
window.addEventListener("blur", updateAnimationPlayback);
window.addEventListener("focus", updateAnimationPlayback);
updateAnimationPlayback();
$("#fit-view").addEventListener("click", () => gestureFramework.dispatch("controls.fit-view"));
$("#reset-plant").addEventListener("click", () => gestureFramework.dispatch("controls.reset"));
$("#export-full").addEventListener("click", () => gestureFramework.dispatch("controls.export-full"));
$("#export-graph").addEventListener("click", () => gestureFramework.dispatch("controls.export-graph"));
$("#import-plant").addEventListener("click", () => gestureFramework.dispatch("controls.import"));
$("#delete-selected").addEventListener("click", () => gestureFramework.dispatch("selection.delete"));
$("#selection-controls").addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-secondary-flow]");
  const connection = button && plant.connections.find(({ id }) => id === button.dataset.secondaryFlow);
  if (!connection) return;
  gestureFramework.dispatch("selection.secondary", connection);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector("dialog[open]")) {
    event.preventDefault(); gestureFramework.dispatch("dialog.close"); return;
  }
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    if (!menuItems.hidden) { event.preventDefault(); gestureFramework.dispatch("controls.dismiss-menu"); return; }
    if (pendingPort) { event.preventDefault(); gestureFramework.dispatch("canvas.cancel-link"); return; }
  }
  const target = event.target as HTMLElement | null;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !event.altKey && !isTextEntry(target) && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    gestureFramework.dispatch("canvas.select-all");
    return;
  }
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (selectedIds.size === 0 && selected && plant.connections.some(({ id }) => id === selected)) {
    event.preventDefault(); gestureFramework.dispatch("selection.delete"); return;
  }
  if (selectedIds.size === 0 && selected) selectedIds.add(selected);
  if (selectedIds.size === 0) return;
  event.preventDefault(); gestureFramework.dispatch("selection.delete");
});
$("#plant-canvas").addEventListener("pointerdown", pointerDown);
$("#plant-canvas").addEventListener("pointermove", pointerMove);
$("#plant-canvas").addEventListener("pointerup", pointerUp);
$("#plant-canvas").addEventListener("pointercancel", pointerCancel);
$("#plant-canvas").addEventListener("contextmenu", (event) => {
  const edge = (event.target as Element).closest<SVGElement>("[data-edge]");
  if (!edge) return;
  event.preventDefault();
  const at = toWorld(screenPoint(event));
  if (event.shiftKey || event.ctrlKey) gestureFramework.dispatch("arrow.split", { id: edge.dataset.edge!, at });
  else gestureFramework.dispatch("arrow.insert-pool", { id: edge.dataset.edge!, at });
});
$("#plant-canvas").addEventListener("wheel", (event) => {
  event.preventDefault(); gestureFramework.dispatch("canvas.zoom", { factor: event.deltaY < 0 ? 1.1 : 1 / 1.1, point: screenPoint(event) });
}, { passive: false });
window.addEventListener("resize", render);

function addRecipe(recipe: Recipe) {
  const pending = pendingPort;
  const result = pending
    ? addPlantRecipeAtPort(plant, recipe, pending, {
      createId: nextId,
      resourcesMatch: (a, b) => resourcesMatch(a, b, itemTags, fluidTags),
    })
    : addPlantRecipe(plant, recipe, nextId);
  plant = result.plant;
  if (pending) { pendingPort = undefined; previewPoint = undefined; pruneDisconnectedBoundaries(); }
  const position = { x: 80 - view.x / view.scale, y: 80 - view.y / view.scale };
  positions[result.processId] = position;
  placeRecipeBoundaries(result.createdComponents, result.processId, position);
  selected = result.processId; selectedIds.clear(); selectedIds.add(result.processId); save(); render(); setStatus(pending ? "Process added and connected" : "Process added");
}

function expandBoundary(component: Extract<PlantComponent, { kind: "supply" | "demand" }>, ctrlKey = false) {
  const matchResource = (a: Resource, b: Resource) => resourcesMatch(a, b, itemTags, fluidTags);
  const action = component.kind === "supply"
    ? (ctrlKey ? "use" : "produce")
    : (ctrlKey ? "produce" : "use");
  const matchingRecipes = recipesForPlantBoundary(recipes, component, matchResource, action);
  const title = `${action[0].toUpperCase()}${action.slice(1)} ${short(component.resource.id)}`;
  pickers.openRecipePicker(title, matchingRecipes, (recipe) => {
    const oldPosition = positions[component.id] ?? { x: 0, y: 0 };
    const result = ctrlKey
      ? addPlantRecipeAtBoundary(plant, component.id, recipe, { createId: nextId, resourcesMatch: matchResource })
      : expandPlantBoundary(plant, component.id, recipe, { createId: nextId, resourcesMatch: matchResource });
    plant = result.plant;
    for (const id of "removedComponentIds" in result ? result.removedComponentIds : []) delete positions[id];
    const position = { x: oldPosition.x + (component.kind === "supply" ? (ctrlKey ? 260 : -260) : (ctrlKey ? -260 : 260)), y: oldPosition.y };
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

function render(reanalyze = true) {
  if (scheduledNodeMoveFrame !== undefined) {
    cancelAnimationFrame(scheduledNodeMoveFrame);
    scheduledNodeMoveFrame = undefined;
    pendingMovedIds.clear();
  }
  if (scheduledDragRender !== undefined) {
    cancelAnimationFrame(scheduledDragRender);
    scheduledDragRender = undefined;
    reanalyze ||= pendingRenderAnalysis;
    pendingRenderAnalysis = false;
  }
  if (reanalyze) rateAnalysis = recipes.length > 0 ? analyzePlantRates(plant, recipesById) : undefined;
  renderCanvas(canvasState());
  updateAnimationPlayback();
  renderSelectionUi();
  const problems = rateAnalysis?.issues ?? [];
  if (problems.length) setStatus(`${rateAnalysis?.status}: ${problems[0]}`);
  else if (rateAnalysis?.status === "underconstrained" && $("#status").textContent?.startsWith("invalid:")) setStatus("Rates are underconstrained");
}

function renderSelectionUi() {
  const components = new Map(plant.components.map((component) => [component.id, component]));
  const picked = components.get(selected);
  const pickedConnection = plant.connections.find(({ id }) => id === selected);
  const info = $("#selection-info");
  info.hidden = !picked && !pickedConnection && selectedIds.size === 0;
  $("#delete-selected").hidden = !picked && !pickedConnection && selectedIds.size === 0;
  $("#delete-selected").textContent = pickedConnection && !picked ? "Delete flow" : "Delete";
  $("#selection-label").textContent = selectedIds.size > 1 ? `${selectedIds.size} nodes selected` : picked
    ? picked.kind === "process" ? `Process · ${picked.recipeId}` : `${picked.kind === "supply" ? "Infinite input" : picked.kind === "demand" ? "Infinite output" : "Storage pool"} · ${picked.resource.id}`
    : pickedConnection ? `Flow · ${pickedConnection.from.resource.id}` : "";
  $("#selection-controls").innerHTML = selectedIds.size > 1 ? "" : picked ? constraintUi.controlsFor(picked)
    : pickedConnection ? `${constraintUi.controlFor({ kind: "connection-rate", connectionId: pickedConnection.id }, `Flow rate · ${pickedConnection.from.resource.id}`, rateDisplayUnit(pickedConnection.from.resource, getRateDisplayUnits()))}<button type="button" data-secondary-flow="${escapeHtml(pickedConnection.id)}">${pickedConnection.secondary ? "Mark primary" : "Mark secondary"}</button>`
    : "";
  updateGestureHelp();
}

function selectConstraintOwner(target: PlantQuantityRef) {
  const componentId = target.kind === "connection-rate" ? undefined
    : target.kind === "port-rate" ? target.port.componentId : target.componentId;
  if (componentId && !plant.components.some(({ id }) => id === componentId)) return;
  const connection = target.kind === "connection-rate" ? plant.connections.find(({ id }) => id === target.connectionId) : undefined;
  if (target.kind === "connection-rate" && !connection) return;
  selected = connection?.id ?? componentId ?? "";
  selectedIds.clear();
  if (componentId) selectedIds.add(componentId);
  for (const element of world.querySelectorAll<SVGGElement>("g[data-component]")) {
    element.classList.toggle("selected", selectedIds.has(element.dataset.component ?? ""));
  }
  for (const element of world.querySelectorAll<SVGGElement>(".edge-group")) {
    element.classList.toggle("selected", element.dataset.edge === selected);
  }
  renderSelectionUi();
}

function scheduleDragRender(reanalyze = false) {
  pendingRenderAnalysis ||= reanalyze;
  if (scheduledDragRender !== undefined) return;
  scheduledDragRender = requestAnimationFrame(() => {
    scheduledDragRender = undefined;
    const shouldReanalyze = pendingRenderAnalysis;
    pendingRenderAnalysis = false;
    render(shouldReanalyze);
  });
}

function scheduleNodeMoveRender(ids: string[]) {
  for (const id of ids) pendingMovedIds.add(id);
  if (scheduledNodeMoveFrame !== undefined) return;
  scheduledNodeMoveFrame = requestAnimationFrame(() => {
    scheduledNodeMoveFrame = undefined;
    const movedIds = [...pendingMovedIds];
    pendingMovedIds.clear();
    renderCanvasMovement(canvasState(), movedIds);
  });
}

function updateAnimationPlayback() {
  const pause = document.hidden || !document.hasFocus();
  document.querySelectorAll<SVGSVGElement>("svg").forEach((element) => {
    if (pause) element.pauseAnimations();
    else element.unpauseAnimations();
  });
}

function canvasState(): CanvasState {
  return {
    svg, world, interactionPreview, plant, recipesById, itemIcons, itemAnimations, itemModelIds, itemModels, machineModelIds, machineModels, machineLayoutRules, rateAnalysis, rateDisplayUnits: getRateDisplayUnits(), positions, portOrder, view, selected, selectedIds,
    pendingPort, previewPoint, reorderingPort: gesture?.kind === "port-reorder" ? gesture.port : undefined,
  };
}

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
  if (selectedIds.size === 0 && selected && plant.connections.some(({ id }) => id === selected)) {
    try {
      plant = deletePlantConnection(plant, selected);
      selected = ""; pruneDisconnectedBoundaries(); save(); render(); setStatus("Flow deleted");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not delete flow"); }
    return;
  }
  const ids = selectedIds.size ? [...selectedIds] : selected ? [selected] : [];
  let deleted = 0, mergedPools = 0;
  for (const id of ids) {
    const component = plant.components.find((item) => item.id === id);
    if (!component) continue;
    if (component.kind === "process") {
      selected = id; deleteSelectedProcess(); deleted++; continue;
    }
    if (component.kind === "pool") {
      const bypassed = bypassPlantPool(plant, id, nextId);
      if (bypassed) {
        plant = bypassed; delete positions[id]; selectedIds.delete(id); deleted++; mergedPools++; continue;
      }
    }
    if ((component.kind === "demand" || component.kind === "pool") && isLastProcessOutputDestination(id)) {
      setStatus("Cannot delete the only destination of a process output"); continue;
    }
    plant = removePlantComponent(plant, id); delete positions[id]; selectedIds.delete(id); deleted++;
  }
  selected = selectedIds.values().next().value ?? "";
  pruneDisconnectedBoundaries(); save(); render();
  if (deleted > 0) setStatus(mergedPools ? `Deleted ${deleted} node${deleted === 1 ? "" : "s"}; storage flows merged` : `Deleted ${deleted} selected node${deleted === 1 ? "" : "s"}`);
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
    const index = recipeOutputPorts(recipe).findIndex((output) => resourceKey(output.resource) === resourceKey(sink.resource));
    const position = positions[process.id] ?? { x: 0, y: 0 };
    positions[sink.id] = { x: position.x + 360, y: position.y + Math.max(index, 0) * 92 };
  }
  save();
  if (result.removedConnectionIds.length) setStatus(`Removed ${result.removedConnectionIds.length} invalid self-connection${result.removedConnectionIds.length === 1 ? "" : "s"}; restored process output destinations`);
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
    const list = component.kind === "supply" ? recipe?.inputs ?? [] : recipeOutputPorts(recipe);
    const index = list.findIndex((item) => resourceKey("resource" in item ? item.resource : item) === resourceKey(component.resource));
    positions[id] = { x: origin.x + (component.kind === "supply" ? -210 : 360), y: origin.y + Math.max(index, 0) * 92 };
  }
  return result.createdComponentIds;
}

function mergeBoundaries(sourceId: string, targetId: string) {
  const source = plant.components.find(({ id }) => id === sourceId);
  const target = plant.components.find(({ id }) => id === targetId);
  if (!source || !target || source.kind === "process" || target.kind === "process" || source.kind === "pool" || target.kind === "pool") return;
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

function insertPoolInConnection(connectionId: string, at: Point) {
  let result: ReturnType<typeof insertPoolInPlantConnection>;
  try { result = insertPoolInPlantConnection(plant, connectionId, nextId); }
  catch { return; }
  plant = result.plant;
  positions[result.poolId] = { x: at.x - 26, y: at.y - 26 };
  selected = result.poolId; selectedIds.clear(); selectedIds.add(result.poolId);
  save(); render(); setStatus("Storage pool inserted into flow");
}

function pointerDown(event: PointerEvent) {
  if (event.button === 2) return;
  const point = screenPoint(event); pointers.set(event.pointerId, point);
  if (pointers.size === 2) {
    gestureFramework.dispatch("canvas.zoom", { event, points: [...pointers.values()] as [Point, Point] });
    return;
  }
  if (event.button === 1) {
    gestureFramework.dispatch("canvas.pan-middle", { event, point });
    return;
  }
  if (event.shiftKey) {
    gestureFramework.dispatch("component.box-select", { event, point });
    return;
  }
  const constraintTarget = (event.target as Element).closest<SVGElement>("[data-constraint-target]");
  if (constraintTarget) {
    const target = (event.target as Element).closest<SVGGElement>("g[data-component]");
    const component = target && plant.components.find(({ id }) => id === target.dataset.component);
    if (component) {
      try {
        const quantity = JSON.parse(constraintTarget.dataset.constraintTarget!) as PlantQuantityRef;
        gestureFramework.dispatch("constraint.move-node", { event, point, component, constraintTarget: quantity });
      } catch { return; }
    }
    return;
  }
  const portElement = (event.target as Element).closest<SVGElement>("[data-port]");
  const portComponent = portElement && plant.components.find(({ id }) => id === portElement.dataset.component);
  if (portElement && event.pointerType !== "mouse" && (portComponent?.kind !== "pool" || pendingPort)) {
    gestureFramework.dispatch(portComponent?.kind === "pool" ? "pool.connect" : "port.connect", { port: portFromElement(portElement), touch: true }); return;
  }
  if (portElement && event.ctrlKey) {
    gestureFramework.dispatch("process.reorder-input-output", { event, point, port: portFromElement(portElement) });
    return;
  }
  const target = (event.target as Element).closest<SVGElement>("[data-component], [data-edge]");
  if (target?.dataset.component) {
    const component = plant.components.find(({ id }) => id === target!.dataset.component)!;
    gestureFramework.dispatch(event.pointerType === "mouse" && event.altKey ? "component.duplicate" : "component.move", { event, point, component });
    return;
  }
  if (target?.dataset.edge) { gestureFramework.dispatch("arrow.select", { id: target.dataset.edge }); return; }
  gestureFramework.dispatch("background.pan", { event, point });
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
    view = { scale, x: mid.x - worldAtMid.x * scale, y: mid.y - worldAtMid.y * scale };
    updateCanvasView(canvasState());
    if (pendingPort) renderCanvasInteractionPreview(canvasState());
    return;
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
      const h = component.kind === "process" ? processGeometry(recipe ? short(recipe.id) : component.recipeId, Math.max(recipe?.inputs.length ?? 0, recipeOutputPorts(recipe).length)).height : component.kind === "pool" ? 90 : 96;
      const w = component.kind === "process" ? 320 : component.kind === "pool" ? 52 : 70;
      return p.x <= rect.right && p.x + w >= rect.left && p.y <= rect.bottom && p.y + h >= rect.top;
    }).map(({ id }) => id));
    selected = selectedIds.values().next().value ?? "";
    scheduleDragRender(false); return;
  }
  if (gesture.kind === "pending" && distance(point, gesture.start) > 9) { clearTimeout(gesture.timer); gesture.moved = true; return; }
  if (gesture.kind === "duplicate") {
    let topologyChanged = false;
    if (!gesture.moved && distance(point, gesture.start) > 4) {
      gesture.ids = duplicateSelection(gesture.ids ?? []);
      topologyChanged = true;
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
      if (topologyChanged || scheduledDragRender !== undefined) scheduleDragRender(topologyChanged);
      else scheduleNodeMoveRender(gesture.ids);
    }
    return;
  }
  if (gesture.kind === "move" && gesture.id) {
    if (distance(point, gesture.start) > 4) gesture.moved = true;
    const dx = (point.x - gesture.start.x) / view.scale;
    const dy = (point.y - gesture.start.y) / view.scale;
    for (const id of gesture.ids ?? [gesture.id]) {
      const origin = gesture.origins?.[id] ?? (id === gesture.id ? gesture.origin : undefined);
      if (origin) positions[id] = { x: origin.x + dx, y: origin.y + dy };
    }
    scheduleNodeMoveRender(gesture.ids ?? [gesture.id]);
  } else if (gesture.kind === "pan") {
    if (distance(point, gesture.start) > 6) gesture.moved = true;
    view.x = gesture.origin.x + point.x - gesture.start.x; view.y = gesture.origin.y + point.y - gesture.start.y; updateCanvasView(canvasState());
  }
}

function pointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId); clearTimeout(gesture?.timer);
  if (isOutsideViewport(event) && (gesture?.kind === "move" || gesture?.kind === "duplicate")) {
    gestureFramework.dispatch("component.cancel-drag");
    return;
  }
  if (gesture?.kind === "port-action") {
    if (gesture.port) gestureFramework.dispatch(plant.components.find(({ id }) => id === gesture!.port!.componentId)?.kind === "pool" ? "pool.connect" : "port.connect", { port: gesture.port, touch: false });
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
  if (gesture?.constraintTarget && !gesture.moved) {
    gestureFramework.dispatch("constraint.edit", gesture.constraintTarget);
  } else {
    if (gesture?.kind === "pending" && !gesture.moved) {
      const component = plant.components.find(({ id }) => id === gesture!.id);
      if (component) gestureFramework.dispatch("component.select", { component, point: screenPoint(event), ctrlKey: event.ctrlKey, pointerType: event.pointerType });
    }
    if (gesture?.kind === "move" && gesture.pointerType === "mouse" && !gesture.moved) {
      const component = plant.components.find(({ id }) => id === gesture!.id);
      if (component) gestureFramework.dispatch("component.select", { component, point: screenPoint(event), ctrlKey: event.ctrlKey, pointerType: event.pointerType });
    }
  }
  if (gesture?.kind === "pan" && !gesture.moved && gesture.button !== 1) {
    handleBackgroundTap(screenPoint(event), false);
  }
  if (gesture?.kind === "move" && gesture.moved && gesture.id) {
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<SVGElement>("[data-component]");
    const targetId = element?.dataset.component;
    if (targetId && targetId !== gesture.id) gestureFramework.dispatch("boundary.merge", { sourceId: gesture.id, targetId });
  }
  if (gesture?.kind === "duplicate" && gesture.moved) setStatus(`Duplicated ${gesture.ids?.length ?? 0} nodes`);
  const movedComponent = (gesture?.kind === "move" || gesture?.kind === "duplicate") && gesture.moved;
  gesture = undefined; save();
  if (movedComponent) renderSelectionUi();
}
function handleBackgroundTap(point: Point, shiftKey: boolean) {
  const now = performance.now();
  lastBoundaryTap = undefined;
  gestureFramework.dispatch("background.deselect");
  if (lastCanvasTap && lastCanvasTap.shiftKey === shiftKey && now - lastCanvasTap.time < 360 && distance(point, lastCanvasTap.point) < 24) {
    lastCanvasTap = undefined;
    const location = toWorld(point);
    window.setTimeout(() => gestureFramework.dispatch(shiftKey ? "background.add-item" : "background.add-process", { location }), 0);
  } else lastCanvasTap = { time: now, point, shiftKey };
}

function openBackgroundPicker(itemPicker: boolean, location: Point) {
  if (itemPicker) {
    const options = pendingPort
      ? knownItems.filter((item) => resourcesMatch(item, pendingPort!.resource, itemTags, fluidTags))
      : knownItems;
    const kinds = pendingPort
      ? pendingPort.direction === "output" ? ["demand", "pool"] as const : ["supply", "pool"] as const
      : undefined;
    pickers.openItemPicker(location, options, kinds);
    return;
  }
  if (!pendingPort) {
    pickers.openRecipePicker("Add a process", recipes, addRecipe);
    return;
  }
  const pending = pendingPort;
  const action = pending.direction === "output" ? "use" : "produce";
  const boundary = pending.direction === "output"
    ? { id: "pending-link", kind: "demand" as const, resource: pending.resource }
    : { id: "pending-link", kind: "supply" as const, resource: pending.resource };
  const options = recipesForPlantBoundary(recipes, boundary, (a, b) => resourcesMatch(a, b, itemTags, fluidTags), action);
  pickers.openRecipePicker(`Connect ${short(pending.resource.id)} · choose a process`, options, addRecipe);
}

function startCanvasPan({ event, point }: { event: PointerEvent; point: Point }) {
  svg.setPointerCapture(event.pointerId);
  gesture = { kind: "pan", button: event.button, start: point, origin: { x: view.x, y: view.y } };
  if (event.button === 1) event.preventDefault();
}

function startCanvasPinch(event: PointerEvent, [a, b]: [Point, Point]) {
  svg.setPointerCapture(event.pointerId);
  clearTimeout(gesture?.timer);
  gesture = { kind: "pinch", start: midpoint(a, b), origin: { ...view }, pinchDistance: distance(a, b), pinchScale: view.scale };
}

function startBoxSelect({ event, point }: { event: PointerEvent; point: Point }) {
  svg.setPointerCapture(event.pointerId);
  gesture = { kind: "box-select", start: point, origin: point, shiftKey: true };
  const box = $("#marquee"); box.hidden = false; box.setAttribute("x", String(point.x)); box.setAttribute("y", String(point.y)); box.setAttribute("width", "0"); box.setAttribute("height", "0");
  event.preventDefault();
}

function startPortAction({ event, point, port }: { event: PointerEvent; point: Point; port: PortRef }) {
  svg.setPointerCapture(event.pointerId);
  gesture = { kind: "port-action", port, start: point, origin: point };
  event.preventDefault();
}

function startComponentMove({ event, point, component, constraintTarget }: { event: PointerEvent; point: Point; component: PlantComponent; constraintTarget?: PlantQuantityRef }) {
  startComponentGesture(event, point, component, false);
  if (gesture) gesture.constraintTarget = constraintTarget;
}

function startComponentDuplicate({ event, point, component }: { event: PointerEvent; point: Point; component: PlantComponent }) {
  startComponentGesture(event, point, component, true);
}

function startComponentGesture(event: PointerEvent, point: Point, component: PlantComponent, duplicate: boolean) {
  const worldPoint = toWorld(point);
  const initialSelected = selected, initialSelectedIds = [...selectedIds];
  svg.setPointerCapture(event.pointerId);
  if (!selectedIds.has(component.id)) { selectedIds.clear(); selectedIds.add(component.id); }
  selected = component.id;
  const ids = [...selectedIds];
  const origins = Object.fromEntries(ids.map((id) => [id, positions[id] ?? (id === component.id ? worldPoint : { x: 0, y: 0 })]));
  if (event.pointerType === "mouse") {
    gesture = { kind: duplicate ? "duplicate" : "move", id: component.id, ids, origins, pointerType: event.pointerType, start: point, origin: origins[component.id], ...(duplicate ? { initialPlant: plant, initialPositions: { ...positions }, initialPortOrder: { ...portOrder }, initialSelected, initialSelectedIds } : {}) };
  } else {
    gesture = { kind: "pending", id: component.id, ids, origins, pointerType: event.pointerType, start: point, origin: origins[component.id], timer: window.setTimeout(() => {
      if (gesture?.kind === "pending" && gesture.id === component.id) { gesture.kind = "move"; setStatus(`Moving ${component.kind === "process" ? "process" : component.kind === "pool" ? "pool" : "resource"}`); }
    }, 420) };
  }
  renderSelectionUi();
  event.preventDefault();
}

function deselectCanvas() {
  selected = "";
  selectedIds.clear();
  render();
}

function selectTappedComponent(component: PlantComponent, point: Point, ctrlKey: boolean, pointerType: string) {
  selected = component.id;
  selectedIds.clear(); selectedIds.add(component.id);
  render();
  if (component.kind === "process") {
    lastBoundaryTap = undefined;
    setStatus("Process selected");
    return;
  }
  if (component.kind === "pool") {
    lastBoundaryTap = undefined;
    setStatus(`Storage pool · ${component.resource.id}`);
    return;
  }
  const now = performance.now();
  const requiresControl = pointerType === "mouse";
  const modifierMatches = lastBoundaryTap?.ctrlKey === ctrlKey;
  if (lastBoundaryTap?.componentId === component.id && modifierMatches && now - lastBoundaryTap.time < 420 && distance(point, lastBoundaryTap.point) < 24) {
    lastBoundaryTap = undefined;
    window.setTimeout(() => gestureFramework.dispatch(ctrlKey ? "boundary.expand-reverse" : "boundary.expand", { component }), 0);
  } else {
    lastBoundaryTap = { time: now, point, componentId: component.id, ctrlKey };
    const normalAction = component.kind === "supply" ? "produce" : "use";
    const controlAction = component.kind === "supply" ? "use" : "produce";
    const doubleGesture = pointerType === "mouse" ? "Double-click" : "Double-tap";
    setStatus(pointerType === "mouse" && ctrlKey
      ? `Ctrl-double-click to ${controlAction} ${short(component.resource.id)}`
      : `${doubleGesture} to ${normalAction} ${short(component.resource.id)}${pointerType === "mouse" ? ` · Ctrl-double-click to ${controlAction}` : ""}`);
  }
}
function pointerCancel(event: PointerEvent) {
  pointers.delete(event.pointerId); clearTimeout(gesture?.timer);
  if (gesture?.kind === "move" || gesture?.kind === "duplicate") cancelNodeDrag();
  $("#marquee").hidden = true; gesture = undefined; previewPoint = undefined; renderCanvasInteractionPreview(canvasState());
}

function cancelNodeDrag() {
  if (gesture?.kind === "duplicate" && gesture.initialPlant) {
    plant = gesture.initialPlant;
    positions = gesture.initialPositions ?? positions;
    portOrder = gesture.initialPortOrder ?? portOrder;
    selected = gesture.initialSelected ?? "";
    selectedIds = new Set(gesture.initialSelectedIds ?? []);
  } else if (gesture?.kind === "move") {
    for (const [id, origin] of Object.entries(gesture.origins ?? {})) positions[id] = origin;
  }
  gesture = undefined; previewPoint = undefined; save(); render(); setStatus("Drag cancelled");
}

function isOutsideViewport(event: PointerEvent): boolean {
  return event.clientX < 0 || event.clientY < 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
}

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
  const component = plant.components.find(({ id }) => id === port.componentId);
  if (component?.kind === "pool") {
    if (pendingPort?.componentId === component.id) { gestureFramework.dispatch("canvas.cancel-link"); return; }
    port = { ...port, direction: pendingPort ? pendingPort.direction === "output" ? "input" : "output" : "output" };
  }
  if (pendingPort && samePort(pendingPort, port)) {
    gestureFramework.dispatch("canvas.cancel-link");
    return;
  }
  if (!pendingPort) {
    pendingPort = port;
    const component = plant.components.find(({ id }) => id === port.componentId);
    if (!component) return;
    previewPoint = portPoint(canvasState(), component, port.direction, port.resource);
    render();
    setStatus(`Selected ${port.direction} ${short(port.resource.id)}; ${touch ? "tap" : "Ctrl-click"} matching ${port.direction === "output" ? "input" : "output"}, or select this port again to cancel`);
    return;
  }
  const from = pendingPort.direction === "output" ? pendingPort : port;
  const to = pendingPort.direction === "input" ? pendingPort : port;
  try {
    if (!resourcesMatch(from.resource, to.resource, itemTags, fluidTags)) throw new Error("Choose ports for matching materials");
    const result = togglePlantConnection(plant, { id: nextId("flow"), from, to });
    plant = result.plant;
    pendingPort = undefined; previewPoint = undefined; pruneDisconnectedBoundaries(); save(); render(); setStatus(result.connected ? "Flow connected" : "Flow removed");
  } catch (error) { pendingPort = undefined; previewPoint = undefined; render(); setStatus(error instanceof Error ? error.message : "Could not connect ports"); }
}

function cancelPortLink() {
  pendingPort = undefined;
  previewPoint = undefined;
  render();
  setStatus("Link cancelled");
}

function reorderPort(port: PortRef, point: Point) {
  const component = plant.components.find(({ id }) => id === port.componentId);
  if (component?.kind !== "process") return;
  const recipe = recipesById.get(component.recipeId);
  if (!recipe) return;
  const ports = port.direction === "input" ? recipe.inputs : recipeOutputPorts(recipe);
  const ordered = orderedPorts(portOrder, component.id, port.direction, ports);
  const keys = ordered.map((item) => resourceKey("resource" in item ? item.resource : item));
  const sourceIndex = keys.indexOf(resourceKey(port.resource));
  if (sourceIndex < 0 || keys.length < 2) return;
  const processPosition = positions[component.id] ?? { x: 0, y: 0 };
  const targetIndex = Math.max(0, Math.min(keys.length - 1, Math.round((point.y - processPosition.y - processGeometry(short(recipe.id), Math.max(recipe.inputs.length, recipeOutputPorts(recipe).length)).portTop) / 44)));
  if (targetIndex === sourceIndex) return;
  const [moved] = keys.splice(sourceIndex, 1);
  keys.splice(targetIndex, 0, moved);
  portOrder[component.id] = { ...portOrder[component.id], [port.direction]: keys };
  save(); render(); setStatus(`${port.direction === "input" ? "Inputs" : "Outputs"} reordered`);
}
function addItemBoundary(kind: "supply" | "demand" | "pool", item: Resource, position: Point) {
  const pending = pendingPort;
  let id: string;
  if (pending) {
    const result = addPlantBoundaryAtPort(plant, kind, item, pending, {
      createId: nextId,
      resourcesMatch: (a, b) => resourcesMatch(a, b, itemTags, fluidTags),
    });
    plant = result.plant;
    id = result.componentId;
    pendingPort = undefined; previewPoint = undefined; pruneDisconnectedBoundaries();
  } else {
    id = nextId(kind === "supply" ? "source" : kind === "demand" ? "sink" : "pool");
    plant = addPlantComponent(plant, { id, kind, resource: item });
  }
  const size = kind === "pool" ? 52 : 70;
  positions[id] = { x: position.x - size / 2, y: position.y - size / 2 };
  selected = id; selectedIds.clear(); selectedIds.add(id);
  save(); render(); setStatus(pending ? `Connected ${item.id}` : `${kind === "supply" ? "Infinite input" : kind === "demand" ? "Infinite output" : "Storage pool"} added: ${item.id}`);
}

function setMenuOpen(open: boolean) {
  menuItems.hidden = !open;
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close canvas menu" : "Open canvas menu");
  updateGestureHelp();
}

function resetPlant() {
  setMenuOpen(false);
  plant = createPlant("main"); positions = {}; portOrder = {}; selected = ""; selectedIds.clear(); pendingPort = undefined;
  save(); render(); setStatus("Plant reset");
}

function selectAllNodes() {
  selectedIds = new Set(plant.components.map(({ id }) => id));
  selected = selectedIds.size === 1 ? selectedIds.values().next().value ?? "" : "";
  render();
  setStatus(`Selected ${selectedIds.size} node${selectedIds.size === 1 ? "" : "s"}`);
}

function toggleSelectedSecondary(connection = plant.connections.find(({ id }) => id === selected)) {
  if (!connection) return;
  plant = setPlantConnectionSecondary(plant, connection.id, !connection.secondary);
  save(); render(); setStatus(connection.secondary ? "Flow marked primary" : "Flow marked secondary");
}

function updateGestureHelp(target?: Element | null, modality?: GestureModality) {
  if (modality) helpModality = modality;
  if (!target && helpPointer) target = document.elementFromPoint(helpPointer.x, helpPointer.y);
  if (document.querySelector("dialog[open]")) helpPath = ["modal"];
  else if (target && !target.closest("#gesture-help")) helpPath = resolveGestureContext(target);
  const components = new Map(plant.components.map((component) => [component.id, component]));
  const selectedConnection = plant.connections.find(({ id }) => id === selected);
  const selectedComponent = components.get(selected);
  const hoveredComponentId = target?.closest<SVGElement>("[data-component]")?.dataset.component;
  const hoveredComponent = hoveredComponentId ? components.get(hoveredComponentId) : undefined;
  const hoveredPort = target?.closest<SVGElement>("[data-port]");
  const hoveredResource = hoveredPort?.dataset.resource?.split(":").slice(1).join(":") ||
    (hoveredComponent && hoveredComponent.kind !== "process" ? hoveredComponent.resource.id : undefined);
  const state: GestureState = {
    modality: helpModality,
    pendingConnection: pendingPort !== undefined,
    selectionCount: selectedIds.size || (selected || selectedConnection ? 1 : 0),
    selectedKind: selectedConnection ? "arrow" : selectedComponent?.kind,
    hoveredKind: hoveredComponent?.kind,
    hoveredResource: hoveredResource ? short(hoveredResource) : undefined,
    hoveredDirection: hoveredPort?.dataset.port as "input" | "output" | undefined,
    menuOpen: !menuItems.hidden,
    draggingComponent: gesture?.kind === "move" || gesture?.kind === "duplicate",
  };
  const groups = gestureFramework.groups(helpPath, state);
  const markup = `<h2>Actions here</h2>${groups.map(({ label, actions }) => `<section><h3>${label}</h3><ul>${actions.map(({ description }) => {
    const [trigger, ...action] = description.split(" · ");
    return `<li><kbd>${escapeHtml(trigger)}</kbd><span>${escapeHtml(action.join(" · "))}</span></li>`;
  }).join("")}</ul></section>`).join("")}`;
  if (markup !== lastGestureHelpMarkup) {
    $("#gesture-help").innerHTML = markup;
    lastGestureHelpMarkup = markup;
  }
}

async function copyPlantYaml(mode: PlantTransferMode) {
  try {
    await navigator.clipboard.writeText(plantTransferYaml(plant, mode, { positions, portOrder }));
    setStatus(`${mode === "full" ? "Full plant" : "Graph-only plant"} YAML copied to clipboard`);
  } catch {
    setStatus("Could not write to clipboard; allow clipboard access and try again");
  }
}

async function importPlantFromClipboard() {
  setMenuOpen(false);
  try {
    const transfer = parsePlantTransferYaml(await navigator.clipboard.readText());
    const missingRecipes = transfer.plant.components.flatMap((component) =>
      component.kind === "process" && !recipesById.has(component.recipeId) ? [component.recipeId] : []);
    if (missingRecipes.length) throw new Error(`Unknown recipe${missingRecipes.length === 1 ? "" : "s"}: ${missingRecipes.slice(0, 3).join(", ")}`);

    const defaults = positionsForImportedGraph(transfer.plant);
    const componentIds = new Set(transfer.plant.components.map(({ id }) => id));
    plant = canonicalizePlantResources(transfer.plant, itemTags, fluidTags);
    positions = transfer.mode === "full"
      ? { ...defaults, ...Object.fromEntries(Object.entries(transfer.layout!.positions).filter(([id]) => componentIds.has(id))) }
      : defaults;
    portOrder = transfer.mode === "full"
      ? Object.fromEntries(Object.entries(transfer.layout!.portOrder).filter(([id]) => componentIds.has(id)))
      : {};
    selected = ""; selectedIds.clear(); pendingPort = undefined; previewPoint = undefined; gesture = undefined;
    ensureOutputDestinations();
    for (const component of plant.components) positions[component.id] ??= defaults[component.id] ?? { x: 80, y: 80 };
    save(); fitView();
    setStatus(`${transfer.mode === "full" ? "Full plant" : "Graph-only plant"} imported from clipboard`);
  } catch (error) {
    setStatus(error instanceof Error ? `Import failed: ${error.message}` : "Import failed: clipboard access unavailable");
  }
}

function positionsForImportedGraph(graph: Plant): Record<string, Point> {
  const processes = graph.components.filter((component) => component.kind === "process");
  const processIds = new Set(processes.map(({ id }) => id));
  const outgoing = new Map(processes.map(({ id }) => [id, [] as string[]]));
  const incoming = new Map(processes.map(({ id }) => [id, 0]));
  for (const connection of graph.connections) {
    const from = connection.from.componentId, to = connection.to.componentId;
    if (!processIds.has(from) || !processIds.has(to)) continue;
    outgoing.get(from)!.push(to);
    incoming.set(to, incoming.get(to)! + 1);
  }

  const layers = new Map<string, number>();
  const assignFrom = (start: string, initial: number) => {
    const queue: Array<[string, number]> = [[start, initial]];
    while (queue.length) {
      const [id, layer] = queue.shift()!;
      if (layers.has(id)) continue;
      layers.set(id, layer);
      outgoing.get(id)?.forEach((next) => queue.push([next, layer + 1]));
    }
  };
  processes.filter(({ id }) => incoming.get(id) === 0).forEach(({ id }) => assignFrom(id, 0));
  let nextLayer = layers.size ? Math.max(...layers.values()) + 1 : 0;
  for (const { id } of processes) if (!layers.has(id)) assignFrom(id, nextLayer++);

  const grouped = new Map<number, string[]>();
  for (const { id } of processes) {
    const layer = layers.get(id) ?? 0;
    grouped.set(layer, [...(grouped.get(layer) ?? []), id]);
  }
  const positions: Record<string, Point> = {};
  for (const [layer, ids] of grouped) ids.forEach((id, row) => {
    positions[id] = { x: 80 + layer * 520, y: 80 + row * 420 };
  });

  const boundaryRows = new Map<string, number>();
  for (const component of graph.components) {
    if (component.kind === "process") continue;
    if (component.kind === "pool") {
      const neighbors = graph.connections.filter((edge) => edge.from.componentId === component.id || edge.to.componentId === component.id)
        .map((edge) => edge.from.componentId === component.id ? edge.to.componentId : edge.from.componentId)
        .map((id) => positions[id]).filter((point): point is Point => !!point);
      if (neighbors.length) positions[component.id] = {
        x: neighbors.reduce((sum, point) => sum + point.x, 0) / neighbors.length + 134,
        y: neighbors.reduce((sum, point) => sum + point.y, 0) / neighbors.length + 100,
      };
      continue;
    }
    const connection = graph.connections.find((edge) => component.kind === "supply"
      ? edge.from.componentId === component.id : edge.to.componentId === component.id);
    const processId = connection && (component.kind === "supply" ? connection.to.componentId : connection.from.componentId);
    const processPosition = processId ? positions[processId] : undefined;
    if (processPosition) {
      const row = boundaryRows.get(processId!) ?? 0;
      boundaryRows.set(processId!, row + 1);
      positions[component.id] = {
        x: processPosition.x + (component.kind === "supply" ? -210 : 360),
        y: processPosition.y + 60 + row * 92,
      };
    }
  }
  graph.components.forEach((component, index) => {
    positions[component.id] ??= { x: 80 + (index % 3) * 520, y: 80 + Math.floor(index / 3) * 420 };
  });
  return positions;
}

function isTextEntry(target: HTMLElement | null): boolean {
  return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function fitView() {
  if (!plant.components.length) { view = { x: 0, y: 0, scale: 1 }; updateCanvasView(canvasState()); return; }
  const boxes = plant.components.map((component) => {
    const p = positions[component.id] ?? { x: 0, y: 0 };
    if (component.kind === "pool") return { left: p.x - 8, top: p.y, right: p.x + 60, bottom: p.y + 89 };
    if (component.kind !== "process") return { left: p.x, top: p.y, right: p.x + 70, bottom: p.y + 96 };
    const recipe = recipesById.get(component.recipeId);
    const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputPorts(recipe).length);
    return { left: p.x, top: p.y, right: p.x + 320, bottom: p.y + processGeometry(short(recipe?.id ?? component.recipeId), rows).height };
  });
  const graphLeft = Math.min(...boxes.map((box) => box.left)), graphRight = Math.max(...boxes.map((box) => box.right));
  for (const y of connectionLanes(canvasState()).values()) boxes.push({ left: graphLeft - 32, top: y, right: graphRight + 32, bottom: y });
  const minX = Math.min(...boxes.map((box) => box.left)), maxX = Math.max(...boxes.map((box) => box.right));
  const minY = Math.min(...boxes.map((box) => box.top)), maxY = Math.max(...boxes.map((box) => box.bottom));
  const rect = svg.getBoundingClientRect(); view.scale = Math.max(.35, Math.min(1.5, Math.min((rect.width - 80) / (maxX - minX), (rect.height - 80) / (maxY - minY))));
  view.x = (rect.width - (maxX - minX) * view.scale) / 2 - minX * view.scale;
  view.y = (rect.height - (maxY - minY) * view.scale) / 2 - minY * view.scale; updateCanvasView(canvasState());
}
function zoomAt(factor: number, point: Point) {
  const scale = Math.max(.35, Math.min(2.5, view.scale * factor));
  const worldPoint = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
  view = { scale, x: point.x - worldPoint.x * scale, y: point.y - worldPoint.y * scale }; updateCanvasView(canvasState());
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
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function tagFallback(id: string): string { return id.split(":").at(-1)?.slice(0, 3).toUpperCase() ?? "?"; }
function positionTagPreview(event: PointerEvent) {
  const margin = 10, gap = 14;
  const bounds = tagPreview.getBoundingClientRect();
  const left = event.clientX + gap + bounds.width <= window.innerWidth - margin ? event.clientX + gap : event.clientX - gap - bounds.width;
  const top = event.clientY + gap + bounds.height <= window.innerHeight - margin ? event.clientY + gap : event.clientY - gap - bounds.height;
  tagPreview.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - bounds.width - margin))}px`;
  tagPreview.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - bounds.height - margin))}px`;
}
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
