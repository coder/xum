import type { LoadedSkillSnapshot, PostCompactionAttachment } from "@/common/types/attachment";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import {
  postCompactionContextMessageId,
  type MuxMessage,
  type PostCompactionContext,
} from "@/common/types/message";
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
  attachments: PostCompactionAttachment[]
): PostCompactionContext | null {
  const text = renderAttachmentsToContentWithBudget(attachments, {
    maxChars: MAX_POST_COMPACTION_INJECTION_CHARS,
  });
  return text.length > 0 ? { text, skillNames: loadedSnapshotSkillNames(attachments) } : null;
}

/** The header of a compaction boundary row; a malformed persisted value counts as none. */
function readPostCompactionContext(message: MuxMessage): PostCompactionContext | null {
  if (!isDurableCompactionBoundaryMarker(message)) return null;
  const context: unknown = message.metadata?.postCompactionContext;
  if (typeof context !== "object" || context === null) return null;
  const { text, skillNames } = context as Partial<Record<keyof PostCompactionContext, unknown>>;
  if (typeof text !== "string" || text.length === 0) return null;
  return {
    text,
    skillNames: Array.isArray(skillNames)
      ? skillNames.filter((name): name is string => typeof name === "string")
      : [],
  };
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

/** Whether the latest boundary's header carries the plan file. */
export function postCompactionContextCarriesPlan(messages: readonly MuxMessage[]): boolean {
  const context = findPostCompactionContext(messages);
  return context != null && rendersPlanFileReference(context.text);
}

/** The id of the latest context boundary when its header renders into the request. */
export function findPostCompactionContextBoundaryId(
  messages: readonly MuxMessage[]
): string | undefined {
  const boundary = messages.findLast(isDurableContextBoundaryMarker);
  return boundary && readPostCompactionContext(boundary) ? boundary.id : undefined;
}

/**
 * Remove the header from one boundary row of a request copy. chat.jsonl keeps the header; only
 * the requests of this session leave it out (see the context-exceeded retry in AgentSession).
 */
export function omitPostCompactionContext(
  messages: MuxMessage[],
  boundaryId: string | undefined
): MuxMessage[] {
  if (boundaryId == null) return messages;
  return messages.map((message) =>
    message.id === boundaryId ? splitPostCompactionContext(message).boundary : message
  );
}

/** Split a boundary row into the row without its header and the header (null without one). */
export function splitPostCompactionContext(boundary: MuxMessage): {
  boundary: MuxMessage;
  context: PostCompactionContext | null;
} {
  if (boundary.metadata?.postCompactionContext == null) return { boundary, context: null };
  const { postCompactionContext: context, ...metadata } = boundary.metadata;
  return { boundary: { ...boundary, metadata }, context };
}

/**
 * Set the header on a boundary that has none. The summary is worth more than the header, so a
 * header that would push the row over the history line limit is dropped, not the summary cut.
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
  if (rowBytes > SESSION_HISTORY_MAX_LINE_BYTES - COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES) {
    log.warn("Post-compaction context does not fit the boundary row; dropping it", {
      workspaceId,
      messageId: boundary.id,
      rowBytes,
    });
    return boundary;
  }
  return withContext;
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
