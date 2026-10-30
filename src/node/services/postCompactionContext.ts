import type { LoadedSkillSnapshot, PostCompactionAttachment } from "@/common/types/attachment";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import {
  postCompactionContextMessageId,
  type MuxMessage,
  type PostCompactionContext,
  type PostCompactionPlan,
} from "@/common/types/message";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { readStringArray } from "@/common/utils/readStringArray";
import { MAX_POST_COMPACTION_INJECTION_CHARS } from "@/common/constants/attachments";
import {
  COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
} from "@/common/constants/contextBudget";
import {
  renderAttachmentsToContentWithBudget,
  rendersPlanFileReference,
} from "@/browser/utils/messages/attachmentRenderer";
import {
  isDurableCompactionBoundaryMarker,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { loadedSnapshotSkillNames } from "./agentSkills/pathSkillActivation";
import { measurePersistedHistoryRowBytes } from "./historyRowBudget";
import { log } from "./log";

/** What compaction knows when it builds a boundary's header. */
export interface PostCompactionContextInput {
  diffs: FileEditDiff[];
  loadedSkills: LoadedSkillSnapshot[];
  /** All tracked reads; the builder decides whether the model sees them. */
  readFilePaths: string[];
  /** Reports completed before the boundary: their tool results are in the summary now. */
  reportsCompletedBeforeMs: number;
}

/**
 * Render post-compaction attachments once, when compaction writes the boundary. The boundary row
 * keeps the rendered text, not the attachments: the text has a fixed size limit, and a later
 * renderer change cannot alter the bytes that earlier requests sent.
 */
export function renderPostCompactionContext(
  attachments: PostCompactionAttachment[],
  plan: PostCompactionPlan | null
): PostCompactionContext | null {
  const text = renderAttachmentsToContentWithBudget(attachments, {
    maxChars: MAX_POST_COMPACTION_INJECTION_CHARS,
  });
  if (text.length === 0) return null;
  const context = { text, skillNames: loadedSnapshotSkillNames(attachments) };
  // The budget can leave the plan out of the text; then the window has no plan to track.
  return plan && rendersPlanFileReference(text) ? { ...context, plan } : context;
}

function readPostCompactionPlan(plan: unknown): PostCompactionPlan | undefined {
  if (!isPlainObject(plan)) return undefined;
  const { path, content, modifiedTimeMs } = plan;
  return typeof path === "string" &&
    typeof content === "string" &&
    typeof modifiedTimeMs === "number" &&
    Number.isFinite(modifiedTimeMs)
    ? { path, content, modifiedTimeMs }
    : undefined;
}

/**
 * The header of a compaction boundary row, also when requests leave it out; a malformed
 * persisted value counts as none.
 */
function readPersistedPostCompactionContext(message: MuxMessage): PostCompactionContext | null {
  if (!isDurableCompactionBoundaryMarker(message)) return null;
  const context: unknown = message.metadata?.postCompactionContext;
  if (!isPlainObject(context)) return null;
  const { text, skillNames, omittedFromRequestSequence, plan } = context;
  if (typeof text !== "string" || text.length === 0) return null;
  const parsedPlan = readPostCompactionPlan(plan);
  return {
    text,
    skillNames: readStringArray(skillNames),
    ...(isNonNegativeInteger(omittedFromRequestSequence) ? { omittedFromRequestSequence } : {}),
    ...(parsedPlan ? { plan: parsedPlan } : {}),
  };
}

/** The header that new requests render after a boundary row; null once a retry left it out. */
function readPostCompactionContext(message: MuxMessage): PostCompactionContext | null {
  const context = readPersistedPostCompactionContext(message);
  return context?.omittedFromRequestSequence == null ? context : null;
}

/** The header of the latest context boundary, if that boundary is a compaction with one. */
export function findPostCompactionContext(
  messages: readonly MuxMessage[]
): PostCompactionContext | null {
  const boundary = messages.findLast(isDurableContextBoundaryMarker);
  return boundary ? readPostCompactionContext(boundary) : null;
}

/** Skills that the latest boundary's header loads into every request of its window. */
export function findPostCompactionContextSkillNames(messages: readonly MuxMessage[]): string[] {
  return findPostCompactionContext(messages)?.skillNames ?? [];
}

/** The plan that the latest boundary's header shows the model, if any. */
export function findPostCompactionPlan(
  messages: readonly MuxMessage[]
): PostCompactionPlan | undefined {
  return findPostCompactionContext(messages)?.plan;
}

/** The id of the latest context boundary when its header renders into the request. */
export function findPostCompactionContextBoundaryId(
  messages: readonly MuxMessage[]
): string | undefined {
  const boundary = messages.findLast(isDurableContextBoundaryMarker);
  return boundary && readPostCompactionContext(boundary) ? boundary.id : undefined;
}

/**
 * The boundary row with its header left out of requests from this sequence on, for the
 * context-exceeded retry in AgentSession. The row keeps the header, so replay can rebuild the
 * earlier requests. Null when requests do not render a header for the row.
 */
export function omitPostCompactionContextFrom(
  boundary: MuxMessage,
  requestHistorySequence: number
): MuxMessage | null {
  const context = readPostCompactionContext(boundary);
  if (!context) return null;
  return {
    ...boundary,
    metadata: {
      ...boundary.metadata,
      postCompactionContext: { ...context, omittedFromRequestSequence: requestHistorySequence },
    },
  };
}

/**
 * Replay: the history as a request at this sequence saw it. A header that a retry left out
 * still rendered into the requests before that retry.
 */
export function restorePostCompactionContextBefore(
  messages: MuxMessage[],
  requestHistorySequence: number
): MuxMessage[] {
  const index = messages.findLastIndex(isDurableContextBoundaryMarker);
  if (index === -1) return messages;
  const context = readPersistedPostCompactionContext(messages[index]);
  if (
    context?.omittedFromRequestSequence == null ||
    requestHistorySequence >= context.omittedFromRequestSequence
  )
    return messages;
  const { omittedFromRequestSequence: _omitted, ...restored } = context;
  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? { ...message, metadata: { ...message.metadata, postCompactionContext: restored } }
      : message
  );
}

/**
 * Set the header on a boundary that has none. The summary is worth more than the header, so a
 * header that would push the row over the history line limit is dropped, not the summary cut.
 * The header keeps its plan baseline or is dropped with it: a plan in the header that nothing
 * tracks would replay stale after the user edits the file.
 */
export function withPostCompactionContext(
  boundary: MuxMessage,
  context: PostCompactionContext | null,
  workspaceId: string
): MuxMessage {
  if (!context || boundary.metadata?.postCompactionContext) return boundary;
  const withContext: MuxMessage = {
    ...boundary,
    metadata: { ...boundary.metadata, postCompactionContext: context },
  };
  const rowBytes = measurePersistedHistoryRowBytes(withContext, workspaceId);
  if (rowBytes <= SESSION_HISTORY_MAX_LINE_BYTES - COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES) {
    return withContext;
  }
  log.warn("Post-compaction context does not fit the boundary row; dropping it", {
    workspaceId,
    messageId: boundary.id,
    rowBytes,
    withPlan: context.plan != null,
  });
  return boundary;
}

function createPostCompactionContextMessage(
  boundary: Pick<MuxMessage, "id" | "metadata">,
  context: PostCompactionContext
): MuxMessage {
  return {
    id: postCompactionContextMessageId(boundary.id),
    role: "user",
    parts: [{ type: "text", text: context.text }],
    // No historySequence: the row is not in chat.jsonl, so it gets no [id: ...] tag.
    metadata: { timestamp: boundary.metadata?.timestamp, synthetic: true },
  };
}

/** Tokens the header adds to a request (0 without one). */
export function estimatePostCompactionContextTokens(
  context: PostCompactionContext | null | undefined
): number {
  return context
    ? estimateMuxMessageTokens(createPostCompactionContextMessage({ id: "estimate" }, context))
    : 0;
}

/**
 * Insert the latest context boundary's header as a synthetic user row right after the
 * boundary. The header is fixed for the life of the boundary, so every turn, step and
 * compaction request of the window builds the same bytes at the same place, and the cached
 * prefix after the summary stays valid.
 */
export function insertPostCompactionContext(messages: MuxMessage[]): MuxMessage[] {
  const index = messages.findLastIndex(isDurableContextBoundaryMarker);
  if (index === -1) return messages;
  const boundary = messages[index];
  const context = readPostCompactionContext(boundary);
  if (!context) return messages;
  return [
    ...messages.slice(0, index + 1),
    createPostCompactionContextMessage(boundary, context),
    ...messages.slice(index + 1),
  ];
}
