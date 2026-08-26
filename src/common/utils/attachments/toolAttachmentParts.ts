import type { DisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";

/** AI SDK media part shape tools emit for model-visible attachments. */
export interface AISDKMediaPart {
  type: "media";
  data: string;
  mediaType: string;
  filename?: string;
}

/**
 * Original attachment-carrying parts a tool result can produce: model
 * attachments (media) and user-preview-only files (display_file).
 *
 * Shared across the IPC boundary: the PTC bridge carries these on
 * code_execution results and the renderer filters/renders them, so both
 * sides must agree on the union (AGENTS.md: import shared types instead of
 * duplicating definitions around the boundary).
 */
export type ToolAttachmentPart = AISDKMediaPart | DisplayOnlyFilePart;

export function isMediaPart(value: unknown): value is AISDKMediaPart {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "media" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string" &&
    (record.filename === undefined || typeof record.filename === "string")
  );
}
