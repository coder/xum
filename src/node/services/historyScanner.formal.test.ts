import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { createMuxMessage } from "@/common/types/message";
import { findProviderHistoryStart, hasRawResetMarker, readProviderHistory } from "./historyScanner";
import { mulberry32 } from "./historyScanner.generator.testHarness";

// Bridge from the Lean model in formal/history-locator to the real provider locator.
//
// Each generated row carries the label the model uses (HistoryLocator/Spec.lean): its class, the
// reset tokens it holds and whether its own text holds the whole marker. `specCut` below is a
// line-by-line port of the model's rule (evs + pick). The property is Scanner.lean's
// `locate_eq_spec`: on rows that satisfy the model's assumptions, findProviderHistoryStart keeps
// exactly the rows the rule keeps, for every skip, with chunk edges (64 KiB from EOF) moved
// through the interesting rows. Unlike historyScanner.differential.test.ts, whose oracle is a
// frozen copy of the same algorithm, the expected answer here never runs the production
// recognizers.
//
// The cases at the end pin fixed findings F1-F3, where the production locator used to break the
// rule on inputs outside the model's assumptions.

type Tok = "key" | "colon" | "value";
type Kind = "plain" | "boundary" | "resetMarker" | "resetFloor" | "unreadable";
interface Label {
  kind: Kind;
  toks: Tok[];
  /** The row's own text holds the whole marker (key, colon, value, only separators between). */
  localEv: boolean;
  /** Id of the message the provider projection would return, if the row is a message. */
  id?: string;
}
interface GenRow {
  text: string;
  label: Label | null; // null: empty row
}

// ── Port of the Lean rule (Spec.lean: runToks, RunEvidence, evs, pick) ─────────────────────

const MARKER: readonly Tok[] = ["key", "colon", "value"];
function isSubsequence(pattern: readonly Tok[], text: readonly Tok[]): boolean {
  let i = 0;
  for (const t of text) if (i < pattern.length && t === pattern[i]) i++;
  return i === pattern.length;
}
/** Run rows are newest first; tokens are compared in file order. */
function runEvidence(run: readonly Label[]): boolean {
  const fileOrder = [...run].reverse().flatMap((row) => row.toks);
  return run.some((row) => row.localEv) || isSubsequence(MARKER, fileOrder);
}
interface Event {
  floor: boolean;
  cut: number;
}
function events(newestFirst: readonly Label[]): Event[] {
  const out: Event[] = [];
  let run: { start: number; rows: Label[] } | null = null;
  const flush = () => {
    if (run && runEvidence(run.rows)) out.push({ floor: true, cut: run.start });
    run = null;
  };
  newestFirst.forEach((row, d) => {
    if (row.kind === "unreadable") {
      run ??= { start: d, rows: [] };
      run.rows.push(row);
      return;
    }
    flush();
    if (row.kind === "boundary") out.push({ floor: false, cut: d + 1 });
    if (row.kind === "resetMarker") out.push({ floor: true, cut: d + 1 });
    if (row.kind === "resetFloor") out.push({ floor: true, cut: d });
  });
  flush();
  return out;
}
/** Number of newest non-empty rows the provider may keep, or null (exhausted: keep all). */
function specCut(skip: number, newestFirst: readonly Label[]): number | null {
  return decidingEvent(skip, newestFirst)?.cut ?? null;
}
function decidingEvent(skip: number, newestFirst: readonly Label[]): Event | null {
  let left = skip;
  for (const event of events(newestFirst)) {
    if (event.floor || left === 0) return event;
    left--;
  }
  return null;
}
/** Which rule decided the cut, so the test can show the generator reaches every branch. */
function decidingRule(skip: number, newestFirst: readonly Label[]): string {
  const event = decidingEvent(skip, newestFirst);
  if (!event) return "exhausted";
  if (!event.floor) return skip > 0 ? "skipped-boundary" : "boundary";
  const row = newestFirst[event.cut] as Label | undefined;
  if (row?.kind === "resetFloor") return "resetFloor";
  if (row?.kind === "unreadable") {
    let end = event.cut;
    while (newestFirst[end + 1]?.kind === "unreadable") end++;
    const run = newestFirst.slice(event.cut, end + 1);
    if (run.some((r) => r.localEv)) return "run-local";
    return run.filter((r) => r.toks.length > 0).length > 1 ? "run-fragmented" : "run-tokens";
  }
  return "resetMarker";
}

// ── Labeled row generator ───────────────────────────────────────────────────────────────────

const hex = (c: string) => c.charCodeAt(0).toString(16).padStart(2, "0");
const TOKEN_TEXT: Record<Tok, string> = {
  key: '"contextBoundaryKind"',
  colon: ":",
  value: '"reset"',
};
// Junk never forms a token: no quote, colon or backslash.
const JUNK = "qwz09{}[],.- ";

function generator(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const junk = (n = 1 + Math.floor(random() * 6)) =>
    Array.from({ length: n }, () => pick([...JUNK])).join("");
  /** A raw token with some characters as \u00XX (either hex case) or \xXX escapes. */
  const rawToken = (tok: Tok) =>
    [...TOKEN_TEXT[tok]]
      .map((c) => {
        const r = random();
        if (r < 0.15) return "\\u00" + hex(c);
        if (r < 0.25) return "\\u00" + hex(c).toUpperCase();
        if (r < 0.35) return "\\x" + hex(c);
        return c;
      })
      .join("");
  /** A JSON string for `text` with some characters \u-escaped: JSON.parse decodes it. */
  const jsonString = (text: string) =>
    '"' + [...text].map((c) => (random() < 0.2 ? "\\u00" + hex(c) : c)).join("") + '"';
  const separator = () => pick(["", "", " ", "\t", "\u0000"]);
  let next = 0;
  const id = () => `m${next++}`;
  const readable = (kind: Kind, text: string, messageId: string): GenRow => ({
    text: random() < 0.15 ? `${text}\r` : text,
    label: { kind, toks: [], localEv: false, id: messageId },
  });
  const unreadable = (text: string, toks: Tok[], localEv: boolean, messageId?: string) => ({
    text,
    label: { kind: "unreadable" as const, toks, localEv, id: messageId },
  });

  /** One or more rows (a fragmented marker spans several). */
  function rows(allowOversized: boolean): GenRow[] {
    const r = random();
    const m = id();
    if (r < 0.25) {
      const role = pick(["user", "assistant"] as const);
      const text = pick([
        "plain",
        'about "contextBoundaryKind":"reset" here',
        "please reset",
        "compactionBoundary",
        `${TOKEN_TEXT.key}${TOKEN_TEXT.colon}${TOKEN_TEXT.value}`,
      ]);
      return [readable("plain", JSON.stringify(createMuxMessage(m, role, text)), m)];
    }
    if (r < 0.35) {
      const epoch = 1 + Math.floor(random() * 9);
      const boundary = JSON.stringify(
        createMuxMessage(m, "assistant", "summary", {
          compactionBoundary: true,
          compacted: true,
          compactionEpoch: epoch,
        })
      );
      const rollover = JSON.stringify({
        id: m,
        role: "assistant",
        parts: [],
        metadata: {
          contextBoundaryKind: "reset",
          muxMetadata: {
            type: "context-window-rollover",
            rolloverId: "r",
            reason: "on-send",
            previousWindowId: "w:0",
            flushOpportunity: false,
            contextTokens: 1,
            maxTokens: 2,
          },
        },
      });
      return [
        readable(
          "boundary",
          pick([
            boundary,
            boundary.replace('"compactionBoundary":true', '"compaction\\u0042oundary":true'),
            rollover,
          ]),
          m
        ),
      ];
    }
    if (r < 0.45) {
      // Manual resets: assistant rows are durable markers (kept), user rows are floors.
      const role = pick(["user", "assistant"] as const);
      const ws = pick(["", " ", "\t"]);
      const text = `{"id":"${m}","role":"${role}","parts":[],"metadata":{${jsonString("contextBoundaryKind")}${ws}:${ws}${jsonString("reset")}}}`;
      return [readable(role === "assistant" ? "resetMarker" : "resetFloor", text, m)];
    }
    if (r < 0.6) {
      // A marker fragmented over 1-3 unreadable rows, split only between tokens and junk.
      const pieces: Array<Tok | "junk"> = [];
      const order: Tok[] = random() < 0.8 ? [...MARKER] : ["value", "colon", "key"];
      for (const tok of order) {
        if (random() < 0.85) pieces.push(tok);
        if (random() < 0.5) pieces.push("junk");
      }
      const out: GenRow[] = [];
      let current = { text: `{bad ${junk()}`, toks: [] as Tok[] };
      for (const piece of pieces) {
        if (random() < 0.3) {
          out.push(unreadable(current.text, current.toks, false));
          current = { text: random() < 0.3 ? "" : junk(), toks: [] };
        }
        if (piece === "junk") current.text += junk();
        else {
          current.text += rawToken(piece);
          current.toks.push(piece);
        }
      }
      out.push(unreadable(current.text, current.toks, false));
      // A row may end up holding the whole marker locally; its tokens already count.
      return out;
    }
    if (r < 0.7) {
      // The whole marker in one row, tokens separated only by separators.
      const sep = separator();
      const marker = rawToken("key") + sep + rawToken("colon") + separator() + rawToken("value");
      const shape = pick(["junk", "notMessage", "ambiguous"] as const);
      if (shape === "junk")
        return [unreadable(`{bad ${junk()}${marker}${junk()}`, [...MARKER], true)];
      if (shape === "notMessage")
        return [
          unreadable(
            `{"id":"${m}","role":"tool","parts":[],"metadata":{${TOKEN_TEXT.key}:${TOKEN_TEXT.value}}}`,
            [...MARKER],
            true
          ),
        ];
      return [
        unreadable(
          `{"id":"${m}","role":"assistant","parts":[],"metadata":{${TOKEN_TEXT.key}:${TOKEN_TEXT.value}},"metadata":{}}`,
          [...MARKER],
          true
        ),
      ];
    }
    if (r < 0.78) {
      return [
        unreadable(
          pick([" \t ", '{"id":1}', "{bad", "[]", "null", '{"id":"x","role":"user"}']),
          [],
          false
        ),
      ];
    }
    if (r < 0.82) return [{ text: "", label: null }];
    if (allowOversized && r < 0.9) {
      const pad = "q".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 1 + Math.floor(random() * 4096));
      const shape = pick(["message", "boundary", "tokens", "marker"] as const);
      if (shape === "message")
        return [unreadable(JSON.stringify(createMuxMessage(m, "user", pad)), [], false, m)];
      if (shape === "boundary")
        return [
          readable(
            "boundary",
            JSON.stringify(
              createMuxMessage(m, "assistant", pad, {
                compactionBoundary: true,
                compacted: true,
                compactionEpoch: 1,
              })
            ),
            m
          ),
        ];
      if (shape === "tokens")
        return [
          unreadable(
            `{bad ${rawToken("key")} ${pad} ${rawToken("colon")} ${rawToken("value")}`,
            [...MARKER],
            false
          ),
        ];
      return [unreadable(`{bad ${TOKEN_TEXT.key}:${TOKEN_TEXT.value} ${pad}`, [...MARKER], true)];
    }
    const role = pick(["user", "assistant"] as const);
    return [readable("plain", JSON.stringify(createMuxMessage(m, role, `row ${m}`)), m)];
  }
  return { rows, id };
}

// ── Harness ─────────────────────────────────────────────────────────────────────────────────

interface Layout {
  content: string;
  /** Start offset of each non-empty labeled row, file order. */
  starts: number[];
  labels: Label[];
}
function layout(rows: readonly GenRow[], finalNewline: boolean): Layout {
  let content = "";
  const starts: number[] = [];
  const labels: Label[] = [];
  rows.forEach((row, i) => {
    if (row.label) {
      starts.push(Buffer.byteLength(content));
      labels.push(row.label);
    }
    content += row.text + (i < rows.length - 1 || finalNewline ? "\n" : "");
  });
  return { content, starts, labels };
}

/** File-order indices of the labeled rows the rule keeps. */
function expectedKept(labels: readonly Label[], skip: number): number[] {
  const cut = specCut(skip, [...labels].reverse());
  const n = labels.length;
  return labels.map((_, i) => i).filter((i) => cut === null || n - 1 - i < cut);
}

describe("findProviderHistoryStart against the Lean rule", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-locator-formal-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const coverage = new Map<string, number>();
  async function check(name: string, rows: readonly GenRow[], finalNewline: boolean) {
    const { content, starts, labels } = layout(rows, finalNewline);
    for (const skip of [0, 1]) {
      const rule = decidingRule(skip, [...labels].reverse());
      coverage.set(rule, (coverage.get(rule) ?? 0) + 1);
    }
    const oversized = rows.filter((row) => row.text.length > SESSION_HISTORY_MAX_LINE_BYTES);
    coverage.set("oversized", (coverage.get("oversized") ?? 0) + oversized.length);
    const file = path.join(dir, `${name}.jsonl`);
    await fs.writeFile(file, content);
    const problems: string[] = [];
    await using handle = await fs.open(file, "r");
    const size = Buffer.byteLength(content);
    for (const skip of [0, 1, 2]) {
      const location = await findProviderHistoryStart(handle, size, skip, false);
      const offset = location.kind === "start" ? location.offset : 0;
      const kept = starts.map((_, i) => i).filter((i) => starts[i] >= offset);
      const expected = expectedKept(labels, skip);
      if (kept.join() !== expected.join())
        problems.push(`${name} skip=${skip}: kept [${kept.join()}] expected [${expected.join()}]`);
      if ((location.kind === "exhausted") !== (specCut(skip, [...labels].reverse()) === null))
        problems.push(`${name} skip=${skip}: ${location.kind} vs rule`);
    }
    // End to end (skip 0): the one-pass provider read returns the kept messages only.
    const chat = path.join(dir, `${name}-chat.jsonl`);
    await fs.rename(file, chat);
    const ids = (
      await readProviderHistory({ chat, archive: path.join(dir, `${name}-archive.jsonl`) })
    ).map((message) => message.id);
    const expectedIds = expectedKept(labels, 0).flatMap((i) => labels[i].id ?? []);
    if (ids.join() !== expectedIds.join())
      problems.push(`${name} provider ids [${ids.join()}] expected [${expectedIds.join()}]`);
    await fs.rm(chat);
    return problems;
  }

  test("keeps exactly the rule's rows across seeds, skips and chunk edges", async () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 400 && problems.length < 10; seed++) {
      const random = mulberry32(seed);
      const gen = generator(random);
      const rows: GenRow[] = [];
      const count = 3 + Math.floor(random() * 12);
      for (let i = 0; i < count; i++) rows.push(...gen.rows(seed % 10 === 0));
      // Move the first 64 KiB chunk edge (counted from EOF) to a random byte of the generated rows
      // with one newest padding row, so fragments and escapes straddle it.
      const body = layout(rows, true).content;
      const target = Math.floor(random() * (Buffer.byteLength(body) + 1));
      const padId = gen.id();
      const shortest = JSON.stringify(createMuxMessage(padId, "user", "p"));
      const padLength = Math.max(1, SESSION_HISTORY_SCAN_CHUNK_BYTES - target - shortest.length);
      const pad = JSON.stringify(createMuxMessage(padId, "user", "p".repeat(padLength)));
      rows.push({ text: pad, label: { kind: "plain", toks: [], localEv: false, id: padId } });
      problems.push(...(await check(`seed-${seed}`, rows, random() < 0.8)));
    }
    expect(problems).toEqual([]);
    // Guard against a vacuous generator: every rule branch decides some cases.
    for (const rule of [
      "exhausted",
      "boundary",
      "skipped-boundary",
      "resetMarker",
      "resetFloor",
      "run-local",
      "run-tokens",
      "run-fragmented",
      "oversized",
    ])
      expect(coverage.get(rule) ?? 0, rule).toBeGreaterThan(5);
  }, 120_000);
});

// ── Fixed findings (outside the model's assumptions) ────────────────────────────────────────
//
// Each case: an older public-looking row "old", a reset-evidence row (or boundary), a newer row
// "new". The rule keeps only rows newer than the floor, so the provider must never see "old".
// The control next to each finding is the same evidence in a shape the locator handles.
describe("provider history privacy findings", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-locator-findings-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const message = (id: string, text = id) =>
    JSON.stringify({ id, role: "user", parts: [{ type: "text", text }] });
  const pad = "x".repeat(SESSION_HISTORY_MAX_LINE_BYTES + 10);
  let fileCount = 0;
  async function providerIds(lines: string[]): Promise<string[]> {
    const chat = path.join(dir, `${fileCount++}-chat.jsonl`);
    await fs.writeFile(chat, lines.join("\n") + "\n");
    const rows = await readProviderHistory({ chat, archive: path.join(dir, "missing.jsonl") });
    return rows.map((row) => row.id);
  }
  // A NUL inside the key: hasRawResetMarker removes it; the reverse token probe used not to.
  const nulKeyMarker = '{"metadata":{"context\u0000BoundaryKind":"reset"},broken ';

  // F1: oversized rows are never classified, so only the reverse token probe saw them, and it did
  // not remove separators inside a token. The same row under SESSION_HISTORY_MAX_LINE_BYTES is a
  // floor via classifyHistoryScanRow; oversized rows now also stream through the raw probe.
  test("F1 control: a reset key split by a separator floors a normal-size unreadable row", async () => {
    expect(
      await providerIds([message("old"), nulKeyMarker + "x".repeat(100), message("new")])
    ).toEqual(["new"]);
  });
  test("F1: the same reset evidence in an oversized unreadable row floors the read", async () => {
    expect(await providerIds([message("old"), nulKeyMarker + pad, message("new")])).toEqual([
      "new",
    ]);
  });

  // F2: a marker fragmented over rows is matched by concatenating unreadable rows without their
  // LF; a CR (CRLF) or space before the LF used to stay inside the token.
  test("F2 control: a reset value split by LF across unreadable rows floors the read", async () => {
    expect(
      await providerIds([
        message("old"),
        '{"metadata":{"contextBoundaryKind":"res',
        'et"},broken',
        message("new"),
      ])
    ).toEqual(["new"]);
  });
  for (const [name, separator] of [
    ["CR", "\r"],
    ["space", " "],
  ] as const) {
    test(`F2: a reset value split by ${name} plus LF across unreadable rows floors the read`, async () => {
      expect(
        await providerIds([
          message("old"),
          `{"metadata":{"contextBoundaryKind":"res${separator}`,
          'et"},broken',
          message("new"),
        ])
      ).toEqual(["new"]);
    });
  }

  // F3: an oversized compaction boundary used to be recovered only when its raw bytes held the
  // compact needle '"compactionBoundary":true'. A normal-size boundary is recognized after
  // JSON.parse, so an escaped key or a space works there.
  const boundary = (text: string) =>
    JSON.stringify(
      createMuxMessage("boundary", "assistant", text, {
        compactionBoundary: true,
        compacted: true,
        compactionEpoch: 1,
      })
    );
  const escapedKey = (row: string) =>
    row.replace('"compactionBoundary":true', '"compaction\\u0042oundary":true');
  const spaced = (row: string) =>
    row.replace('"compactionBoundary":true', '"compactionBoundary": true');
  test("F3 control: an escaped-key boundary starts the epoch at normal size and compact oversized", async () => {
    expect(
      await providerIds([message("old"), escapedKey(boundary("summary")), message("new")])
    ).toEqual(["boundary", "new"]);
    expect(await providerIds([message("old"), boundary(pad), message("new")])).toEqual([
      "boundary",
      "new",
    ]);
  });
  for (const [name, shape] of [
    ["escaped key", escapedKey],
    ["space after the colon", spaced],
  ] as const) {
    test(`F3: an oversized compaction boundary with ${name} starts the epoch`, async () => {
      expect(await providerIds([message("old"), shape(boundary(pad)), message("new")])).toEqual([
        "boundary",
        "new",
      ]);
    });
  }
  // Properties behind F1-F3: random spellings of the evidence, with the 64 KiB chunk edge (counted
  // from EOF) moved through it so escapes, UTF-8 sequences and tokens straddle segments. The
  // expected floor is hasRawResetMarker itself: whatever the classifier would floor at normal size
  // must floor oversized or fragmented.
  const RAW_SEPARATORS = [" ", "\t", "\r", "\u0000", "\u0085", "\u00a0", "\u2028", "\ufeff"];
  const ESCAPED_SEPARATORS = ["\\u0020", "\\x09", "\\U001f", "\\X7F", "\\u0000"];
  const DECOYS = ["é", "€", "𝄞", "q", "\\", '"'];
  function noisyMarker(random: () => number, text = '"contextBoundaryKind":"reset"'): string {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const noise = () => {
      const r = random();
      if (r < 0.3) return pick(RAW_SEPARATORS);
      if (r < 0.4) return pick(ESCAPED_SEPARATORS);
      if (r < 0.43) return pick(DECOYS);
      return "";
    };
    return [...text]
      .map((c) => {
        const r = random();
        const code = c.charCodeAt(0).toString(16).padStart(2, "0");
        // Raw separators may sit inside an escape too: they are removed before decoding.
        if (r < 0.15) return "\\" + noise() + "u00" + noise() + code;
        if (r < 0.25) return "\\x" + code.toUpperCase();
        return c;
      })
      .map((unit) => unit + noise())
      .join("");
  }
  /** The newest row, sized so a chunk edge (a multiple of 64 KiB from EOF) lands at `target`. */
  function newestRowForEdge(before: number, target: number): string {
    const shortest = message("new", "p");
    let length = target - before - 1;
    while (length < shortest.length) length += SESSION_HISTORY_SCAN_CHUNK_BYTES;
    return message("new", "p".repeat(length - shortest.length + 1));
  }
  const bytes = (text: string) => Buffer.byteLength(text);

  /** A byte offset inside `text` that splits a multibyte character or an escape, if any. */
  function splittingOffset(random: () => number, text: string): number | null {
    const offsets: number[] = [];
    let at = 0;
    for (const unit of text) {
      const size = bytes(unit);
      for (let i = 1; i < size; i++) offsets.push(at + i);
      if (unit === "\\") for (let i = 1; i <= 5; i++) offsets.push(at + i);
      at += size;
    }
    return offsets.length > 0 ? offsets[Math.floor(random() * offsets.length)] : null;
  }

  const escapeUnits = (c: string) => ["\\", "u", ...c.charCodeAt(0).toString(16).padStart(4, "0")];
  const spacedEscapedMarker = [...SESSION_HISTORY_RESET_NEEDLE]
    .map((c) => escapeUnits(c).join(""))
    .join("\\u0020");
  // Escaped separators may also sit inside each escape: hasRawResetMarker removes them first.
  const widestEscapedMarker = [...SESSION_HISTORY_RESET_NEEDLE]
    .map((c) => escapeUnits(c).join("\\u0020"))
    .join("\\u0020");
  test("F1 property: an oversized row with its own raw reset marker floors the read", async () => {
    let floors = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const random = mulberry32(seed);
      // Escaping every unit and putting an escaped separator between units makes the key token
      // longer than the token probe's retained overlap, so at a chunk edge inside the key only the
      // raw probe finds the marker.
      const variant = random();
      const core =
        variant < 0.35
          ? spacedEscapedMarker
          : variant < 0.7
            ? widestEscapedMarker
            : noisyMarker(random);
      const head = `{bad ${"q".repeat(SESSION_HISTORY_MAX_LINE_BYTES)}`;
      const row = `${head}${core} tail`;
      if (!hasRawResetMarker(row)) continue;
      floors++;
      const coreStart = bytes(message("old")) + 1 + bytes(head);
      const split = random() < 0.6 ? splittingOffset(random, core) : null;
      const target = coreStart + (split ?? Math.floor(random() * (bytes(core) + 1)));
      const before = bytes(message("old")) + 1 + bytes(row) + 1;
      const ids = await providerIds([message("old"), row, newestRowForEdge(before, target)]);
      expect(ids, `seed ${seed}`).toEqual(["new"]);
    }
    expect(floors).toBeGreaterThan(20);
  }, 120_000);

  test("F2 property: a raw reset marker fragmented over unreadable rows floors the read", async () => {
    let floors = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed);
      const core = `{bad ${noisyMarker(random)}`;
      // Split anywhere, even inside an escape or a UTF-8 sequence's code units.
      const units = [...core];
      const fragments: string[] = [];
      let current = "";
      for (const unit of units) {
        current += unit;
        if (random() < 0.08) {
          fragments.push(current);
          current = "";
        }
      }
      fragments.push(current + " tail");
      if (!hasRawResetMarker(fragments.join(""))) continue;
      floors++;
      const coreStart = bytes(message("old")) + 1;
      const run = fragments.join("\n");
      const target = coreStart + Math.floor(random() * (bytes(run) + 1));
      const before = coreStart + bytes(run) + 1;
      const ids = await providerIds([
        message("old"),
        ...fragments,
        newestRowForEdge(before, target),
      ]);
      expect(ids, `seed ${seed}: ${JSON.stringify(fragments)}`).toEqual(["new"]);
    }
    expect(floors).toBeGreaterThan(50);
  }, 120_000);

  test("unreadable runs floor alike under every chunk alignment, nested escapes included", async () => {
    // Removing one escaped separator can expose another (\u00\u002020 leaves \u0020), which the
    // single-pass rule does not remove; where the chunk edge falls must not change the answer.
    const NESTED = ["\\u00\\u002020", "\\x\\x2020", "\\ u0020", "\\\\u0020", "\\u0\\x2000"];
    let floors = 0;
    let keeps = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const random = mulberry32(seed);
      const nestedRate = random() < 0.5 ? 0 : 0.05;
      const marker = random() < 0.5 ? undefined : '"contextBoundaryKind":"rezet"';
      const units = [...`{bad ${noisyMarker(random, marker)}`].map((unit) =>
        random() < nestedRate ? NESTED[Math.floor(random() * NESTED.length)] + unit : unit
      );
      const fragments: string[] = [];
      let current = "";
      for (const unit of units) {
        current += unit;
        if (random() < 0.1) {
          fragments.push(current);
          current = "";
        }
      }
      fragments.push(current + " tail");
      const coreStart = bytes(message("old")) + 1;
      const run = fragments.join("\n");
      const before = coreStart + bytes(run) + 1;
      const results = new Set<string>();
      for (let k = 0; k < 12; k++) {
        const target = coreStart + Math.floor(random() * (before - coreStart + 1));
        const ids = await providerIds([
          message("old"),
          ...fragments,
          newestRowForEdge(before, target),
        ]);
        results.add(ids.join());
      }
      expect([...results], `seed ${seed}: ${JSON.stringify(fragments)}`).toHaveLength(1);
      // The cross-row token rule is a superset of hasRawResetMarker on the joined run.
      if (hasRawResetMarker(fragments.join("")))
        expect([...results], `seed ${seed}`).toEqual(["new"]);
      if ([...results][0] === "new") floors++;
      else keeps++;
    }
    expect(floors).toBeGreaterThanOrEqual(3);
    expect(keeps).toBeGreaterThanOrEqual(3);
  }, 120_000);

  test("F3 property: an oversized compaction boundary in any JSON spelling starts the epoch", async () => {
    const whitespace = ["", "", " ", "\t", "\r", " \t "];
    for (let seed = 1; seed <= 30; seed++) {
      const random = mulberry32(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
      const key = [..."compactionBoundary"]
        .map((c) => {
          if (random() >= 0.25) return c;
          const code = c.charCodeAt(0).toString(16).padStart(4, "0");
          return "\\u" + (random() < 0.5 ? code : code.toUpperCase());
        })
        .join("");
      const spelling = `"${key}"${pick(whitespace)}:${pick(whitespace)}true`;
      const row = boundary(pad).replace('"compactionBoundary":true', spelling);
      expect(row).toContain(spelling);
      const keyStart = bytes(message("old")) + 1 + bytes(row.slice(0, row.indexOf(spelling)));
      const target = keyStart + Math.floor(random() * (bytes(spelling) + 1));
      const before = bytes(message("old")) + 1 + bytes(row) + 1;
      const ids = await providerIds([message("old"), row, newestRowForEdge(before, target)]);
      expect(ids, `seed ${seed}: ${spelling}`).toEqual(["boundary", "new"]);
    }
  }, 120_000);
});
