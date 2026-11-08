import { describe, expect, it, spyOn } from "bun:test";

import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { isMediaPart } from "@/common/utils/attachments/toolAttachmentParts";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { redactSecretLike } from "./memorySecretRedaction";
import {
  derivesFromSessionHistory,
  renderToolValue,
  serializeToolValue,
  takeWithoutMedia,
} from "./memoryToolText";

// How the renderer worked before it was size-budgeted: clone and stringify the whole value, replace
// every data URL, and only then cut. The budgeted one must print the same for what fits.
function renderBeforeBudget(value: unknown, maxChars: number): string {
  const sanitize = (item: unknown, depth: number): unknown => {
    if (depth > 30) return "[nested data omitted]";
    if (Array.isArray(item)) return item.map((child) => sanitize(child, depth + 1));
    if (!isPlainObject(item)) return item;
    if (
      isMediaPart(item) ||
      isDisplayOnlyFilePart(item) ||
      item.type === "image-data" ||
      item.type === "file-data"
    ) {
      return "[media]";
    }
    if (item.toolName === "session_history") return "[session_history result omitted]";
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [key, sanitize(child, depth + 1)])
    );
  };
  const stringify = (): string => {
    if (value === undefined) return "[none]";
    const sanitized = sanitize(value, 0);
    if (typeof sanitized === "string") return sanitized;
    try {
      return JSON.stringify(sanitized) ?? "[unserializable]";
    } catch {
      return "[unserializable]";
    }
  };
  const withoutMedia = stringify().replace(
    /data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=_-]+/gi,
    "[media]"
  );
  const redacted = redactSecretLike(withoutMedia.slice(0, maxChars + 512));
  if (withoutMedia.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)} [truncated ${withoutMedia.length - maxChars} more chars for memory harvest]`;
}

const TRUNCATED = " [truncated ";

describe("renderToolValue", () => {
  const githubToken = `ghp_${"a1B2".repeat(9)}`;
  const dataUrl = "data:image/png;base64,QUJDREVGR0hJSktM";
  const nest = (depth: number, leaf: string): unknown =>
    depth === 0 ? leaf : { inner: nest(depth - 1, leaf) };
  const withHole = new Array<number>(3);
  withHole[0] = 1;
  withHole[2] = 3;

  const values: Array<[string, unknown]> = [
    ["a string", 'plain output\nwith a newline, "quotes" and a \\ backslash'],
    ["an empty string", ""],
    ["no value", undefined],
    ["a number", 42],
    ["negative zero", -0],
    ["a large float", 1.5e21],
    ["NaN", Number.NaN],
    ["null", null],
    ["a boolean", false],
    ["an empty array", []],
    ["an empty object", {}],
    ["every JSON type", { a: 1, b: "two", c: [3, { d: null }], e: true, f: [] }],
    ["a string of unicode", "héllo \u2028 日本語 \u{1F600}"],
    ["a key that needs escaping", { 'a"b\\c\n': 1 }],
    ["an own __proto__ key", JSON.parse('{"__proto__":{"a":1},"b":[1,{"c":null}]}')],
    [
      "properties and items that JSON leaves out",
      { a: undefined, b: () => 1, c: [undefined, () => 2] },
    ],
    ["an array with a hole", withHole],
    ["a Date", { when: new Date(0) }],
    ["a bigint", { n: 10n }],
    ["a media part", { type: "media", data: "QUJD".repeat(100), mediaType: "image/png" }],
    [
      "media parts inside a result",
      {
        content: [
          { type: "text", text: "hi" },
          { type: "display_file", data: "x", mediaType: "text/plain" },
        ],
      },
    ],
    ["a session_history result", { toolName: "session_history", output: { items: ["x"] } }],
    [
      "a session_history result inside another",
      {
        calls: [
          { toolName: "session_history", output: "x" },
          { toolName: "bash", output: "ok" },
        ],
      },
    ],
    ["data URLs in strings", { image: `before ${dataUrl} after`, again: [dataUrl] }],
    ["a data URL as the whole value", dataUrl],
    ["a secret", { env: `GITHUB_TOKEN=${githubToken}`, ok: true }],
    ["a secret that crosses the cap", `${"x".repeat(1_989)} ${githubToken} tail`],
    ["data nested to the limit", nest(29, "LEAF")],
    ["data nested past the limit", nest(40, "DEEP")],
    ["a long array", Array.from({ length: 3_000 }, (_, index) => index)],
    ["a long string", "x".repeat(5_000)],
    [
      "a wide object",
      Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [`key${index}`, `value ${index}`])
      ),
    ],
    ["a string a few characters over the cap", "y".repeat(2_100)],
  ];
  const caps = [10, 120, 2_000];

  it.each(values.flatMap(([label, value]) => caps.map((cap) => [label, value, cap] as const)))(
    "prints %s as before, at a cap of %d",
    (_label, value, cap) => {
      const expected = renderBeforeBudget(value, cap);
      const actual = renderToolValue(value, cap);
      const marker = expected.lastIndexOf(TRUNCATED);
      if (marker === -1) {
        expect(actual).toBe(expected);
        return;
      }
      // What was kept is the same. The count of what was cut is exact while the serialization
      // fits the redaction lookahead past the cap, and a lower bound past it: the walk stopped.
      const cutChars = Number(/\[truncated (\d+) more/.exec(expected.slice(marker))?.[1]);
      expect(actual).toBe(
        cutChars <= 512
          ? expected
          : `${expected.slice(0, marker)}${TRUNCATED}512+ more chars for memory harvest]`
      );
    }
  );

  it("says how much was cut when the whole value fit, and at least how much when it did not", () => {
    expect(renderToolValue("x".repeat(2_100), 2_000)).toBe(
      `${"x".repeat(2_000)} [truncated 100 more chars for memory harvest]`
    );
    expect(renderToolValue("x".repeat(60_000), 2_000)).toBe(
      `${"x".repeat(2_000)} [truncated 512+ more chars for memory harvest]`
    );
  });

  it("does not spend the cap on attachment bytes", () => {
    const shot = `data:image/png;base64,${"QUJD".repeat(250_000)}`;

    expect(renderToolValue({ shot, log: "build ok" }, 2_000)).toBe(
      '{"shot":"[media]","log":"build ok"}'
    );
  });

  it.each([
    ["a media part", { type: "media", data: "QUJD".repeat(100), mediaType: "image/png" }],
    [
      "a media part with a null filename",
      { type: "media", data: "QUJD", mediaType: "image/png", filename: null },
    ],
    [
      "a display-only file",
      { type: "display_file", data: "QUJD".repeat(100), mediaType: "text/csv" },
    ],
    [
      "an image-data output",
      { type: "image-data", data: "QUJD".repeat(100), mediaType: "image/png" },
    ],
    ["a file-data output", { type: "file-data", data: "QUJD".repeat(100), mediaType: "text/csv" }],
  ])("replaces %s by the stub", (_label, attachment) => {
    expect(renderToolValue({ shot: attachment, log: "build ok" }, 2_000)).toBe(
      '{"shot":"[media]","log":"build ok"}'
    );
  });

  // The provider sends a record typed "media" or "display_file" as an attachment only with the
  // shared shape, and any other record reaches it as tool-result JSON, so it may be the durable
  // evidence of the call and the harvest reads it the same way.
  it.each([
    ["a media record of application data", { type: "media", text: "campaign channel" }],
    ["a media record without a media type", { type: "media", data: "QUJD" }],
    ["a media record with a data that is not text", { type: "media", data: 5, mediaType: "x/y" }],
    ["a display_file record of application data", { type: "display_file", note: "invoice 42" }],
  ])("renders %s like any other record", (_label, record) => {
    expect(renderToolValue({ result: record }, 2_000)).toBe(JSON.stringify({ result: record }));
    expect(renderToolValue(record, 2_000)).toBe(JSON.stringify(record));
  });

  it("redacts a secret that starts inside the cap and ends past it", () => {
    const rendered = renderToolValue(`${"x".repeat(1_989)} ${githubToken} tail`, 2_000);

    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("ghp_");
  });

  // A tool prints JSON, and a structured result holds that JSON as a string, so a credential sits
  // in a string inside a string. Each layer doubles the backslashes before a quote (`\"`, `\\\"`,
  // `\\\\\\"`), and the credential's own escaped quote must not end it early. Escaping a text again
  // escapes the redacted text the same way, so that is what the rendering must equal.
  describe("a credential in JSON nested in the tool's output", () => {
    const stringifyTimes = (text: string, times: number): string =>
      times === 0 ? text : stringifyTimes(JSON.stringify({ wrapped: text }), times - 1);
    const passwords = ["plain-pw-4f9e", 'embedded"quote-7c1d', "trailing\\", 'back\\"slash-2b8a'];
    const cases = [1, 2, 3].flatMap((layers) =>
      passwords.map((password) => [layers, password] as const)
    );

    it.each(cases)("redacts it %i JSON strings deep: %j", (layers, password) => {
      const nested = (text: string): string => stringifyTimes(text, layers - 1);

      expect(
        renderToolValue({ out: nested(JSON.stringify({ password, user: "alice" })) }, 2_000)
      ).toBe(JSON.stringify({ out: nested('{"password":[redacted],"user":"alice"}') }));
    });
  });
});

/** An array of `length` items that exist only when read, so a walk's reads are countable. */
function lazyArray(length: number, itemAt: (index: number) => unknown): unknown[] {
  return new Proxy([] as unknown[], {
    get(target, key, receiver): unknown {
      if (key === "length") return length;
      if (typeof key === "string" && /^\d+$/.test(key)) return itemAt(Number(key));
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

/** The length of every string a regex scanned while `run` ran. */
function regexInputLengths(run: () => void): number[] {
  const spy = spyOn(RegExp.prototype, "exec");
  try {
    run();
    return spy.mock.calls.map(([input]) => input.length);
  } finally {
    spy.mockRestore();
  }
}

// A tool result can be megabytes of text or millions of entries; only a short prefix is sent. These
// count the work done instead of timing it: a value is read only as far as the budget reaches.
describe("a value far past the budget", () => {
  const BUDGET = 2_512; // a 2,000-character cap and the redaction lookahead

  it("reads only as many items of a huge array as the budget holds", () => {
    let reads = 0;
    const huge = lazyArray(1_000_000, (index) => {
      reads++;
      return index;
    });

    const { text, complete } = serializeToolValue(huge, BUDGET);

    expect(complete).toBe(false);
    expect(text).toHaveLength(BUDGET);
    expect(text.startsWith("[0,1,2,3,")).toBe(true);
    expect(reads).toBeLessThanOrEqual(BUDGET);
  });

  it("reads only as many values of a wide object as the budget holds", () => {
    let reads = 0;
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 20_000; index++) {
      Object.defineProperty(wide, `key${index}`, {
        enumerable: true,
        get: () => {
          reads++;
          return `value ${index}`;
        },
      });
    }

    const { text, complete } = serializeToolValue({ rows: wide }, BUDGET);

    expect(complete).toBe(false);
    expect(text.startsWith('{"rows":{"key0":"value 0","key1"')).toBe(true);
    expect(reads).toBeLessThanOrEqual(BUDGET);
  });

  it("stops at the budget inside deeply nested wide values", () => {
    let reads = 0;
    const rows = lazyArray(1_000_000, (index) => {
      reads++;
      return { id: index, tags: ["a", "b"], nested: { ok: true } };
    });

    const { complete } = serializeToolValue({ calls: [{ rows }] }, BUDGET);

    expect(complete).toBe(false);
    expect(reads).toBeLessThanOrEqual(BUDGET);
  });

  it("scans no more of a huge string than the budget reaches", () => {
    let rendered = "";
    const scanned = regexInputLengths(() => {
      rendered = renderToolValue({ output: `HEAD ${"x".repeat(20_000_000)} TAIL` }, 2_000);
    });

    expect(rendered).toContain("HEAD");
    expect(rendered).not.toContain("TAIL");
    // The spy sees every regex scan: the media search and the redaction patterns.
    expect(scanned.length).toBeGreaterThan(0);
    expect(Math.max(...scanned)).toBeLessThanOrEqual(BUDGET);
  });

  it("reads a data URL to its end, and the text after it", () => {
    const text = `data:image/png;base64,${"QUJD".repeat(1_000_000)} tail text`;

    expect(renderToolValue(text, 2_000)).toBe("[media] tail text");
  });
});

describe("takeWithoutMedia", () => {
  it("takes the text when it fits, and says nothing followed", () => {
    expect(takeWithoutMedia("a data:x b", 100)).toEqual({ text: "a data:x b", cut: false });
    expect(takeWithoutMedia("", 100)).toEqual({ text: "", cut: false });
  });

  it("counts the stub, not the payload, against the limit", () => {
    const text = `data:image/png;base64,${"A".repeat(100_000)} tail text here`;

    expect(takeWithoutMedia(text, 12)).toEqual({ text: "[media] tail", cut: true });
    expect(takeWithoutMedia(text, 1_000)).toEqual({ text: "[media] tail text here", cut: false });
  });

  it("searches only the text the limit can reach for a URL", () => {
    const scanned = regexInputLengths(() => {
      takeWithoutMedia(`${"x".repeat(1_000_000)}data:image/png;base64,QUJD`, 100);
    });

    expect(scanned.length).toBeGreaterThan(0);
    expect(Math.max(...scanned)).toBeLessThanOrEqual(100);
  });
});

describe("takeWithoutMedia on hostile text", () => {
  // Tool output is text a repository or a web page controls, so a hostile 100 KB result must not
  // stall the process. Each shape is one the header or the wrapped-line loop could rescan.
  it.each([
    ["a bare scheme", "data:".repeat(20_000)],
    ["a media-type header without a payload", "data:image/png;".repeat(7_000)],
    ["a header of parameters", `data:a/a${";a".repeat(50_000)}`],
    ["a header word", `data:${"a".repeat(100_000)}`],
    ["a wrapped payload", `data:image/png;base64,${`${"QUJD".repeat(5)}\n`.repeat(10_000)}`],
    ["a payload of one-character lines", `data:image/png;base64,${"A\n".repeat(50_000)}`],
    ["many short payloads", `data:image/png;base64,${"A".repeat(20)}\n`.repeat(3_000)],
    ["escaped line breaks", `data:image/png;base64,${`${"A".repeat(20)}\\n`.repeat(8_000)}`],
  ])("scans %s in linear time", (_label, text) => {
    takeWithoutMedia(text, Number.POSITIVE_INFINITY); // keep a cold regex compile out of the timing
    const started = performance.now();
    takeWithoutMedia(text, Number.POSITIVE_INFINITY);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("derivesFromSessionHistory", () => {
  const lookup = { toolName: "session_history" };
  const execution = (output: unknown, nestedCalls?: unknown): unknown => ({
    toolName: "code_execution",
    output,
    nestedCalls,
  });

  it.each([
    ["a lookup itself", lookup],
    [
      "a lookup in the records of its result",
      execution({ toolCalls: [{ toolName: "bash" }, lookup] }),
    ],
    [
      "a lookup in its persisted nested calls",
      execution({ result: "x" }, [{ toolName: "bash" }, lookup]),
    ],
    [
      "a lookup in a call it made in turn",
      execution({ toolCalls: [{ toolName: "task", result: { toolCalls: [lookup] } }] }),
    ],
    [
      "a lookup in the nested calls of a persisted call",
      execution({}, [{ toolName: "task", nestedCalls: [lookup] }]),
    ],
  ])("is true for %s", (_label, part) => {
    expect(derivesFromSessionHistory(part)).toBe(true);
  });

  it.each([
    ["other tools only", execution({ toolCalls: [{ toolName: "bash" }] }, [{ toolName: "bash" }])],
    ["no calls", execution({ result: "x", toolCalls: [] })],
    ["a lookup named only in text", execution({ result: "session_history" })],
    ["calls that are not lists", execution({ toolCalls: lookup }, lookup)],
    ["a string output", execution("done")],
    ["no part", undefined],
  ])("is false for %s", (_label, part) => {
    expect(derivesFromSessionHistory(part)).toBe(false);
  });

  // A chain too deep to read to its end cannot be shown to be free of a lookup.
  it("is true for a chain of calls deeper than the depth limit", () => {
    const chain = (depth: number): unknown =>
      depth === 0 ? { toolName: "bash" } : { toolName: "task", nestedCalls: [chain(depth - 1)] };

    expect(derivesFromSessionHistory(chain(5))).toBe(false);
    expect(derivesFromSessionHistory(chain(60))).toBe(true);
  });
});
