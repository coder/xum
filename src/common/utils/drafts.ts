import {
  DraftAttachmentSchema,
  type Draft,
  type DraftAttachment,
  type DraftAttachmentMetadata,
  type DraftScope,
  type DraftSummary,
  type PendingSend,
} from "@/common/orpc/schemas/drafts";
import { joinDraftText } from "@/common/utils/composerDraftText";
import { MAX_DRAFT_JSON_BYTES } from "@/constants/drafts";

/** Stable map key for a draft scope (creation keys are unambiguous for any project path). */
export function draftScopeKey(scope: DraftScope): string {
  return scope.kind === "workspace"
    ? `workspace:${scope.workspaceId}`
    : `creation:${JSON.stringify([scope.projectPath, scope.draftId])}`;
}

/** A new creation draft id (matches DRAFT_ID_PATTERN: it becomes a backend file name). */
export function createDraftId(): string {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
    const id = maybeCrypto.randomUUID();
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  return `draft_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * A new composer send id (idempotent sends; matches SendIdSchema). crypto.randomUUID is missing
 * in insecure contexts (a plain-HTTP remote browser), where getRandomValues still works.
 */
export function createSendId(): string {
  const maybeCrypto = globalThis.crypto;
  if (typeof maybeCrypto?.randomUUID === "function") return maybeCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  maybeCrypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createEmptyDraft(): Draft {
  return { text: "", attachments: [] };
}

/** An empty draft has no file on the backend: writing one deletes it. */
export function isDraftEmpty(draft: Draft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

const UTF8_CHUNK_UNITS = 64 * 1024;
const utf8Encoder = new TextEncoder();
// Up to 3 bytes per UTF-16 code unit, so one chunk always fits.
const utf8Scratch = new Uint8Array(UTF8_CHUNK_UNITS * 3);

/**
 * UTF-8 byte length of a string, counted natively in fixed-size chunks: no encoded copy of a
 * multi-MB draft, and no per-character JavaScript work for ASCII or dense non-ASCII text alike.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + UTF8_CHUNK_UNITS, value.length);
    // Never split a surrogate pair: each half alone would count as 3 bytes instead of 4 total.
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    bytes += utf8Encoder.encodeInto(value.slice(start, end), utf8Scratch).written;
    start = end;
  }
  return bytes;
}

/**
 * JSON size of a draft in UTF-8 bytes, compared against MAX_DRAFT_JSON_BYTES. Bytes, because the
 * transport limits count bytes: UTF-16 code units undercount non-ASCII text up to 3x.
 */
export function draftJsonBytes(draft: Draft & { pendingSends?: readonly PendingSend[] }): number {
  return utf8ByteLength(
    JSON.stringify({
      text: draft.text,
      attachments: draft.attachments,
      // Replay bookkeeping counts too: the file holds it.
      ...(draft.pendingSends != null && draft.pendingSends.length > 0
        ? { pendingSends: draft.pendingSends }
        : {}),
    })
  );
}

/**
 * Idempotent sends: the draft file keeps the text of pending sends in the legacy `text` field,
 * before the composer's visible text, joined as a restore merges drafts (retained texts in entry
 * order, then the visible text). An older build reads it all as ordinary draft text.
 */
export function buildLegacyDraftText(
  pendingSends: readonly PendingSend[],
  visibleText: string
): string {
  return joinDraftText(...pendingSends.map((send) => send.text), visibleText);
}

/**
 * The visible text of a legacy `text` written by buildLegacyDraftText, or null when the text does
 * not start with the retained texts (an older build or another writer rewrote it).
 */
export function splitLegacyDraftText(
  text: string,
  pendingSends: readonly PendingSend[]
): string | null {
  const retained = joinDraftText(...pendingSends.map((send) => send.text));
  if (retained.length === 0) return text;
  if (text === retained) return "";
  const separator = "\n\n";
  return text.startsWith(retained + separator)
    ? text.slice(retained.length + separator.length)
    : null;
}

/** Ids of the attachments pending sends retain (hidden from the composer). */
export function retainedAttachmentIds(pendingSends: readonly PendingSend[]): Set<string> {
  return new Set(pendingSends.flatMap((send) => send.attachmentIds));
}

const DRAFT_TOO_LARGE_PREFIX = "Draft is too large to save";

/** The save error for a draft over MAX_DRAFT_JSON_BYTES (shown by the composer as a toast). */
export function draftTooLargeMessage(bytes: number): string {
  const toMb = (value: number) => Math.ceil(value / (1024 * 1024));
  return `${DRAFT_TOO_LARGE_PREFIX} (${toMb(bytes)} MB; the limit is ${toMb(MAX_DRAFT_JSON_BYTES)} MB). Remove an attachment.`;
}

/** Whether an error is the size refusal: permanent until the draft changes, so not retried. */
export function isDraftTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(DRAFT_TOO_LARGE_PREFIX);
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

export function summarizeDraft(
  scope: DraftScope,
  draft: Draft,
  revision: number,
  pendingSends: readonly PendingSend[] = []
): DraftSummary {
  return {
    scope,
    text: draft.text,
    attachments: draft.attachments.map(toDraftAttachmentMetadata),
    ...(pendingSends.length > 0 ? { pendingSends: [...pendingSends] } : {}),
    revision,
  };
}
