import { describe, expect, test } from "bun:test";
import {
  PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS,
  describePluginHookHandler,
  formatPluginHookInput,
} from "./PluginHooksPanel";

describe("describePluginHookHandler", () => {
  test("tells apart mcp_tool hooks that differ only in timeout", () => {
    // A changed hook may differ only in its timeout: the review must show that difference.
    const handler = { type: "mcp_tool" as const, server: "s", tool: "t", input: {} };
    expect(describePluginHookHandler({ ...handler, timeoutSeconds: 30 })).not.toBe(
      describePluginHookHandler({ ...handler, timeoutSeconds: 86400 })
    );
  });
});

describe("formatPluginHookInput", () => {
  test("a large nested input shows capped compact text with a truncation note", () => {
    // Codex P2 (PRRT_kwDOPxxmWM6rRIkW): many values under deep arrays; pretty-printed in full this
    // grows to megabytes before the user trusts anything.
    let nested: unknown = Array.from({ length: 2000 }, (_, i) => i);
    for (let depth = 0; depth < 40; depth++) nested = [nested];
    const input = { a: nested, b: "x".repeat(100_000) };

    const shown = formatPluginHookInput(input);

    expect(shown.length).toBeLessThan(PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS + 64);
    expect(shown).toMatch(/\n…truncated \(\d+ KB\)$/);
    expect(shown.startsWith(JSON.stringify(input).slice(0, 100))).toBe(true);
  });

  test("the cut never splits a surrogate pair", () => {
    // The emoji's two UTF-16 units straddle the cut point.
    const prefix = '{"a":"'.length;
    const input = {
      a: "x".repeat(PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS - prefix - 1) + "\u{1F600}".repeat(10),
    };
    const shown = formatPluginHookInput(input).split("\n…truncated")[0];
    expect(shown.length).toBe(PLUGIN_HOOK_INPUT_DISPLAY_MAX_CHARS - 1);
    expect(shown.endsWith("x")).toBe(true);
  });

  test("a small input stays pretty-printed in full", () => {
    const input = { path: "${tool_input.path}", n: [1, 2] };
    expect(formatPluginHookInput(input)).toBe(JSON.stringify(input, null, 2));
  });
});
