import { describe, expect, test } from "bun:test";
import { isAllowedSubframeNavigation } from "./subframeNavigation";

describe("isAllowedSubframeNavigation", () => {
  test("subframes may only load their srcdoc", () => {
    expect(isAllowedSubframeNavigation(false, "about:srcdoc")).toBe(true);
    expect(isAllowedSubframeNavigation(false, "https://evil.example/")).toBe(false);
    expect(isAllowedSubframeNavigation(false, "data:text/html,<p>x</p>")).toBe(false);
    expect(isAllowedSubframeNavigation(false, "about:blank")).toBe(false);
  });

  test("main-frame navigations are left to will-navigate", () => {
    expect(isAllowedSubframeNavigation(true, "https://example.com/")).toBe(true);
  });
});
