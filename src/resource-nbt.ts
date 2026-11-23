/** NBT values present in the recipe catalog, represented as JSON-compatible data. */
export type NbtValue = string | number | boolean | NbtValue[] | NbtCompound;
export type NbtCompound = { [key: string]: NbtValue };
export class UnsupportedNbtError extends Error {}

function normalizeValue(value: unknown): NbtValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]));
  }
  throw new UnsupportedNbtError('Unsupported NBT value');
}

/** Parse the simple string-valued SNBT compounds used by the catalog. */
function parseSimpleSnbt(text: string): NbtCompound {
  const result: NbtCompound = {};
  const source = text.trim();
  if (!source.startsWith('{') || !source.endsWith('}')) throw new UnsupportedNbtError('Unsupported SNBT compound');
  const body = source.slice(1, -1).trim();
  if (!body) return result;
  for (const entry of body.split(',')) {
    const match = /^\s*([A-Za-z0-9_.+-]+)\s*:\s*(?:"([A-Za-z0-9_.+:-]+)"|([A-Za-z_][A-Za-z0-9_.+:-]*))\s*$/.exec(entry);
    if (!match || (match[3] && /^(true|false)$/i.test(match[3])) || Object.hasOwn(result, match[1])) {
      throw new UnsupportedNbtError('Unsupported SNBT compound');
    }
    Object.defineProperty(result, match[1], { value: match[2] ?? match[3], enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/** Normalize catalog NBT; absent and empty compounds are unrestricted ingredients. */
export function normalizeNbt(value: unknown, preserveEmpty = false): NbtCompound | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      value = parseSimpleSnbt(text);
    }
  }
  const normalized = normalizeValue(value);
  if (typeof normalized !== 'object' || Array.isArray(normalized)) throw new UnsupportedNbtError('Expected NBT compound');
  return !preserveEmpty && Object.keys(normalized).length === 0 ? undefined : normalized;
}

function isCompound(value: NbtValue | undefined): value is NbtCompound {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalValue(a: NbtValue | undefined, b: NbtValue): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((v, i) => equalValue(a[i], v));
  if (isCompound(b)) return isCompound(a) && Object.keys(a).length === Object.keys(b).length && containsCompound(a, b);
  return a === b;
}

function containsCompound(actual: NbtCompound, required: NbtCompound): boolean {
  return Object.entries(required).every(([key, expected]) => {
    const value = actual[key];
    return isCompound(expected) && isCompound(value) ? containsCompound(value, expected) : equalValue(value, expected);
  });
}

/** Whether merging required compound keys into the actual tag leaves it unchanged. */
export function nbtContains(actual: NbtCompound | undefined, required: NbtCompound | undefined): boolean {
  return required === undefined || containsCompound(actual ?? {}, required);
}

/** Stable JSON encoding for identity and display of supported NBT values. */
export function canonicalNbt(value: NbtCompound): string {
  const sort = (item: NbtValue): NbtValue => Array.isArray(item) ? item.map(sort) : isCompound(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
