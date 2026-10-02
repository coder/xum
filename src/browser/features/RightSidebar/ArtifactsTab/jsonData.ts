import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Above this many nodes the tree view is skipped and the raw text is shown instead. */
export const JSON_TREE_MAX_NODES = 20_000;

/** Parse JSON, or JSON Lines for .jsonl files. Returns undefined when the text is not valid. */
export function parseJsonArtifact(content: string, path: string): JsonValue | undefined {
  try {
    if (path.toLowerCase().endsWith(".jsonl")) {
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonValue);
    }
    return JSON.parse(content) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Count nodes (every value, containers included), stopping once the count passes `cap`. */
export function countJsonNodes(value: JsonValue, cap: number): number {
  let count = 0;
  const stack: JsonValue[] = [value];
  while (stack.length > 0 && count <= cap) {
    const node = stack.pop()!;
    count += 1;
    if (node !== null && typeof node === "object") {
      for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
    }
  }
  return count;
}

/**
 * Table hint for JSON artifacts (documented in the artifact_list tool description):
 * `{ "$xum": "table", "columns"?: string[], "rows": [...] }`, where each row is either an
 * object keyed by column name or an array of cells in column order.
 */
export const XumJsonTableSchema = z.object({
  $xum: z.literal("table"),
  columns: z.array(z.string()).optional(),
  rows: z.array(z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())])),
});

const MAX_DERIVED_COLUMNS = 100;

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Table data for a value carrying the table hint, or null when the hint is absent/invalid. */
export function toJsonTable(
  value: JsonValue,
  maxRows: number,
  /** Columns kept; explicit `columns` and array rows can be arbitrarily wide. */
  maxColumns: number
): { columns: string[]; rows: string[][]; totalRows: number; totalColumns: number } | null {
  const parsed = XumJsonTableSchema.safeParse(value);
  if (!parsed.success) return null;
  const sourceRows = parsed.data.rows;
  let columns = parsed.data.columns;
  if (columns == null) {
    const keys = new Set<string>();
    let width = 0;
    for (const row of sourceRows) {
      if (Array.isArray(row)) {
        width = Math.max(width, row.length);
      } else {
        for (const key of Object.keys(row)) {
          if (keys.size >= MAX_DERIVED_COLUMNS) break;
          keys.add(key);
        }
      }
    }
    columns =
      keys.size > 0
        ? [...keys]
        : Array.from({ length: Math.min(width, MAX_DERIVED_COLUMNS) }, (_, i) => `${i + 1}`);
  }
  let totalColumns = columns.length;
  const keys = columns.slice(0, maxColumns);
  const rows = sourceRows.slice(0, maxRows).map((row) => {
    if (!Array.isArray(row)) return keys.map((key) => formatCell(row[key]));
    totalColumns = Math.max(totalColumns, row.length);
    return row.slice(0, maxColumns).map(formatCell);
  });
  return { columns: keys, rows, totalRows: sourceRows.length, totalColumns };
}
