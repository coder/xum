import { describe, expect, it } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { prepareMessagePayload } from "./prepareMessagePayload";

const baseOptions = { model: "anthropic:claude-sonnet-4", thinkingLevel: "off", agentId: "exec" } satisfies SendMessageOptions;

const baseInput = {
  messageText: "hello",
  messageTextForSend: "hello",
  attachments: [],
  reviewIds: [],
  agentSkillRefs: [],
  mcpPromptRefs: [],
  sendMessageOptions: baseOptions,
  policyModel: baseOptions.model,
  transferredDraftProjectDiscovery: false,
  additionalSystemContextHydrated: false,
  additionalSystemContext: { enabled: false, content: "" },
};

describe("prepareMessagePayload", () => {
  it.each([
    {
      name: "normal message",
      input: {},
      expected: {
        message: "hello",
        effectiveModel: baseOptions.model,
        filePartCount: undefined,
      },
    },
    {
      name: "one-shot model",
      input: {
        messageText: "/opus+high hello",
        modelOneShot: {
          type: "model-oneshot" as const,
          modelString: "anthropic:claude-opus-4-1",
          thinkingLevel: "high" as const,
          message: "hello",
        },
      },
      expected: {
        message: "hello",
        effectiveModel: "anthropic:claude-opus-4-1",
        filePartCount: undefined,
      },
    },
    {
      name: "empty edit attachments",
      input: { editMessageId: "message-1" },
      expected: {
        message: "hello",
        effectiveModel: baseOptions.model,
        filePartCount: 0,
      },
    },
  ])("prepares $name", ({ input, expected }) => {
    const result = prepareMessagePayload({ ...baseInput, ...input });
    expect(result.message).toBe(expected.message);
    expect(result.effectiveModel).toBe(expected.effectiveModel);
    expect(result.options.fileParts?.length).toBe(expected.filePartCount);
  });

  it("applies compaction, context, and dispatch overrides", () => {
    const result = prepareMessagePayload({
      ...baseInput,
      compactionMessageText: "compact request",
      appendStagedNotice: false,
      compactionOptions: { model: "openai:gpt-5", additionalSystemInstructions: "compact" },
      additionalSystemContextHydrated: true,
      additionalSystemContext: { enabled: false, content: "ignored" },
      queueDispatchMode: "turn-end",
      goalInterventionPolicy: "pause",
    });

    expect(result.message).toBe("compact request");
    expect(result.effectiveModel).toBe("openai:gpt-5");
    expect(result.options).toMatchObject({
      model: "openai:gpt-5",
      additionalSystemInstructions: "compact",
      additionalSystemContext: "",
      queueDispatchMode: "turn-end",
      goalInterventionPolicy: "pause",
    });
  });
});
