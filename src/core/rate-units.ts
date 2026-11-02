import unitsData from "../../data/rate-units.json";
import type { Resource } from "../plant.ts";

export type RatePeriodId = typeof unitsData.periods[number]["id"];
export type RateDisplayUnits = { amount: "items" | "stacks"; period: RatePeriodId };
export type RatePeriod = typeof unitsData.periods[number];

const periods = new Map(unitsData.periods.map((period) => [period.id, period]));

export function ratePeriods(): RatePeriod[] { return unitsData.periods; }
export function defaultRateDisplayUnits(): RateDisplayUnits { return { amount: "items", period: "minute" }; }

export function normalizeRateDisplayUnits(value: unknown): RateDisplayUnits {
  if (!value || typeof value !== "object") return defaultRateDisplayUnits();
  const units = value as Partial<RateDisplayUnits>;
  return {
    amount: units.amount === "stacks" ? "stacks" : "items",
    period: periods.has(units.period as RatePeriodId) ? units.period as RatePeriodId : "minute",
  };
}

export function perMinuteToDisplayRate(value: number, resource: Resource, display: RateDisplayUnits): number {
  const periodMinutes = periods.get(display.period)!.minutes;
  const amountDivisor = resource.type === "item" && display.amount === "stacks" ? unitsData.itemsPerStack : 1;
  return value * periodMinutes / amountDivisor;
}

export function displayToPerMinuteRate(value: number, resource: Resource, display: RateDisplayUnits): number {
  const periodMinutes = periods.get(display.period)!.minutes;
  const amountMultiplier = resource.type === "item" && display.amount === "stacks" ? unitsData.itemsPerStack : 1;
  return value * amountMultiplier / periodMinutes;
}

export function rateDisplayUnit(resource: Resource, display: RateDisplayUnits): string {
  const amount = resource.type === "fluid" ? "mB" : display.amount;
  return `${amount}/${periods.get(display.period)!.symbol}`;
}

export function itemsPerStack(): number { return unitsData.itemsPerStack; }
