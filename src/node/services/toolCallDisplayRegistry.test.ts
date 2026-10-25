import { beforeEach, describe, expect, test } from "bun:test";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import {
  TOOL_CALL_DISPLAY_MAX_ENTRIES,
  TOOL_CALL_DISPLAY_TTL_MS,
  ToolCallDisplayRegistry,
  type ExecutionScope,
} from "./toolCallDisplayRegistry";

function snapshot(name: string): MCPToolCallDisplay {
  return {
    connection: { key: "notion", transport: "stdio" },
    identity: { name, version: "1" },
    source: "connection",
  };
}

describe("ToolCallDisplayRegistry", () => {
  let now = 0;
  let registry: ToolCallDisplayRegistry;
  const scopeA: ExecutionScope = { workspaceId: "ws", messageId: "m-a", token: "t-a" };
  const scopeB: ExecutionScope = { workspaceId: "ws", messageId: "m-b", token: "t-b" };

  beforeEach(() => {
    now = 1_000;
    registry = new ToolCallDisplayRegistry({ now: () => now });
  });

  test("set then take exactly once for a known scope", () => {
    registry.open(scopeA);
    expect(registry.set(scopeA, "call-1", snapshot("a"))).toBe(true);
    expect(registry.take(scopeA, "call-1")).toStrictEqual(snapshot("a"));
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
    expect(registry.take(scopeA, "never-set")).toBeUndefined();
  });

  test("ignores writes for unknown or closed scopes", () => {
    expect(registry.set(scopeA, "call-1", snapshot("a"))).toBe(false);
    expect(registry.take(scopeA, "call-1")).toBeUndefined();

    registry.open(scopeA);
    registry.close(scopeA);
    expect(registry.set(scopeA, "call-1", snapshot("a"))).toBe(false);
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
    // Closing again or closing something never opened is harmless.
    registry.close(scopeA);
    registry.close(scopeB);
  });

  test("scope ownership is object identity, not structural equality", () => {
    registry.open(scopeA);
    const lookalike: ExecutionScope = { ...scopeA };
    expect(registry.set(lookalike, "call-1", snapshot("a"))).toBe(false);
    registry.set(scopeA, "call-1", snapshot("a"));
    expect(registry.take(lookalike, "call-1")).toBeUndefined();
    expect(registry.take(scopeA, "call-1")).toStrictEqual(snapshot("a"));
  });

  test("identical tool call ids in two scopes stay distinct", () => {
    registry.open(scopeA);
    registry.open(scopeB);
    registry.set(scopeA, "call-1", snapshot("a"));
    registry.set(scopeB, "call-1", snapshot("b"));
    expect(registry.take(scopeB, "call-1")).toStrictEqual(snapshot("b"));
    expect(registry.take(scopeA, "call-1")).toStrictEqual(snapshot("a"));
  });

  test("close removes only that scope's entries", () => {
    registry.open(scopeA);
    registry.open(scopeB);
    registry.set(scopeA, "call-1", snapshot("a"));
    registry.set(scopeB, "call-1", snapshot("b"));
    registry.close(scopeA);
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
    expect(registry.take(scopeB, "call-1")).toStrictEqual(snapshot("b"));
  });

  test("re-opening a known scope keeps its entries", () => {
    registry.open(scopeA);
    registry.set(scopeA, "call-1", snapshot("a"));
    registry.open(scopeA);
    expect(registry.take(scopeA, "call-1")).toStrictEqual(snapshot("a"));
  });

  test("overwriting an entry replaces the snapshot without growing the registry", () => {
    registry.open(scopeA);
    registry.set(scopeA, "call-1", snapshot("first"));
    registry.set(scopeA, "call-1", snapshot("second"));
    expect(registry.take(scopeA, "call-1")).toStrictEqual(snapshot("second"));
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
  });

  test("aborted run A completing late cannot write into run B with the same call id", () => {
    registry.open(scopeA);
    registry.close(scopeA); // abort A
    registry.open(scopeB); // B begins and the model reuses the same call id
    expect(registry.set(scopeA, "call-1", snapshot("a-late"))).toBe(false);
    expect(registry.take(scopeB, "call-1")).toBeUndefined();
    registry.set(scopeB, "call-1", snapshot("b"));
    expect(registry.take(scopeB, "call-1")).toStrictEqual(snapshot("b"));
  });

  test("a late consumer of run A cannot take run B's snapshot", () => {
    registry.open(scopeA);
    registry.open(scopeB);
    registry.set(scopeB, "call-1", snapshot("b"));
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
    registry.close(scopeA);
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
    expect(registry.take(scopeB, "call-1")).toStrictEqual(snapshot("b"));
  });

  test("entries expire after the TTL, independently of each other", () => {
    registry.open(scopeA);
    registry.set(scopeA, "old", snapshot("old"));
    registry.set(scopeA, "old-twin", snapshot("old-twin"));
    now += TOOL_CALL_DISPLAY_TTL_MS / 2;
    registry.set(scopeA, "fresh", snapshot("fresh"));
    now += TOOL_CALL_DISPLAY_TTL_MS / 2 - 1;
    expect(registry.take(scopeA, "old-twin")).toStrictEqual(snapshot("old-twin"));
    now += 1;
    expect(registry.take(scopeA, "old")).toBeUndefined();
    expect(registry.take(scopeA, "fresh")).toStrictEqual(snapshot("fresh"));
  });

  test("evicts the oldest entry across all scopes once the global cap is reached", () => {
    registry.open(scopeA);
    registry.open(scopeB);
    registry.set(scopeA, "oldest", snapshot("oldest"));
    for (let i = 1; i < TOOL_CALL_DISPLAY_MAX_ENTRIES - 1; i++) {
      registry.set(scopeA, `call-${i}`, snapshot(`a-${i}`));
    }
    registry.set(scopeB, "b-1", snapshot("b-1"));
    // At capacity: overwriting an existing entry must not evict anything.
    registry.set(scopeA, "call-1", snapshot("a-1-rewritten"));
    expect(registry.take(scopeA, "oldest")).toStrictEqual(snapshot("oldest"));
    registry.set(scopeA, "oldest", snapshot("oldest"));

    registry.set(scopeB, "b-2", snapshot("b-2"));
    // "oldest" was re-inserted after call-2, so call-2 is now the oldest entry.
    expect(registry.take(scopeA, "call-2")).toBeUndefined();
    expect(registry.take(scopeA, "oldest")).toStrictEqual(snapshot("oldest"));
    expect(registry.take(scopeA, "call-1")).toStrictEqual(snapshot("a-1-rewritten"));
    expect(registry.take(scopeA, "call-3")).toStrictEqual(snapshot("a-3"));
    expect(registry.take(scopeB, "b-1")).toStrictEqual(snapshot("b-1"));
    expect(registry.take(scopeB, "b-2")).toStrictEqual(snapshot("b-2"));
  });

  test("uses a wall clock and the documented bounds by default", () => {
    const defaults = new ToolCallDisplayRegistry();
    defaults.open(scopeA);
    expect(defaults.set(scopeA, "call-1", snapshot("a"))).toBe(true);
    expect(defaults.take(scopeA, "call-1")).toStrictEqual(snapshot("a"));
    expect(TOOL_CALL_DISPLAY_TTL_MS).toBe(10 * 60 * 1000);
    expect(TOOL_CALL_DISPLAY_MAX_ENTRIES).toBe(1_000);
  });
});
