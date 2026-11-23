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

const { canonicalizePlantResources, ingredientConnectionAccepts } = await import("../src/recipe-queries.ts");
const tagPlant: Plant = { id: "tag-plant", components: [{ id: "source", kind: "supply", resource: { type: "item", id: "#logs" } }], connections: [], constraints: [] };
const enriched = canonicalizePlantResources(tagPlant, { logs: ["iron", "copper"] }, {});
const tagSource = enriched.components[0];
assert.ok(tagSource.kind === "supply");
assert.deepEqual(tagSource.resource.alternatives, ["iron", "copper"]);
const tagIngredient = { type: "item" as const, id: "#ingredient", alternatives: ["copper", "gold"], amount: 1 };
assert.equal(ingredientConnectionAccepts([tagIngredient], tagIngredient, tagSource.resource), true);
assert.equal(ingredientConnectionAccepts([tagIngredient], tagIngredient, { type: "item", id: "#other", alternatives: ["silver"] }), false);
assert.deepEqual(canonicalizePlantResources(tagPlant, {}, {}).components, tagPlant.components);
for (const id of ["constructor", "toString", "__proto__"]) {
  const resource = { type: "item" as const, id: `#${id}` };
  const plant = { id: "unknown", components: [{ id: "s", kind: "supply" as const, resource }], connections: [], constraints: [] };
  assert.deepEqual(canonicalizePlantResources(plant, {}, {}).components, plant.components);
  assert.equal(resourcesMatch(resource, { type: "item", id: "iron" }, {}, {}), false);
  assert.equal(resourcesMatch(resource, resource, {}, {}), true);
}

const inlineYaml = `format: "CreateRate plant"
version: 1
mode: graph
plant:
  id: p
  components:
    - id: source
      kind: supply
      resource:
        type: item
        id: iron
    - "id": sink
      kind: demand
      resource:
        type: item
        id: iron
  connections:
    - id: flow
      from:
        componentId: source
        direction: output
        resource:
          type: item
          id: iron
      to:
        componentId: sink
        direction: input
        resource:
          type: item
          id: iron
  constraints: []`;
const inline = parsePlantTransferYaml(inlineYaml);
assert.equal(inline.plant.components.length, 2);
assert.equal(inline.plant.connections[0].id, "flow");
assert.throws(() => parsePlantTransferYaml(inlineYaml.replace('      kind: supply', '      id: duplicate\n      kind: supply')), /Duplicate YAML key/);
