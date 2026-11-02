export type GestureContext = "canvas" | "background" | "component" | "process" | "boundary" | "pool" | "port" | "arrow" | "selection" | "controls" | "constraint" | "modal";
export type GestureModality = "mouse" | "touch";
export type GestureState = {
  modality: GestureModality;
  pendingConnection: boolean;
  selectionCount: number;
  selectedKind?: "process" | "supply" | "demand" | "pool" | "arrow";
  hoveredKind?: "process" | "supply" | "demand" | "pool";
  hoveredResource?: string;
  hoveredDirection?: "input" | "output";
  menuOpen: boolean;
  draggingComponent: boolean;
};
export type GestureDefinition = {
  id: string;
  context: GestureContext;
  description: (state: GestureState) => string | undefined;
  exposed?: boolean;
};
export type GestureHandler = (payload?: any) => void;
export type GestureHandlers = Record<string, GestureHandler>;

export const gestureDefinitions: GestureDefinition[] = [
  { id: "canvas.select-all", context: "canvas", description: () => "Ctrl/⌘ + A · Select all nodes" },
  { id: "selection.delete", context: "canvas", description: (state) => state.selectionCount ? "Del · Delete selection" : undefined },
  { id: "canvas.cancel-link", context: "canvas", description: (state) => state.pendingConnection ? "Esc · Cancel connection" : undefined },
  { id: "canvas.zoom", context: "canvas", description: (state) => state.modality === "mouse" ? "Scroll · Zoom at cursor" : "Pinch · Zoom" },
  { id: "canvas.pan-middle", context: "canvas", description: (state) => state.modality === "mouse" ? "Middle-drag · Pan canvas" : undefined },
  { id: "background.pan", context: "background", description: (state) => state.modality === "mouse" ? "Drag empty canvas · Pan" : "Drag empty canvas · Pan" },
  { id: "background.deselect", context: "background", description: (state) => state.selectionCount ? "Click/tap empty canvas · Deselect" : undefined },
  { id: "background.add-process", context: "background", description: (state) => state.modality === "mouse"
    ? state.pendingConnection ? "Double-click · Add and connect matching process" : "Double-click · Add process"
    : state.pendingConnection ? "Double-tap · Add and connect matching process" : "Double-tap · Add process" },
  { id: "background.add-item", context: "background", description: (state) => state.modality === "mouse"
    ? state.pendingConnection ? "Shift + double-click · Add and connect matching item" : "Shift + double-click · Add item source/sink"
    : state.pendingConnection ? "Shift + double-tap · Add and connect matching item" : "Shift + double-tap · Add item source/sink" },
  { id: "component.select", context: "component", description: () => "Click/tap · Select" },
  { id: "component.move", context: "component", description: (state) => state.modality === "mouse" ? "Drag · Move" : "Hold, then drag · Move" },
  { id: "component.cancel-drag", context: "component", description: (state) => state.draggingComponent ? "Drag off-screen · Cancel move" : undefined },
  { id: "component.duplicate", context: "component", description: (state) => state.modality === "mouse" ? "Alt + drag · Duplicate selection" : undefined },
  { id: "component.box-select", context: "canvas", description: (state) => state.modality === "mouse" ? "Shift + drag · Box select" : undefined },
  { id: "process.reorder-input-output", context: "port", description: (state) => state.modality === "mouse" && state.hoveredKind === "process" ? "Ctrl + drag · Reorder ports" : undefined },
  { id: "port.connect", context: "port", description: (state) => state.hoveredKind !== "pool" && (state.modality === "mouse"
    ? state.pendingConnection ? "Ctrl-click matching port · Connect (same port cancels)" : "Ctrl-click · Start connection"
    : state.pendingConnection ? "Tap matching port · Connect (origin cancels)" : "Tap port · Start connection") },
  { id: "boundary.expand", context: "boundary", description: (state) => {
    const action = state.hoveredKind === "supply" ? "Produce" : "Use";
    return `${state.modality === "mouse" ? "Double-click" : "Double-tap"} · ${action} ${state.hoveredResource ?? "item"}`;
  } },
  { id: "boundary.expand-reverse", context: "boundary", description: (state) => state.modality === "mouse"
    ? `Ctrl + double-click · ${state.hoveredKind === "supply" ? "Use" : "Produce"} ${state.hoveredResource ?? "item"}`
    : undefined },
  { id: "boundary.merge", context: "boundary", description: (state) => state.draggingComponent && (state.selectedKind === "supply" || state.selectedKind === "demand")
    ? "Drop dragged square here · Merge or connect" : undefined },
  { id: "pool.connect", context: "pool", description: (state) => state.modality === "mouse"
    ? state.pendingConnection ? "Click pool port · Connect" : "Ctrl-click pool port · Start connection"
    : state.pendingConnection ? "Tap pool port · Connect" : "Tap pool port · Start connection" },
  { id: "arrow.select", context: "arrow", description: () => "Click/tap · Select flow" },
  { id: "arrow.insert-pool", context: "arrow", description: (state) => state.modality === "mouse" ? "Right-click · Insert storage pool" : "Long-press · Insert storage pool" },
  { id: "arrow.split", context: "arrow", description: (state) => state.modality === "mouse" ? "Ctrl + right-click · Split into source and sink" : "Shift + long-press · Split into source and sink" },
  { id: "selection.secondary", context: "selection", description: (state) => state.selectedKind === "arrow" ? "Selection panel · Mark flow secondary/primary" : undefined },
  { id: "controls.menu", context: "controls", description: (state) => state.menuOpen ? "Click menu · Close actions" : "Click menu · Open actions" },
  { id: "controls.dismiss-menu", context: "canvas", description: (state) => state.menuOpen ? "Esc / click outside · Close menu" : undefined },
  { id: "controls.fit-view", context: "controls", description: (state) => state.menuOpen ? "Fit view · Frame the plant" : undefined },
  { id: "controls.reset", context: "controls", description: (state) => state.menuOpen ? "Reset · Clear the plant" : undefined },
  { id: "controls.export-full", context: "controls", description: (state) => state.menuOpen ? "Export full · Copy layout and graph" : undefined },
  { id: "controls.export-graph", context: "controls", description: (state) => state.menuOpen ? "Export graph · Copy recipes and constraints" : undefined },
  { id: "controls.import", context: "controls", description: (state) => state.menuOpen ? "Import · Read plant from clipboard" : undefined },
  { id: "constraint.edit", context: "constraint", description: () => "Click rate · Edit constraint" },
  { id: "constraint.move-node", context: "constraint", description: (state) => !state.hoveredKind ? undefined
    : state.modality === "mouse" ? "Drag rate · Move node" : "Hold, then drag rate · Move node" },
  { id: "dialog.close", context: "modal", description: () => "Esc / Close button · Close dialog" },
];

export function createGestureFramework(handlers: GestureHandlers) {
  const definitions = new Map(gestureDefinitions.map((definition) => [definition.id, definition]));
  const missing = [...definitions.keys()].filter((id) => typeof handlers[id] !== "function");
  if (missing.length) throw new Error(`Missing gesture handlers: ${missing.join(", ")}`);
  const undocumented = Object.keys(handlers).filter((id) => !definitions.has(id));
  if (undocumented.length) throw new Error(`Undocumented gesture handlers: ${undocumented.join(", ")}`);

  return {
    dispatch(id: string, payload?: unknown) {
      const handler = handlers[id];
      if (!handler) throw new Error(`Unknown gesture action: ${id}`);
      handler(payload);
    },
    groups(contextPath: GestureContext[], state: GestureState) {
      return contextPath.flatMap((context) => {
        const actions = gestureDefinitions
          .filter((definition) => definition.context === context && definition.exposed !== false)
          .flatMap((definition) => {
            const description = definition.description(state);
            return description ? [{ id: definition.id, description }] : [];
          });
        return actions.length ? [{ context, label: contextLabel(context), actions }] : [];
      });
    },
  };
}

export function gestureContextPath(target: Element | null): GestureContext[] {
  if (target?.closest("dialog[open]")) return ["modal"];
  if (target?.closest("#gesture-help")) return ["background", "canvas"];
  if (target?.closest(".canvas-menu")) return ["controls", "canvas"];
  if (target?.closest("#selection-info")) return ["selection", "canvas"];
  if (target?.closest("[data-constraint-target]")) return ["constraint", "canvas"];
  const port = target?.closest<SVGElement>("[data-port]");
  const component = target?.closest<SVGGElement>("g[data-component]");
  const kind = component?.classList.contains("process") ? "process"
    : component?.classList.contains("pool") ? "pool"
      : component ? "boundary" : undefined;
  if (port) {
    const specific: GestureContext = kind === "process" ? "process" : kind === "pool" ? "pool" : "boundary";
    return ["port", specific, "component", "canvas"];
  }
  if (target?.closest("[data-edge]")) return ["arrow", "canvas"];
  if (kind === "process") return ["process", "component", "canvas"];
  if (kind === "pool") return ["pool", "component", "canvas"];
  if (kind === "supply" || kind === "demand") return ["boundary", "component", "canvas"];
  return ["background", "canvas"];
}

function contextLabel(context: GestureContext): string {
  return ({ canvas: "Canvas", background: "Empty canvas", component: "Node", process: "Process", boundary: "Source / sink", pool: "Storage pool", port: "Ports", arrow: "Flow", selection: "Selection", controls: "Canvas menu", constraint: "Rate", modal: "Dialog" })[context];
}
