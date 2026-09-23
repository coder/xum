import { describe, expect, test } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import type { MuxMessage, MuxReasoningPart } from "@/common/types/message";
import {
  attachReasoningReplayMetadata,
  findFirstReasoningPartIndexInTrailingRun,
  mergeReasoningProviderOptions,
  reasoningProviderOptionsFromMetadata,
  stripOpenAIReasoningReplay,
} from "./reasoningProviderOptions";

describe("reasoningProviderOptionsFromMetadata", () => {
  test("maps Anthropic signatures", () => {
    expect(reasoningProviderOptionsFromMetadata({ anthropic: { signature: "sig_abc" } })).toEqual({
      anthropic: { signature: "sig_abc" },
    });
  });

  test("maps xAI encrypted reasoning used for ZDR multi-turn quality", () => {
    expect(
      reasoningProviderOptionsFromMetadata({
        xai: {
          itemId: "rs_1",
          reasoningEncryptedContent: "enc_blob",
        },
      })
    ).toEqual({
      xai: {
        itemId: "rs_1",
        reasoningEncryptedContent: "enc_blob",
      },
    });
  });

  test("maps OpenAI encrypted reasoning the same way", () => {
    expect(
      reasoningProviderOptionsFromMetadata({
        openai: {
          itemId: "rs_oai",
          reasoningEncryptedContent: "enc_oai",
        },
      })
    ).toEqual({
      openai: {
        itemId: "rs_oai",
        reasoningEncryptedContent: "enc_oai",
      },
    });
  });

  test("maps Google thought signatures", () => {
    expect(reasoningProviderOptionsFromMetadata({ google: { thoughtSignature: "ts_1" } })).toEqual({
      google: { thoughtSignature: "ts_1" },
    });
  });

  test("returns undefined when metadata is empty", () => {
    expect(reasoningProviderOptionsFromMetadata(undefined)).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({})).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({ xai: {} })).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({ google: {} })).toBeUndefined();
  });
});

describe("mergeReasoningProviderOptions", () => {
  test("merges itemId from start with encrypted content from end", () => {
    expect(
      mergeReasoningProviderOptions(
        { xai: { itemId: "rs_1" } },
        { xai: { reasoningEncryptedContent: "enc_blob" } }
      )
    ).toEqual({
      xai: {
        itemId: "rs_1",
        reasoningEncryptedContent: "enc_blob",
      },
    });
  });
});

describe("attachReasoningReplayMetadata", () => {
  function assistantMessage(parts: MuxMessage["parts"]): MuxMessage {
    return { id: "a1", role: "assistant", metadata: { timestamp: 1 }, parts };
  }

  function reasoningParts(message: MuxMessage): Array<MuxReasoningPart & Record<string, unknown>> {
    return message.parts.filter(
      (part): part is MuxReasoningPart & Record<string, unknown> => part.type === "reasoning"
    );
  }

  test("replays complete OpenAI reasoning by encrypted content only, never by itemId", () => {
    // With the SDK's default store=true, an itemId becomes a server-side
    // `item_reference` that is unresolvable after a route/credential change and
    // fails every later request. The encrypted blob is self-contained.
    const part: MuxReasoningPart = {
      type: "reasoning",
      text: "thinking",
      providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
    };
    const input = assistantMessage([part]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      openai: { reasoningEncryptedContent: "enc" },
    });
    // Request-only: the persisted part keeps its itemId for debugging/downgrade.
    expect(part.providerOptions).toEqual({
      openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
    });
  });

  test("keeps the xAI itemId alongside encrypted content (scope pin)", () => {
    const input = assistantMessage([
      {
        type: "reasoning",
        text: "thinking",
        providerOptions: { xai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
      },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      xai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
    });
  });

  test("bridges the legacy top-level signature field from old histories", () => {
    const input = assistantMessage([{ type: "reasoning", text: "old", signature: "legacy_sig" }]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      anthropic: { signature: "legacy_sig" },
    });
  });

  test("providerOptions wins over the legacy signature on conflict", () => {
    const input = assistantMessage([
      {
        type: "reasoning",
        text: "both",
        signature: "stale_sig",
        providerOptions: { anthropic: { signature: "fresh_sig" } },
      },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      anthropic: { signature: "fresh_sig" },
    });
  });

  test("leaves messages without replay data untouched (same reference)", () => {
    const noReplay = assistantMessage([
      { type: "reasoning", text: "unsigned" },
      { type: "text", text: "answer" },
    ]);
    const user: MuxMessage = {
      id: "u1",
      role: "user",
      metadata: { timestamp: 0 },
      parts: [{ type: "text", text: "hi" }],
    };

    const output = attachReasoningReplayMetadata([user, noReplay]);

    expect(output[0]).toBe(user);
    expect(output[1]).toBe(noReplay);
  });

  test("drops a malformed non-string legacy signature instead of forwarding it", () => {
    const input = assistantMessage([
      { type: "reasoning", text: "corrupt", signature: 12345 as unknown as string },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(output).toBe(input);
    expect("providerMetadata" in reasoningParts(output)[0]).toBe(false);
  });

  test("drops malformed providerOptions fields while keeping valid siblings", () => {
    const input = assistantMessage([
      {
        type: "reasoning",
        text: "partially corrupt",
        providerOptions: {
          anthropic: "not-an-object",
          openai: { itemId: 42, reasoningEncryptedContent: "enc_ok" },
          // Malformed encrypted content leaves a bare xai itemId, which the
          // store=false drop rule then removes as unresolvable.
          xai: { itemId: "rs_ok", reasoningEncryptedContent: { nested: true } },
          google: { thoughtSignature: "" },
        } as unknown as MuxReasoningPart["providerOptions"],
      },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      openai: { reasoningEncryptedContent: "enc_ok" },
    });
  });

  test("drops a bare xAI itemId left behind by an interrupted stream", () => {
    // store=false means the server never kept the item; replaying the bare
    // reference would fail every subsequent request.
    const input = assistantMessage([
      { type: "reasoning", text: "cut off", providerOptions: { xai: { itemId: "rs_partial" } } },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(output).toBe(input);
    expect("providerMetadata" in reasoningParts(output)[0]).toBe(false);
  });

  test("drops a bare OpenAI itemId left behind by an interrupted stream (ZDR)", () => {
    const input = assistantMessage([
      { type: "reasoning", text: "cut off", providerOptions: { openai: { itemId: "rs_partial" } } },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(output).toBe(input);
    expect("providerMetadata" in reasoningParts(output)[0]).toBe(false);
  });

  test("keeps complete xAI replay metadata and other namespaces alongside a dropped bare itemId", () => {
    const input = assistantMessage([
      {
        type: "reasoning",
        text: "mixed",
        providerOptions: {
          xai: { itemId: "rs_partial" },
          anthropic: { signature: "sig_keep" },
        },
      },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      anthropic: { signature: "sig_keep" },
    });
  });

  test("does not mutate the input parts", () => {
    const part: MuxReasoningPart = {
      type: "reasoning",
      text: "thinking",
      providerOptions: { anthropic: { signature: "sig" } },
    };
    const input = assistantMessage([part]);

    attachReasoningReplayMetadata([input]);

    expect("providerMetadata" in part).toBe(false);
  });
});

describe("stripOpenAIReasoningReplay", () => {
  // Persisted history replay (encrypted content only, bridged by
  // attachReasoningReplayMetadata) and same-turn SDK step messages (itemId +
  // encrypted content copied from providerMetadata) are both OpenAI replay.
  const historyReasoning = {
    type: "reasoning" as const,
    text: "earlier thinking",
    providerOptions: { openai: { reasoningEncryptedContent: "gAAA-stale" } },
  };
  const stepReasoning = {
    type: "reasoning" as const,
    text: "step thinking",
    providerOptions: { openai: { itemId: "rs_stale", reasoningEncryptedContent: "gAAA-step" } },
  };
  const xaiReasoning = {
    type: "reasoning" as const,
    text: "grok thinking",
    providerOptions: { xai: { itemId: "rs_grok", reasoningEncryptedContent: "xai-blob" } },
  };
  const anthropicReasoning = {
    type: "reasoning" as const,
    text: "claude thinking",
    providerOptions: { anthropic: { signature: "sig" } },
  };

  test("removes only OpenAI reasoning parts and keeps text and tool parts in place", () => {
    const toolCall = {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "bash",
      input: { script: "pwd" },
    };
    const toolMessage: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          output: { type: "text", value: "/tmp" },
        },
      ],
    };
    const input: ModelMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: [historyReasoning, { type: "text", text: "earlier answer" }] },
      { role: "user", content: "now" },
      { role: "assistant", content: [stepReasoning, toolCall] },
      toolMessage,
    ];
    const snapshot = structuredClone(input);

    const stripped = stripOpenAIReasoningReplay(input);

    expect(stripped).toEqual([
      { role: "user", content: "earlier" },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      { role: "user", content: "now" },
      { role: "assistant", content: [toolCall] },
      toolMessage,
    ]);
    // Untouched rows keep their identity; only rewritten assistants are copies.
    expect(stripped[0]).toBe(input[0]);
    expect(stripped[2]).toBe(input[2]);
    expect(stripped[4]).toBe(input[4]);
    expect(input).toEqual(snapshot);
  });

  test("preserves string assistants, other providers' reasoning, and pre-existing empty content", () => {
    const stringAssistant: ModelMessage = { role: "assistant", content: "plain answer" };
    const otherProviders: AssistantModelMessage = {
      role: "assistant",
      content: [xaiReasoning, anthropicReasoning, { type: "text", text: "kept" }],
    };
    const alreadyEmpty: AssistantModelMessage = { role: "assistant", content: [] };
    const input: ModelMessage[] = [stringAssistant, otherProviders, alreadyEmpty];

    const stripped = stripOpenAIReasoningReplay(input);

    expect(stripped).toBe(input);
    expect(stripped[1]).toBe(otherProviders);
  });

  test("drops assistants emptied by the removal but nothing else", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: [historyReasoning] },
      { role: "user", content: "follow-up" },
    ];

    expect(stripOpenAIReasoningReplay(input)).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "follow-up" },
    ]);
  });
});

describe("findFirstReasoningPartIndexInTrailingRun", () => {
  test("returns the first reasoning part in a trailing run of deltas", () => {
    const parts = [
      { type: "text" },
      { type: "reasoning" },
      { type: "reasoning" },
      { type: "reasoning" },
    ];
    expect(findFirstReasoningPartIndexInTrailingRun(parts)).toBe(1);
  });

  test("returns -1 when the trailing part is not reasoning", () => {
    expect(
      findFirstReasoningPartIndexInTrailingRun([{ type: "reasoning" }, { type: "text" }])
    ).toBe(-1);
  });
});
