import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

/**
 * Attachment drafts above this JSON size stay memory-only (localStorage quota).
 *
 * Provider attachments persist as base64 data URLs. The smallest known origin quota is about
 * 5 MB (Safari), so a single 4M-char draft could nearly fill it and make every later write fail,
 * including the draft text itself. 1M chars leaves headroom for other drafts, text and UI keys.
 * Pasted screenshots are already shrunk by resizeImageIfNeeded. Moving drafts to a backend store
 * removes this cap.
 */
export const MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderChatAttachment(value: unknown): value is {
  kind?: "provider";
  id: string;
  url: string;
  mediaType: string;
  filename?: string;
} {
  if (!isRecord(value)) return false;
  return (
    (value.kind === undefined || value.kind === "provider") &&
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    typeof value.mediaType === "string" &&
    (value.filename === undefined || typeof value.filename === "string")
  );
}

function isStagedChatAttachment(value: unknown): value is {
  kind: "staged";
  id: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  stagedPath: string;
} {
  if (!isRecord(value)) return false;
  return (
    value.kind === "staged" &&
    typeof value.id === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.filename === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.stagedPath === "string"
  );
}

function isPendingFileChatAttachment(value: unknown): value is {
  kind: "pending-file";
  id: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
  dataBase64: string;
} {
  if (!isRecord(value)) return false;
  return (
    value.kind === "pending-file" &&
    typeof value.id === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.filename === "string" &&
    typeof value.sizeBytes === "number" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.dataBase64 === "string"
  );
}

export function parsePersistedChatAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const attachments: ChatAttachment[] = [];
  for (const item of raw) {
    if (isProviderChatAttachment(item)) {
      attachments.push({
        kind: "provider",
        id: item.id,
        url: item.url,
        mediaType: item.mediaType,
        filename: item.filename,
      });
      continue;
    }

    if (isStagedChatAttachment(item)) {
      attachments.push({
        kind: "staged",
        id: item.id,
        mediaType: item.mediaType,
        filename: item.filename,
        sizeBytes: item.sizeBytes,
        stagedPath: item.stagedPath,
      });
      continue;
    }

    if (isPendingFileChatAttachment(item)) {
      attachments.push({
        kind: "pending-file",
        id: item.id,
        mediaType: item.mediaType,
        filename: item.filename,
        sizeBytes: item.sizeBytes,
        dataBase64: item.dataBase64,
      });
      continue;
    }

    return [];
  }

  return attachments;
}

export function readPersistedChatAttachments(attachmentsKey: string): ChatAttachment[] {
  return parsePersistedChatAttachments(readPersistedState<unknown>(attachmentsKey, []));
}

export function estimatePersistedChatAttachmentsChars(attachments: ChatAttachment[]): number {
  return JSON.stringify(attachments).length;
}
