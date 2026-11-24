import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { stripAnthropicThinkingFromTailCopy } from "./tailCopyThinking";

type Part = MuxMessage["parts"][number];

const openaiReasoning: Part = {
  type: "reasoning",
  text: "openai thoughts",
  providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
};
const text = (value: string): Part => ({ type: "text", text: value });

describe("stripAnthropicThinkingFromTailCopy", () => {
  it("removes Anthropic replay data but keeps every part and the step indices", () => {
    const message: MuxMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "signed", providerOptions: { anthropic: { signature: "s" } } },
        { type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "r" } } },
        { type: "reasoning", text: "legacy", signature: "legacy-sig" },
        {
          type: "reasoning",
          text: "both",
          providerOptions: {
            anthropic: { signature: "s2" },
            google: { thoughtSignature: "g" },
          },
        },
        openaiReasoning,
        text("answer"),
      ],
      metadata: { model: "anthropic:claude", stepStartPartIndices: [0, 2] },
    };
    const stripped = stripAnthropicThinkingFromTailCopy(message);
    expect(stripped.parts).toEqual([
      { type: "reasoning", text: "signed" },
      { type: "reasoning", text: "" },
      { type: "reasoning", text: "legacy" },
      { type: "reasoning", text: "both", providerOptions: { google: { thoughtSignature: "g" } } },
      openaiReasoning,
      text("answer"),
    ]);
    expect(stripped.metadata).toEqual(message.metadata);
    // The source row is never mutated: the original stays above the boundary.
    expect(message.parts[0]).toMatchObject({ providerOptions: { anthropic: { signature: "s" } } });
    expect(message.parts[2]).toMatchObject({ signature: "legacy-sig" });
  });

  it("leaves rows without Anthropic replay data unchanged", () => {
    const openaiRow: MuxMessage = {
      id: "a2",
      role: "assistant",
      parts: [openaiReasoning, { type: "reasoning", text: "no replay data" }, text("answer")],
    };
    expect(stripAnthropicThinkingFromTailCopy(openaiRow)).toBe(openaiRow);
  });
});
