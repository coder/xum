import { describe, expect, it } from "bun:test";

import { pageToolText } from "./pageToolText";

describe("pageToolText", () => {
  it("rounds an offset inside a surrogate pair back to the pair's start", () => {
    const text = "ab😀cd";
    // Offset 3 sits between the emoji's high (index 2) and low (index 3) surrogate.
    const page = pageToolText(text, 3, 10);
    // Starts at the high surrogate: no unpaired low surrogate, and says where it started.
    expect(page.text).toBe("😀cd");
    expect(page.startCharOffset).toBe(2);
  });

  it("never ends a page on a high surrogate", () => {
    const text = "ab😀cd";
    const first = pageToolText(text, 0, 3);
    expect(first).toEqual({ text: "ab", nextCharOffset: 2 });
    expect(pageToolText(text, first.nextCharOffset, 3).text).toBe("😀c");
  });
});
