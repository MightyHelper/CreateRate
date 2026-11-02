import { resourceKey } from "./plant.ts";
import type { Plant, PlantComponent, PlantConstraint, PlantQuantityRef, PortRef, Resource } from "./plant.ts";
import type { Recipe } from "./recipes.ts";
import type { OperationTiming } from "./timing.ts";

export type PlantAnalyzerDependencies = {
  findRecipe: (id: string) => Recipe | undefined;
  requiredOperatingConditions: (recipe: Recipe) => Array<"rpm" | "stackSize">;
  calculateTiming: (recipe: Recipe, rpm: number, stackSize: number) => OperationTiming;
  stressImpactPerMachine: (recipe: Recipe) => number;
};

export type PlantIssue = {
  severity: "error";
  code: "missing-component" | "missing-recipe" | "invalid-port" | "resource-mismatch" | "self-connection" | "invalid-constraint";
  message: string;
};
export type PlantInspection = { valid: boolean; issues: PlantIssue[] };
export type RateValue =
  | { state: "constrained" | "derived"; perMinute: number }
  | { state: "underconstrained"; minimum: number; maximum?: number; integer?: boolean; powerOfTwo?: boolean }
  | { state: "conflict" };
export type PlantRateAnalysis = {
  status: "balanced" | "underconstrained" | "conflicting" | "invalid";
  connectionRates: Array<{ connectionId: string; rate: RateValue }>;
  portRates: Array<{ port: PortRef; rate: RateValue }>;
  issues: string[];
};

export function inspectPlant(plant: Plant, findRecipe: (id: string) => Recipe | undefined): PlantInspection {
  const issues: PlantIssue[] = [];
  const components = new Map(plant.components.map((component) => [component.id, component]));
  for (const component of plant.components) {
    if (component.kind === "process" && !findRecipe(component.recipeId)) {
      issues.push({ severity: "error", code: "missing-recipe", message: `${component.id} references unknown recipe ${component.recipeId}` });
    }
  }

  for (const connection of plant.connections) {
    if (connection.from.componentId === connection.to.componentId) {
      issues.push({ severity: "error", code: "self-connection", message: `${connection.id} connects a process to itself` });
    }
    const from = components.get(connection.from.componentId);
    const to = components.get(connection.to.componentId);
    if (!from || !to) {
      issues.push({ severity: "error", code: "missing-component", message: `${connection.id} references a missing component` });
      continue;
    }
    if (!portExists(from, connection.from, findRecipe) || !portExists(to, connection.to, findRecipe)) {
      issues.push({ severity: "error", code: "invalid-port", message: `${connection.id} references a port the component does not have` });
      continue;
    }
    if (resourceKey(connection.from.resource) !== resourceKey(connection.to.resource)) {
      issues.push({ severity: "error", code: "resource-mismatch", message: `${connection.id} connects different resources` });
    }
  }

  for (const constraint of plant.constraints) {
    if (constraint.target.kind === "connection-rate") {
      if (!plant.connections.some(({ id }) => id === constraint.target.connectionId)) {
        issues.push({ severity: "error", code: "invalid-constraint", message: `${constraint.id} targets a missing connection` });
      }
      continue;
    }
    const componentId = constraint.target.kind === "port-rate" ? constraint.target.port.componentId : constraint.target.componentId;
    const component = components.get(componentId);
    if (!component || (constraint.target.kind !== "port-rate" && component.kind !== "process")) {
      issues.push({ severity: "error", code: "invalid-constraint", message: `${constraint.id} targets a missing or incompatible component` });
      continue;
    }
    if (constraint.target.kind === "port-rate" && !portExists(component, constraint.target.port, findRecipe)) {
      issues.push({ severity: "error", code: "invalid-constraint", message: `${constraint.id} targets a port the component does not have` });
    }
  }
  const constraintsByTarget = new Map<string, PlantConstraint[]>();
  for (const constraint of plant.constraints) {
    const key = quantityTargetKey(constraint.target);
    constraintsByTarget.set(key, [...(constraintsByTarget.get(key) ?? []), constraint]);
  }
  for (const [target, constraints] of constraintsByTarget) {
    const bounds = constraints.filter((constraint) => constraint.kind === "bound");
    if (bounds.some(({ value }) => !Number.isFinite(value) || value < 0)) {
      issues.push({ severity: "error", code: "invalid-constraint", message: `${target} has an invalid negative or non-finite value` });
      continue;
    }
    const exact = bounds.filter(({ relation }) => relation === "equals").map(({ value }) => value);
    const minimum = Math.max(0, ...bounds.filter(({ relation }) => relation === "at-least").map(({ value }) => value));
    const maximums = bounds.filter(({ relation }) => relation === "at-most").map(({ value }) => value);
    const maximum = maximums.length > 0 ? Math.min(...maximums) : undefined;
    if ((maximum !== undefined && minimum > maximum) ||
        exact.some((value) => value !== exact[0] || value < minimum || (maximum !== undefined && value > maximum))) {
      issues.push({ severity: "error", code: "invalid-constraint", message: `${target} has conflicting constraints` });
      continue;
    }
    const targetRef = constraints[0].target;
    const requiresInteger = targetRef.kind === "machine-count" || targetRef.kind === "stack-size" || constraints.some(({ kind }) => kind === "integer" || kind === "power-of-two");
    const requiresPowerOfTwo = constraints.some(({ kind }) => kind === "power-of-two");
    const hasAllowedValue = (value: number) =>
      (!requiresInteger || Number.isInteger(value)) && (!requiresPowerOfTwo || isPowerOfTwo(value));
    if (exact.some((value) => !hasAllowedValue(value))) {
      issues.push({ severity: "error", code: "invalid-constraint", message: `${target} equality violates its integer or power-of-two restriction` });
      continue;
    }
    const lowestAllowed = requiresPowerOfTwo
      ? 2 ** Math.ceil(Math.log2(Math.max(minimum, 1)))
      : requiresInteger ? Math.ceil(minimum) : minimum;
    const highestAllowed = maximum === undefined ? undefined : requiresInteger ? Math.floor(maximum) : maximum;
    if (highestAllowed !== undefined && lowestAllowed > highestAllowed) {
      issues.push({ severity: "error", code: "invalid-constraint", message: `${target} bounds contain no allowed integer or power-of-two value` });
    }
  }
  return { valid: issues.length === 0, issues };
}

export function analyzePlantRates(plant: Plant, dependencies: PlantAnalyzerDependencies): PlantRateAnalysis {
  const { findRecipe, requiredOperatingConditions, calculateTiming, stressImpactPerMachine } = dependencies;
  const inspection = inspectPlant(plant, findRecipe);
  if (!inspection.valid) {
    return {
      status: "invalid",
      connectionRates: plant.connections.map(({ id }) => ({ connectionId: id, rate: { state: "conflict" } })),
      portRates: collectPlantPorts(plant),
      issues: inspection.issues.map(({ message }) => message),
    };
  }

  const equations: RateEquation[] = [];
  const variables = new Set<string>();
  const portRefs = new Map<string, PortRef>();
  const connectionVariables = new Map<string, string>();
  const registerPort = (port: PortRef) => {
    const key = portRateVariable(port);
    variables.add(key);
    portRefs.set(key, port);
    return key;
  };
  const equation = (terms: Array<[string, number]>, description: string) => {
    const coefficients = new Map<string, number>();
    for (const [variable, coefficient] of terms) {
      variables.add(variable);
      coefficients.set(variable, (coefficients.get(variable) ?? 0) + coefficient);
    }
    equations.push({ coefficients, constant: 0, description });
  };

  for (const connection of plant.connections) {
    const variable = `connection:${connection.id}`;
    connectionVariables.set(connection.id, variable);
    variables.add(variable);
    registerPort(connection.from);
    registerPort(connection.to);
  }

  for (const component of plant.components) {
    if (component.kind === "supply") {
      registerPort({ componentId: component.id, direction: "output", resource: component.resource });
      continue;
    }
    if (component.kind === "demand") {
      registerPort({ componentId: component.id, direction: "input", resource: component.resource });
      continue;
    }

    const recipe = findRecipe(component.recipeId);
    if (!recipe) continue;
    const runVariable = `runs:${component.id}`;
    variables.add(runVariable);
    for (const input of recipe.inputs) {
      const ports = recipeInputPorts(plant, component.id, input);
      equation([
        ...ports.map((port) => [registerPort(port), 1] as [string, number]),
        [runVariable, -input.amount],
      ], `${component.id} input ratio`);
    }

    const outputs = new Map<string, { resource: Resource; amount: number }>();
    for (const output of recipe.outputs) {
      const key = resourceKey(output.resource);
      const current = outputs.get(key);
      const amount = output.amount * (output.chance ?? 1);
      outputs.set(key, { resource: output.resource, amount: (current?.amount ?? 0) + amount });
    }
    for (const output of outputs.values()) {
      const ports = connectedPorts(plant, component.id, "output", output.resource);
      const refs = ports.length > 0 ? ports : [{ componentId: component.id, direction: "output" as const, resource: output.resource }];
      equation([
        ...refs.map((port) => [registerPort(port), 1] as [string, number]),
        [runVariable, -output.amount],
      ], `${component.id} output ratio`);
    }
  }

  for (const port of portRefs.values()) {
    const portVariable = portRateVariable(port);
    const connected = plant.connections
      .filter((connection) => port.direction === "output"
        ? samePort(connection.from, port)
        : samePort(connection.to, port))
      .map((connection) => [connectionVariables.get(connection.id)!, -1] as [string, number]);
    equation([[portVariable, 1], ...connected], `${port.componentId} port balance`);
  }

  const known = new Map<string, { value: number; state: "constrained" | "derived" }>();
  const bounds = new Map<string, { minimum: number; maximum?: number }>();
  const domains = new Map<string, { integer: boolean; powerOfTwo: boolean }>();
  const issues: string[] = [];

  for (const component of plant.components) {
    if (component.kind !== "process") continue;
    const recipe = findRecipe(component.recipeId);
    const runVariable = `runs:${component.id}`;
    if (!recipe || !variables.has(runVariable)) continue;
    const conditions = requiredOperatingConditions(recipe);
    const rpm = exactConstraintValue(plant, { kind: "rpm", componentId: component.id });
    const stackSize = exactConstraintValue(plant, { kind: "stack-size", componentId: component.id });
    if (conditions.includes("rpm") && rpm === undefined) continue;
    if (conditions.includes("stackSize") && stackSize === undefined) continue;
    let machineCount = upperBoundFor(plant, { kind: "machine-count", componentId: component.id });
    const stressPerMachineAtRpm = stressImpactPerMachine(recipe) * Math.abs(rpm ?? 0);
    if (stressPerMachineAtRpm > 0) {
      const stressLimit = upperBoundFor(plant, { kind: "stress", componentId: component.id });
      if (stressLimit !== undefined) {
        const stressMachineLimit = Math.floor(stressLimit / stressPerMachineAtRpm + 1e-8);
        machineCount = machineCount === undefined ? stressMachineLimit : Math.min(machineCount, stressMachineLimit);
      }
      const exactStress = exactConstraintValue(plant, { kind: "stress", componentId: component.id });
      if (exactStress !== undefined) {
        const exactStressMachineCount = exactStress / stressPerMachineAtRpm;
        if (!Number.isInteger(exactStressMachineCount)) {
          addIssue(issues, `${component.id} stress constraint implies a fractional machine count`);
        } else {
          const exactMachineCount = exactConstraintValue(plant, { kind: "machine-count", componentId: component.id });
          if (exactMachineCount !== undefined && exactMachineCount !== exactStressMachineCount) {
            addIssue(issues, `${component.id} stress and machine-count constraints disagree`);
          }
          machineCount = machineCount === undefined ? exactStressMachineCount : Math.min(machineCount, exactStressMachineCount);
        }
      }
    }
    if (machineCount === undefined) continue;
    try {
      const timing = calculateTiming(recipe, rpm ?? 0, stackSize ?? 1);
      const maximumRuns = timing.batchesPerMinute * timing.runsPerCycle * machineCount;
      const current = bounds.get(runVariable) ?? { minimum: 0 };
      current.maximum = Math.min(current.maximum ?? Infinity, maximumRuns);
      bounds.set(runVariable, current);
    } catch {
      // A machine without a timing rule cannot contribute a capacity bound yet.
    }
  }

  for (const component of plant.components) {
    if (component.kind !== "process") continue;
    const recipe = findRecipe(component.recipeId);
    const rpm = exactConstraintValue(plant, { kind: "rpm", componentId: component.id });
    const machineCount = exactConstraintValue(plant, { kind: "machine-count", componentId: component.id });
    if (!recipe || rpm === undefined || (machineCount === undefined && stressImpactPerMachine(recipe) !== 0 && rpm !== 0)) continue;
    const actualStress = stressImpactPerMachine(recipe) * Math.abs(rpm) * (machineCount ?? 0);
    for (const constraint of plant.constraints) {
      if (constraint.kind !== "bound" || constraint.target.kind !== "stress" || constraint.target.componentId !== component.id) continue;
      const violated = constraint.relation === "equals" ? Math.abs(actualStress - constraint.value) > 1e-7
        : constraint.relation === "at-least" ? actualStress < constraint.value - 1e-7
          : actualStress > constraint.value + 1e-7;
      if (violated) addIssue(issues, `${component.id} stress usage ${actualStress} SU violates its constraint`);
    }
  }

  const assign = (variable: string, value: number, state: "constrained" | "derived") => {
    if (!Number.isFinite(value) || value < -1e-8) {
      addIssue(issues, `${variable} resolves to an invalid negative or non-finite rate`);
      return false;
    }
    const normalized = Math.abs(value) < 1e-8 ? 0 : value;
    const current = known.get(variable);
    if (current && Math.abs(current.value - normalized) > 1e-7) {
      addIssue(issues, `${variable} has conflicting values ${current.value} and ${normalized}`);
      return false;
    }
    const bound = bounds.get(variable);
    if (bound && (normalized < bound.minimum - 1e-7 || (bound.maximum !== undefined && normalized > bound.maximum + 1e-7))) {
      addIssue(issues, `${variable} rate ${normalized} violates its bounds`);
      return false;
    }
    if (!current) {
      known.set(variable, { value: normalized, state });
      return true;
    }
    return false;
  };

  for (const constraint of plant.constraints) {
    const variable = rateConstraintVariable(constraint, connectionVariables);
    if (!variable || constraint.kind === "bound") continue;
    const domain = domains.get(variable) ?? { integer: false, powerOfTwo: false };
    if (constraint.kind === "integer") domain.integer = true;
    else domain.powerOfTwo = true;
    domains.set(variable, domain);
  }

  const exactRateConstraints: Array<{ variable: string; value: number }> = [];
  for (const constraint of plant.constraints) {
    if (constraint.kind !== "bound") continue;
    const variable = rateConstraintVariable(constraint, connectionVariables);
    if (!variable) continue;
    const bound = bounds.get(variable) ?? { minimum: 0 };
    if (constraint.relation === "equals") {
      bound.minimum = Math.max(bound.minimum, constraint.value);
      bound.maximum = bound.maximum === undefined ? constraint.value : Math.min(bound.maximum, constraint.value);
      exactRateConstraints.push({ variable, value: constraint.value });
    } else if (constraint.relation === "at-least") bound.minimum = Math.max(bound.minimum, constraint.value);
    else bound.maximum = bound.maximum === undefined ? constraint.value : Math.min(bound.maximum, constraint.value);
    bounds.set(variable, bound);
  }

  const tightenBounds = (variable: string, minimum: number, maximum: number): boolean => {
    const current = bounds.get(variable) ?? { minimum: 0 };
    const domain = domains.get(variable);
    let nextMinimum = Math.max(current.minimum, 0, minimum);
    let nextMaximum = Math.min(current.maximum ?? Infinity, maximum);
    if (domain?.powerOfTwo) {
      nextMinimum = 2 ** Math.ceil(Math.log2(Math.max(nextMinimum, 1)));
      if (Number.isFinite(nextMaximum)) nextMaximum = nextMaximum < 1 ? 0 : 2 ** Math.floor(Math.log2(nextMaximum));
    } else if (domain?.integer) {
      nextMinimum = Math.ceil(nextMinimum);
      if (Number.isFinite(nextMaximum)) nextMaximum = Math.floor(nextMaximum);
    }
    if (nextMinimum > nextMaximum + 1e-8) {
      addIssue(issues, `${variable} has incompatible rate bounds`);
      return false;
    }
    const changedMinimum = nextMinimum > current.minimum + 1e-8;
    const changedMaximum = nextMaximum < (current.maximum ?? Infinity) - 1e-8;
    if (!changedMinimum && !changedMaximum) return false;
    const next = { minimum: nextMinimum, ...(Number.isFinite(nextMaximum) ? { maximum: nextMaximum } : {}) };
    bounds.set(variable, next);
    if (Number.isFinite(nextMaximum) && Math.abs(nextMaximum - nextMinimum) < 1e-8) {
      return assign(variable, nextMinimum, "derived") || changedMinimum || changedMaximum;
    }
    return true;
  };

  const variableBounds = (variable: string) => {
    const value = known.get(variable);
    if (value) return { minimum: value.value, maximum: value.value };
    return bounds.get(variable) ?? { minimum: 0 };
  };

  for (const { variable, value } of exactRateConstraints) assign(variable, value, "constrained");
  for (const [variable, bound] of [...bounds]) {
    tightenBounds(variable, bound.minimum, bound.maximum ?? Infinity);
  }

  let changed = true;
  let passes = 0;
  while (changed && passes <= equations.length) {
    changed = false;
    passes++;
    for (const relation of equations) {
      let residual = relation.constant;
      const unresolved: Array<[string, number]> = [];
      for (const [variable, coefficient] of relation.coefficients) {
        const value = known.get(variable);
        if (value) residual += value.value * coefficient;
        else unresolved.push([variable, coefficient]);
      }
      if (unresolved.length === 1) {
        const [variable, coefficient] = unresolved[0];
        if (Math.abs(coefficient) > 1e-8 && assign(variable, -residual / coefficient, "derived")) changed = true;
      } else if (unresolved.length === 0 && Math.abs(residual) > 1e-7) {
        addIssue(issues, `${relation.description} is inconsistent`);
      } else if (unresolved.length > 1) {
        for (const [variable, coefficient] of unresolved) {
          if (Math.abs(coefficient) <= 1e-8) continue;
          let sumMinimum = relation.constant;
          let sumMaximum = relation.constant;
          for (const [other, otherCoefficient] of relation.coefficients) {
            if (other === variable || Math.abs(otherCoefficient) <= 1e-8) continue;
            const range = variableBounds(other);
            const upper = range.maximum ?? Infinity;
            if (otherCoefficient > 0) {
              sumMinimum += otherCoefficient * range.minimum;
              sumMaximum += otherCoefficient * upper;
            } else {
              sumMinimum += otherCoefficient * upper;
              sumMaximum += otherCoefficient * range.minimum;
            }
          }
          const first = -sumMinimum / coefficient;
          const second = -sumMaximum / coefficient;
          if (tightenBounds(variable, Math.min(first, second), Math.max(first, second))) changed = true;
        }
      }
    }
  }

  for (const [variable, value] of known) {
    const domain = domains.get(variable);
    if (domain?.integer && !Number.isInteger(value.value)) addIssue(issues, `${variable} rate ${value.value} violates its integer restriction`);
    if (domain?.powerOfTwo && !isPowerOfTwo(value.value)) addIssue(issues, `${variable} rate ${value.value} violates its power-of-two restriction`);
  }

  const rateValue = (variable: string): RateValue => {
    if (issues.length > 0) return { state: "conflict" };
    const value = known.get(variable);
    if (value) return { state: value.state, perMinute: value.value };
    const bound = bounds.get(variable);
    const domain = domains.get(variable);
    const minimum = domain?.powerOfTwo
      ? 2 ** Math.ceil(Math.log2(Math.max(bound?.minimum ?? 0, 1)))
      : domain?.integer ? Math.ceil(bound?.minimum ?? 0) : bound?.minimum ?? 0;
    const maximum = bound?.maximum === undefined ? undefined
      : domain?.powerOfTwo ? 2 ** Math.floor(Math.log2(bound.maximum))
        : domain?.integer ? Math.floor(bound.maximum) : bound.maximum;
    return {
      state: "underconstrained",
      minimum,
      ...(maximum === undefined ? {} : { maximum }),
      ...(domain?.integer ? { integer: true } : {}),
      ...(domain?.powerOfTwo ? { powerOfTwo: true } : {}),
    };
  };

  const connectionRates = plant.connections.map(({ id }) => ({ connectionId: id, rate: rateValue(connectionVariables.get(id)!) }));
  const portRates = [...portRefs].map(([variable, port]) => ({ port, rate: rateValue(variable) }));
  const unresolved = [...connectionRates, ...portRates].some(({ rate }) => rate.state === "underconstrained");
  return {
    status: issues.length > 0 ? "conflicting" : unresolved ? "underconstrained" : "balanced",
    connectionRates,
    portRates,
    issues,
  };
}

function collectPlantPorts(plant: Plant): Array<{ port: PortRef; rate: RateValue }> {
  const ports = new Map<string, PortRef>();
  for (const connection of plant.connections) {
    ports.set(portRateVariable(connection.from), connection.from);
    ports.set(portRateVariable(connection.to), connection.to);
  }
  for (const constraint of plant.constraints) {
    if (constraint.target.kind === "port-rate") ports.set(portRateVariable(constraint.target.port), constraint.target.port);
  }
  return [...ports.values()].map((port) => ({ port, rate: { state: "conflict" } }));
}

function portExists(component: PlantComponent, port: PortRef, findRecipe: (id: string) => Recipe | undefined): boolean {
  if (component.kind === "supply") return port.direction === "output" && sameResource(component.resource, port.resource);
  if (component.kind === "demand") return port.direction === "input" && sameResource(component.resource, port.resource);
  const recipe = findRecipe(component.recipeId);
  if (!recipe) return false;
  if (port.direction === "input") {
    return recipe.inputs.some((input) => sameResource(input, port.resource) ||
      (input.type === port.resource.type && input.alternatives?.includes(port.resource.id)));
  }
  return recipe.outputs.some((output) => sameResource(output.resource, port.resource));
}

function sameResource(a: Resource, b: Resource): boolean {
  return resourceKey(a) === resourceKey(b);
}

type RateEquation = { coefficients: Map<string, number>; constant: number; description: string };

function portRateVariable(port: PortRef): string {
  return `port:${JSON.stringify([port.componentId, port.direction, resourceKey(port.resource)])}`;
}

function samePort(a: PortRef, b: PortRef): boolean {
  return portRateVariable(a) === portRateVariable(b);
}

function connectedPorts(plant: Plant, componentId: string, direction: PortRef["direction"], resource: Resource): PortRef[] {
  const refs = plant.connections.flatMap((connection) => {
    const port = direction === "output" ? connection.from : connection.to;
    return port.componentId === componentId && port.direction === direction && sameResource(port.resource, resource)
      ? [port]
      : [];
  });
  return [...new Map(refs.map((port) => [portRateVariable(port), port])).values()];
}

function recipeInputPorts(plant: Plant, componentId: string, input: Ingredient): PortRef[] {
  const refs = plant.connections.flatMap((connection) => {
    const port = connection.to;
    const matches = sameResource(input, port.resource) ||
      (input.type === port.resource.type && input.alternatives?.includes(port.resource.id));
    return port.componentId === componentId && port.direction === "input" && matches ? [port] : [];
  });
  if (refs.length === 0) {
    return [{ componentId, direction: "input", resource: { type: input.type, id: input.id } }];
  }
  return [...new Map(refs.map((port) => [portRateVariable(port), port])).values()];
}

function rateConstraintVariable(
  constraint: PlantConstraint,
  connectionVariables: Map<string, string>,
): string | undefined {
  if (constraint.target.kind === "port-rate") return portRateVariable(constraint.target.port);
  if (constraint.target.kind === "connection-rate") return connectionVariables.get(constraint.target.connectionId);
  return undefined;
}

function quantityTargetKey(target: PlantQuantityRef): string {
  if (target.kind === "port-rate") return `port:${target.port.componentId}:${target.port.direction}:${resourceKey(target.port.resource)}`;
  if (target.kind === "connection-rate") return `connection:${target.connectionId}`;
  return `${target.kind}:${target.componentId}`;
}

function exactConstraintValue(plant: Plant, target: Extract<PlantQuantityRef, { componentId: string }>): number | undefined {
  const values = plant.constraints
    .filter((constraint) => constraint.kind === "bound" && constraint.target.kind === target.kind &&
      constraint.target.kind !== "port-rate" && constraint.target.kind !== "connection-rate" &&
      constraint.target.componentId === target.componentId && constraint.relation === "equals")
    .map(({ value }) => value);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function upperBoundFor(plant: Plant, target: { kind: "machine-count" | "stress"; componentId: string }): number | undefined {
  const constraints = plant.constraints.filter((constraint) =>
    constraint.kind === "bound" && constraint.target.kind === target.kind && constraint.target.componentId === target.componentId);
  const equal = constraints.filter(({ relation }) => relation === "equals").map(({ value }) => value);
  const upper = constraints.filter(({ relation }) => relation === "at-most").map(({ value }) => value);
  const candidates = [...equal, ...upper];
  if (candidates.length === 0) return undefined;
  const maximum = Math.floor(Math.min(...candidates));
  return target.kind === "machine-count" && plant.constraints.some((constraint) => constraint.kind === "power-of-two" &&
    constraint.target.kind === "machine-count" && constraint.target.componentId === target.componentId)
    ? maximum < 1 ? 0 : 2 ** Math.floor(Math.log2(maximum))
    : maximum;
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isInteger(value) || value <= 0) return false;
  const exponent = Math.round(Math.log2(value));
  return 2 ** exponent === value;
}

function addIssue(issues: string[], message: string): void {
  if (!issues.includes(message)) issues.push(message);
}
