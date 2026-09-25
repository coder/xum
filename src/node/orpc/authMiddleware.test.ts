import { describe, expect, it } from "bun:test";
import { safeEq } from "./authMiddleware";

describe("safeEq", () => {
  it("returns true for equal strings", () => {
    expect(safeEq("secret", "secret")).toBe(true);
    expect(safeEq("", "")).toBe(true);
    expect(safeEq("a", "a")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeEq("secret", "secreT")).toBe(false);
    expect(safeEq("aaaaaa", "aaaaab")).toBe(false);
    expect(safeEq("a", "b")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(safeEq("short", "longer")).toBe(false);
    expect(safeEq("", "a")).toBe(false);
    expect(safeEq("abc", "ab")).toBe(false);
  });

  it("handles unicode strings", () => {
    expect(safeEq("héllo", "héllo")).toBe(true);
    expect(safeEq("héllo", "hello")).toBe(false);
    expect(safeEq("🔐", "🔐")).toBe(true);
  });
});
