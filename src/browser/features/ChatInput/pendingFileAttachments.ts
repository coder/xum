import type { APIClient } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";

import type {
  ChatAttachment,
  PendingFileChatAttachment,
  StagedChatAttachment,
} from "./ChatAttachments";

export interface PendingFileStagingFailure {
  attachment: PendingFileChatAttachment;
  error: string;
}

export interface StagePendingFilesOutcome {
  staged: StagedChatAttachment[];
  failures: PendingFileStagingFailure[];
}

export function getPendingFileAttachments(
  attachments: ChatAttachment[]
): PendingFileChatAttachment[] {
  return attachments.filter((attachment) => attachment.kind === "pending-file");
}

/**
 * Per-file errors are collected into `failures` so callers can fail closed
 * while keeping the successfully staged results.
 */
export async function stagePendingFiles(
  api: { workspace: Pick<APIClient["workspace"], "stageAttachment"> },
  workspaceId: string,
  pendingFiles: PendingFileChatAttachment[]
): Promise<StagePendingFilesOutcome> {
  const staged: StagedChatAttachment[] = [];
  const failures: PendingFileStagingFailure[] = [];

  for (const attachment of pendingFiles) {
    try {
      const result = await api.workspace.stageAttachment({
        workspaceId,
        filename: attachment.filename,
        mediaType: attachment.mediaType.length > 0 ? attachment.mediaType : null,
        sizeBytes: attachment.sizeBytes,
        dataBase64: attachment.dataBase64,
      });
      if (result.success) {
        // Keep the pending attachment's id so composer chips swap in place.
        staged.push({
          kind: "staged",
          id: attachment.id,
          filename: result.data.filename,
          mediaType: result.data.mediaType,
          sizeBytes: result.data.sizeBytes,
          stagedPath: result.data.stagedPath,
        });
      } else {
        failures.push({ attachment, error: result.error });
      }
    } catch (error) {
      failures.push({ attachment, error: getErrorMessage(error) });
    }
  }

  return { staged, failures };
}

export function replacePendingFilesWithStaged(
  attachments: ChatAttachment[],
  staged: StagedChatAttachment[]
): ChatAttachment[] {
  const stagedById = new Map(staged.map((attachment) => [attachment.id, attachment]));
  return attachments.map((attachment) =>
    attachment.kind === "pending-file" ? (stagedById.get(attachment.id) ?? attachment) : attachment
  );
}

export function formatPendingFileStagingError(failures: PendingFileStagingFailure[]): string {
  const details = failures
    .map((failure) => `${failure.attachment.filename}: ${failure.error}`)
    .join("; ");
  return `Failed to save attached file(s) into the workspace. ${details}`;
}
