import { strict as assert } from "node:assert";
import { listChoiceTags, resourceChoice } from "../src/recipe-choices.ts";

const alternatives = ["minecraft:iron_nugget", "create:zinc_nugget"];
const choice = resourceChoice({ id: "iron or gold", alternatives });
assert.equal(choice.tagId, "#createrate:nuggets");
assert.deepEqual(choice.members, alternatives);
assert.deepEqual(listChoiceTags()["createrate:nuggets"], [...alternatives].sort());
assert.equal(resourceChoice({ id: "other", alternatives: [...alternatives].reverse() }).tagId, choice.tagId);
const other = resourceChoice({ id: "gold or iron", alternatives: ["minecraft:gold_nugget", "minecraft:iron_nugget"] });
assert.notEqual(other.tagId, choice.tagId);
assert.deepEqual(listChoiceTags()[choice.tagId!.slice(1)], [...alternatives].sort());
assert.deepEqual(listChoiceTags()[other.tagId!.slice(1)], ["minecraft:gold_nugget", "minecraft:iron_nugget"]);
assert.deepEqual(resourceChoice({ id: "#forge:ingots", alternatives: ["a", "a", "b"] }), { tagId: "#forge:ingots", members: ["a", "b"] });
assert.deepEqual(resourceChoice({ id: "minecraft:iron_ingot" }), { tagId: undefined, members: [] });
