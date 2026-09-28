import {
  DraftAttachmentSchema,
  type Draft,
  type DraftAttachment,
  type DraftAttachmentMetadata,
  type DraftScope,
  type DraftSummary,
} from "@/common/orpc/schemas/drafts";
import { MAX_DRAFT_JSON_CHARS } from "@/constants/drafts";

/** Stable map key for a draft scope (creation keys are unambiguous for any project path). */
export function draftScopeKey(scope: DraftScope): string {
  return scope.kind === "workspace"
    ? `workspace:${scope.workspaceId}`
    : `creation:${JSON.stringify([scope.projectPath, scope.draftId])}`;
}

export function createEmptyDraft(): Draft {
  return { text: "", attachments: [] };
}

/** An empty draft has no file on the backend: writing one deletes it. */
export function isDraftEmpty(draft: Draft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

/** JSON size of a draft, compared against MAX_DRAFT_JSON_CHARS. */
export function draftJsonChars(draft: Draft): number {
  return JSON.stringify({ text: draft.text, attachments: draft.attachments }).length;
}

/** The save error for a draft over MAX_DRAFT_JSON_CHARS (shown by the composer as a toast). */
export function draftTooLargeMessage(chars: number): string {
  const toMb = (value: number) => Math.ceil(value / (1024 * 1024));
  return `Draft is too large to save (${toMb(chars)} MB; the limit is ${toMb(MAX_DRAFT_JSON_CHARS)} MB). Remove an attachment.`;
}

/**
 * Keep the well-formed attachments and count the rest. Never throws: used on untrusted input (a
 * hand-edited or truncated draft file, a legacy localStorage value). Legacy provider entries
 * written before attachments had a `kind` are read as provider attachments.
 */
export function sanitizeDraftAttachments(raw: unknown): {
  attachments: DraftAttachment[];
  droppedEntries: number;
} {
  if (!Array.isArray(raw)) {
    return { attachments: [], droppedEntries: raw === undefined || raw === null ? 0 : 1 };
  }
  const attachments: DraftAttachment[] = [];
  let droppedEntries = 0;
  for (const item of raw as unknown[]) {
    const candidate =
      typeof item === "object" && item !== null && !("kind" in item)
        ? { ...item, kind: "provider" }
        : item;
    const parsed = DraftAttachmentSchema.safeParse(candidate);
    if (parsed.success) {
      attachments.push(parsed.data);
    } else {
      droppedEntries++;
    }
  }
  return { attachments, droppedEntries };
}

/** Sanitize a parsed draft file or legacy payload; malformed parts are dropped and counted. */
export function sanitizeDraft(raw: unknown): { draft: Draft; droppedEntries: number } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { draft: createEmptyDraft(), droppedEntries: raw === undefined ? 0 : 1 };
  }
  const record = raw as Record<string, unknown>;
  const textValid = typeof record.text === "string";
  const { attachments, droppedEntries } = sanitizeDraftAttachments(record.attachments);
  return {
    draft: { text: textValid ? (record.text as string) : "", attachments },
    droppedEntries: droppedEntries + (textValid || record.text === undefined ? 0 : 1),
  };
}

/** Forks do not share worktree files, so staged attachments (worktree paths) are dropped. */
export function stripStagedDraftAttachments(attachments: DraftAttachment[]): DraftAttachment[] {
  return attachments.filter((attachment) => attachment.kind !== "staged");
}

export function toDraftAttachmentMetadata(attachment: DraftAttachment): DraftAttachmentMetadata {
  switch (attachment.kind) {
    case "provider": {
      // A base64 data URL encodes 3 bytes per 4 characters after the comma.
      const commaIndex = attachment.url.indexOf(",");
      const payloadChars = attachment.url.length - (commaIndex === -1 ? 0 : commaIndex + 1);
      return {
        id: attachment.id,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
        sizeBytes: Math.floor((payloadChars * 3) / 4),
      };
    }
    case "staged":
    case "pending-file":
      return {
        id: attachment.id,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
      };
  }
}

export function summarizeDraft(scope: DraftScope, draft: Draft, revision: number): DraftSummary {
  return {
    scope,
    text: draft.text,
    attachments: draft.attachments.map(toDraftAttachmentMetadata),
    revision,
  };
}
