#!/usr/bin/env -S node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addPlantRecipe, analyzePlantRates, createPlant, getRecipe, parsePlantTransferYaml } from "../src/core.ts";
import { plantProcessMetrics } from "../src/core/plant-analysis.ts";

const plant = parsePlantTransferYaml(readFileSync(new URL("../tests/resources/machine-bound.yaml", import.meta.url), "utf8")).plant;
const process = plant.components.find((component) => component.kind === "process" && component.recipeId === "create:mixing/andesite_alloy");
assert.ok(process && process.kind === "process");
plant.constraints = plant.constraints.filter((constraint) => !(constraint.target.kind === "machine-count" && constraint.target.componentId === process.id));
plant.constraints.push({ id: "rate-cap", kind: "bound", relation: "at-most", value: 10,
  target: { kind: "port-rate", port: { componentId: "sink-7a4f615b-b895-4ea5-b006-27e942944425", direction: "input", resource: { type: "item", id: "create:andesite_alloy" } } } });
const recipe = getRecipe(process.recipeId);
assert.ok(recipe);
const analysis = analyzePlantRates(plant);
const metrics = plantProcessMetrics(plant, process.id, recipe, analysis);
assert.equal(metrics.machineCountIsMaximum, true);
assert.equal(metrics.machineCount, 1);

let nextId = 0;
const added = addPlantRecipe(createPlant("default-rpm"), recipe, (prefix) => `${prefix}-${nextId++}`);
assert.ok(added.plant.constraints.some((constraint) => constraint.target.kind === "rpm" && constraint.target.componentId === added.processId && constraint.kind === "bound" && constraint.relation === "equals" && constraint.value === 256));

const { calculateTiming } = await import("../src/timing.ts");
const duplicateOutcomeRecipe = { ...recipe, outputs: [
  { resource: recipe.output, amount: 1 }, { resource: recipe.output, amount: 1 },
], outputAmount: 1 };
const perMachine = calculateTiming(duplicateOutcomeRecipe, 256).batchesPerMinute * calculateTiming(duplicateOutcomeRecipe, 256).runsPerCycle * 2;
const outputAnalysis = { status: "balanced" as const, issues: [], connectionRates: [], portRates: [{ port: { componentId: process.id, direction: "output" as const, resource: recipe.output }, rate: { state: "derived" as const, perMinute: perMachine * 2 } }] };
const unconstrained = { ...plant, constraints: [{ id: "rpm", kind: "bound" as const, relation: "equals" as const, value: 256, target: { kind: "rpm" as const, componentId: process.id } }] };
assert.equal(plantProcessMetrics(unconstrained, process.id, duplicateOutcomeRecipe, outputAnalysis).machineCount, 2);
