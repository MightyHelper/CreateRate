import { defaultRateDisplayUnits, normalizeRateDisplayUnits } from "../core/index.ts";
import type { RateDisplayUnits } from "../core/index.ts";

const storageKey = "rate-display-units";
let current = load();

export function getRateDisplayUnits(): RateDisplayUnits { return current; }

export function setRateDisplayUnits(units: RateDisplayUnits): void {
  current = normalizeRateDisplayUnits(units);
  try { localStorage.setItem(storageKey, JSON.stringify(current)); } catch { /* Display preference is optional. */ }
}

function load(): RateDisplayUnits {
  try { return normalizeRateDisplayUnits(JSON.parse(localStorage.getItem(storageKey) ?? "null")); }
  catch { return defaultRateDisplayUnits(); }
}
