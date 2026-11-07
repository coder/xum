import { describe, expect, it } from "bun:test";

import { DATA_URL_PATTERN, MEDIA_STUB } from "./memoryToolText";

describe("DATA_URL_PATTERN", () => {
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
    text.replace(DATA_URL_PATTERN, MEDIA_STUB); // keep a cold regex compile out of the timing
    const started = performance.now();
    text.replace(DATA_URL_PATTERN, MEDIA_STUB);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
