import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { createMuxMessage } from "@/common/types/message";
import { findProviderHistoryStart, readProviderHistory } from "./historyScanner";
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
// The `test.failing` cases at the end document confirmed findings where the production locator
// breaks the rule (inputs outside the model's assumptions). Remove `.failing` once fixed.

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

// ── Confirmed findings (outside the model's assumptions) ────────────────────────────────────
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
  // A NUL inside the key: hasRawResetMarker removes it, the reverse token probe does not.
  const nulKeyMarker = '{"metadata":{"context\u0000BoundaryKind":"reset"},broken ';

  // F1: oversized rows are never classified, so only the reverse token probe sees them, and it
  // does not remove separators inside a token (historyScanner.ts addHistoryResetProbe). The same
  // row under SESSION_HISTORY_MAX_LINE_BYTES is a floor via classifyHistoryScanRow.
  test("F1 control: a reset key split by a separator floors a normal-size unreadable row", async () => {
    expect(
      await providerIds([message("old"), nulKeyMarker + "x".repeat(100), message("new")])
    ).toEqual(["new"]);
  });
  test.failing(
    "F1: the same reset evidence in an oversized unreadable row floors the read",
    async () => {
      expect(await providerIds([message("old"), nulKeyMarker + pad, message("new")])).toEqual([
        "new",
      ]);
    }
  );

  // F2: a marker fragmented over rows is matched by concatenating unreadable rows without their
  // LF, but a CR (CRLF) or space before the LF stays inside the token.
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
    test.failing(
      `F2: a reset value split by ${name} plus LF across unreadable rows floors the read`,
      async () => {
        expect(
          await providerIds([
            message("old"),
            `{"metadata":{"contextBoundaryKind":"res${separator}`,
            'et"},broken',
            message("new"),
          ])
        ).toEqual(["new"]);
      }
    );
  }

  // F3: an oversized compaction boundary is recovered only when its raw bytes hold the compact
  // needle '"compactionBoundary":true' (recoverOversizedBoundary / boundaryMarkerSeen). A
  // normal-size boundary is recognized after JSON.parse, so an escaped key or a space works there.
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
    test.failing(`F3: an oversized compaction boundary with ${name} starts the epoch`, async () => {
      expect(await providerIds([message("old"), shape(boundary(pad)), message("new")])).toEqual([
        "boundary",
        "new",
      ]);
    });
  }
});
