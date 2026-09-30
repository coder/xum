import { stripStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type { CompactionRequestData } from "@/common/types/message";
import { isDefaultSourceContent } from "@/common/types/message";

/**
 * Format the compaction command line (without any multiline continue payload).
 */
export function formatCompactionCommandLine(options: {
  model?: string;
  maxOutputTokens?: number;
}): string {
  let cmd = "/compact";
  if (typeof options.maxOutputTokens === "number") {
    cmd += ` -t ${options.maxOutputTokens}`;
  }
  if (typeof options.model === "string" && options.model.trim().length > 0) {
    cmd += ` -m ${options.model}`;
  }
  return cmd;
}

/**
 * Return the visible follow-up text for a compaction request.
 * Hides the default resume sentinel ("Continue") and empty text.
 */
export function getFollowUpContentText(
  followUpContent?: CompactionRequestData["followUpContent"],
  options?: { stripStagedAttachmentNotice?: boolean }
): string | null {
  if (!followUpContent) return null;
  if (isDefaultSourceContent(followUpContent)) return null;
  const rawText = followUpContent.text;
  if (typeof rawText !== "string") {
    return null;
  }
  const text =
    options?.stripStagedAttachmentNotice === true ? stripStagedAttachmentNotice(rawText) : rawText;
  if (text.trim().length === 0) {
    return null;
  }
  return text;
}
