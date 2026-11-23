/** Look up catalog members without treating inherited object properties as tags. */
export function tagMembers(tags: Record<string, string[]> | undefined, tag: string): string[] | undefined {
  return tags && Object.hasOwn(tags, tag) ? tags[tag] : undefined;
}
