import type { Plant, PlantComponent, PlantQuantityRef, PortRef, Resource } from "../plant.ts";
import { resourceKey } from "../plant.ts";
import { constraintTargetsFor, machineLayoutForRecipe, plantProcessMetrics, plantQuantityState } from "../core/index.ts";
import type { MachineLayout } from "../core/index.ts";
import type { MachineLayoutRules, MachineModel, MachineModelElement, Recipe, TextureAnimation } from "../recipes.ts";
import { recipeOutputs } from "../recipe-queries.ts";
import type { PlantRateAnalysis, RateValue } from "../plant-analysis.ts";

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
  machineModelIds: Record<string, string>;
  machineModels: Record<string, MachineModel>;
  machineLayoutRules: MachineLayoutRules;
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
  const { plant, recipesById, positions, portOrder, view, selected, selectedIds } = state;
  const components = new Map(plant.components.map((component) => [component.id, component]));
  const markup: string[] = [];
  for (const edge of plant.connections) {
    const from = components.get(edge.from.componentId), to = components.get(edge.to.componentId);
    if (!from || !to) continue;
    const a = portPoint(state, from, edge.from.direction, edge.from.resource);
    const b = portPoint(state, to, edge.to.direction, edge.to.resource);
    const path = connectionPath(a, b);
    const edgeRate = rateForConnection(state.rateAnalysis, edge.id);
    const labelX = (a.x + b.x) / 2, labelY = (a.y + b.y) / 2 - 8;
    const iconMarkup = resourceIconMarkup(edge.from.resource, state, "edge-icon", labelX - 12, labelY - 22, 24);
    markup.push(`<g class="edge-group ${selected === edge.id ? "selected" : ""}" tabindex="0" data-edge="${esc(edge.id)}"><path class="edge" d="${path}"/><path class="edge-hit" d="${path}"/>${iconMarkup}<text class="edge-label ${rateClass(edgeRate)}" data-base-x="${labelX}" data-base-y="${labelY}" x="${labelX}" y="${labelY}" text-anchor="middle">${esc(short(edge.from.resource.id))} · ${esc(rateText(edgeRate, rateUnit(edge.from.resource)))}</text></g>`);
  }
  for (const component of plant.components) {
    const p = positions[component.id] ?? (positions[component.id] = { x: 0, y: 0 });
    if (component.kind !== "process") {
      const direction = component.kind === "supply" ? "output" : "input";
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction, resource: component.resource } };
      const rate = rateForPort(state.rateAnalysis, target);
      const portX = component.kind === "supply" ? 70 : 0;
      const iconMarkup = resourceIconMarkup(component.resource, state, "resource-image", 7, 3, 56)
        || `<text class="resource-icon" x="35" y="29">${esc(icon(component.resource.id))}</text>`;
      markup.push(`<g class="resource ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${p.x} ${p.y})"><rect class="resource-body" width="70" height="70" rx="10"/>${iconMarkup}<text class="resource-name" x="35" y="67">${esc(short(component.resource.id))}</text><circle class="port-hit" data-port="${direction}" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(component.resource))}" cx="${portX}" cy="35" r="14"/><circle class="port-dot boundary-port ${isPendingPortTarget(state, component.id, direction, component.resource) ? "link-active" : ""}" cx="${portX}" cy="35" r="5"/><rect class="rate-hit" data-constraint-target="${esc(JSON.stringify(target))}" x="12" y="72" width="46" height="24" rx="5"/><text class="resource-rate ${rateClass(rate)}" data-constraint-target="${esc(JSON.stringify(target))}" x="35" y="89">${esc(rateText(rate, rateUnit(component.resource)))}</text></g>`);
      continue;
    }
    const recipe = recipesById.get(component.recipeId);
    const ins = orderedPorts(portOrder, component.id, "input", recipe?.inputs ?? []);
    const outs = orderedPorts(portOrder, component.id, "output", recipeOutputs(recipe));
    const rows = Math.max(ins.length, outs.length);
    const recipeName = recipe ? short(recipe.id) : component.recipeId;
    const geometry = processGeometry(recipeName, rows);
    const { height, portTop, shift } = geometry;
    const primaryOutput = outs[0];
    const productionRate = primaryOutput
      ? rateText(rateForPort(state.rateAnalysis, { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: primaryOutput.resource } }), rateUnit(primaryOutput.resource))
      : "? /min";
    const metrics = plantProcessMetrics(plant, component.id, recipe, state.rateAnalysis);
    const rpm = recipe ? processQuantityDisplay(plant, component.id, "rpm", metrics.rpm) : { text: "?", state: "underconstrained" };
    const machineCount = metrics.machineCount;
    const machines = recipe ? processQuantityDisplay(plant, component.id, "machine-count", machineCount) : { text: "?", state: "underconstrained" };
    const stress = recipe ? processQuantityDisplay(plant, component.id, "stress", metrics.stress) : { text: "?", state: "underconstrained" };
    const supportsStackSize = recipe && constraintTargetsFor(component, recipe).some((target) => target.kind === "stack-size");
    const stackSize = supportsStackSize
      ? processQuantityDisplay(plant, component.id, "stack-size", metrics.stackSize) : undefined;
    const layout = recipe ? machineLayoutForRecipe(recipe, state.machineModelIds, state.machineLayoutRules) : undefined;
    const machineLayout = layout ? machineLayoutMarkup(layout, state, 250, 1) : "";
    const titleMarkup = geometry.titleLines.map((line, index) => `<tspan x="12" y="${21 + index * 14}">${esc(line)}</tspan>`).join("");
    markup.push(`<g class="process ${selectedIds.has(component.id) || selected === component.id ? "selected" : ""}" data-component="${esc(component.id)}" transform="translate(${p.x} ${p.y})"><rect class="process-body" width="320" height="${height}" rx="11"/>${machineLayout}<text class="process-title">${titleMarkup}</text><text class="process-machine" x="12" y="${39 + shift}">${esc(recipe?.machine ?? recipe?.method ?? "process")} · ${esc(productionRate)}</text><text class="process-meta" x="12" y="${53 + shift}">RPM <tspan class="${rpm.state}">${esc(rpm.text)}</tspan> · Machines <tspan class="${machines.state}">${esc(machines.text)}</tspan></text><text class="process-meta" x="12" y="${67 + shift}">SU <tspan class="${stress.state}">${esc(stress.text)}</tspan>${stackSize ? ` · Stack <tspan class="${stackSize.state}">${esc(stackSize.text)}</tspan>` : ""}</text><text class="port-heading" x="12" y="${82 + shift}">INPUTS</text><text class="port-heading" x="308" y="${82 + shift}" text-anchor="end">OUTPUTS</text>`);
    ins.forEach((input, index) => {
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "input", resource: input } };
      const rate = rateForPort(state.rateAnalysis, target), targetData = esc(JSON.stringify(target));
      const row = portTop + index * 44;
      const inputIcon = resourceIconMarkup(input, state, "process-port-icon", 10, row - 8, 16) ?? "";
      markup.push(`<circle class="port-dot ${isPendingPortTarget(state, component.id, "input", input) ? "link-active" : ""}" cx="0" cy="${row}" r="5"/><rect class="port-hit" data-port="input" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(input))}" x="-15" y="${row - 10}" width="160" height="20"/>${inputIcon}<text class="port-label" x="${inputIcon ? 31 : 12}" y="${row + 4}">${esc(fitLabel(input.id))} · ${input.amount}</text><rect class="rate-hit" data-constraint-target="${targetData}" x="8" y="${row + 11}" width="140" height="22" rx="5"/><text class="port-rate ${rateClass(rate)}" data-constraint-target="${targetData}" x="12" y="${row + 27}">${esc(rateText(rate, rateUnit(input)))}</text>`);
    });
    outs.forEach((output, index) => {
      const target: PlantQuantityRef = { kind: "port-rate", port: { componentId: component.id, direction: "output", resource: output.resource } };
      const rate = rateForPort(state.rateAnalysis, target), targetData = esc(JSON.stringify(target));
      const row = portTop + index * 44;
      const outputIcon = resourceIconMarkup(output.resource, state, "process-port-icon", 294, row - 8, 16) ?? "";
      markup.push(`<circle class="port-dot ${isPendingPortTarget(state, component.id, "output", output.resource) ? "link-active" : ""}" cx="320" cy="${row}" r="5"/><rect class="port-hit" data-port="output" data-component="${esc(component.id)}" data-resource="${esc(resourceKey(output.resource))}" x="175" y="${row - 10}" width="160" height="20"/><text class="port-label" x="${outputIcon ? 288 : 308}" y="${row + 4}" text-anchor="end">${esc(fitLabel(output.resource.id, outputIcon ? 15 : 19))} · ${output.amount}</text>${outputIcon}<rect class="rate-hit" data-constraint-target="${targetData}" x="172" y="${row + 11}" width="140" height="22" rx="5"/><text class="port-rate ${rateClass(rate)}" data-constraint-target="${targetData}" x="308" y="${row + 27}" text-anchor="end">${esc(rateText(rate, rateUnit(output.resource)))}</text>`);
    });
    markup.push("</g>");
  }
  state.world.innerHTML = markup.join("");
  hoveredEdgeLabel = undefined;
  state.world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  renderCanvasInteractionPreview(state);
  $("#grid").setAttribute("patternTransform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  $("#empty-hint").hidden = plant.components.length > 0;
}

export function orderedPorts<T extends Resource | { resource: Resource }>(order: CanvasState["portOrder"], componentId: string, direction: "input" | "output", ports: T[]): T[] {
  const savedOrder = order[componentId]?.[direction] ?? [];
  const keyOf = (port: T) => resourceKey("resource" in port ? port.resource : port);
  return ports.map((port, index) => ({ port, index, savedIndex: savedOrder.indexOf(keyOf(port)) }))
    .sort((a, b) => (a.savedIndex < 0 ? savedOrder.length + a.index : a.savedIndex) - (b.savedIndex < 0 ? savedOrder.length + b.index : b.savedIndex))
    .map(({ port }) => port);
}

export function portPoint(state: CanvasState, component: PlantComponent, direction: "input" | "output", resource: Resource): CanvasPoint {
  const p = state.positions[component.id] ?? { x: 0, y: 0 };
  if (component.kind !== "process") return { x: p.x + (component.kind === "supply" ? 70 : 0), y: p.y + 35 };
  const recipe = state.recipesById.get(component.recipeId);
  const ports = direction === "input" ? recipe?.inputs ?? [] : recipeOutputs(recipe).map((output) => ({ ...output.resource, amount: output.amount }));
  const list = orderedPorts(state.portOrder, component.id, direction, ports);
  const index = Math.max(0, list.findIndex((item) => resourceKey(item) === resourceKey(resource)));
  const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputs(recipe).length);
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
      const terminal = portPoint(state, component, state.pendingPort.direction, state.pendingPort.resource);
      const from = state.pendingPort.direction === "output" ? terminal : state.previewPoint;
      const to = state.pendingPort.direction === "output" ? state.previewPoint : terminal;
      preview.push(`<path class="edge-ghost" d="${connectionPath(from, to)}"/>`);
    }
  }
  const port = state.reorderingPort;
  if (port && state.previewPoint) {
    const component = state.plant.components.find(({ id }) => id === port.componentId);
    if (component?.kind === "process") {
      const position = state.positions[component.id] ?? { x: 0, y: 0 }, recipe = state.recipesById.get(component.recipeId);
      const ports = port.direction === "input" ? recipe?.inputs ?? [] : recipeOutputs(recipe);
      const rows = Math.max(recipe?.inputs.length ?? 0, recipeOutputs(recipe).length);
      const portTop = processGeometry(recipe ? short(recipe.id) : component.recipeId, rows).portTop;
      const targetIndex = Math.max(0, Math.min(ports.length - 1, Math.round((state.previewPoint.y - position.y - portTop) / 44)));
      const dropY = position.y + portTop + targetIndex * 44;
      preview.push(`<line class="reorder-ghost-line" x1="${position.x + 8}" y1="${dropY}" x2="${position.x + 312}" y2="${dropY}"/><g class="reorder-ghost" transform="translate(${state.previewPoint.x + 12} ${state.previewPoint.y + 8})"><rect width="150" height="30" rx="7"/><text x="10" y="20">${esc(short(port.resource.id))}</text></g>`);
    }
  }
  state.interactionPreview.innerHTML = preview.join("");
  state.interactionPreview.setAttribute("transform", `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`);
}

function processQuantityDisplay(plant: Plant, componentId: string, kind: "rpm" | "machine-count" | "stress" | "stack-size", measured: number | undefined) {
  const state = plantQuantityState(plant, componentId, kind, measured);
  const constraints = state.constraints;
  const imposed = constraints.flatMap((constraint) => {
    if (constraint.kind === "integer") return ["int"];
    if (constraint.kind === "power-of-two") return ["2ⁿ"];
    return [`${constraint.relation === "equals" ? "=" : constraint.relation === "at-least" ? "≥" : "≤"} ${formatNumber(constraint.value)}`];
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
function rateClass(rate: RateValue | undefined): string { return !rate || rate.state === "underconstrained" ? "underconstrained" : rate.state; }
function rateText(rate: RateValue | undefined, unit: string): string {
  if (!rate || rate.state === "underconstrained") {
    if (!rate) return `? ${unit}`;
    const { minimum, maximum } = rate;
    const range = maximum === undefined ? minimum > 0 ? `≥ ${formatNumber(minimum)}` : "?"
      : minimum === maximum ? formatNumber(minimum) : minimum === 0 ? `≤ ${formatNumber(maximum)}` : `${formatNumber(minimum)}–${formatNumber(maximum)}`;
    return `${range} ${unit}${rate.powerOfTwo ? " · 2ⁿ" : rate.integer ? " · int" : ""}`;
  }
  return rate.state === "conflict" ? "!" : `${formatNumber(rate.perMinute)} ${unit}`;
}
function rateUnit(resource: Resource): string { return resource.type === "fluid" ? "mB/min" : "items/min"; }
function resourceIconMarkup(resource: Resource, state: CanvasState, className: string, x: number, y: number, size: number): string | undefined {
  const keys = resource.type === "fluid" ? [`${resource.id}_still`, resource.id, `${resource.id}_bucket`] : [resource.id];
  const key = keys.find((candidate) => state.itemIcons[candidate]);
  if (!key) return undefined;
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
function machineLayoutMarkup(layout: MachineLayout, state: CanvasState, x: number, y: number): string {
  const key = JSON.stringify(layout.parts);
  const cachedId = machineLayoutIds.get(key);
  if (cachedId) return `<use class="machine-model" href="#${cachedId}" x="${x}" y="${y}" width="68" height="72"/>`;

  const faces = layout.parts.flatMap(({ model: modelId, position }) => {
    const model = state.machineModels[modelId];
    return [
      ...(model?.elements ?? []).flatMap((element) => modelFaces(element, position, state)),
      ...(model?.triangles ?? []).flatMap((triangle) => modelTriangles(triangle, position, state)),
    ];
  }).sort((a, b) => a.depth - b.depth);
  if (faces.length === 0) {
    const texture = layout.parts.map(({ model }) => state.machineModels[model]?.fallbackTexture).find((id): id is string => !!id);
    return texture ? resourceIconMarkup({ type: "item", id: texture }, state, "machine-layout-fallback", x + 10, y + 10, 48) ?? "" : "";
  }

  const points = faces.flatMap((face) => face.points);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const idPrefix = `machine-layout-${nextMachineLayoutId++}`;
  const faceMarkup = faces.map((face, index) => {
    const id = `machine-face-${idPrefix}-${index}`;
    const clip = `<clipPath id="${id}"><path d="${polygonPath(face.points)}"/></clipPath>`;
    const shade = face.shade ? `<path d="${polygonPath(face.points)}" fill="#101712" opacity="${face.shade}" pointer-events="none"/>` : "";
    return { clip, content: `${machineTextureMarkup(face, id, state)}${shade}` };
  });
  const symbol = `<symbol id="${idPrefix}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" preserveAspectRatio="xMidYMid meet"><defs>${faceMarkup.map(({ clip }) => clip).join("")}</defs>${faceMarkup.map(({ content }) => content).join("")}</symbol>`;
  document.querySelector<SVGDefsElement>("#machine-model-defs")?.insertAdjacentHTML("beforeend", symbol);
  machineLayoutIds.set(key, idPrefix);
  return `<use class="machine-model" href="#${idPrefix}" x="${x}" y="${y}" width="68" height="72"/>`;
}

type ProjectedFace = { points: CanvasPoint[]; texture: string; href: string; transform: string; depth: number; shade: number };
const isoCos = Math.sqrt(3) / 2;
const machineLayoutIds = new Map<string, string>();
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
    projected.push({ points: screen, texture: face.texture, href, transform, depth: center, shade: direction === "up" ? 0 : direction === "east" ? 0.22 : 0.12 });
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
  return [{ points, texture: triangle.texture, href, transform, depth, shade }];
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
  return !!state.pendingPort && state.pendingPort.componentId !== componentId && state.pendingPort.direction !== direction && resourceKey(state.pendingPort.resource) === resourceKey(resource);
}
function connectionPath(from: CanvasPoint, to: CanvasPoint): string {
  const bend = Math.max(50, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}
function formatNumber(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
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
