import { describe, expect, test } from "bun:test";

import { getNestedToolStatus } from "./toolUtils";

describe("getNestedToolStatus", () => {
  test("kernel-mode suppressed summaries derive failure from the ok bit", () => {
    expect(
      getNestedToolStatus("output-available", { suppressed: true, ok: false, bytes: 0 }, false)
    ).toBe("failed");
    expect(
      getNestedToolStatus("output-available", { suppressed: true, ok: true, bytes: 10 }, false)
    ).toBe("completed");
  });
});
