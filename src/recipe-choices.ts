const choiceTags = new Map<string, string[]>();

export function choiceTagId(alternatives: string[]): string {
  const members = [...alternatives].sort();
  const key = members.join("\0");
  const name = members.length === 2 && members.every((id) => id.endsWith("_nugget"))
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
