import assert from 'node:assert/strict';
import { legacyFluidPorts, repairLegacyFluidPort, splitAndRepairLegacyFluidPort, legacyFluidConstraints, repairLegacyFluidConstraint } from '../src/core/legacy-fluid-repair.ts';
import type { Plant } from '../src/plant.ts';
import type { Recipe } from '../src/recipes.ts';

const old = { type: 'fluid' as const, id: 'railways:paint' };
const yellow = { ...old, nbt: { Color: 'yellow' } };
const green = { ...old, nbt: { Color: 'green' } };
const chartreuse = { ...old, nbt: { Color: 'chartreuse' } };
const recipe = { id: 'mix', inputs: [{ ...yellow, amount: 125 }, { ...green, amount: 125 }], output: chartreuse, outputAmount: 250 } as Recipe;
const findRecipe = (id: string) => id === 'mix' ? recipe : undefined;
const plant: Plant = { id: 'old', components: [{ id: 'source', kind: 'supply', resource: old }, { id: 'mix', kind: 'process', recipeId: 'mix' }], connections: [{ id: 'edge', secondary: true, from: { componentId: 'source', direction: 'output', resource: old }, to: { componentId: 'mix', direction: 'input', resource: old } }], constraints: [ { id: 'flow-rate', kind: 'bound', relation: 'equals', value: 10, target: { kind: 'connection-rate', connectionId: 'edge' } }, { id: 'input-rate', kind: 'bound', relation: 'equals', value: 10, target: { kind: 'port-rate', port: { componentId: 'mix', direction: 'input', resource: old } } } ] };
const ports = legacyFluidPorts(plant, findRecipe);
assert.equal(ports.length, 1);
assert.deepEqual(ports[0].candidates, [yellow, green]);
const repaired = repairLegacyFluidPort(plant, 'edge', 'input', yellow, findRecipe);
assert.deepEqual(repaired.connections[0], { id: 'edge', secondary: true, from: { componentId: 'source', direction: 'output', resource: yellow }, to: { componentId: 'mix', direction: 'input', resource: yellow } });
assert.deepEqual(repaired.constraints, plant.constraints);
assert.deepEqual(plant.components[0], { id: 'source', kind: 'supply', resource: old });
assert.equal(legacyFluidPorts(repaired, findRecipe).length, 0);
assert.throws(() => repairLegacyFluidPort(plant, 'edge', 'input', chartreuse, findRecipe));
const shared: Plant = { ...plant, connections: [...plant.connections, { ...plant.connections[0], id: 'other' }] };
assert.throws(() => repairLegacyFluidPort(shared, 'edge', 'input', yellow, findRecipe), /Shared resource/);
for (const kind of ['supply', 'pool'] as const) {
  const sharedInput: Plant = { ...shared, components: shared.components.map(component => component.id === 'source' ? { ...component, kind } : component) };
  const split = splitAndRepairLegacyFluidPort(sharedInput, 'edge', 'input', yellow, 'split', findRecipe);
  assert.deepEqual(split.components.find(component => component.id === 'source'), sharedInput.components[0]);
  assert.deepEqual(split.components.find(component => component.id === 'split'), { id: 'split', kind, resource: yellow });
  assert.equal(split.connections[0].from.componentId, 'split');
  assert.deepEqual(split.connections[1], sharedInput.connections[1]);
  assert.deepEqual(split.constraints, sharedInput.constraints);
}
for (const kind of ['demand', 'pool'] as const) {
  const sharedOutput: Plant = { id: 'output', components: [{ id: 'mix', kind: 'process', recipeId: 'mix' }, { id: 'sink', kind, resource: old }], connections: ['first', 'second'].map(id => ({ id, from: { componentId: 'mix', direction: 'output' as const, resource: old }, to: { componentId: 'sink', direction: 'input' as const, resource: old } })), constraints: [{ id: 'rate', kind: 'bound', relation: 'equals', value: 10, target: { kind: 'port-rate', port: { componentId: 'sink', direction: 'input', resource: old } } }] };
  const split = splitAndRepairLegacyFluidPort(sharedOutput, 'first', 'output', chartreuse, 'split', findRecipe);
  assert.deepEqual(split.components.find(component => component.id === 'split'), { id: 'split', kind, resource: chartreuse });
  assert.deepEqual(split.components.find(component => component.id === 'sink'), sharedOutput.components[1]);
  assert.equal(split.connections[0].to.componentId, 'split');
  assert.deepEqual(split.connections[1], sharedOutput.connections[1]);
  assert.deepEqual(split.constraints, sharedOutput.constraints);
  assert.throws(() => splitAndRepairLegacyFluidPort(sharedOutput, 'first', 'output', chartreuse, 'sink', findRecipe), /unique/);
}
const legacyConstraints = legacyFluidConstraints(repaired, findRecipe);
assert.deepEqual(legacyConstraints.map(({ constraintId, candidates }) => ({ constraintId, candidates })), [{ constraintId: 'input-rate', candidates: [yellow, green] }]);
assert.throws(() => repairLegacyFluidConstraint(repaired, 'input-rate', chartreuse, findRecipe));
const repairedConstraint = repairLegacyFluidConstraint(repaired, 'input-rate', green, findRecipe);
assert.deepEqual(repairedConstraint.constraints[1], { ...plant.constraints[1], target: { kind: 'port-rate', port: { componentId: 'mix', direction: 'input', resource: green } } });
assert.deepEqual(repairedConstraint.connections, repaired.connections);
assert.deepEqual(repairedConstraint.constraints[0], repaired.constraints[0]);
assert.equal(legacyFluidConstraints(repairedConstraint, findRecipe).length, 0);
assert.equal(legacyFluidConstraints(repaired, findRecipe).length, 1);
console.log('Legacy fluid repair tests passed');
