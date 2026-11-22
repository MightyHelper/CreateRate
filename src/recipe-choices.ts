const choiceTags = new Map<string, string[]>();

export function resourceChoice(resource: { id: string; alternatives?: string[] }) {
  const members = [...new Set(resource.alternatives ?? [])];
  const tagId = resource.id.startsWith("#") ? resource.id : members.length > 1 ? choiceTagId(members) : undefined;
  return { tagId, members };
}

export function choiceTagId(alternatives: string[]): string {
  const members = [...alternatives].sort();
  const key = members.join("\0");
  const name = key === "create:zinc_nugget\0minecraft:iron_nugget"
    ? "nuggets"
    : `choices/${hash(key)}`;
  const tag = `createrate:${name}`;
  choiceTags.set(tag, members);
  return `#${tag}`;
}

export function listChoiceTags(): Record<string, string[]> {
  return Object.fromEntries(choiceTags);
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
