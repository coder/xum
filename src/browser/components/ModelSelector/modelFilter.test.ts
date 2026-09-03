import { describe, expect, test } from "bun:test";
import { modelMatchesQuery } from "./modelFilter";

describe("modelMatchesQuery", () => {
  test("matches model string substrings", () => {
    expect(modelMatchesQuery("google:gemini-3.8-flash", "3.8")).toBe(true);
    expect(modelMatchesQuery("google:gemini-3.8-flash", "sonnet")).toBe(false);
  });

  test("matches documented aliases that are not model string substrings", () => {
    expect(modelMatchesQuery("google:gemini-3.8-flash", "gemini-flash")).toBe(true);
    expect(modelMatchesQuery("deepseek:deepseek-v4-pro", "deepseek-pro")).toBe(true);
  });

  test("matches aliases for gateway-prefixed model strings", () => {
    expect(modelMatchesQuery("mux-gateway:google/gemini-3.8-flash", "gemini-flash")).toBe(true);
  });

  test("does not match aliases belonging to other models", () => {
    expect(modelMatchesQuery("anthropic:claude-opus-4-8", "gemini-flash")).toBe(false);
  });
});
