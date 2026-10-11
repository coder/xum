import { describe, expect, test } from "bun:test";
import { describePluginHookHandler } from "./PluginHooksPanel";

describe("describePluginHookHandler", () => {
  test("tells apart mcp_tool hooks that differ only in timeout", () => {
    // A changed hook may differ only in its timeout: the review must show that difference.
    const handler = { type: "mcp_tool" as const, server: "s", tool: "t", input: {} };
    expect(describePluginHookHandler({ ...handler, timeoutSeconds: 30 })).not.toBe(
      describePluginHookHandler({ ...handler, timeoutSeconds: 86400 })
    );
  });

  test("an omitted timeout reads as the runner default, not a number", () => {
    const handler = { type: "mcp_tool" as const, server: "s", tool: "t", input: {} };
    const summary = describePluginHookHandler(handler);
    expect(summary).not.toContain("undefined");
    expect(summary).not.toBe(describePluginHookHandler({ ...handler, timeoutSeconds: 30 }));
  });
});
