import { strict as assert } from "node:assert";
import { listChoiceTags, resourceChoice } from "../src/recipe-choices.ts";

const alternatives = ["minecraft:iron_nugget", "minecraft:gold_nugget"];
const choice = resourceChoice({ id: "iron or gold", alternatives });
assert.equal(choice.tagId, "#createrate:nuggets");
assert.deepEqual(choice.members, alternatives);
assert.deepEqual(listChoiceTags()["createrate:nuggets"], [...alternatives].sort());
assert.equal(resourceChoice({ id: "other", alternatives: [...alternatives].reverse() }).tagId, choice.tagId);
assert.deepEqual(resourceChoice({ id: "#forge:ingots", alternatives: ["a", "a", "b"] }), { tagId: "#forge:ingots", members: ["a", "b"] });
assert.deepEqual(resourceChoice({ id: "minecraft:iron_ingot" }), { tagId: undefined, members: [] });
