import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { stripPrefixBoundReplayFromTailCopy } from "./tailCopyThinking";

type Part = MuxMessage["parts"][number];

const openaiReasoning: Part = {
  type: "reasoning",
  text: "openai thoughts",
  providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
};
const text = (value: string): Part => ({ type: "text", text: value });

describe("stripPrefixBoundReplayFromTailCopy", () => {
  it("removes Anthropic and Gemini replay data but keeps every part and the step indices", () => {
    const signedCall: Part = {
      type: "dynamic-tool",
      toolCallId: "call-1",
      toolName: "bash",
      state: "output-available",
      input: { script: "ls" },
      output: "README.md",
      providerOptions: {
        coderGoogle: { thoughtSignature: "c" },
        google: { thoughtSignature: "g" },
        googleVertex: { thoughtSignature: "v" },
      },
    };
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
        {
          type: "reasoning",
          text: "gemini",
          providerOptions: {
            googleVertex: { thoughtSignature: "v" },
            openai: { reasoningEncryptedContent: "enc" },
          },
        },
        signedCall,
        openaiReasoning,
        text("answer"),
      ],
      metadata: { model: "anthropic:claude", stepStartPartIndices: [0, 2] },
    };
    const stripped = stripPrefixBoundReplayFromTailCopy(message);
    const { providerOptions: _signatures, ...unsignedCall } = signedCall;
    expect(stripped.parts).toEqual([
      { type: "reasoning", text: "signed" },
      { type: "reasoning", text: "" },
      { type: "reasoning", text: "legacy" },
      { type: "reasoning", text: "both" },
      {
        type: "reasoning",
        text: "gemini",
        providerOptions: { openai: { reasoningEncryptedContent: "enc" } },
      },
      unsignedCall,
      openaiReasoning,
      text("answer"),
    ]);
    expect(stripped.metadata).toEqual(message.metadata);
    // The source row is never mutated: the original stays above the boundary.
    expect(message.parts[0]).toMatchObject({ providerOptions: { anthropic: { signature: "s" } } });
    expect(message.parts[2]).toMatchObject({ signature: "legacy-sig" });
    expect(message.parts[5]).toMatchObject({
      providerOptions: { google: { thoughtSignature: "g" } },
    });
  });

  it("leaves rows without prefix-bound replay data unchanged", () => {
    const openaiRow: MuxMessage = {
      id: "a2",
      role: "assistant",
      parts: [
        openaiReasoning,
        { type: "reasoning", text: "no replay data" },
        {
          type: "dynamic-tool",
          toolCallId: "call-2",
          toolName: "bash",
          state: "output-available",
          input: { script: "ls" },
          output: "README.md",
        },
        text("answer"),
      ],
    };
    expect(stripPrefixBoundReplayFromTailCopy(openaiRow)).toBe(openaiRow);
  });
});
