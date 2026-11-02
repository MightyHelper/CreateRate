import { connectPlantPorts } from "../plant.ts";
import type { Plant, PlantComponent, PlantConnection, PlantConstraint, PortRef, Resource } from "../plant.ts";

export type PlantTransferMode = "full" | "graph";
export type PlantTransferLayout = {
  positions: Record<string, { x: number; y: number }>;
  portOrder: Record<string, { input?: string[]; output?: string[] }>;
};
export type PlantTransferDocument = {
  mode: PlantTransferMode;
  plant: Plant;
  layout?: PlantTransferLayout;
};

export function plantTransferYaml(plant: Plant, mode: PlantTransferMode, layout: PlantTransferLayout): string {
  return stringifyYaml({
    format: "CreateRate plant",
    version: 1,
    mode,
    plant,
    ...(mode === "full" ? { layout } : {}),
  });
}

export function parsePlantTransferYaml(source: string): PlantTransferDocument {
  const root = parseYaml(source);
  if (!isRecord(root) || root.format !== "CreateRate plant" || root.version !== 1) {
    throw new Error("Clipboard does not contain a supported CreateRate plant YAML document");
  }
  if (root.mode !== "full" && root.mode !== "graph") throw new Error("Plant YAML mode must be full or graph");
  const plant = parsePlant(root.plant);
  const layout = root.mode === "full" ? parseLayout(root.layout) : undefined;
  return { mode: root.mode, plant, ...(layout ? { layout } : {}) };
}

function parsePlant(value: unknown): Plant {
  if (!isRecord(value) || !isString(value.id) || !Array.isArray(value.components) || !Array.isArray(value.connections) || !Array.isArray(value.constraints)) {
    throw new Error("Plant YAML is missing its id, components, connections, or constraints");
  }
  const components = value.components.map(parseComponent);
  assertUniqueIds(components.map(({ id }) => id), "component");
  const connections = value.connections.map(parseConnection);
  assertUniqueIds(connections.map(({ id }) => id), "connection");
  const constraints = value.constraints.map(parseConstraint);
  assertUniqueIds(constraints.map(({ id }) => id), "constraint");

  let checked: Plant = { id: value.id, components, connections: [], constraints: [] };
  for (const connection of connections) checked = connectPlantPorts(checked, connection);
  const componentIds = new Set(components.map(({ id }) => id));
  const connectionIds = new Set(connections.map(({ id }) => id));
  for (const constraint of constraints) {
    const { target } = constraint;
    if (target.kind === "connection-rate") {
      if (!connectionIds.has(target.connectionId)) throw new Error(`Constraint refers to missing connection ${target.connectionId}`);
    } else if (target.kind === "port-rate") {
      if (!componentIds.has(target.port.componentId)) throw new Error(`Constraint refers to missing component ${target.port.componentId}`);
    } else if (!componentIds.has(target.componentId)) {
      throw new Error(`Constraint refers to missing component ${target.componentId}`);
    }
  }
  return { ...checked, constraints };
}

function parseComponent(value: unknown): PlantComponent {
  if (!isRecord(value) || !isString(value.id)) throw new Error("Each plant component needs an id");
  if (value.kind === "process" && isString(value.recipeId)) return { id: value.id, kind: "process", recipeId: value.recipeId };
  if ((value.kind === "supply" || value.kind === "demand" || value.kind === "pool") && isRecord(value.resource)) {
    return { id: value.id, kind: value.kind, resource: parseResource(value.resource) };
  }
  throw new Error(`Invalid plant component ${value.id}`);
}

function parseConnection(value: unknown): PlantConnection {
  if (!isRecord(value) || !isString(value.id)) throw new Error("Each plant connection needs an id");
  if (value.secondary !== undefined && typeof value.secondary !== "boolean") throw new Error(`Invalid secondary flag on connection ${value.id}`);
  return { id: value.id, from: parsePort(value.from), to: parsePort(value.to), ...(value.secondary ? { secondary: true } : {}) };
}

function parsePort(value: unknown): PortRef {
  if (!isRecord(value) || !isString(value.componentId) || (value.direction !== "input" && value.direction !== "output")) {
    throw new Error("Invalid plant port reference");
  }
  return { componentId: value.componentId, direction: value.direction, resource: parseResource(value.resource) };
}

function parseResource(value: unknown): Resource {
  if (!isRecord(value) || (value.type !== "item" && value.type !== "fluid") || !isString(value.id)) {
    throw new Error("Invalid plant resource");
  }
  return { type: value.type, id: value.id };
}

function parseConstraint(value: unknown): PlantConstraint {
  if (!isRecord(value) || !isString(value.id) || !isRecord(value.target)) throw new Error("Invalid plant constraint");
  const target = value.target;
  let parsedTarget: PlantConstraint["target"];
  if (target.kind === "port-rate") parsedTarget = { kind: "port-rate", port: parsePort(target.port) };
  else if (target.kind === "connection-rate" && isString(target.connectionId)) parsedTarget = { kind: "connection-rate", connectionId: target.connectionId };
  else if (["rpm", "stack-size", "machine-count", "stress"].includes(String(target.kind)) && isString(target.componentId)) {
    parsedTarget = { kind: target.kind as "rpm" | "stack-size" | "machine-count" | "stress", componentId: target.componentId };
  } else throw new Error(`Invalid constraint target ${value.id}`);

  if (value.kind === "integer" || value.kind === "power-of-two") return { id: value.id, kind: value.kind, target: parsedTarget };
  if (value.kind === "bound" && ["equals", "at-least", "at-most"].includes(String(value.relation)) && isFiniteNonNegative(value.value)) {
    return { id: value.id, kind: "bound", relation: value.relation as "equals" | "at-least" | "at-most", value: value.value, target: parsedTarget };
  }
  throw new Error(`Invalid constraint ${value.id}`);
}

function parseLayout(value: unknown): PlantTransferLayout {
  if (!isRecord(value) || !isRecord(value.positions) || !isRecord(value.portOrder)) {
    throw new Error("Full plant YAML needs layout positions and port order");
  }
  const positions: PlantTransferLayout["positions"] = {};
  for (const [id, point] of Object.entries(value.positions)) {
    if (!isRecord(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`Invalid position for ${id}`);
    positions[id] = { x: point.x as number, y: point.y as number };
  }
  const portOrder: PlantTransferLayout["portOrder"] = {};
  for (const [id, order] of Object.entries(value.portOrder)) {
    if (!isRecord(order) || (order.input !== undefined && !stringArray(order.input)) || (order.output !== undefined && !stringArray(order.output))) {
      throw new Error(`Invalid port order for ${id}`);
    }
    portOrder[id] = {
      ...(order.input ? { input: order.input } : {}),
      ...(order.output ? { output: order.output } : {}),
    };
  }
  return { positions, portOrder };
}

function parseYaml(source: string): unknown {
  const lines = source.split(/\r?\n/).flatMap((raw, index) => {
    if (!raw.trim() || raw.trimStart().startsWith("#") || raw.trim() === "---") return [];
    if (raw.includes("\t")) throw new Error(`Tabs are not supported in YAML (line ${index + 1})`);
    const indent = raw.length - raw.trimStart().length;
    return [{ indent, text: raw.trim() }];
  });
  if (!lines.length) throw new Error("Clipboard is empty");
  const parsed = parseYamlBlock(lines, 0, lines[0].indent);
  if (parsed.index !== lines.length) throw new Error("Unexpected YAML content after the root value");
  return parsed.value;
}

function parseYamlBlock(lines: Array<{ indent: number; text: string }>, start: number, indent: number): { value: unknown; index: number } {
  const sequence = lines[start].text === "-" || lines[start].text.startsWith("- ");
  if (sequence) {
    const values: unknown[] = [];
    let index = start;
    while (index < lines.length && lines[index].indent === indent && (lines[index].text === "-" || lines[index].text.startsWith("- "))) {
      const rest = lines[index].text.slice(1).trim();
      if (rest) { values.push(parseYamlScalar(rest)); index++; }
      else if (index + 1 < lines.length && lines[index + 1].indent > indent) {
        const nested = parseYamlBlock(lines, index + 1, lines[index + 1].indent);
        values.push(nested.value); index = nested.index;
      } else { values.push(null); index++; }
    }
    return { value: values, index };
  }

  const value: Record<string, unknown> = Object.create(null);
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const [keyText, rest] = splitYamlMapping(lines[index].text);
    const keyValue = parseYamlKey(keyText);
    if (Object.hasOwn(value, keyValue)) throw new Error(`Duplicate YAML key: ${keyValue}`);
    if (rest) { value[keyValue] = parseYamlScalar(rest); index++; }
    else if (index + 1 < lines.length && lines[index + 1].indent > indent) {
      const nested = parseYamlBlock(lines, index + 1, lines[index + 1].indent);
      value[keyValue] = nested.value; index = nested.index;
    } else { value[keyValue] = null; index++; }
  }
  if (!Object.keys(value).length) throw new Error("Invalid YAML mapping");
  return { value, index };
}

function splitYamlMapping(line: string): [string, string] {
  let quoted = false, escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quoted) { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ":" && !quoted && (index + 1 === line.length || /\s/.test(line[index + 1]))) {
      return [line.slice(0, index), line.slice(index + 1).trim()];
    }
  }
  throw new Error(`Expected a YAML mapping entry: ${line}`);
}

function parseYamlKey(key: string): string {
  const value = key.startsWith('"') ? parseYamlScalar(key) : key;
  if (!isString(value) || !value) throw new Error(`Invalid YAML mapping key: ${key}`);
  return value;
}

function parseYamlScalar(text: string): unknown {
  if (text.startsWith('"') || text === "[]" || text === "{}") {
    try { return JSON.parse(text); } catch { throw new Error(`Invalid YAML scalar: ${text}`); }
  }
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  return text;
}

function stringifyYaml(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (!value.length) return `${" ".repeat(indent)}[]`;
    return value.map((item) => isComposite(item)
      ? `${" ".repeat(indent)}-\n${stringifyYaml(item, indent + 2)}`
      : `${" ".repeat(indent)}- ${yamlScalar(item)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return `${" ".repeat(indent)}{}`;
    return entries.map(([key, item]) => {
      const prefix = `${" ".repeat(indent)}${yamlKey(key)}:`;
      return isComposite(item) ? `${prefix}\n${stringifyYaml(item, indent + 2)}` : `${prefix} ${yamlScalar(item)}`;
    }).join("\n");
  }
  return `${" ".repeat(indent)}${yamlScalar(value)}`;
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isRecord(value) && Object.keys(value).length === 0) return "{}";
  throw new Error("Cannot export an unsupported YAML value");
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function isComposite(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : isRecord(value) && Object.keys(value).length > 0;
}

function assertUniqueIds(ids: string[], kind: string): void {
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error(`Plant has a missing or duplicate ${kind} id`);
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isFiniteNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isString(value: unknown): value is string { return typeof value === "string"; }
function isRecord(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
