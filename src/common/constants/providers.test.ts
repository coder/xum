import { describe, test, expect } from "bun:test";
import { isValidProvider } from "./providers";

describe("isValidProvider", () => {
  test("accepts registered providers", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("openai")).toBe(true);
  });

  test("rejects unknown names and inherited Object.prototype keys", () => {
    for (const name of [
      "invalid",
      "",
      "gpt-4",
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(isValidProvider(name)).toBe(false);
    }
  });
});
