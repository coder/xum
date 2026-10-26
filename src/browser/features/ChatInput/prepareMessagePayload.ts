import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { ChatAttachment } from "./ChatAttachments";
import { chatAttachmentsToFileParts } from "@/browser/utils/attachmentsHandling";
import type { FilePart, HistoryEditPrecondition, SendMessageOptions } from "@/common/orpc/types";
import {
  prepareUserMessageForSend,
  type AgentSkillReference,
  type MCPPromptReference,
  type MuxMessageMetadata,
  type ReviewNoteDataForDisplay,
  withAgentSkillRefs,
  withMcpPromptRefs,
} from "@/common/types/message";
import { resolveThinkingInput } from "@/common/utils/thinking/policy";
import { appendStagedAttachmentNotice } from "./stagedAttachments";
import { hasProjectScopedSkillRef } from "./utils";
import type { GoalInterventionPolicy, QueueDispatchMode } from "./types";

type ModelOneShot = Extract<NonNullable<ParsedCommand>, { type: "model-oneshot" }>;

interface PrepareMessagePayloadInput {
  messageText: string;
  messageTextForSend: string;
  attachments: ChatAttachment[];
  fileParts?: FilePart[];
  reviews?: ReviewNoteDataForDisplay[];
  reviewIds: string[];
  editMessageId?: string;
  /** Required with editMessageId: the RPC refuses an unfenced UI edit. */
  historyEditPrecondition?: HistoryEditPrecondition;
  baseMetadata?: MuxMessageMetadata;
  agentSkillRefs: AgentSkillReference[];
  mcpPromptRefs: MCPPromptReference[];
  sendMessageOptions: SendMessageOptions;
  modelOneShot?: ModelOneShot | null;
  policyModel: string;
  transferredDraftProjectDiscovery: boolean;
  additionalSystemContextHydrated: boolean;
  additionalSystemContext: { enabled: boolean; content: string };
  goalInterventionPolicy?: GoalInterventionPolicy;
  queueDispatchMode?: QueueDispatchMode;
}

interface PreparedMessagePayload {
  message: string;
  // The schema leaves muxMetadata untyped (z.any()); narrow it at this seam.
  options: Omit<SendMessageOptions, "muxMetadata"> & {
    fileParts?: FilePart[];
    muxMetadata?: MuxMessageMetadata;
  };
  effectiveModel: string;
  sentReviewIds: string[];
}

export function prepareMessagePayload(input: PrepareMessagePayloadInput): PreparedMessagePayload {
  const fileParts =
    input.fileParts ?? chatAttachmentsToFileParts(input.attachments, { validate: true });
  const sendFileParts = input.editMessageId
    ? fileParts
    : fileParts.length > 0
      ? fileParts
      : undefined;
  let metadata = input.baseMetadata;
  if (input.agentSkillRefs.length > 0) {
    metadata = withAgentSkillRefs(metadata, input.agentSkillRefs);
  }
  if (input.mcpPromptRefs.length > 0) {
    metadata = withMcpPromptRefs(metadata, input.mcpPromptRefs);
  }

  const userMessageText = appendStagedAttachmentNotice(input.messageTextForSend, input.attachments);
  const prepared = prepareUserMessageForSend(
    { text: userMessageText, reviews: input.reviews },
    metadata
  );
  const effectiveModel = input.modelOneShot?.modelString ?? input.sendMessageOptions.model;
  const trimmedMessageText = input.messageText.trim();
  const commandPrefix = input.modelOneShot
    ? trimmedMessageText
        .slice(0, trimmedMessageText.length - input.modelOneShot.message.length)
        .trimEnd()
    : undefined;
  const rawCommand = commandPrefix
    ? appendStagedAttachmentNotice(trimmedMessageText, input.attachments)
    : undefined;
  metadata = {
    ...(prepared.metadata ?? { type: "normal" }),
    requestedModel: effectiveModel,
    ...(rawCommand ? { rawCommand, commandPrefix } : {}),
  };

  const rawThinkingOverride = input.modelOneShot?.thinkingLevel;
  const thinkingOverride =
    rawThinkingOverride != null
      ? resolveThinkingInput(rawThinkingOverride, input.policyModel)
      : undefined;

  return {
    message: prepared.finalText,
    effectiveModel,
    sentReviewIds: input.reviewIds,
    options: {
      ...input.sendMessageOptions,
      ...(input.transferredDraftProjectDiscovery && hasProjectScopedSkillRef(input.agentSkillRefs)
        ? { disableWorkspaceAgents: true }
        : {}),
      ...(input.modelOneShot?.modelString ? { model: input.modelOneShot.modelString } : {}),
      ...(thinkingOverride ? { thinkingLevel: thinkingOverride } : {}),
      // A one-shot command is the user's explicit choice for this turn, per dimension: a
      // model one-shot pins the model and a thinking override pins the level, so a
      // thinking-only command (`/+2 hello`) leaves model Auto routing the turn.
      ...(input.modelOneShot ? { skipAiSettingsPersistence: true } : {}),
      ...(input.modelOneShot?.modelString ? { autoModelRouting: false } : {}),
      ...(thinkingOverride ? { autoThinkingLevel: false } : {}),
      ...(input.goalInterventionPolicy
        ? { goalInterventionPolicy: input.goalInterventionPolicy }
        : {}),
      ...(input.queueDispatchMode ? { queueDispatchMode: input.queueDispatchMode } : {}),
      ...(input.additionalSystemContextHydrated
        ? {
            additionalSystemContext: input.additionalSystemContext.enabled
              ? input.additionalSystemContext.content
              : "",
          }
        : {}),
      editMessageId: input.editMessageId,
      ...(input.editMessageId && input.historyEditPrecondition
        ? { historyEditPrecondition: input.historyEditPrecondition }
        : {}),
      fileParts: sendFileParts,
      muxMetadata: metadata,
      // Reviews were formatted into `message`; keep the authored text (with any staged-file
      // notice) for queue restores and held-input previews of this send.
      ...(input.reviews?.length ? { authoredText: userMessageText } : {}),
    },
  };
}
