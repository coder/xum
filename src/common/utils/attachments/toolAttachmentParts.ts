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

/**
 * Stub markers written into carried parts' `data` when the PTC bridge strips
 * attachment bytes from nested tool results. Shared so the renderer can
 * suppress duplicate stub cards when the carrier renders the real bytes.
 */
export const MEDIA_BUDGET_EXCEEDED_STUB =
  "[media omitted: aggregate attachment budget for this code_execution call was exceeded; attach fewer or smaller files in one call]";

export const MEDIA_DATA_STUB =
  "[base64 omitted: media is delivered to the model as an attachment on this code_execution result]";

export const DISPLAY_DATA_STUB =
  "[base64 omitted: file is shown to the user on this code_execution result; its bytes are never sent to the model]";

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
