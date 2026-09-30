import type { Node } from "jsonc-parser";

/**
 * jsonc.parse exposes the last duplicate, but jsonc.modify edits the first.
 * Reject ambiguous properties before making path-based edits.
 */
export function findDuplicateProperty(
  node: Node | undefined,
  names?: ReadonlySet<string>
): string | undefined {
  if (node?.type !== "object") {
    return undefined;
  }
  const seen = new Set<string>();
  for (const property of node.children ?? []) {
    const name: unknown = property.children?.[0]?.value;
    if (typeof name !== "string" || (names !== undefined && !names.has(name))) {
      continue;
    }
    if (seen.has(name)) {
      return name;
    }
    seen.add(name);
  }
  return undefined;
}
