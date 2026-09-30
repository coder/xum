import { describe, expect, test } from "bun:test";
import {
  deepEqualAnyDepth,
  mulberry32,
  referenceStatusElision,
} from "./historyScanner.generator.testHarness";
import { isReadableHistoryMessage } from "./historyScanner";
import { projectStatusHistoryRow } from "./historyStatusProjection";

// The status read (#4790) parses `projectStatusHistoryRow(row) ?? row` for rows over the line
// limit. Contract: on every row JSON.parse accepts, the parse equals referenceStatusElision of
// the full parse (so status keeps every field it reads), and a row the full read keeps stays
// readable. Rows are written by hand below, not by JSON.stringify: pretty whitespace, escaped
// and duplicate keys, and invalid UTF-8 are bytes the scanner must handle like JSON.parse does.

/** An object written with ordered, possibly duplicate keys. */
class Obj {
  constructor(readonly entries: Array<[string, unknown]>) {}
}
/** Bytes written verbatim (deep nesting JSON.stringify cannot produce). */
class Raw {
  constructor(readonly text: string) {}
}
/** Replaced by an invalid UTF-8 byte after writing; only placed inside elided payload strings. */
const INVALID_UTF8 = "\u0007INVALID\u0007";

function writer(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const ws = () => (random() < 0.7 ? "" : pick([" ", "\t", "\r\n", "\n  ", " \t\r\n"]));
  const key = (name: string) =>
    [...JSON.stringify(name)]
      .map((c, i, all) =>
        i > 0 && i < all.length - 1 && random() < 0.1
          ? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
          : c
      )
      .join("");
  const write = (value: unknown): string => {
    if (value instanceof Raw) return value.text;
    if (value instanceof Obj)
      return `{${ws()}${value.entries.map(([k, v]) => `${key(k)}${ws()}:${ws()}${write(v)}`).join(`${ws()},${ws()}`)}${ws()}}`;
    if (Array.isArray(value)) return `[${ws()}${value.map(write).join(`${ws()},${ws()}`)}${ws()}]`;
    return JSON.stringify(value);
  };
  return (value: unknown) => {
    const text = ws() + write(value) + ws();
    const bytes = Buffer.from(text);
    const marker = Buffer.from(JSON.stringify(INVALID_UTF8).slice(1, -1));
    const pieces: Buffer[] = [];
    let at = 0;
    for (let i = bytes.indexOf(marker); i !== -1; i = bytes.indexOf(marker, at)) {
      pieces.push(bytes.subarray(at, i), Buffer.from([pick([0xff, 0xc3, 0xe2, 0x80])]));
      at = i + marker.length;
    }
    pieces.push(bytes.subarray(at));
    return Buffer.concat(pieces);
  };
}

function generateRow(random: () => number): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const text = () =>
    pick([
      "plain",
      'escape runs \\ \\\\ \\" \\\\" "',
      "trailing backslash \\",
      "\\\\",
      "unicode é 日本語 🎉 \ud83c\udf89",
      "lone surrogate \ud800",
      "",
    ]);
  const payload = (depth = 0): unknown => {
    const r = random();
    if (r < 0.25) return text() + (random() < 0.2 ? INVALID_UTF8 : "");
    if (r < 0.4) return pick([0, -1.5e3, true, false, null]);
    if (r < 0.5) return new Raw("[".repeat(2000) + "]".repeat(2000));
    if (depth > 3) return text();
    if (r < 0.75) return Array.from({ length: Math.floor(random() * 3) }, () => payload(depth + 1));
    return new Obj(
      Array.from({ length: Math.floor(random() * 3) }, () => [
        pick(["input", "output", "url", "a", "parts"]),
        payload(depth + 1),
      ])
    );
  };
  const maybeDuplicate = (entries: Array<[string, unknown]>) => {
    if (random() < 0.15)
      entries.splice(Math.floor(random() * entries.length), 0, [
        pick(["input", "output", "url", "parts"]),
        payload(),
      ]);
    return new Obj(entries);
  };
  const nestedCall = () =>
    random() < 0.2
      ? pick(["call", 3, null, [payload()]])
      : maybeDuplicate([
          ["toolCallId", "n"],
          ["toolName", "file_read"],
          ["state", "output-available"],
          ...(random() < 0.7 ? [["input", payload()] as [string, unknown]] : []),
          ...(random() < 0.7 ? [["output", payload()] as [string, unknown]] : []),
          ...(random() < 0.3 ? [["url", text()] as [string, unknown]] : []),
        ]);
  const part = (): unknown => {
    const r = random();
    if (r < 0.1) return pick(["text", 5, null, [1, 2], []]);
    if (r < 0.3)
      return maybeDuplicate([
        ["type", "text"],
        ["text", text()],
      ]);
    if (r < 0.45)
      return maybeDuplicate([
        ["type", "file"],
        ["mediaType", "image/png"],
        ["url", random() < 0.85 ? `data:image/png;base64,${text()}` : pick([7, null, ["u"]])],
      ]);
    const state = pick(["input-available", "output-available", "output-redacted"]);
    return maybeDuplicate([
      ["type", "dynamic-tool"],
      ["toolCallId", "c"],
      ["toolName", pick(["bash", "code_execution"])],
      ["state", state],
      ["input", payload()],
      ...(state === "output-available" ? [["output", payload()] as [string, unknown]] : []),
      ...(random() < 0.3
        ? [
            [
              "nestedCalls",
              random() < 0.85
                ? Array.from({ length: 1 + Math.floor(random() * 3) }, nestedCall)
                : pick([{}, "x", 1]),
            ] as [string, unknown],
          ]
        : []),
      // Untouched: the scanner cuts only direct payload keys of a part and its nested calls.
      ...(random() < 0.2
        ? [
            [
              "workflowRun",
              new Obj([
                ["runId", "wfr_1"],
                ["timestamp", 1],
                [
                  "run",
                  new Obj([
                    ["input", payload()],
                    ["output", payload()],
                  ]),
                ],
              ]),
            ] as [string, unknown],
          ]
        : []),
    ]);
  };
  const parts = () => Array.from({ length: Math.floor(random() * 5) }, part);
  return maybeDuplicate([
    ["id", "m"],
    ["role", pick(["user", "assistant"])],
    ["parts", random() < 0.95 ? parts() : pick([{}, "p", 1])],
    ...(random() < 0.3
      ? [
          [
            "metadata",
            new Obj([
              ["input", payload()],
              ["output", payload()],
              ["parts", parts()],
            ]),
          ] as [string, unknown],
        ]
      : []),
  ]);
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
const projected = (row: Buffer) => parse(projectStatusHistoryRow(row) ?? row.toString("utf8"));
const readable = (value: unknown) => value !== undefined && isReadableHistoryMessage(value);

describe("projectStatusHistoryRow", () => {
  test("equals the reference elision of the full parse on seeded rows", () => {
    const problems: string[] = [];
    let readableRows = 0;
    let cutRows = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const random = mulberry32(seed);
      const row = writer(random)(generateRow(random));
      const full = parse(row.toString("utf8"));
      if (full === undefined) {
        problems.push(`seed ${seed}: generated row is not JSON`);
        continue;
      }
      if (projectStatusHistoryRow(row) !== null) cutRows++;
      const value = projected(row);
      if (!deepEqualAnyDepth(value, referenceStatusElision(full)))
        problems.push(`seed ${seed}: differs from the reference elision`);
      if (readable(full)) {
        readableRows++;
        if (!readable(value)) problems.push(`seed ${seed}: readable row became unreadable`);
      }
    }
    expect(problems).toEqual([]);
    // The generator must exercise both branches, or the property proves nothing.
    expect(readableRows).toBeGreaterThan(300);
    expect(cutRows).toBeGreaterThan(1500);
    // ~2.6 s locally; the default 5 s timeout flaked on a loaded host.
  }, 30_000);

  test("keeps the full parse's readability at every truncation offset", () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const random = mulberry32(seed + 10_000);
      let row = writer(random)(generateRow(random));
      while (row.length < 1024 || row.length > 8192 || !readable(parse(row.toString("utf8"))))
        row = writer(random)(generateRow(random));
      for (let end = 0; end <= row.length; end++) {
        const prefix = row.subarray(0, end);
        if (readable(parse(prefix.toString("utf8"))) !== readable(projected(prefix)))
          problems.push(`seed ${seed}: readability differs at offset ${end}`);
      }
    }
    expect(problems).toEqual([]);
  }, 30_000);

  test("an oversized row with corrupt but balanced payload bytes stays readable to status", () => {
    // Documented divergence: a raw control character is invalid JSON, but it sits inside a cut
    // value, so status keeps the row the provider read drops. It is inside the epoch either way.
    const row = Buffer.from(
      '{"id":"m","role":"assistant","parts":[{"type":"dynamic-tool","toolCallId":"c",' +
        '"toolName":"bash","state":"output-available","input":{},"output":"a\u0001b"}]}'
    );
    expect(parse(row.toString("utf8"))).toBeUndefined();
    expect(readable(projected(row))).toBe(true);
  });
});
