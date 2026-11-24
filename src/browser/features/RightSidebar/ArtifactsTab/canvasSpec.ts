import { z } from "zod";
import { XumJsonTableSchema, type JsonValue } from "./jsonData";

/**
 * Declarative canvas artifacts (`*.canvas.json`): `{ "$xum": "canvas", "blocks": [...] }`.
 *
 * The spec is data only. Every block renders through Xum components (no HTML, no iframe), and
 * every string in it is shown as React text. Files a block references are read through the
 * artifacts API, which keeps containment in the backend.
 */

/**
 * Most blocks one canvas renders. Every block is a React subtree (charts, tables), so an
 * agent-written file with thousands of blocks would freeze the panel; the rest get a notice.
 */
export const CANVAS_MAX_BLOCKS = 500;

const CanvasDocumentSchema = z.object({
  $xum: z.literal("canvas"),
  blocks: z.array(z.unknown()),
});

const MarkdownBlockSchema = z.object({ type: z.literal("markdown"), text: z.string() });

const TableBlockSchema = z.object({
  type: z.literal("table"),
  columns: XumJsonTableSchema.shape.columns,
  rows: XumJsonTableSchema.shape.rows,
});

const ChartBlockSchema = z.object({
  type: z.literal("chart"),
  kind: z.enum(["bar", "line"]),
  /** Inline rows, or a file ref with an optional JSON pointer: "data.json#/series/0". */
  data: z.union([z.array(z.unknown()), z.string()]),
  x: z.string(),
  y: z.union([z.string(), z.array(z.string()).min(1)]),
  title: z.string().optional(),
});

const StatBlockSchema = z.object({
  type: z.literal("stat"),
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  delta: z.union([z.string(), z.number()]).optional(),
});

const DiffBlockSchema = z.object({ type: z.literal("diff"), patch: z.string() });

const ImageBlockSchema = z.object({
  type: z.literal("image"),
  src: z.string(),
  alt: z.string().optional(),
});

const ButtonBlockSchema = z.object({
  type: z.literal("button"),
  label: z.string(),
  send: z.string(),
  data: z.unknown().optional(),
});

const BLOCK_SCHEMAS = {
  markdown: MarkdownBlockSchema,
  table: TableBlockSchema,
  chart: ChartBlockSchema,
  stat: StatBlockSchema,
  diff: DiffBlockSchema,
  image: ImageBlockSchema,
  button: ButtonBlockSchema,
} as const;

type BlockType = keyof typeof BLOCK_SCHEMAS;

export type CanvasBlock = {
  [K in BlockType]: z.infer<(typeof BLOCK_SCHEMAS)[K]>;
}[BlockType];

export type ParsedCanvasBlock =
  | CanvasBlock
  /** A type this renderer does not know. */
  | { type: "unsupported"; blockType: string }
  /** A known type whose fields do not match its schema. */
  | { type: "invalid"; blockType: string };

export type ParsedCanvas =
  /** `omittedBlocks`: blocks past CANVAS_MAX_BLOCKS that are not parsed or rendered. */
  | { ok: true; blocks: ParsedCanvasBlock[]; omittedBlocks: number }
  | { ok: false; reason: "not_json" | "not_canvas" };

function isBlockType(type: string): type is BlockType {
  return Object.hasOwn(BLOCK_SCHEMAS, type);
}

/** Parse a canvas file. Blocks are validated one by one, so one bad block never hides the rest. */
export function parseCanvas(content: string): ParsedCanvas {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const document = CanvasDocumentSchema.safeParse(value);
  if (!document.success) return { ok: false, reason: "not_canvas" };
  const rawBlocks = document.data.blocks;
  return {
    ok: true,
    omittedBlocks: Math.max(0, rawBlocks.length - CANVAS_MAX_BLOCKS),
    blocks: rawBlocks.slice(0, CANVAS_MAX_BLOCKS).map((raw): ParsedCanvasBlock => {
      const type =
        raw != null && typeof raw === "object" && "type" in raw && typeof raw.type === "string"
          ? raw.type
          : "";
      if (!isBlockType(type)) return { type: "unsupported", blockType: type };
      const block = BLOCK_SCHEMAS[type].safeParse(raw);
      return block.success ? block.data : { type: "invalid", blockType: type };
    }),
  };
}

/**
 * Split a data reference into its file part and JSON pointer. No "#" means the whole document.
 * The pointer is taken as written (no percent-decoding of the fragment).
 */
export function splitDataReference(ref: string): { file: string; pointer: string } {
  const hash = ref.indexOf("#");
  return hash < 0
    ? { file: ref, pointer: "" }
    : { file: ref.slice(0, hash), pointer: ref.slice(hash + 1) };
}

export type JsonPointerResult = { ok: true; value: JsonValue } | { ok: false; error: string };

/** Resolve an RFC 6901 JSON pointer ("" is the whole document; "~1" is "/", "~0" is "~"). */
export function resolveJsonPointer(document: JsonValue, pointer: string): JsonPointerResult {
  if (pointer === "") return { ok: true, value: document };
  if (!pointer.startsWith("/")) return { ok: false, error: `Invalid JSON pointer: ${pointer}` };
  let current: JsonValue = document;
  for (const rawToken of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(rawToken)) return { ok: false, error: `Invalid JSON pointer: ${pointer}` };
    // ~1 first: "~01" must become "~1", not "/".
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = /^(0|[1-9]\d*)$/.test(token) ? Number(token) : -1;
      if (index < 0 || index >= current.length) {
        return { ok: false, error: `Nothing at JSON pointer ${pointer}` };
      }
      current = current[index];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return { ok: false, error: `Nothing at JSON pointer ${pointer}` };
    }
  }
  return { ok: true, value: current };
}

export type ChartRow = Record<string, string | number | null>;

/**
 * Most `y` series one chart plots. Every series is a Recharts subtree and a pass over every row,
 * so an agent-written chart with thousands of series would freeze the panel.
 */
export const CANVAS_MAX_CHART_SERIES = 12;

/** A chart block's `y` as a list, cut to CANVAS_MAX_CHART_SERIES; `total` counts them all. */
export function chartSeries(y: string | string[]): { series: string[]; total: number } {
  const all = typeof y === "string" ? [y] : y;
  return { series: all.slice(0, CANVAS_MAX_CHART_SERIES), total: all.length };
}

/**
 * Chart points from resolved data: an array of objects, `x` kept as a label, `y` fields as
 * numbers (anything non-numeric becomes a gap). At most `maxPoints` rows are kept.
 */
export function toChartRows(
  data: unknown,
  x: string,
  y: string[],
  maxPoints: number
): { ok: true; rows: ChartRow[]; totalPoints: number } | { ok: false; error: string } {
  if (!Array.isArray(data)) return { ok: false, error: "Chart data is not an array." };
  const rows: ChartRow[] = [];
  for (const item of data.slice(0, maxPoints)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "Chart data must be an array of objects." };
    }
    const record = item as Record<string, unknown>;
    const label = record[x];
    const row: ChartRow = {
      [x]:
        typeof label === "number" || typeof label === "string"
          ? label
          : label == null
            ? ""
            : JSON.stringify(label),
    };
    for (const field of y) {
      const raw = record[field];
      const value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim() !== ""
            ? Number(raw)
            : NaN;
      row[field] = Number.isFinite(value) ? value : null;
    }
    rows.push(row);
  }
  return { ok: true, rows, totalPoints: data.length };
}
