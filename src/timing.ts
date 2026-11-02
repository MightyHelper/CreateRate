import timingData from "../data/timing.json";
import stressData from "../data/stress.json";
import type { Recipe } from "./recipes.ts";

type MixerRules = {
  minimumRpm: number;
  animationTicks: number;
  referenceRpm: number;
  defaultRecipeDurationTicks: number;
  durationReferenceTicks: number;
  recipeWorkPerDuration: number;
  minimumProcessingTicks: number;
  maximumProcessingTicks: number;
};

type FanRules = {
  processingTimeTicks: number;
  itemsPerProcessingStep: number;
};

type PressRules = {
  minimumRpm: number;
  cycleTicks: number;
  referenceRpm: number;
  minimumTickAdvance: number;
  maximumTickAdvance: number;
};

type CrushingWheelRules = {
  rpmMultiplier: number;
  stackSizeLogBase: number;
  minimumProcessingSpeed: number;
  maximumProcessingSpeed: number;
  recipeApplyThresholdTicks: number;
  defaultRecipeDurationTicks: number;
};

type MillstoneRules = {
  rpmPerProcessingSpeed: number;
  minimumProcessingSpeed: number;
  maximumProcessingSpeed: number;
  recipeRestartTicks: number;
};

type SawRules = {
  rpmPerProcessingSpeed: number;
  minimumProcessingSpeed: number;
  maximumProcessingSpeed: number;
  itemsPerDurationStep: number;
  recipeApplyThresholdTicks: number;
  postApplyTicks: number;
  startupTicks: number;
  defaultRecipeDurationTicks: number;
};

type TimingRules = {
  ticksPerSecond: number;
  fixedDurationMachines: Record<string, number>;
  encasedFan: FanRules;
  crushingWheels: CrushingWheelRules;
  millstone: MillstoneRules;
  mechanicalSaw: SawRules;
  mechanicalMixer: MixerRules;
  mechanicalPress: PressRules;
};
type StressRule = { suPerRpm: number; unitsPerProcess?: number; unitsFromRecipePattern?: boolean };

const rules = timingData as TimingRules;
const stressRules = stressData as Record<string, StressRule>;
const ticksPerMinute = rules.ticksPerSecond * 60;

export type OperationTiming = {
  firstBatchTicks: number;
  cycleTicks: number;
  firstBatchSeconds: number;
  cycleSeconds: number;
  batchesPerMinute: number;
  runsPerCycle: number;
  outputPerMinute: number;
};

export function stressImpactPerMachine(recipe: Recipe): number {
  const rule = stressRules[recipe.machine ?? ""];
  if (!rule) return 0;
  const units = rule.unitsFromRecipePattern ? recipe.machineUnits ?? 1 : rule.unitsPerProcess ?? 1;
  return rule.suPerRpm * units;
}

export function calculateStressImpact(recipe: Recipe, rpm: number, machineCount: number): number {
  if (![rpm, machineCount].every(Number.isFinite) || machineCount < 0) {
    throw new Error("RPM and machine count must be finite values");
  }
  return stressImpactPerMachine(recipe) * Math.abs(rpm) * machineCount;
}

export type IntegerRange = { minimum: number; maximum: number };
export type OperatingRange = number | IntegerRange;
export type FeasibleTimingRequest = {
  targetOutputPerMinute: number;
  rpm?: OperatingRange;
  stackSize?: OperatingRange;
};
export type FeasibleOperatingPoint = {
  rpm?: number;
  stackSize?: number;
  capacityPerMachine: number;
};
export type FeasibleTimingResult = {
  status: "determined" | "underconstrained" | "infeasible";
  unresolved: Array<"rpm" | "stackSize">;
  operatingPoints: FeasibleOperatingPoint[];
};

const rpmMachines = new Set(["mechanical_mixer", "mechanical_press", "crushing_wheels", "millstone", "mechanical_saw"]);
const stackSizeMachines = new Set(["encased_fan", "crushing_wheels", "mechanical_saw"]);

export type OperatingCondition = "rpm" | "stackSize";

export function requiredOperatingConditions(recipe: Recipe): OperatingCondition[] {
  const machine = recipe.machine ?? "";
  return [
    ...(rpmMachines.has(machine) ? ["rpm" as const] : []),
    ...(stackSizeMachines.has(machine) ? ["stackSize" as const] : []),
  ];
}

export function calculateTiming(recipe: Recipe, rpm: number, stackSize = 1): OperationTiming {
  if (recipe.machine === "encased_fan") return fanTiming(recipe, stackSize);
  if (recipe.machine === "crushing_wheels") return crushingWheelTiming(recipe, rpm, stackSize);
  if (recipe.machine === "millstone") return millstoneTiming(recipe, rpm);
  if (recipe.machine === "mechanical_saw") return sawTiming(recipe, rpm, stackSize);
  const machineSlots = rules.fixedDurationMachines[recipe.machine ?? ""];
  if (machineSlots !== undefined) {
    if (!recipe.durationTicks || recipe.durationTicks <= 0) {
      throw new Error(`No cooking duration for ${recipe.method} (${recipe.id})`);
    }
    const cycleTicks = recipe.durationTicks;
    const batchesPerMinute = ticksPerMinute / cycleTicks;
    return {
      firstBatchTicks: cycleTicks,
      cycleTicks,
      firstBatchSeconds: cycleTicks / rules.ticksPerSecond,
      cycleSeconds: cycleTicks / rules.ticksPerSecond,
      batchesPerMinute,
      runsPerCycle: machineSlots,
      outputPerMinute: batchesPerMinute * recipe.outputAmount * machineSlots,
    };
  }
  if (recipe.machine !== "mechanical_mixer" && recipe.machine !== "mechanical_press") {
    throw new Error(`No timing rule for ${recipe.method} (${recipe.id})`);
  }

  const timing = recipe.machine === "mechanical_mixer"
    ? mixerTiming(recipe, rpm)
    : pressTiming(rpm);
  const batchesPerMinute = ticksPerMinute / timing.cycleTicks;

  return {
    ...timing,
    firstBatchSeconds: timing.firstBatchTicks / rules.ticksPerSecond,
    cycleSeconds: timing.cycleTicks / rules.ticksPerSecond,
    batchesPerMinute,
    runsPerCycle: 1,
    outputPerMinute: batchesPerMinute * recipe.outputAmount,
  };
}

export function findFeasibleTimings(recipe: Recipe, request: FeasibleTimingRequest): FeasibleTimingResult {
  if (!Number.isFinite(request.targetOutputPerMinute) || request.targetOutputPerMinute <= 0) {
    throw new Error("Target output rate must be greater than zero");
  }

  const needsRpm = rpmMachines.has(recipe.machine ?? "");
  const needsStackSize = stackSizeMachines.has(recipe.machine ?? "");
  const rpmValues = needsRpm ? valuesIn(request.rpm, "rpm") : undefined;
  const stackSizes = needsStackSize ? valuesIn(request.stackSize, "stackSize") : undefined;
  const unresolved = [
    ...(needsRpm && rpmValues === undefined ? ["rpm" as const] : []),
    ...(needsStackSize && stackSizes === undefined ? ["stackSize" as const] : []),
  ];
  if (unresolved.length > 0) return { status: "underconstrained", unresolved, operatingPoints: [] };

  const points: FeasibleOperatingPoint[] = [];
  for (const rpm of rpmValues ?? [0]) {
    for (const stackSize of stackSizes ?? [1]) {
      let timing: OperationTiming;
      try {
        timing = calculateTiming(recipe, rpm, stackSize);
      } catch (error) {
        if (error instanceof Error && error.message.includes("requires at least")) continue;
        throw error;
      }
      if (timing.outputPerMinute < request.targetOutputPerMinute) continue;
      points.push({
        ...(needsRpm ? { rpm } : {}),
        ...(needsStackSize ? { stackSize } : {}),
        capacityPerMachine: timing.outputPerMinute,
      });
    }
  }

  if (points.length === 0) return { status: "infeasible", unresolved: [], operatingPoints: [] };
  return {
    status: points.length === 1 ? "determined" : "underconstrained",
    unresolved: [],
    operatingPoints: points,
  };
}

function valuesIn(range: OperatingRange | undefined, name: string): number[] | undefined {
  if (range === undefined) return undefined;
  const bounds = typeof range === "number" ? { minimum: range, maximum: range } : range;
  if (!Number.isInteger(bounds.minimum) || !Number.isInteger(bounds.maximum) || bounds.minimum > bounds.maximum) {
    throw new Error(`${name} range must have whole-number bounds in ascending order`);
  }
  if (bounds.minimum < 1) throw new Error(`${name} values must be positive`);
  return Array.from({ length: bounds.maximum - bounds.minimum + 1 }, (_, index) => bounds.minimum + index);
}

function mixerTiming(recipe: Recipe, rpm: number): Pick<OperationTiming, "firstBatchTicks" | "cycleTicks"> {
  const config = rules.mechanicalMixer;
  if (!Number.isFinite(rpm) || rpm < config.minimumRpm) {
    throw new Error(`Mechanical mixer requires at least ${config.minimumRpm} RPM`);
  }

  const recipeDuration = recipe.durationTicks ?? config.defaultRecipeDurationTicks;
  const rpmRatio = Math.trunc(config.referenceRpm / rpm);
  const logSpeed = rpmRatio === 0 ? -1 : Math.floor(Math.log2(rpmRatio));
  const workPerTick = Math.ceil((recipeDuration / config.durationReferenceTicks) * config.recipeWorkPerDuration);
  const processingTicks = clamp(
    logSpeed * workPerTick + 1,
    config.minimumProcessingTicks,
    config.maximumProcessingTicks,
  );
  return {
    firstBatchTicks: config.animationTicks / 2 + 1 + processingTicks,
    cycleTicks: processingTicks,
  };
}

function pressTiming(rpm: number): Pick<OperationTiming, "firstBatchTicks" | "cycleTicks"> {
  const config = rules.mechanicalPress;
  if (!Number.isFinite(rpm) || rpm < config.minimumRpm) {
    throw new Error(`Mechanical press requires at least ${config.minimumRpm} RPM`);
  }

  const tickAdvance = Math.trunc(
    config.minimumTickAdvance +
      (config.maximumTickAdvance - config.minimumTickAdvance) * Math.min(rpm / config.referenceRpm, 1),
  );
  const midpoint = config.cycleTicks / 2;
  const firstBatchTicks = Math.ceil(midpoint / tickAdvance) + 1;
  let runningTicks = 0;
  let elapsedTicks = 0;

  while (true) {
    elapsedTicks++;
    if (runningTicks > config.cycleTicks) return { firstBatchTicks, cycleTicks: elapsedTicks };
    if (runningTicks < midpoint && runningTicks + tickAdvance >= midpoint) runningTicks = midpoint;
    else runningTicks += tickAdvance;
  }
}

function fanTiming(recipe: Recipe, stackSize: number): OperationTiming {
  if (!Number.isInteger(stackSize) || stackSize < 1) {
    throw new Error("Fan stack size must be a positive whole number");
  }
  const runsPerCycle = itemRunsPerCycle(recipe, stackSize, "Fan");

  const config = rules.encasedFan;
  const cycleTicks = config.processingTimeTicks * Math.ceil(stackSize / config.itemsPerProcessingStep);
  const batchesPerMinute = ticksPerMinute / cycleTicks;

  return {
    firstBatchTicks: cycleTicks,
    cycleTicks,
    firstBatchSeconds: cycleTicks / rules.ticksPerSecond,
    cycleSeconds: cycleTicks / rules.ticksPerSecond,
    batchesPerMinute,
    runsPerCycle,
    outputPerMinute: batchesPerMinute * runsPerCycle * recipe.outputAmount,
  };
}

function crushingWheelTiming(recipe: Recipe, rpm: number, stackSize: number): OperationTiming {
  if (!Number.isFinite(rpm) || rpm <= 0) throw new Error("Crushing wheels require a non-zero RPM");
  if (!Number.isInteger(stackSize) || stackSize < 1) {
    throw new Error("Crushing wheel stack size must be a positive whole number");
  }
  const runsPerCycle = itemRunsPerCycle(recipe, stackSize, "Crushing wheels");

  const config = rules.crushingWheels;
  const stackDivisor = Math.log(stackSize) / Math.log(config.stackSizeLogBase);
  const duration = recipe.durationTicks ?? config.defaultRecipeDurationTicks;
  let remaining = duration;
  let appliedRecipe = false;
  let cycleTicks = 0;
  while (remaining > 0 || !appliedRecipe) {
    cycleTicks++;
    const divisor = appliedRecipe ? 1 : stackDivisor;
    const processingSpeed = clamp(
      (rpm * config.rpmMultiplier) / divisor,
      config.minimumProcessingSpeed,
      config.maximumProcessingSpeed,
    );
    remaining -= processingSpeed;
    if (remaining < config.recipeApplyThresholdTicks && !appliedRecipe) appliedRecipe = true;
  }

  return fixedCycleTiming(cycleTicks, recipe.outputAmount, runsPerCycle);
}

function millstoneTiming(recipe: Recipe, rpm: number): OperationTiming {
  if (!Number.isFinite(rpm) || rpm === 0) throw new Error("Millstone requires a non-zero RPM");
  if (!recipe.durationTicks || recipe.durationTicks <= 0) {
    throw new Error(`No recipe duration for ${recipe.method} (${recipe.id})`);
  }

  const config = rules.millstone;
  const processingSpeed = clamp(
    Math.trunc(Math.abs(rpm) / config.rpmPerProcessingSpeed),
    config.minimumProcessingSpeed,
    config.maximumProcessingSpeed,
  );
  const processingTicks = Math.ceil(recipe.durationTicks / processingSpeed);
  const cycleTicks = processingTicks + config.recipeRestartTicks;
  return fixedCycleTiming(cycleTicks, recipe.outputAmount, 1);
}

function sawTiming(recipe: Recipe, rpm: number, stackSize: number): OperationTiming {
  if (!Number.isFinite(rpm) || rpm === 0) throw new Error("Mechanical saw requires a non-zero RPM");
  if (!Number.isInteger(stackSize) || stackSize < 1) {
    throw new Error("Mechanical saw stack size must be a positive whole number");
  }
  const runsPerCycle = itemRunsPerCycle(recipe, stackSize, "Mechanical saw");

  const config = rules.mechanicalSaw;
  const speed = clamp(
    Math.abs(rpm) / config.rpmPerProcessingSpeed,
    config.minimumProcessingSpeed,
    config.maximumProcessingSpeed,
  );
  const stackMultiplier = Math.max(1, Math.floor(stackSize / config.itemsPerDurationStep));
  let remaining = (recipe.durationTicks ?? config.defaultRecipeDurationTicks) * stackMultiplier;
  let appliedRecipe = false;
  let cycleTicks = config.startupTicks;
  while (remaining > 0) {
    cycleTicks++;
    remaining -= speed;
    if (remaining < config.recipeApplyThresholdTicks && !appliedRecipe) {
      appliedRecipe = true;
      remaining = config.postApplyTicks;
    }
  }

  return fixedCycleTiming(cycleTicks, recipe.outputAmount, runsPerCycle);
}

function itemRunsPerCycle(recipe: Recipe, stackSize: number, machine: string): number {
  if (recipe.inputs.length !== 1 || recipe.inputs[0].type !== "item") {
    throw new Error(`${machine} timing expects one item input (${recipe.id})`);
  }
  return stackSize / recipe.inputs[0].amount;
}

function fixedCycleTiming(cycleTicks: number, outputAmount: number, runsPerCycle: number): OperationTiming {
  const batchesPerMinute = ticksPerMinute / cycleTicks;
  return {
    firstBatchTicks: cycleTicks,
    cycleTicks,
    firstBatchSeconds: cycleTicks / rules.ticksPerSecond,
    cycleSeconds: cycleTicks / rules.ticksPerSecond,
    batchesPerMinute,
    runsPerCycle,
    outputPerMinute: batchesPerMinute * outputAmount * runsPerCycle,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
