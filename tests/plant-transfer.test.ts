import { strict as assert } from "node:assert";
import { parsePlantTransferYaml, plantTransferYaml } from "../src/core/plant-transfer.ts";
import { resourcesMatch } from "../src/recipe-queries.ts";
import type { Plant } from "../src/plant.ts";
const choice = { type: "item" as const, id: "iron or gold", alternatives: ["iron", "gold"] };
const plant: Plant = { id: "plant", components: [{ id: "source", kind: "supply", resource: choice }, { id: "process", kind: "process", recipeId: "r" }], connections: [{ id: "flow", from: { componentId: "source", direction: "output", resource: choice }, to: { componentId: "process", direction: "input", resource: choice } }], constraints: [] };
const layout = { positions: { source: { x: 2, y: 3 } }, portOrder: {} };
for (const mode of ["graph", "full"] as const) {
  const restored = parsePlantTransferYaml(plantTransferYaml(plant, mode, layout));
  const supply = restored.plant.components.find((component) => component.kind === "supply");
  assert.ok(supply && supply.kind === "supply");
  assert.deepEqual(supply.resource.alternatives, choice.alternatives);
  assert.ok(resourcesMatch(supply.resource, { type: "item", id: "iron" }, {}, {}));
  assert.deepEqual(restored.plant.connections[0].to.resource.alternatives, choice.alternatives);
}
const invalid = plantTransferYaml(plant, "graph", layout).replace('"iron"', '123');
assert.throws(() => parsePlantTransferYaml(invalid), /Invalid resource alternatives/);
