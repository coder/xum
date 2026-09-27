import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";

/**
 * Seeded chat.jsonl row generator shared by the provider suffix property test (#4784) and the
 * provider locator differential test (#4655). The default kinds must keep producing the same
 * rows for the same seed, so the suffix property test's inputs never drift; adversarial kinds
 * draw extra random numbers only when `adversarial` is on.
 */

export const OVERSIZED = SESSION_HISTORY_MAX_LINE_BYTES + 4096;

export function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const json = (m: MuxMessage) => JSON.stringify(m);
export const rollover = {
  type: "context-window-rollover",
  rolloverId: "r",
  reason: "on-send",
  previousWindowId: "w:0",
  flushOpportunity: false,
  contextTokens: 100,
  maxTokens: 200,
};
export function toolRow(id: string, output: unknown): string {
  const message = createMuxMessage(id, "assistant", "running a tool");
  message.parts.push({
    type: "dynamic-tool",
    toolCallId: `${id}-call`,
    toolName: "bash",
    state: "output-available",
    input: { script: "ls" },
    output,
  });
  return json(message);
}
export function hiddenRow(id: string): string {
  const record = { v: 1 as const, kind: "resolve" as const, recordId: id, threadId: "t" };
  return json(
    createMuxMessage(id, "user", formatPlanReviewEnvelope(record), {
      synthetic: true,
      muxMetadata: buildPlanReviewMetadata(record),
    })
  );
}

/** One row without its newline. Buffers carry bytes a JS string cannot (invalid UTF-8). */
export type GeneratedRow = string | Buffer;

/** File contents: every row followed by a newline. */
export function rowsToBytes(rows: readonly GeneratedRow[]): Buffer {
  return Buffer.concat(rows.flatMap((row) => [Buffer.from(row), Buffer.from("\n")]));
}

export interface GenerateRowsOptions {
  /** Rows over SESSION_HISTORY_MAX_LINE_BYTES (slow; callers enable them for a few seeds). */
  oversized: boolean;
  /** Reset encodings, split markers, deep nesting, size edges and invalid bytes (#4655). */
  adversarial?: boolean;
}

/** Rows in file order (oldest first), without newlines. */
export function generateRows(random: () => number, options: GenerateRowsOptions): GeneratedRow[] {
  const rows: GeneratedRow[] = [];
  const count = Math.floor(random() * 160);
  for (let i = 0; i < count; i++) {
    const id = `m${i}`;
    const r = random();
    if (r < 0.4) {
      const text = random() < 0.2 ? `héllo — 日本語 🎉 ${i}` : `message ${i}`;
      const pad = random() < 0.03 ? "x".repeat(20_000 + Math.floor(random() * 50_000)) : "";
      const row = json(createMuxMessage(id, random() < 0.5 ? "user" : "assistant", text + pad));
      rows.push(random() < 0.05 ? `${row}\r` : row);
    } else if (r < 0.5) rows.push(toolRow(id, { success: true, output: "file ".repeat(20) }));
    else if (r < 0.62) rows.push(hiddenRow(id));
    else if (r < 0.66) {
      const durable = random() < 0.6;
      rows.push(
        json(
          createMuxMessage(id, "assistant", "summary", {
            compactionBoundary: true,
            compacted: true,
            ...(durable ? { compactionEpoch: i + 1 } : {}),
          })
        )
      );
    } else if (r < 0.68)
      rows.push(json(createMuxMessage(id, "assistant", "", { contextBoundaryKind: "reset" })));
    else if (r < 0.7)
      rows.push(
        json(
          createMuxMessage(id, "assistant", "", {
            contextBoundaryKind: "reset",
            muxMetadata: rollover,
          } as MuxMessage["metadata"])
        )
      );
    else if (r < 0.72) rows.push('{"metadata":{"contextBoundaryKind" : "reset"},broken');
    else if (r < 0.75) {
      const fragments = [
        ['"contextBoundaryKind"', ":", '"reset"'],
        ['{"metadata":{"contextBoundaryKind"', ': "reset"},broken'],
        ['junk "contextBoundaryKind" junk', 'more : junk "reset" }'],
      ];
      rows.push(...fragments[Math.floor(random() * fragments.length)]);
    } else if (r < 0.8)
      rows.push(["not json", "{", "[]", "null", "", "   "][Math.floor(random() * 6)]);
    else if (r < 0.82) rows.push('junk "contextBoundaryKind" junk');
    else rows.push(json(createMuxMessage(id, "user", `plain ${i}`)));
    if (options.oversized && random() < 0.02) {
      const big = "y".repeat(OVERSIZED);
      const shapes = [
        json(createMuxMessage(`${id}-big`, "user", big)),
        // Raw reset tokens inside a readable oversized row: the locator floors at it.
        toolRow(`${id}-big`, { note: big, nested: { contextBoundaryKind: "reset" } }),
        // A value token only: chains with an older key-bearing junk row into a floor.
        json(
          createMuxMessage(`${id}-big`, "user", big, { note: "reset" } as MuxMessage["metadata"])
        ),
        // An oversized compaction boundary the locator re-reads and accepts as the start (#4551).
        json(
          createMuxMessage(`${id}-big`, "assistant", big, {
            compactionBoundary: true,
            compacted: true,
            compactionEpoch: i + 1,
          })
        ),
      ];
      rows.push(shapes[Math.floor(random() * shapes.length)]);
    }
    if (options.adversarial && random() < 0.35)
      rows.push(...adversarialRows(random, `${id}-a`, i, options.oversized));
  }
  return rows;
}

const hex4 = (character: string) => character.charCodeAt(0).toString(16).padStart(4, "0");
const perCharU = [...SESSION_HISTORY_RESET_NEEDLE].map((c) => "\\u" + hex4(c)).join("");

/**
 * Raw spellings of the reset marker the probes must recognize (or deliberately near-miss), from
 * historyReplacementRows.test.ts and historyService.providerPrivacy.test.ts.
 */
const RESET_ENCODINGS = [
  SESSION_HISTORY_RESET_NEEDLE,
  '"contextBoundaryKind" : "reset"',
  '"contextBoundaryKind"\\x20\\u003A"res\\x65t"',
  '"contextBoundaryKind"\u0000:\u0001"reset"',
  perCharU,
  perCharU.replaceAll("\\u", "\\U"),
  perCharU.replaceAll("\\u00", "\\x"),
  perCharU.replaceAll("\\u00", "\\X"),
  SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\\u0000Boundary"),
  SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\u0000Boundary"),
  SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\u2003Boundary"),
  SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\\u2003Boundary"),
  SESSION_HISTORY_RESET_NEEDLE.replace("Boundary", "\\u00\\u002020Boundary"),
  '"contextBoundaryKind"' + "x".repeat(1000) + ':"reset"',
  '\\u00\\u002022contextBoundaryKind":"reset"',
  "😀" + perCharU + "\\u00",
  "\ufeff" + SESSION_HISTORY_RESET_NEEDLE,
  // Near misses: a key or value alone, and the tokens in the wrong order.
  '"contextBoundaryKind"',
  '"reset" : "contextBoundaryKind"',
];

/** historyReplacementRows.test.ts's per-character mixer, driven by the layout's seed. */
function mixedResetEncoding(random: () => number): string {
  let text = "";
  for (const character of SESSION_HISTORY_RESET_NEEDLE) {
    const code = character.charCodeAt(0).toString(16);
    const r = random();
    text += r < 1 / 3 ? "\\u" + code.padStart(4, "0") : r < 2 / 3 ? "\\x" + code : character;
    if (random() < 0.2)
      text += ["\u0000", "\\u0000", "\u2003", "\\u2003"][Math.floor(random() * 4)];
  }
  return text;
}

/** Whole rows from historyService.providerPrivacy.test.ts's floor variants (newlines split rows). */
const PRIVACY_VARIANTS = [
  '{"metadata":{"contextBoundaryKind" : "reset"},broken',
  '{"metadata":{"contextBoundaryKind"\\x20\\u003A"res\\x65t"},broken',
  ' {\n"contextBoundaryKind"\n:\n"reset"\n}',
  '{"metadata":{"contextBoundaryKind"\u0000:\u0001"reset"},broken',
  '{"id":"damaged","role":"assistant","parts":[],"metadata":[{"contextBoundaryKind":"reset"}]}',
  `{"id":"ambiguous","role":"assistant","parts":[],"metadata":{"contextBoundaryKind":"reset"},"metadata":${JSON.stringify(rollover)}}`,
];

/**
 * A tool row whose output is `depth` nested arrays, optionally around a reset object, optionally
 * with a duplicate top-level key (ambiguous once the row counts as reset evidence). Built as text:
 * JSON.stringify cannot produce it.
 */
export function deepToolRow(
  id: string,
  depth: number,
  innerReset: boolean,
  duplicateKey: boolean
): string {
  const inner = innerReset ? '{"contextBoundaryKind":"reset"}' : "";
  const row = toolRow(id, "__deep__").replace(
    '"__deep__"',
    "[".repeat(depth) + inner + "]".repeat(depth)
  );
  return duplicateKey ? row.slice(0, -1) + `,"id":"${id}-dup"}` : row;
}

/** A readable row of exactly `bytes` bytes (excluding the newline). */
function rowOfSize(bytes: number, build: (pad: string) => string): string {
  // Measure with a non-empty pad: createMuxMessage drops the text part for empty text.
  const base = Buffer.byteLength(build("z")) - 1;
  const row = build("z".repeat(bytes - base));
  if (Buffer.byteLength(row) !== bytes) throw new Error(`row size ${Buffer.byteLength(row)}`);
  return row;
}

function adversarialRows(
  random: () => number,
  id: string,
  i: number,
  oversized: boolean
): GeneratedRow[] {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const encoding = () => (random() < 0.25 ? mixedResetEncoding(random) : pick(RESET_ENCODINGS));
  // Valid JSON string content with some characters \u-escaped (random hex case); JSON.parse
  // decodes it, so an escaped key in metadata is a real key.
  const escapeSome = (text: string) =>
    [...text]
      .map((c) => {
        if (random() >= 0.3) return c;
        const escape = "\\u" + hex4(c);
        return random() < 0.5 ? escape : escape.toUpperCase().replace("\\U", "\\u");
      })
      .join("");
  const role = pick(["user", "assistant"] as const);
  const r = random();
  if (r < 0.12) {
    // Junk rows carrying an encoding.
    const e = encoding();
    return [
      pick([
        `junk ${e} junk`,
        `{"metadata":{${e}},broken`,
        e,
        `{"id":"${id}","role":"assistant","parts":[],"metadata":{${e}}}`,
      ]),
    ];
  }
  if (r < 0.2) {
    // Readable nested data must not floor.
    return [json(createMuxMessage(id, role, `about ${encoding()} here`))];
  }
  if (r < 0.27) {
    const e = encoding();
    return [toolRow(id, { note: e, nested: pick([{ contextBoundaryKind: "reset" }, e, [e]]) })];
  }
  if (r < 0.37) {
    // Metadata of readable rows: manual and rollover resets with escaped keys/values,
    // whitespace around the colon, and duplicate metadata keys.
    const ws = pick(["", " ", "\t", "\r", " \t "]);
    const key = escapeSome("contextBoundaryKind");
    const value = random() < 0.1 ? "res\\x65t" : escapeSome("reset");
    const muxMetadata = random() < 0.4 ? `,"muxMetadata":${JSON.stringify(rollover)}` : "";
    const duplicate = pick([
      "",
      "",
      `,"metadata":${JSON.stringify({ muxMetadata: rollover, contextBoundaryKind: "reset" })}`,
      `,"metadata":{}`,
    ]);
    return [
      `{"id":"${id}","role":"assistant","parts":[],"metadata":{"${key}"${ws}:${ws}"${value}"${muxMetadata}}${duplicate}}`,
    ];
  }
  if (r < 0.47) {
    // One encoding split across 2-3 consecutive unreadable rows.
    const e = encoding();
    const cuts = Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
      Math.floor(random() * (e.length + 1))
    ).sort((a, b) => a - b);
    const bounds = [0, ...cuts, e.length];
    const pieces = bounds.slice(1).map((end, k) => e.slice(bounds[k], end));
    return pieces.map((piece) => (random() < 0.3 ? `junk ${piece}` : piece));
  }
  if (r < 0.53) return pick(PRIVACY_VARIANTS).split("\n");
  if (r < 0.59) {
    const prose = pick(["please reset", "re set", "re\tset", "compactionBoundary", "reset: yes"]);
    return [json(createMuxMessage(id, role, `${prose} contextBoundaryKind ${i}`))];
  }
  if (r < 0.63) {
    // JSON.parse decodes the escaped key, so this is a real durable boundary.
    return [
      json(
        createMuxMessage(id, "assistant", "summary", {
          compactionBoundary: true,
          compacted: true,
          compactionEpoch: i + 1,
          ...(random() < 0.5 ? { compactionPublicationId: `pub-${id}` } : {}),
        })
      ).replace('"compactionBoundary":true', '"compaction\\u0042oundary":true'),
    ];
  }
  if (r < 0.67) return [json(createMuxMessage(id, role, `\u001b[31mred\u001b[0m ${i}`))];
  if (r < 0.69) {
    // Deep arrays in a tool output, around V8's JSON.stringify depth limit (production). Rare:
    // each parse costs milliseconds.
    const depth = 5000 + Math.floor(random() * 15_000);
    return [deepToolRow(id, depth, random() < 0.3, random() < 0.5)];
  }
  if (r < 0.72) return [json(createMuxMessage(id, role, `plain adversarial ${i}`))];
  if (r < 0.8) {
    const readable = json(createMuxMessage(id, role, `line shapes ${i}`));
    return [
      pick([
        `${readable}\r`,
        "",
        " \t ",
        "\r",
        // A lone 0xC3 inside a string decodes to U+FFFD: still a readable row.
        Buffer.concat([
          Buffer.from(readable.slice(0, -4)),
          Buffer.from([0xc3]),
          Buffer.from(readable.slice(-4)),
        ]),
        Buffer.concat([Buffer.from('junk "contextBoundaryKind"'), Buffer.from([0xff])]),
        Buffer.concat([
          Buffer.from('{"metadata":{"contextBoundaryKind"'),
          Buffer.from([0xc3]),
          Buffer.from(':"reset"},broken'),
        ]),
      ]),
    ];
  }
  if (r < 0.86) {
    // Rows larger than one scan chunk: every chunk edge falls inside them, including inside
    // multibyte characters and reset encodings repeated through junk.
    const bytes = SESSION_HISTORY_SCAN_CHUNK_BYTES + Math.floor(random() * 16_384);
    if (random() < 0.5) {
      const unit = pick(["日本語", "🎉", "é"]);
      const text = unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)));
      return [json(createMuxMessage(id, role, text))];
    }
    const e = encoding();
    const filler = "q".repeat(1 + Math.floor(random() * 5000));
    return [`${e} ${(filler + e).repeat(Math.ceil(bytes / (filler.length + e.length)))}`];
  }
  if (oversized && r < 0.93) {
    // Rows at SESSION_HISTORY_MAX_LINE_BYTES - 1, +0 and +1.
    const bytes = SESSION_HISTORY_MAX_LINE_BYTES + pick([-1, 0, 1]);
    const shapes: Array<(pad: string) => string> = [
      (pad) => json(createMuxMessage(id, role, pad)),
      (pad) =>
        json(
          createMuxMessage(id, "assistant", pad, {
            compactionBoundary: true,
            compacted: true,
            compactionEpoch: i + 1,
          })
        ),
      (pad) => toolRow(id, { note: pad, nested: { contextBoundaryKind: "reset" } }),
      (pad) => json(createMuxMessage(id, "assistant", pad, { contextBoundaryKind: "reset" })),
    ];
    return [rowOfSize(bytes, pick(shapes))];
  }
  if (oversized) {
    return [
      '{"metadata":{"contextBoundaryKind"' +
        " ".repeat(SESSION_HISTORY_MAX_LINE_BYTES + SESSION_HISTORY_SCAN_CHUNK_BYTES) +
        ':"reset"},broken',
    ];
  }
  return [json(createMuxMessage(id, role, `plain adversarial ${i}`))];
}

/**
 * Deep equality without recursion: Bun.deepEquals and JSON.stringify overflow the stack on the
 * deeply nested rows above. Keys holding undefined are ignored, like toEqual.
 */
export function deepEqualAnyDepth(a: unknown, b: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[a, b]];
  for (let pair = pending.pop(); pair; pair = pending.pop()) {
    const [x, y] = pair;
    if (Object.is(x, y)) continue;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const entries = (value: object) =>
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0));
    const ex = entries(x);
    const ey = entries(y);
    if (ex.length !== ey.length) return false;
    for (let k = 0; k < ex.length; k++) {
      if (ex[k][0] !== ey[k][0]) return false;
      pending.push([ex[k][1], ey[k][1]]);
    }
  }
  return true;
}
