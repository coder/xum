import { describe, expect, test } from "bun:test";
import { SendMessageOptionsSchema } from "./stream";

describe("SendMessageOptions autoModelRouting", () => {
  test("round-trips the flag and leaves it absent when omitted", () => {
    const withFlag = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      autoModelRouting: true,
    });
    expect(withFlag.autoModelRouting).toBe(true);

    const withoutFlag = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    });
    expect(withoutFlag).not.toHaveProperty("autoModelRouting");
  });
});

describe("SendMessageOptions plugin send-hook fields", () => {
  test("a client cannot mark a compaction follow-up as already hooked", () => {
    const followUpContent = {
      text: "push to main",
      pluginSendHooksApplied: true,
      pluginRewrite: { plugin: "guard", originalText: "x" },
      model: "anthropic:claude-opus-4-6",
    };
    const muxMetadata = {
      type: "compaction-request",
      rawCommand: "/compact",
      parsed: { followUpContent },
    };
    const parsed = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      muxMetadata,
    });
    expect(parsed.muxMetadata).toEqual({
      type: "compaction-request",
      rawCommand: "/compact",
      parsed: { followUpContent: { text: "push to main", model: "anthropic:claude-opus-4-6" } },
    });
    // The caller's object is not mutated.
    expect(followUpContent.pluginSendHooksApplied).toBe(true);
  });

  test("other metadata passes through unchanged", () => {
    const muxMetadata = { type: "normal", custom: { a: 1 } };
    const parsed = SendMessageOptionsSchema.parse({ model: "m", agentId: "exec", muxMetadata });
    expect(parsed.muxMetadata).toBe(muxMetadata);
  });
});
