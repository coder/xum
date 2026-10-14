import {
  getCanonicalProjectMetadataRelativePath,
  listProjectMetadataRelativePaths,
} from "@/common/compat/legacyMux";

export const STAGED_ATTACHMENT_DIR = getCanonicalProjectMetadataRelativePath("user-attachments");
export const STAGED_ATTACHMENT_DIRS = listProjectMetadataRelativePaths("user-attachments");
/**
 * Session-dir directory (`<sessionDir>/<name>/<uuid>/<filename>`) holding a durable copy of each
 * staged upload. The checkout copy under STAGED_ATTACHMENT_DIR stays the path the agent reads, but
 * it is git-excluded, so snapshot archives drop it; unarchive rehydrates it from this mirror (#3947).
 */
export const STAGED_ATTACHMENT_MIRROR_DIR_NAME = "staged-attachments";
/**
 * Session-dir marker present while a snapshot unarchive may have recreated the checkout without
 * finishing mirror rehydration; startup finishes it after a crash (#4850).
 */
export const STAGED_ATTACHMENT_REHYDRATE_PENDING_FILE_NAME = "staged-attachments-rehydrate-pending";
export const MAX_STAGED_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_STAGED_ATTACHMENT_BASE64_CHARS =
  Math.ceil(MAX_STAGED_ATTACHMENT_SIZE_BYTES / 3) * 4 + 8;

export const ZIP_MEDIA_TYPE = "application/zip";
export const ZIP_MEDIA_TYPES = [ZIP_MEDIA_TYPE, "application/x-zip-compressed"] as const;
