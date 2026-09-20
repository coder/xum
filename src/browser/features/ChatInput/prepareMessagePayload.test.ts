import { describe, expect, it } from "bun:test";
import type { HistoryEditPrecondition, SendMessageOptions } from "@/common/orpc/types";
import type { MuxMessageMetadata } from "@/common/types/message";
import { prepareMessagePayload } from "./prepareMessagePayload";

const model = "anthropic:claude-sonnet-4";
const options = { model, thinkingLevel: "off", agentId: "exec" } satisfies SendMessageOptions;
const prepare = (input = {}) =>
  prepareMessagePayload({
    messageText: "hello",
    messageTextForSend: "hello",
    attachments: [],
    reviewIds: [],
    agentSkillRefs: [],
    mcpPromptRefs: [],
    sendMessageOptions: options,
    policyModel: model,
    transferredDraftProjectDiscovery: false,
    additionalSystemContextHydrated: false,
    additionalSystemContext: { enabled: false, content: "" },
    ...input,
  });
const oneShot = {
  type: "model-oneshot",
  modelString: "anthropic:claude-opus-4-1",
  thinkingLevel: "high",
  message: "hello",
} as const;

describe("prepareMessagePayload", () => {
  it.each([
    ["normal message", {}, "hello", model, undefined],
    [
      "one-shot model",
      { messageText: "/opus+high hello", modelOneShot: oneShot },
      "hello",
      oneShot.modelString,
      undefined,
    ],
    ["empty edit attachments", { editMessageId: "message-1" }, "hello", model, 0],
  ])("prepares %s", (_name, input, message, effectiveModel, fileParts) => {
    const result = prepare(input);
    expect([result.message, result.effectiveModel, result.options.fileParts?.length]).toEqual([
      message,
      effectiveModel,
      fileParts,
    ]);
  });

  it.each([
    ["a normal send", {}, true],
    ["a one-shot model command", { messageText: "/opus+high hello", modelOneShot: oneShot }, false],
    [
      "a thinking-only one-shot command",
      {
        messageText: "/+2 hello",
        modelOneShot: { type: "model-oneshot", thinkingLevel: "2", message: "hello" } as const,
      },
      false,
    ],
  ])("keeps the Auto routing flag only for %s", (_name, input, expected) => {
    const result = prepare({
      ...input,
      sendMessageOptions: { ...options, autoModelRouting: true },
    });
    expect(result.options.autoModelRouting).toBe(expected);
  });

  it.each([
    ["normal", undefined, ["demo"]],
    [
      "compaction-request",
      {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {},
      } satisfies MuxMessageMetadata,
      undefined,
    ],
  ])("attaches skill refs to %s metadata only", (_name, baseMetadata, expectedSkills) => {
    const result = prepare({
      baseMetadata,
      agentSkillRefs: [{ skillName: "demo", scope: "project", source: "inline" }],
    });
    expect(result.options.muxMetadata?.agentSkillRefs?.map((ref) => ref.skillName)).toEqual(
      expectedSkills
    );
  });

  it("applies compaction, context, and dispatch overrides", () => {
    const result = prepare({
      compactionMessageText: "compact request",
      appendStagedNotice: false,
      compactionOptions: { model: "openai:gpt-5", additionalSystemInstructions: "compact" },
      additionalSystemContextHydrated: true,
      additionalSystemContext: { enabled: false, content: "ignored" },
      queueDispatchMode: "turn-end",
      goalInterventionPolicy: "pause",
    });
    expect([
      result.message,
      result.effectiveModel,
      result.options.model,
      result.options.additionalSystemInstructions,
      result.options.additionalSystemContext,
      result.options.queueDispatchMode,
      result.options.goalInterventionPolicy,
    ]).toEqual([
      "compact request",
      "openai:gpt-5",
      "openai:gpt-5",
      "compact",
      "",
      "turn-end",
      "pause",
    ]);
  });

  it("fences an edit with its precondition and never attaches one to a plain send", () => {
    const historyEditPrecondition: HistoryEditPrecondition = {
      editMessageId: "message-1",
      rangeStartMessageId: "message-1",
      rangeStartHistorySequence: 4,
      newestMessageId: "message-3",
      newestHistorySequence: 6,
      rangeRowCount: 3,
      rangeFingerprint: "cafebabe",
    };
    const edit = prepare({ editMessageId: "message-1", historyEditPrecondition });
    expect(edit.options.editMessageId).toBe("message-1");
    expect(edit.options.historyEditPrecondition).toBe(historyEditPrecondition);
    // A stale fence from a finished edit must not ride along on a normal send.
    const plain = prepare({ historyEditPrecondition });
    expect(plain.options.editMessageId).toBeUndefined();
    expect("historyEditPrecondition" in plain.options).toBe(false);
  });
});
