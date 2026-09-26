import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { ChatAttachment } from "./ChatAttachments";
import { chatAttachmentsToFileParts } from "@/browser/utils/attachmentsHandling";
import type {
  FilePart,
  HistoryEditPrecondition,
  ProvidersConfigMap,
  SendMessageOptions,
} from "@/common/orpc/types";
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

/** Per-turn overrides for `/<model>[+level] message`, shared by workspace and creation sends. */
export function getModelOneShotOverrides(
  modelOneShot: ModelOneShot,
  messageText: string,
  attachments: ChatAttachment[],
  policyModel: string,
  // Resolves mapped model aliases so numeric levels index the real thinking ladder.
  providersConfig: ProvidersConfigMap | null
) {
  const trimmedMessageText = messageText.trim();
  const commandPrefix = trimmedMessageText
    .slice(0, trimmedMessageText.length - modelOneShot.message.length)
    .trimEnd();
  const thinkingLevel =
    modelOneShot.thinkingLevel != null
      ? resolveThinkingInput(modelOneShot.thinkingLevel, policyModel, providersConfig)
      : undefined;
  return {
    // rawCommand keeps the typed command for transcript display and draft restoration.
    metadata: {
      rawCommand: appendStagedAttachmentNotice(trimmedMessageText, attachments),
      commandPrefix,
    },
    // A one-shot command is the user's explicit choice for this turn, per dimension: a
    // model one-shot pins the model and a thinking override pins the level, so a
    // thinking-only command (`/+2 hello`) leaves model Auto routing the turn.
    options: {
      skipAiSettingsPersistence: true,
      ...(modelOneShot.modelString
        ? { model: modelOneShot.modelString, autoModelRouting: false }
        : {}),
      ...(thinkingLevel ? { thinkingLevel, autoThinkingLevel: false } : {}),
    } satisfies Partial<SendMessageOptions>,
  };
}

type ModelOneShotOverrides = ReturnType<typeof getModelOneShotOverrides>;

interface PrepareMessagePayloadInput {
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
  compactionOptions?: Partial<SendMessageOptions>;
  compactionMessageText?: string;
  appendStagedNotice?: boolean;
  oneShot?: ModelOneShotOverrides;
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
  // Refs on a compaction request would make the summarization turn materialize
  // skill snapshots; the caller carries them on the compaction follow-up instead.
  if (metadata?.type !== "compaction-request") {
    if (input.agentSkillRefs.length > 0) {
      metadata = withAgentSkillRefs(metadata, input.agentSkillRefs);
    }
    if (input.mcpPromptRefs.length > 0) {
      metadata = withMcpPromptRefs(metadata, input.mcpPromptRefs);
    }
  }

  const actualMessageText = input.compactionMessageText ?? input.messageTextForSend;
  const userMessageText =
    input.appendStagedNotice === false
      ? actualMessageText
      : appendStagedAttachmentNotice(actualMessageText, input.attachments);
  const prepared = prepareUserMessageForSend(
    { text: userMessageText, reviews: input.reviews },
    metadata
  );
  const compactionOptions = input.compactionOptions ?? {};
  const additionalSystemInstructions =
    compactionOptions.additionalSystemInstructions ??
    input.sendMessageOptions.additionalSystemInstructions;
  const effectiveModel =
    input.oneShot?.options.model ?? compactionOptions.model ?? input.sendMessageOptions.model;
  metadata = {
    ...(prepared.metadata ?? { type: "normal" }),
    requestedModel: effectiveModel,
    ...input.oneShot?.metadata,
  };

  return {
    message: prepared.finalText,
    effectiveModel,
    sentReviewIds: input.reviewIds,
    options: {
      ...input.sendMessageOptions,
      ...compactionOptions,
      ...(input.transferredDraftProjectDiscovery && hasProjectScopedSkillRef(input.agentSkillRefs)
        ? { disableWorkspaceAgents: true }
        : {}),
      ...input.oneShot?.options,
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
      additionalSystemInstructions,
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
