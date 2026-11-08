import { describe, expect, it } from "bun:test";

import { expectLinearScan, SLOW_SCAN_MS } from "./linearScan.testHarness";

// Two regex scans of "aaa...": `/a+$/` reads the text once per call (a thousand calls make it
// cost a few milliseconds), and `/a*b/` has no "b" to find, so it restarts from every position
// and reads the rest of the text each time. The regex is compiled once, so its cost per character
// does not fall between the two sizes, as a loop written in this file would.
const build = (scale: number) => "a".repeat(3_000 * scale);
const linearPattern = /a+$/;
const quadraticPattern = /a*b/;
const linear = (text: string) => {
  for (let call = 0; call < 1_000; call++) linearPattern.test(text);
};
const quadratic = (text: string) => quadraticPattern.test(text);

describe("expectLinearScan", () => {
  it("accepts a scan whose cost grows with the text", () => {
    expect(() => expectLinearScan(linear, build, SLOW_SCAN_MS)).not.toThrow();
  });

  it("rejects a scan whose cost grows with the square of the text", () => {
    expect(() => expectLinearScan(quadratic, build, SLOW_SCAN_MS)).toThrow();
  });

  it("rejects a linear scan that costs more than its ceiling", () => {
    expect(() => expectLinearScan(linear, build, 0.001)).toThrow();
  });
});
