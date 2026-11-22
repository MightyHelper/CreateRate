export function validateConstraintSet(exact: number | undefined, minimum: number | undefined, maximum: number | undefined, integer: boolean, powerOfTwo: boolean): void {
  if ([exact, minimum, maximum].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) throw new Error("Bounds must be finite and non-negative");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error("GEQ cannot exceed LEQ");
  if (exact !== undefined && ((minimum !== undefined && exact < minimum) || (maximum !== undefined && exact > maximum))) {
    throw new Error("Equality must fit within the GEQ and LEQ bounds");
  }
  const valid = (value: number) => (!integer && !powerOfTwo || Number.isInteger(value)) && (!powerOfTwo || isPowerOfTwo(value));
  if (exact !== undefined && !valid(exact)) throw new Error("Equality violates the selected integer or power-of-two restriction");
  if (exact === undefined && (integer || powerOfTwo)) {
    const lowest = powerOfTwo ? 2 ** Math.ceil(Math.log2(Math.max(minimum ?? 0, 1))) : Math.ceil(minimum ?? 0);
    const highest = maximum === undefined ? undefined : Math.floor(maximum);
    if (highest !== undefined && lowest > highest) throw new Error("Bounds contain no allowed integer or power-of-two value");
  }
}

function isPowerOfTwo(value: number): boolean { return Number.isInteger(value) && value > 0 && 2 ** Math.round(Math.log2(value)) === value; }
