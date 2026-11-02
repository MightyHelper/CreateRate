import type { Plant, PlantComponent, PlantQuantityRef, PortRef, Resource } from "../plant.ts";
import { resourceKey } from "../plant.ts";
import { constraintTargetsFor, machineLayoutForRecipe, perMinuteToDisplayRate, plantProcessMetrics, plantQuantityState, rateDisplayUnit, recipeOutputPorts } from "../core/index.ts";
import type { MachineLayout } from "../core/index.ts";
import type { RateDisplayUnits } from "../core/index.ts";
import type { Ingredient, MachineLayoutRules, MachineModel, MachineModelElement, Recipe, TextureAnimation } from "../recipes.ts";
import type { PlantRateAnalysis, RateValue } from "../plant-analysis.ts";
import { rasterizeModel } from "./model-raster.ts";
import type { RasterModel, RasterTriangle } from "./model-raster.ts";

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

export type CanvasPoint = { x: number; y: number };
export type CanvasState = {
  svg: SVGSVGElement;
  world: SVGGElement;
  interactionPreview: SVGGElement;
  plant: Plant;
  recipesById: Map<string, Recipe>;
  itemIcons: Record<string, string>;
  itemAnimations: Record<string, TextureAnimation>;
  itemModelIds: Record<string, string>;
  itemModels: Record<string, MachineModel>;
  machineModelIds: Record<string, string>;
  machineModels: Record<string, MachineModel>;
  machineLayoutRules: MachineLayoutRules;
  rateDisplayUnits: RateDisplayUnits;
  rateAnalysis?: PlantRateAnalysis;
  positions: Record<string, CanvasPoint>;
  portOrder: Record<string, { input?: string[]; output?: string[] }>;
  view: { x: number; y: number; scale: number };
  selected: string;
  selectedIds: Set<string>;
  pendingPort?: PortRef;
  previewPoint?: CanvasPoint;
  reorderingPort?: PortRef;
};

export function processGeometry(title: string, rows: number) {
  const titleLines = wrapProcessTitle(title);
  const shift = (titleLines.length - 1) * 14;
  return { titleLines, shift, portTop: 98 + shift, height: Math.max(140, 96 + rows * 44) + shift };
}

let hoveredEdgeLabel: SVGTextElement | undefined;

export function renderCanvas(state: CanvasState) {
  latestCanvasState = state;
  const { plant, recipesById, positions, portOrder, view, selected, selectedIds } = state;
  const components = new Map(plant.components.map((component) => [component.id, component]));
  const returnLanes = connectionLanes(state);
  const markup: string[] = [];
  for (const edge of plant.connections) {
    const from = components.get(edge.from.componentId), to = components.get(edge.to.componentId);
    if (!from || !to) continue;
    const a = portPoint(state, from, edge.from.direction, edge.from.resource, componentCenter(state, to));
    const b = portPoint(state, to, edge.to.direction, edge.to.resource, componentCenter(state, from));
    const fromTangent = portTangent(state, from, edge.from.direction, a);
    const toTangent = portTangent(state, to, edge.to.direction, b);
    const laneY = returnLanes.get(edge.id);
    const path = connectionPath(a, b, laneY, fromTangent, toTangent);
    const edgeRate = rateForConnection(state.rateAnalysis, edge.id);
    const labelX = (a.x + b.x) / 2, labelY = laneY === undefined ? (a.y + b.y) / 2 - 8 : laneY - 8;
    const iconMarkup = resourceIconMarkup(edge.from.resource, state, "edge-icon", labelX - 12, labelY - 22, 24);
    markup.push(`<g class="edge-group ${selected === edge.id ? "selected" : ""}" tabindex="0" data-edge="${esc(edge.id)}"><path class="edge ${edge.secondary ? "secondary" : ""}" d="${path}"/><path class="edge-hit" d="${path}"/>${iconMarkup}<text class="edge-label ${rateClass(edgeRate)}" data-base-x="${labelX}" data-base-y="${labelY}" x="${labelX}" y="${labelY}" text-anchor="middle">${esc(short(edge.from.resource.id))} · ${esc(rateText(edgeRate, edge.from.resource, state.rateDisplayUnits))}</text></g>`);
  }
  for (const component of plant.components) {
    const p = positions[component.id] ?? (positions[component.id] = { x: 0, y: 0 });
    if (component.kind === "pool") {
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: component.resource } };
      const rate = rateForPort(state.rateAnalysis, target);
      const iconMarkup = resourceIconMarkup(component.resource, state, "pool-image", 8, 8, 36)
        || `<text class="pool-fallback" x="26" y="31">${esc(icon(component.resource.id))}</text>`;
      markup.push(`<g class="pool ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${p.x} ${p.y})"><circle class="pool-body ${state.pendingPort?.componentId === component.id ? "link-active" : ""}" cx="26" cy="26" r="26"/><circle class="pool-port-hit" data-port="output" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(component.resource))}" cx="26" cy="26" r="25"/>${iconMarkup}<text class="pool-name" x="26" y="64">${esc(short(component.resource.id))}</text><rect class="rate-hit" data-constraint-target="${esc(JSON.stringify(target))}" x="-8" y="67" width="68" height="22" rx="5"/><text class="pool-rate ${rateClass(rate)}" data-constraint-target="${esc(JSON.stringify(target))}" x="26" y="83" text-anchor="middle">${esc(rateText(rate, component.resource, state.rateDisplayUnits))}</text></g>`);
      continue;
    }
    if (component.kind !== "process") {
      const direction = component.kind === "supply" ? "output" : "input";
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction, resource: component.resource } };
      const rate = rateForPort(state.rateAnalysis, target);
      const portX = component.kind === "supply" ? 70 : 0;
      const iconMarkup = resourceIconMarkup(component.resource, state, "resource-image", 7, 3, 56)
        || `<text class="resource-icon" x="35" y="29">${esc(icon(component.resource.id))}</text>`;
      markup.push(`<g class="resource ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${p.x} ${p.y})"><rect class="resource-body" width="70" height="70" rx="10"/>${iconMarkup}<text class="resource-name" x="35" y="67">${esc(short(component.resource.id))}</text><circle class="port-hit" data-port="${direction}" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(component.resource))}" cx="${portX}" cy="35" r="14"/><circle class="port-dot boundary-port ${isPendingPortTarget(state, component.id, direction, component.resource) ? "link-active" : ""}" cx="${portX}" cy="35" r="5"/><rect class="rate-hit" data-constraint-target="${esc(JSON.stringify(target))}" x="12" y="72" width="46" height="24" rx="5"/><text class="resource-rate ${rateClass(rate)}" data-constraint-target="${esc(JSON.stringify(target))}" x="35" y="89">${esc(rateText(rate, component.resource, state.rateDisplayUnits))}</text></g>`);
      continue;
    }
    markup.push(processNodeMarkup(component, state));
  }
  state.world.innerHTML = markup.join("");
  hoveredEdgeLabel = undefined;
  updateCanvasView(state);
  renderCanvasInteractionPreview(state);
  $("#empty-hint").hidden = plant.components.length > 0;
}

export function updateCanvasView(state: CanvasState) {
  latestCanvasState = state;
  const transform = `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`;
  state.world.setAttribute("transform", transform);
  state.interactionPreview.setAttribute("transform", transform);
  $("#grid").setAttribute("patternTransform", transform);
}

export function renderCanvasMovement(state: CanvasState, movedIds: string[]) {
  latestCanvasState = state;
  const components = new Map(state.plant.components.map((component) => [component.id, component]));
  const componentElements = new Map([...state.world.querySelectorAll<SVGGElement>("g[data-component]")].map((element) => [element.dataset.component, element]));
  for (const id of movedIds) {
    const element = componentElements.get(id);
    const position = state.positions[id];
    if (element && position) element.setAttribute("transform", `translate(${position.x} ${position.y})`);
  }
  for (const element of state.world.querySelectorAll<SVGGElement>("g[data-component]")) {
    element.classList.toggle("selected", state.selected === element.dataset.component || state.selectedIds.has(element.dataset.component ?? ""));
  }
  for (const element of state.world.querySelectorAll<SVGGElement>(".edge-group")) {
    element.classList.toggle("selected", state.selected === element.dataset.edge);
  }

  const lanes = connectionLanes(state);
  const edgeElements = new Map([...state.world.querySelectorAll<SVGGElement>(".edge-group")].map((element) => [element.dataset.edge, element]));
  for (const edge of state.plant.connections) {
    const element = edgeElements.get(edge.id);
    const from = components.get(edge.from.componentId), to = components.get(edge.to.componentId);
    if (!element || !from || !to) continue;
    const a = portPoint(state, from, edge.from.direction, edge.from.resource, componentCenter(state, to));
    const b = portPoint(state, to, edge.to.direction, edge.to.resource, componentCenter(state, from));
    const laneY = lanes.get(edge.id);
    const path = connectionPath(a, b, laneY, portTangent(state, from, edge.from.direction, a), portTangent(state, to, edge.to.direction, b));
    element.querySelector<SVGPathElement>(".edge")?.setAttribute("d", path);
    element.querySelector<SVGPathElement>(".edge-hit")?.setAttribute("d", path);
    const labelX = (a.x + b.x) / 2;
    const labelY = laneY === undefined ? (a.y + b.y) / 2 - 8 : laneY - 8;
    const label = element.querySelector<SVGTextElement>(".edge-label");
    if (label) {
      label.setAttribute("x", String(labelX));
      label.setAttribute("y", String(labelY));
      label.dataset.baseX = String(labelX);
      label.dataset.baseY = String(labelY);
    }
    const icon = element.querySelector<SVGElement>(".edge-icon");
    if (icon) {
      icon.setAttribute("x", String(labelX - 12));
      icon.setAttribute("y", String(labelY - 22));
      icon.dataset.baseX = String(labelX - 12);
      icon.dataset.baseY = String(labelY - 22);
    }
  }
  if (state.pendingPort || state.reorderingPort) renderCanvasInteractionPreview(state);
}

export function renderRecipePreview(recipe: Recipe, state: CanvasState): string {
  const component: Extract<PlantComponent, { kind: "process" }> = { id: "recipe-preview", kind: "process", recipeId: recipe.id };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.innerHTML = '<defs id="machine-model-defs"></defs>';
  const previewState: CanvasState = {
    ...state,
    svg,
    plant: { id: "recipe-preview", components: [component], connections: [], constraints: [] },
    recipesById: new Map([[recipe.id, recipe]]),
    rateAnalysis: undefined,
    positions: { [component.id]: { x: 12, y: 8 } },
    portOrder: {},
    selected: "",
    selectedIds: new Set(),
  };
  const markup = processNodeMarkup(component, previewState);
  const defs = svg.querySelector("#machine-model-defs")?.outerHTML ?? "<defs></defs>";
  const rows = Math.max(recipe.inputs.length, recipeOutputPorts(recipe).length);
  const height = processGeometry(short(recipe.id), rows).height + 16;
  return `<svg class="recipe-preview-svg" viewBox="0 0 344 ${height}" role="img" aria-label="${esc(recipe.id)} preview">${defs}<g>${markup}</g></svg>`;
}

function processNodeMarkup(component: Extract<PlantComponent, { kind: "process" }>, state: CanvasState): string {
  const { plant, recipesById, positions, portOrder, selected, selectedIds } = state;
  const recipe = recipesById.get(component.recipeId);
  const ins = orderedPorts(portOrder, component.id, "input", recipe?.inputs ?? []);
  const outs = orderedPorts(portOrder, component.id, "output", recipeOutputPorts(recipe));
  const rows = Math.max(ins.length, outs.length);
  const geometry = processGeometry(recipe ? short(recipe.id) : component.recipeId, rows);
  const { height, portTop, shift } = geometry;
  const primaryOutput = outs[0];
  const primaryRate = primaryOutput ? rateForPort(state.rateAnalysis, { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: primaryOutput.resource } }) : undefined;
  const productionRate = primaryOutput ? rateText(primaryRate, primaryOutput.resource, state.rateDisplayUnits) : "? /min";
  const layout = recipe ? machineLayoutForRecipe(recipe, state.machineModelIds, state.machineLayoutRules) : undefined;
  const machineCountMultiplier = layout?.machineCountMultiplier ?? 1;
  const metrics = plantProcessMetrics(plant, component.id, recipe, state.rateAnalysis);
  const rpm = recipe ? processQuantityDisplay(plant, component.id, "rpm", metrics.rpm) : { text: "?", state: "underconstrained" };
  const machines = recipe ? processQuantityDisplay(plant, component.id, "machine-count", metrics.machineCount, machineCountMultiplier) : { text: "?", state: "underconstrained" };
  const stress = recipe ? processQuantityDisplay(plant, component.id, "stress", metrics.stress) : { text: "?", state: "underconstrained" };
  const primaryMeta = [
    ...(metrics.requiresRpm ? [`RPM <tspan class="${rpm.state}">${esc(rpm.text)}</tspan>`] : []),
    `Machines <tspan class="${machines.state}">${esc(machines.text)}</tspan>`,
  ].join(" · ");
  const supportsStackSize = recipe && constraintTargetsFor(component, recipe).some((target) => target.kind === "stack-size");
  const stackSize = supportsStackSize ? processQuantityDisplay(plant, component.id, "stack-size", metrics.stackSize) : undefined;
  const secondaryMeta = [
    ...(metrics.tracksStress ? [`SU <tspan class="${stress.state}">${esc(stress.text)}</tspan>`] : []),
    ...(stackSize ? [`Stack <tspan class="${stackSize.state}">${esc(stackSize.text)}</tspan>`] : []),
  ].join(" · ");
  const machineLayout = layout ? machineLayoutMarkup(layout, state, 250, 1) : "";
  const titleMarkup = geometry.titleLines.map((line, index) => `<tspan x="12" y="${21 + index * 14}">${esc(line)}</tspan>`).join("");
  const markup = [`<g class="process ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${positions[component.id]?.x ?? 0} ${positions[component.id]?.y ?? 0})"><rect class="process-body" width="320" height="${height}" rx="11"/>${machineLayout}<text class="process-title">${titleMarkup}</text><text class="process-machine" x="12" y="${39 + shift}">${esc(recipe?.machine ?? recipe?.method ?? "process")} · <tspan class="${rateClass(primaryRate)}">${esc(productionRate)}</tspan></text><text class="process-meta" x="12" y="${53 + shift}">${primaryMeta}</text>${secondaryMeta ? `<text class="process-meta" x="12" y="${67 + shift}">${secondaryMeta}</text>` : ""}<text class="port-heading" x="12" y="${82 + shift}">INPUTS</text><text class="port-heading" x="308" y="${82 + shift}" text-anchor="end">OUTPUTS</text>`];
  ins.forEach((input, index) => {
    const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "input", resource: input } };
    const rate = rateForPort(state.rateAnalysis, target), targetData = esc(JSON.stringify(target));
    const row = portTop + index * 44;
    const inputIcon = resourceIconMarkup(input, state, "process-port-icon", 10, row - 8, 16) ?? "";
    markup.push(`<circle class="port-dot ${isPendingPortTarget(state, component.id, "input", input) ? "link-active" : ""}" cx="0" cy="${row}" r="5"/><rect class="port-hit" data-port="input" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(input))}" ${tagAttributes(input)} x="-15" y="${row - 10}" width="160" height="20"/>${inputIcon}<text class="port-label" x="${inputIcon ? 31 : 12}" y="${row + 4}">${esc(fitLabel(input.id))} · ${input.amount}</text><rect class="rate-hit" data-constraint-target="${targetData}" x="8" y="${row + 11}" width="140" height="22" rx="5"/><text class="port-rate ${rateClass(rate)}" data-constraint-target="${targetData}" x="12" y="${row + 27}">${esc(rateText(rate, input, state.rateDisplayUnits))}</text>`);
  });
  outs.forEach((output, index) => {
    const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: output.resource } };
    const rate = rateForPort(state.rateAnalysis, target), targetData = esc(JSON.stringify(target));
    const row = portTop + index * 44;
    const outputIcon = resourceIconMarkup(output.resource, state, "process-port-icon", 294, row - 8, 16) ?? "";
    const probability = output.outcomes.map(({ chance }) => chance === undefined ? "100%" : probabilityText(chance)).join(" + ");
    const probabilityMarkup = output.outcomes.length > 1 || output.outcomes[0]?.chance !== undefined ? `<tspan class="port-probability">${esc(probability)}</tspan> · ` : "";
    const amount = output.outcomes.length > 1 ? `${formatNumber(output.amount)} avg` : output.outcomes[0]?.amount ?? output.amount;
    markup.push(`<circle class="port-dot ${isPendingPortTarget(state, component.id, "output", output.resource) ? "link-active" : ""}" cx="320" cy="${row}" r="5"/><rect class="port-hit" data-port="output" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(output.resource))}" ${tagAttributes(output.resource)} x="175" y="${row - 10}" width="160" height="20"/><text class="port-label" x="${outputIcon ? 288 : 308}" y="${row + 4}" text-anchor="end">${probabilityMarkup}${esc(short(output.resource.id))} · ${amount}</text>${outputIcon}<rect class="rate-hit" data-constraint-target="${targetData}" x="172" y="${row + 11}" width="140" height="22" rx="5"/><text class="port-rate ${rateClass(rate)}" data-constraint-target="${targetData}" x="308" y="${row + 27}" text-anchor="end">${esc(rateText(rate, output.resource, state.rateDisplayUnits))}</text>`);
  });
  markup.push("</g>");
  return markup.join("");
}

export function orderedPorts<T extends Resource | { resource: Resource }>(order: CanvasState["portOrder"], componentId: string, direction: "input" | "output", ports: T[]): T[] {
  const savedOrder = order[componentId]?.[direction] ?? [];
  const keyOf = (port: T) => resourceKey("resource" in port ? port.resource : port);
  return ports.map((port, index) => ({ port, index, savedIndex: savedOrder.indexOf(keyOf(port)) }))
    .sort((a, b) => (a.savedIndex < 0 ? savedOrder.length + a.index : a.savedIndex) - (b.savedIndex < 0 ? savedOrder.length + b.index : b.savedIndex))
    .map(({ port }) => port);
}

export function portPoint(state: CanvasState, component: PlantComponent, direction: "input" | "output", resource: Resource, toward?: CanvasPoint): CanvasPoint {
  const p = state.positions[component.id] ?? { x: 0, y: 0 };
  if (component.kind === "pool") {
    const center = { x: p.x + 26, y: p.y + 26 };
    const target = toward ?? { x: center.x, y: center.y - 1 };
    const length = Math.hypot(target.x - center.x, target.y - center.y) || 1;
    return { x: center.x + (target.x - center.x) / length * 26, y: center.y + (target.y - center.y) / length * 26 };
  }
  if (component.kind !== "process") return { x: p.x + (component.kind === "supply" ? 70 : 0), y: p.y + 35 };
  const recipe = state.recipesById.get(component.recipeId);
  const ports = direction === "input" ? recipe?.inputs ?? [] : recipeOutputPorts(recipe);
  const list = orderedPorts(state.portOrder, component.id, direction, ports);
  const index = Math.max(0, list.findIndex((item) => resourceKey("resource" in item ? item.resource : item) === resourceKey(resource)));
  const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputPorts(recipe).length);
  const portTop = processGeometry(recipe ? short(recipe.id) : component.recipeId, rows).portTop;
  return { x: p.x + (direction === "input" ? 0 : 320), y: p.y + portTop + index * 44 };
}

export function updateEdgeTooltip(event: PointerEvent, svg: SVGSVGElement, view: CanvasState["view"]) {
  const target = event.target instanceof Element ? event.target : undefined;
  const group = target?.closest<SVGGElement>(".edge-group"), path = group?.querySelector<SVGPathElement>(".edge"), label = group?.querySelector<SVGTextElement>(".edge-label");
  if (!path || !label) {
    resetHoveredLabel();
    return;
  }
  if (hoveredEdgeLabel && hoveredEdgeLabel !== label && hoveredEdgeLabel.isConnected) resetLabel(hoveredEdgeLabel);
  hoveredEdgeLabel = label;
  const rect = svg.getBoundingClientRect();
  const cursor = { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale };
  const length = path.getTotalLength(), samples = Math.min(180, Math.max(24, Math.ceil(length / 5)));
  let closest = path.getPointAtLength(0), closestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const point = path.getPointAtLength(length * i / samples), dx = point.x - cursor.x, dy = point.y - cursor.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < closestDistance) { closest = point; closestDistance = distanceSquared; }
  }
  const icon = group.querySelector<SVGElement>(".edge-icon");
  if (icon) {
    const labelWidth = label.getComputedTextLength() || (label.textContent?.length ?? 0) * 7;
    const iconX = closest.x - (labelWidth + 30) / 2;
    icon.setAttribute("x", String(iconX));
    icon.setAttribute("y", String(closest.y - 12));
    label.setAttribute("x", String(iconX + 30));
    label.setAttribute("y", String(closest.y + 7));
    label.setAttribute("text-anchor", "start");
  } else {
    label.setAttribute("x", String(closest.x));
    label.setAttribute("y", String(closest.y - 8));
    label.setAttribute("text-anchor", "middle");
  }
}

function resetHoveredLabel() {
  if (hoveredEdgeLabel?.isConnected) resetLabel(hoveredEdgeLabel);
  hoveredEdgeLabel = undefined;
}

function resetLabel(label: SVGTextElement) {
  label.setAttribute("x", label.dataset.baseX ?? "0");
  label.setAttribute("y", label.dataset.baseY ?? "0");
  label.setAttribute("text-anchor", "middle");
  const icon = label.parentElement?.querySelector<SVGElement>(".edge-icon");
  if (icon) {
    icon.setAttribute("x", icon.dataset.baseX ?? "0");
    icon.setAttribute("y", icon.dataset.baseY ?? "0");
  }
}

export function renderCanvasInteractionPreview(state: CanvasState) {
  const preview: string[] = [];
  if (state.pendingPort && state.previewPoint) {
    const component = state.plant.components.find(({ id }) => id === state.pendingPort!.componentId);
    if (component) {
      const terminal = portPoint(state, component, state.pendingPort.direction, state.pendingPort.resource, state.previewPoint);
      const from = state.pendingPort.direction === "output" ? terminal : state.previewPoint;
      const to = state.pendingPort.direction === "output" ? state.previewPoint : terminal;
      const pendingTangent = portTangent(state, component, state.pendingPort.direction, terminal);
      const fromTangent = state.pendingPort.direction === "output" ? pendingTangent : { x: 1, y: 0 };
      const toTangent = state.pendingPort.direction === "input" ? pendingTangent : { x: 1, y: 0 };
      const laneY = component.kind === "pool" ? undefined : to.x < from.x ? Math.min(from.y, to.y) - 48 : undefined;
      preview.push(`<path class="edge-ghost" d="${connectionPath(from, to, laneY, fromTangent, toTangent)}"/>`);
    }
  }
  const port = state.reorderingPort;
  if (port && state.previewPoint) {
    const component = state.plant.components.find(({ id }) => id === port.componentId);
    if (component?.kind === "process") {
      const position = state.positions[component.id] ?? { x: 0, y: 0 }, recipe = state.recipesById.get(component.recipeId);
      const ports = port.direction === "input" ? recipe?.inputs ?? [] : recipeOutputPorts(recipe);
      const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputPorts(recipe).length);
      const portTop = processGeometry(recipe ? short(recipe.id) : component.recipeId, rows).portTop;
      const targetIndex = Math.max(0, Math.min(ports.length - 1, Math.round((state.previewPoint.y - position.y - portTop) / 44)));
      const dropY = position.y + portTop + targetIndex * 44;
      preview.push(`<line class="reorder-ghost-line" x1="${position.x + 8}" y1="${dropY}" x2="${position.x + 312}" y2="${dropY}"/><g class="reorder-ghost" transform="translate(${state.previewPoint.x + 12} ${state.previewPoint.y + 8})"><rect width="150" height="30" rx="7"/><text x="10" y="20">${esc(short(port.resource.id))}</text></g>`);
    }
  }
  state.interactionPreview.innerHTML = preview.join("");
  state.interactionPreview.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`);
}

function componentCenter(state: CanvasState, component: PlantComponent): CanvasPoint {
  const p = state.positions[component.id] ?? { x: 0, y: 0 };
  if (component.kind === "pool") return { x: p.x + 26, y: p.y + 26 };
  if (component.kind !== "process") return { x: p.x + 35, y: p.y + 35 };
  const recipe = state.recipesById.get(component.recipeId);
  const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputPorts(recipe).length);
  return { x: p.x + 160, y: p.y + processGeometry(recipe ? short(recipe.id) : component.recipeId, rows).height / 2 };
}

function portTangent(state: CanvasState, component: PlantComponent, direction: "input" | "output", point: CanvasPoint): CanvasPoint {
  if (component.kind !== "pool") return { x: 1, y: 0 };
  const position = state.positions[component.id] ?? { x: 0, y: 0 };
  const center = { x: position.x + 26, y: position.y + 26 };
  const length = Math.hypot(point.x - center.x, point.y - center.y) || 1;
  const sign = direction === "output" ? 1 : -1;
  return { x: (point.x - center.x) / length * sign, y: (point.y - center.y) / length * sign };
}

function componentBounds(state: CanvasState, component: PlantComponent): { top: number; bottom: number } {
  const position = state.positions[component.id] ?? { x: 0, y: 0 };
  if (component.kind === "pool") return { top: position.y, bottom: position.y + 89 };
  if (component.kind !== "process") return { top: position.y, bottom: position.y + 96 };
  const recipe = state.recipesById.get(component.recipeId);
  const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputPorts(recipe).length);
  return { top: position.y, bottom: position.y + processGeometry(recipe ? short(recipe.id) : component.recipeId, rows).height };
}

export function connectionLanes(state: CanvasState): Map<string, number> {
  const components = new Map(state.plant.components.map((component) => [component.id, component]));
  const bounds = state.plant.components.map((component) => componentBounds(state, component));
  if (!bounds.length) return new Map();
  const graphTop = Math.min(...bounds.map(({ top }) => top));
  const graphBottom = Math.max(...bounds.map(({ bottom }) => bottom));
  const lanes = new Map<string, number>();
  let upperLane = 0, lowerLane = 0;
  for (const edge of state.plant.connections) {
    const from = components.get(edge.from.componentId), to = components.get(edge.to.componentId);
    if (!from || !to) continue;
    const start = portPoint(state, from, edge.from.direction, edge.from.resource, componentCenter(state, to));
    const end = portPoint(state, to, edge.to.direction, edge.to.resource, componentCenter(state, from));
    const fromCenter = componentCenter(state, from);
    const toCenter = componentCenter(state, to);
    const backwards = toCenter.x < fromCenter.x || (toCenter.x === fromCenter.x && end.x < start.x);
    if (!backwards) continue;
    const top = graphTop - 32 - upperLane * 16;
    const bottom = graphBottom + 32 + lowerLane * 16;
    if (Math.abs(start.y - top) + Math.abs(end.y - top) <= Math.abs(start.y - bottom) + Math.abs(end.y - bottom)) {
      lanes.set(edge.id, top); upperLane++;
    } else {
      lanes.set(edge.id, bottom); lowerLane++;
    }
  }
  return lanes;
}

function processQuantityDisplay(plant: Plant, componentId: string, kind: "rpm" | "machine-count" | "stress" | "stack-size", measured: number | undefined, machineCountMultiplier = 1) {
  const state = plantQuantityState(plant, componentId, kind, measured);
  const constraints = state.constraints;
  if (kind === "machine-count" && measured === undefined && machineCountMultiplier > 1 && constraints.length === 0) {
    return { text: `? × ${machineCountMultiplier}`, state: "underconstrained" };
  }
  if (kind === "machine-count" && measured !== undefined && !state.exact) {
    const minimums = constraints.filter((constraint) => constraint.kind === "bound" && constraint.relation === "at-least").map(({ value }) => value * machineCountMultiplier);
    let minimum = Math.max(Math.ceil(measured * machineCountMultiplier), ...minimums);
    const powerOfTwo = constraints.some((constraint) => constraint.kind === "power-of-two");
    if (powerOfTwo) minimum = 2 ** Math.ceil(Math.log2(Math.max(minimum, 1)));
    const maximums = constraints.filter((constraint) => constraint.kind === "bound" && constraint.relation === "at-most").map(({ value }) => value * machineCountMultiplier);
    const restrictions = [
      ...(maximums.length ? [`≤ ${formatNumber(Math.min(...maximums))}`] : []),
      ...(powerOfTwo ? ["2ⁿ"] : []),
    ];
    return {
      text: `≥ ${formatNumber(minimum)}${restrictions.length ? ` · ${restrictions.join(" · ")}` : ""}`,
      state: state.constrained ? "constrained" : "derived",
    };
  }
  const imposed = constraints.flatMap((constraint) => {
    if (constraint.kind === "integer") return ["int"];
    if (constraint.kind === "power-of-two") return ["2ⁿ"];
    const value = kind === "machine-count" ? constraint.value * machineCountMultiplier : constraint.value;
    return [`${constraint.relation === "equals" ? "=" : constraint.relation === "at-least" ? "≥" : "≤"} ${formatNumber(value)}`];
  });
  if (state.integer && !imposed.includes("int")) imposed.push("int");
  const text = state.constrained ? state.exact || measured === undefined ? imposed.join(" ") : `${formatNumber(measured)} (${imposed.join(" ")})`
    : measured === undefined ? imposed.join(" ") || "?" : `${formatNumber(measured)}${imposed.length ? ` ${imposed.join(" ")}` : ""}`;
  return { text, state: state.constrained ? "constrained" : measured === undefined ? "underconstrained" : "derived" };
}

function rateForPort(analysis: PlantRateAnalysis | undefined, target: Extract<PlantQuantityRef, { kind: "port-rate" }>): RateValue | undefined {
  return analysis?.portRates.find(({ port }) => port.componentId === target.port.componentId && port.direction === target.port.direction && resourceKey(port.resource) === resourceKey(target.port.resource))?.rate;
}
function rateForConnection(analysis: PlantRateAnalysis | undefined, connectionId: string): RateValue | undefined { return analysis?.connectionRates.find((rate) => rate.connectionId === connectionId)?.rate; }
function rateClass(rate: RateValue | undefined): string {
  const state = !rate || rate.state === "underconstrained" ? "underconstrained" : rate.state;
  return rate?.surplus !== undefined && rate.surplus > 1e-7 ? `${state} surplus` : state;
}
function rateText(rate: RateValue | undefined, resource: Resource, units: RateDisplayUnits): string {
  const unit = rateDisplayUnit(resource, units);
  if (!rate || rate.state === "underconstrained") {
    if (!rate) return `? ${unit}`;
    const minimum = perMinuteToDisplayRate(rate.minimum, resource, units);
    const maximum = rate.maximum === undefined ? undefined : perMinuteToDisplayRate(rate.maximum, resource, units);
    const range = maximum === undefined ? minimum > 0 ? `≥ ${formatNumber(minimum)}` : "?"
      : minimum === maximum ? formatNumber(minimum) : minimum === 0 ? `≤ ${formatNumber(maximum)}` : `${formatNumber(minimum)}–${formatNumber(maximum)}`;
    return `${range} ${unit}${rate.powerOfTwo ? " · 2ⁿ" : rate.integer ? " · int" : ""}`;
  }
  return rate.state === "conflict" ? "!" : `${formatNumber(perMinuteToDisplayRate(rate.perMinute, resource, units))} ${unit}`;
}
function resourceIconMarkup(resource: Pick<Ingredient, "type" | "id" | "alternatives">, state: CanvasState, className: string, x: number, y: number, size: number): string | undefined {
  const alternatives = resource.alternatives ?? [];
  const tagName = resource.id.startsWith("#") ? resource.id.split(":").at(-1) : undefined;
  const preferred = tagName && alternatives.find((id) => id.split(":").at(-1) === tagName);
  const ids = [...new Set([resource.id, ...(preferred ? [preferred] : []), ...alternatives])];
  const keys = ids.flatMap((id) => resource.type === "fluid" ? [`${id}_still`, id, `${id}_bucket`] : [id]);
  const available = [...new Set(keys.filter((candidate) => state.itemIcons[candidate] || state.itemModelIds[candidate]))];
  if (!available.length) return undefined;
  const members = [...new Set(alternatives)];
  if (!resource.id.startsWith("#") || members.length < 2) return resourceIconKeyMarkup(available[0], state, className, x, y, size);
  const memberKeys = members.map((id) => {
    const memberCandidates = resource.type === "fluid" ? [`${id}_still`, id, `${id}_bucket`] : [id];
    return memberCandidates.find((candidate) => state.itemIcons[candidate] || state.itemModelIds[candidate]);
  }).filter((key): key is string => !!key);
  if (!memberKeys.length) return undefined;
  const interval = 0.5;
  const duration = memberKeys.length * interval;
  return `<svg class="${className} tag-cycle-icon" data-tag-id="${esc(resource.id)}" data-tag-type="${resource.type}" data-tag-alternatives="${esc(JSON.stringify(members))}" x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet">${memberKeys.map((key, index) => `<g opacity="0"><animate attributeName="opacity" values="1;0;0" keyTimes="0;${1 / memberKeys.length};1" dur="${duration}s" begin="${index * interval}s" calcMode="discrete" repeatCount="indefinite"/><g>${resourceIconKeyMarkup(key, state, "tag-cycle-member", 0, 0, size)}</g></g>`).join("")}</svg>`;
}

function resourceIconKeyMarkup(key: string, state: CanvasState, className: string, x: number, y: number, size: number): string {
  const modelId = state.itemModelIds[key];
  if (modelId && state.itemModels[modelId]) {
    const model = renderModelParts([{ model: modelId, position: [0, 0, 0] }], state.itemModels, state, x, y, size, size, "item", className);
    if (model) return model;
  }
  return resourceTextureKeyMarkup(key, state, className, x, y, size);
}

function resourceTextureKeyMarkup(key: string, state: CanvasState, className: string, x: number, y: number, size: number): string {
  const href = esc(state.itemIcons[key]);
  const animation = state.itemAnimations[key];
  if (!animation) return `<image class="${className}" href="${href}" data-base-x="${x}" data-base-y="${y}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  const totalTicks = animation.frames.reduce((total, frame) => total + frame.time, 0);
  const columns = animation.textureWidth / animation.frameWidth;
  const transformFor = (index: number) => {
    const column = index % columns, row = Math.floor(index / columns);
    return `${-column * animation.frameWidth} ${-row * animation.frameHeight}`;
  };
  let elapsed = 0;
  const keyTimes = animation.frames.map((frame) => {
    const time = elapsed / totalTicks;
    elapsed += frame.time;
    return time;
  });
  keyTimes.push(1);
  const transforms = [...animation.frames.map(({ index }) => transformFor(index)), transformFor(animation.frames[0].index)];
  return `<svg class="${className}" data-base-x="${x}" data-base-y="${y}" x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 ${animation.frameWidth} ${animation.frameHeight}" preserveAspectRatio="xMidYMid meet" overflow="hidden"><image href="${href}" x="0" y="0" width="${animation.textureWidth}" height="${animation.textureHeight}" preserveAspectRatio="none"><animateTransform attributeName="transform" type="translate" values="${transforms.join(";")}" keyTimes="${keyTimes.join(";")}" dur="${totalTicks / 20}s" calcMode="discrete" repeatCount="indefinite"/></image></svg>`;
}

export function tagAttributes(resource: Pick<Ingredient, "type" | "id" | "alternatives">): string {
  return resource.id.startsWith("#") && resource.alternatives?.length
    ? `data-tag-id="${esc(resource.id)}" data-tag-type="${resource.type}" data-tag-alternatives="${esc(JSON.stringify(resource.alternatives))}"`
    : "";
}

export function renderResourceIcon(resource: Pick<Ingredient, "type" | "id" | "alternatives">, state: CanvasState, size: number): string | undefined {
  return resourceIconMarkup(resource, state, "recipe-option-icon-image", 0, 0, size);
}

function machineLayoutMarkup(layout: MachineLayout, state: CanvasState, x: number, y: number): string {
  const markup = renderModelParts(layout.parts, state.machineModels, state, x, y, 68, 72, "machine", "machine-layout-icon");
  if (markup) return `${markup}${layout.machineCountMultiplier > 1 ? `<text class="machine-layout-count" x="318" y="11" text-anchor="end">×${layout.machineCountMultiplier}</text>` : ""}`;
  const texture = layout.parts.map(({ model }) => state.machineModels[model]?.fallbackTexture).find((id): id is string => !!id);
  const icon = texture ? resourceIconMarkup({ type: "item", id: texture }, state, "machine-layout-fallback", x + 10, y + 10, 48) ?? "" : "";
  return `${icon}${icon && layout.machineCountMultiplier > 1 ? `<text class="machine-layout-count" x="318" y="11" text-anchor="end">×${layout.machineCountMultiplier}</text>` : ""}`;
}

type ModelPart = { model: string; position: [number, number, number] };

function renderModelParts(parts: ModelPart[], models: Record<string, MachineModel>, state: CanvasState, x: number, y: number, width: number, height: number, cacheKey: string, className = ""): string {
  const key = `${cacheKey}:${JSON.stringify(parts)}`;
  const classes = `machine-model${className ? ` ${className}` : ""}`;
  const raster = rasterizedModels.get(key);
  if (raster) return `<image class="${classes}" href="${raster.href}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" image-rendering="pixelated"/>`;
  let layouts = machineLayoutIds.get(state.svg);
  if (!layouts) machineLayoutIds.set(state.svg, layouts = new Map());
  const cachedId = layouts.get(key);
  if (cachedId) return `<use class="${classes}" href="#${cachedId}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;

  let symbol = renderedModelSymbols.get(key);
  if (!symbol) {
    const faces = parts.flatMap(({ model: modelId, position }) => {
      const model = models[modelId];
      return [
        ...(model?.elements ?? []).flatMap((element) => modelFaces(element, position, state)),
        ...(model?.triangles ?? []).flatMap((triangle) => modelTriangles(triangle, position, state)),
      ];
    }).sort((a, b) => a.depth - b.depth);
    if (faces.length === 0) return "";

    const points = faces.flatMap((face) => face.points);
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    rasterizeWhenStatic(key, faces, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, state);
    const faceMarkup = faces.map((face, index) => {
      const id = `machine-face-__model__-${index}`;
      const clip = `<clipPath id="${id}"><path d="${polygonPath(face.points)}"/></clipPath>`;
      const shade = face.shade ? `<path d="${polygonPath(face.points)}" fill="#101712" opacity="${face.shade}" pointer-events="none"/>` : "";
      return { clip, content: `${machineTextureMarkup(face, id, state)}${shade}` };
    });
    symbol = `<symbol id="machine-layout-__model__" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" preserveAspectRatio="xMidYMid meet"><defs>${faceMarkup.map(({ clip }) => clip).join("")}</defs>${faceMarkup.map(({ content }) => content).join("")}</symbol>`;
    renderedModelSymbols.set(key, symbol);
  }
  const idPrefix = `machine-layout-${nextMachineLayoutId++}`;
  const symbolId = idPrefix.replace("machine-layout-", "");
  const localSymbol = symbol.replaceAll("__model__", symbolId);
  state.svg.querySelector<SVGDefsElement>("#machine-model-defs")?.insertAdjacentHTML("beforeend", localSymbol);
  layouts.set(key, idPrefix);
  return `<use class="${classes}" href="#${idPrefix}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;
}

type ProjectedFace = { points: CanvasPoint[]; uvs: CanvasPoint[]; depths: number[]; texture: string; href: string; transform: string; depth: number; shade: number };
const isoCos = Math.sqrt(3) / 2;
const machineLayoutIds = new WeakMap<SVGSVGElement, Map<string, string>>();
const renderedModelSymbols = new Map<string, string>();
const rasterizedModels = new Map<string, RasterModel>();
const rasterizingModels = new Set<string>();
let latestCanvasState: CanvasState | undefined;
let rasterRefreshScheduled = false;
let nextMachineLayoutId = 0;
const visibleNormals: Record<string, [number, number, number]> = {
  north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
};

function modelFaces(element: MachineModelElement, offset: [number, number, number], state: CanvasState): ProjectedFace[] {
  const [x0, y0, z0] = element.from, [x1, y1, z1] = element.to;
  const pointsByFace: Record<string, CanvasPoint[]> = {
    north: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    south: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    west: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    east: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
    up: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
    down: [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]],
  };
  const projected: ProjectedFace[] = [];
  for (const [direction, face] of Object.entries(element.faces)) {
    const vertices = pointsByFace[direction];
    const normal = visibleNormals[direction];
    const href = state.itemIcons[face.texture];
    if (!vertices || !normal || !href) continue;
    const worldVertices = vertices.map((vertex) => rotateModelPoint(vertex, element.rotation).map((value, index) => value + offset[index]) as [number, number, number]);
    const worldNormal = rotateModelVector(normal, element.rotation);
    if (worldNormal[0] + worldNormal[1] + worldNormal[2] <= 0) continue;
    const uv = rotatedFaceUvs(face.uv, face.rotation, direction);
    const screen = worldVertices.map(([x, y, z]) => ({ x: (x - z) * isoCos, y: (x + z) * 0.5 - y }));
    const transform = imageTransform(uv, screen);
    if (!transform) continue;
    const center = worldVertices.reduce((sum, [x, y, z]) => sum + x + y + z, 0) / worldVertices.length;
    projected.push({ points: screen, uvs: uv, depths: worldVertices.map(([x, y, z]) => x + y + z), texture: face.texture, href, transform, depth: center, shade: direction === "up" ? 0 : direction === "east" ? 0.22 : 0.12 });
  }
  return projected;
}

function modelTriangles(triangle: { texture: string; vertices: Array<{ position: [number, number, number]; uv: [number, number] }> }, offset: [number, number, number], state: CanvasState): ProjectedFace[] {
  const href = state.itemIcons[triangle.texture];
  if (!href || triangle.vertices.length !== 3) return [];
  const positions = triangle.vertices.map(({ position }) => position.map((value, index) => value + offset[index]) as [number, number, number]);
  const [a, b, c] = positions;
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal: [number, number, number] = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  if (normal[0] + normal[1] + normal[2] <= 0) return [];
  const points = positions.map(([x, y, z]) => ({ x: (x - z) * isoCos, y: (x + z) * 0.5 - y }));
  const uv = triangle.vertices.map(({ uv: [x, y] }) => ({ x, y }));
  const transform = imageTransform(uv, points);
  if (!transform) return [];
  const depth = positions.reduce((sum, [x, y, z]) => sum + x + y + z, 0) / 3;
  const shade = Math.max(0, Math.min(0.28, 0.2 - normal[1] / (Math.hypot(...normal) || 1) * 0.14));
  return [{ points, uvs: uv, depths: positions.map(([x, y, z]) => x + y + z), texture: triangle.texture, href, transform, depth, shade }];
}

function rasterizeWhenStatic(key: string, faces: ProjectedFace[], bounds: { x: number; y: number; width: number; height: number }, state: CanvasState) {
  if (faces.length > 512 || faces.some((face) => textureAnimation(state, face.texture)) || rasterizingModels.has(key)) return;
  const triangles: RasterTriangle[] = faces.flatMap((face) => {
    if (face.points.length !== 3 && face.points.length !== 4) return [];
    const indices = face.points.length === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
    return indices.map(([a, b, c]) => ({
      texture: face.href,
      shade: face.shade,
      vertices: [a, b, c].map((index) => ({ ...face.points[index], depth: face.depths[index], u: face.uvs[index].x, v: face.uvs[index].y })) as RasterTriangle["vertices"],
    }));
  });
  if (!triangles.length) return;
  rasterizingModels.add(key);
  void rasterizeModel(triangles, bounds, faces.length > 80 ? 128 : 256).then((raster) => {
    if (raster) {
      rasterizedModels.set(key, raster);
      if (!rasterRefreshScheduled) {
        rasterRefreshScheduled = true;
        requestAnimationFrame(() => {
          rasterRefreshScheduled = false;
          if (latestCanvasState) renderCanvas(latestCanvasState);
        });
      }
    }
  }).finally(() => rasterizingModels.delete(key));
}

function textureAnimation(state: CanvasState, texture: string): TextureAnimation | undefined {
  const [namespace, path] = texture.split(":", 2);
  return state.itemAnimations[texture] ?? state.itemAnimations[`${namespace}:${path.replace(/^(?:block|item)\//, "")}`];
}

function machineTextureMarkup(face: ProjectedFace, clipId: string, state: CanvasState): string {
  const [namespace, path] = face.texture.split(":", 2);
  const animation = state.itemAnimations[face.texture] ?? state.itemAnimations[`${namespace}:${path.replace(/^(?:block|item)\//, "")}`];
  if (!animation) {
    return `<g clip-path="url(#${clipId})"><g transform="${face.transform}"><image href="${esc(face.href)}" x="0" y="0" width="16" height="16" preserveAspectRatio="none" image-rendering="pixelated"/></g></g>`;
  }
  const columns = animation.textureWidth / animation.frameWidth;
  const scale = 16 / animation.frameWidth;
  const transformFor = (index: number) => {
    const column = index % columns, row = Math.floor(index / columns);
    return `${-column * 16} ${-row * 16}`;
  };
  const totalTicks = animation.frames.reduce((total, frame) => total + frame.time, 0);
  let elapsed = 0;
  const keyTimes = animation.frames.map((frame) => {
    const time = elapsed / totalTicks;
    elapsed += frame.time;
    return time;
  });
  keyTimes.push(1);
  const transforms = [...animation.frames.map(({ index }) => transformFor(index)), transformFor(animation.frames[0].index)];
  const values = transforms.map((value) => {
    const [x, y] = value.split(" ").map(Number);
    return `${x} ${y}`;
  });
  const duration = totalTicks / 20;
  return `<g clip-path="url(#${clipId})"><g transform="${face.transform}"><image href="${esc(face.href)}" x="0" y="0" width="${animation.textureWidth * scale}" height="${animation.textureHeight * scale}" preserveAspectRatio="none" image-rendering="pixelated"><animateTransform attributeName="transform" type="translate" values="${values.join(";")}" keyTimes="${keyTimes.join(";")}" dur="${duration}s" calcMode="discrete" repeatCount="indefinite"/></image></g></g>`;
}

function rotateModelPoint(point: [number, number, number], rotation?: MachineModelElement["rotation"]): [number, number, number] {
  if (!rotation) return point;
  const origin = rotation.origin ?? [8, 8, 8];
  const radians = rotation.angle * Math.PI / 180;
  const relative = point.map((value, index) => value - origin[index]) as [number, number, number];
  const [x, y, z] = relative;
  const rotated: [number, number, number] = rotation.axis === "x" ? [x, y * Math.cos(radians) - z * Math.sin(radians), y * Math.sin(radians) + z * Math.cos(radians)]
    : rotation.axis === "y" ? [x * Math.cos(radians) + z * Math.sin(radians), y, -x * Math.sin(radians) + z * Math.cos(radians)]
      : [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians), z];
  return rotated.map((value, index) => value + origin[index]) as [number, number, number];
}

function rotateModelVector(vector: [number, number, number], rotation?: MachineModelElement["rotation"]): [number, number, number] {
  if (!rotation) return vector;
  const radians = rotation.angle * Math.PI / 180;
  const [x, y, z] = vector;
  return rotation.axis === "x" ? [x, y * Math.cos(radians) - z * Math.sin(radians), y * Math.sin(radians) + z * Math.cos(radians)]
    : rotation.axis === "y" ? [x * Math.cos(radians) + z * Math.sin(radians), y, -x * Math.sin(radians) + z * Math.cos(radians)]
      : [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians), z];
}

function rotatedFaceUvs([u0, v0, u1, v1]: [number, number, number, number], rotation: number, direction: string): CanvasPoint[] {
  const corners = direction === "up" || direction === "down"
    ? [{ x: u0, y: v0 }, { x: u1, y: v0 }, { x: u1, y: v1 }, { x: u0, y: v1 }]
    : [{ x: u0, y: v1 }, { x: u1, y: v1 }, { x: u1, y: v0 }, { x: u0, y: v0 }];
  const shift = ((rotation / 90) % 4 + 4) % 4;
  return corners.map((_, index) => corners[(index + shift) % 4]);
}

function imageTransform(uv: CanvasPoint[], screen: CanvasPoint[]): string | undefined {
  const [p0, p1] = uv, p3 = uv.length === 3 ? uv[2] : uv[3];
  const [s0, s1] = screen, s3 = screen.length === 3 ? screen[2] : screen[3];
  if (!p0 || !p1 || !p3 || !s0 || !s1 || !s3) return undefined;
  const du1 = p1.x - p0.x, dv1 = p1.y - p0.y, du3 = p3.x - p0.x, dv3 = p3.y - p0.y;
  const determinant = du1 * dv3 - du3 * dv1;
  if (Math.abs(determinant) < 1e-8) return undefined;
  const dx1 = s1.x - s0.x, dy1 = s1.y - s0.y, dx3 = s3.x - s0.x, dy3 = s3.y - s0.y;
  const a = (dx1 * dv3 - dx3 * dv1) / determinant, c = (du1 * dx3 - du3 * dx1) / determinant;
  const b = (dy1 * dv3 - dy3 * dv1) / determinant, d = (du1 * dy3 - du3 * dy1) / determinant;
  const e = s0.x - a * p0.x - c * p0.y, f = s0.y - b * p0.x - d * p0.y;
  return `matrix(${[a, b, c, d, e, f].map((value) => Number(value.toFixed(5))).join(" ")})`;
}

function polygonPath(points: CanvasPoint[]): string {
  return points.map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(3)} ${y.toFixed(3)}`).join(" ") + " Z";
}
function isPendingPortTarget(state: CanvasState, componentId: string, direction: "input" | "output", resource: Resource): boolean {
  const pending = state.pendingPort;
  if (!pending || pending.direction === direction) return false;
  if (resourceKey(pending.resource) === resourceKey(resource)) return true;
  const input = direction === "input" ? { componentId, resource } : pending.direction === "input" ? pending : undefined;
  const item = direction === "output" ? resource : pending.resource;
  if (!input) return false;
  const component = state.plant.components.find(({ id }) => id === input.componentId);
  if (component?.kind !== "process") return false;
  const recipe = state.recipesById.get(component.recipeId);
  return recipe?.inputs.some((candidate) => resourceKey(candidate) === resourceKey(input.resource) &&
    candidate.type === item.type && candidate.alternatives?.includes(item.id)) ?? false;
}
function connectionPath(from: CanvasPoint, to: CanvasPoint, returnLaneY?: number, fromTangent = { x: 1, y: 0 }, toTangent = { x: 1, y: 0 }): string {
  if (returnLaneY !== undefined) {
    const radius = 28, laneY = returnLaneY;
    const direction = -1;
    const laneStart = { x: from.x + fromTangent.x * radius, y: laneY };
    const laneEnd = { x: to.x - toTangent.x * radius, y: laneY };
    const startCorner = { x: laneStart.x - direction * radius, y: laneY };
    const endCorner = { x: laneEnd.x + direction * radius, y: laneY };
    const firstControl = { x: from.x + fromTangent.x * radius, y: from.y + fromTangent.y * radius };
    const lastControl = { x: to.x - toTangent.x * radius, y: to.y - toTangent.y * radius };
    return `M ${from.x} ${from.y} C ${firstControl.x} ${firstControl.y}, ${startCorner.x} ${startCorner.y}, ${laneStart.x} ${laneStart.y} L ${laneEnd.x} ${laneEnd.y} C ${endCorner.x} ${endCorner.y}, ${lastControl.x} ${lastControl.y}, ${to.x} ${to.y}`;
  }
  if (to.x >= from.x && fromTangent.x === 1 && toTangent.x === 1 && fromTangent.y === 0 && toTangent.y === 0) {
    const bend = Math.max(50, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  }
  const handle = Math.max(32, Math.min(120, Math.hypot(to.x - from.x, to.y - from.y) * 0.4));
  const control1 = { x: from.x + fromTangent.x * handle, y: from.y + fromTangent.y * handle };
  const control2 = { x: to.x - toTangent.x * handle, y: to.y - toTangent.y * handle };
  return `M ${from.x} ${from.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${to.x} ${to.y}`;
}
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function probabilityText(chance: number): string { return `${formatNumber(chance <= 1 ? chance * 100 : chance)}%`; }
function short(id: string): string { return id.split(":").at(-1)!.replaceAll("_", " "); }
function wrapProcessTitle(title: string): string[] {
  const maxLength = 30;
  const lines: string[] = [];
  let line = "";
  for (const word of title.split(/\s+/)) {
    if (word.length > maxLength) {
      if (line) { lines.push(line); line = ""; }
      for (let index = 0; index < word.length; index += maxLength) lines.push(word.slice(index, index + maxLength));
    } else if (!line || `${line} ${word}`.length <= maxLength) line = line ? `${line} ${word}` : word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [title];
}
function fitLabel(id: string, maxLength = 19): string { const label = short(id); return label.length > maxLength ? `${label.slice(0, maxLength - 1)}…` : label; }
function icon(id: string): string { return short(id).split(/[- _]/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function esc(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
