import { describe, expect, it } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { prepareMessagePayload } from "./prepareMessagePayload";

const model = "anthropic:claude-sonnet-4";
const baseOptions = { model, thinkingLevel: "off", agentId: "exec" } satisfies SendMessageOptions;
const baseInput = {
  ...{ messageText: "hello", messageTextForSend: "hello" },
  ...{ attachments: [], reviewIds: [], agentSkillRefs: [], mcpPromptRefs: [] },
  sendMessageOptions: baseOptions,
  policyModel: model,
  ...{ transferredDraftProjectDiscovery: false, additionalSystemContextHydrated: false },
  additionalSystemContext: { enabled: false, content: "" },
};
const prepare = (input = {}) => prepareMessagePayload({ ...baseInput, ...input });
const oneShot = {
  type: "model-oneshot",
  modelString: "anthropic:claude-opus-4-1",
  thinkingLevel: "high",
  message: "hello",
} as const;

describe("prepareMessagePayload", () => {
  it.each([
    ["normal message", {}, "hello", baseOptions.model, undefined],
    [
      "one-shot model",
      { messageText: "/opus+high hello", modelOneShot: oneShot },
      "hello",
      oneShot.modelString,
      undefined,
    ],
    ["empty edit attachments", { editMessageId: "message-1" }, "hello", baseOptions.model, 0],
  ])("prepares %s", (_name, input, message, model, filePartCount) => {
    const result = prepare(input);
    expect(result.message).toBe(message);
    expect(result.effectiveModel).toBe(model);
    expect(result.options.fileParts?.length).toBe(filePartCount);
  });

  it("applies compaction, context, and dispatch overrides", () => {
    expect(
      prepare({
        compactionMessageText: "compact request",
        appendStagedNotice: false,
        compactionOptions: { model: "openai:gpt-5", additionalSystemInstructions: "compact" },
        additionalSystemContextHydrated: true,
        additionalSystemContext: { enabled: false, content: "ignored" },
        queueDispatchMode: "turn-end",
        goalInterventionPolicy: "pause",
      })
    ).toMatchObject({
      message: "compact request",
      effectiveModel: "openai:gpt-5",
      options: {
        model: "openai:gpt-5",
        additionalSystemInstructions: "compact",
        additionalSystemContext: "",
        queueDispatchMode: "turn-end",
        goalInterventionPolicy: "pause",
      },
    });
  });
});
