/**
 * Read a record entry only if the record itself has it.
 *
 * `record[key]` also returns inherited Object.prototype members, so a key such as
 * "constructor" or "toString" reads a function where the caller expects "not set".
 * MCP server names are user-chosen keys and hit this (#5740).
 */
export function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
