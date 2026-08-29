import { useCallback, useState } from "react";
import type React from "react";
import { useAPI } from "@/browser/contexts/API";
import {
  extractAttachmentsFromClipboard,
  extractAttachmentsFromDrop,
  processAttachmentFiles,
} from "@/browser/utils/attachmentsHandling";
import type { ChatAttachment } from "./ChatAttachments";
import type { Toast } from "./ChatInputToast";

const PDF_MEDIA_TYPE = "application/pdf";
const EDIT_MODE_ATTACHMENT_ERROR_MESSAGE = "Attachments cannot be added while editing a message.";

type PushToast = (toast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;

interface UseComposerAttachmentsOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  attachments: ChatAttachment[];
  setAttachments: (
    value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])
  ) => void;
  editingMessage: boolean;
  pushToast: PushToast;
}
export function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}
export function isPdfAttachment(
  attachment: ChatAttachment
): attachment is Extract<ChatAttachment, { kind: "provider" }> {
  return (
    attachment.kind === "provider" && getBaseMediaType(attachment.mediaType) === PDF_MEDIA_TYPE
  );
}
export function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;
  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;
  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
export function useComposerAttachments(options: UseComposerAttachmentsOptions) {
  const { api } = useAPI();
  const { attachments, setAttachments } = options;
  const [processingAttachmentCount, setProcessingAttachmentCount] = useState(0);

  const showResizeToast = useCallback(
    (next: ChatAttachment[]) => {
      const resized = next.filter(
        (attachment): attachment is Extract<ChatAttachment, { kind: "provider" }> =>
          attachment.kind === "provider" && attachment.resizeInfo != null
      );
      const resizeInfo = resized[0]?.resizeInfo;
      if (!resizeInfo) return;
      options.pushToast({
        type: "info",
        message:
          resized.length === 1
            ? `Image resized from ${resizeInfo.originalWidth}×${resizeInfo.originalHeight} to ${resizeInfo.newWidth}×${resizeInfo.newHeight}`
            : `${resized.length} images resized to fit provider limits`,
      });
    },
    [options.pushToast]
  );

  const processFiles = useCallback(
    (files: File[]) => {
      setProcessingAttachmentCount((count) => count + 1);
      return processAttachmentFiles(files, {
        stageAttachment:
          options.variant === "workspace"
            ? async (file, dataBase64) => {
                if (!api) throw new Error("Not connected to server");
                if (options.workspaceId == null)
                  throw new Error("Files can be staged after opening a workspace.");
                const result = await api.workspace.stageAttachment({
                  workspaceId: options.workspaceId,
                  filename: file.name,
                  mediaType: file.type || null,
                  sizeBytes: file.size,
                  dataBase64,
                });
                if (!result.success) throw new Error(result.error);
                return result.data;
              }
            : undefined,
        holdNonProviderFiles: options.variant === "creation",
      }).finally(() => setProcessingAttachmentCount((count) => Math.max(0, count - 1)));
    },
    [api, options.variant, options.workspaceId]
  );

  const attachFiles = useCallback(
    (files: File[]) => {
      void Promise.all(
        files.map((file) =>
          processFiles([file]).then(
            (processed) => ({ ok: true as const, attachments: processed }),
            (error: unknown) => ({ ok: false as const, error })
          )
        )
      ).then((outcomes) => {
        const successes = outcomes.flatMap((outcome) => (outcome.ok ? outcome.attachments : []));
        if (successes.length > 0) {
          setAttachments((previous) => [...previous, ...successes]);
          showResizeToast(successes);
        }
        for (const outcome of outcomes) {
          if (outcome.ok) continue;
          console.error("Failed to process attached file:", outcome.error);
          options.pushToast({
            type: "error",
            message:
              outcome.error instanceof Error
                ? outcome.error.message
                : "Failed to process attachment",
          });
        }
      });
    },
    [options.pushToast, processFiles, setAttachments, showResizeToast]
  );

  const rejectEditAttachment = useCallback(() => {
    options.pushToast({ type: "error", message: EDIT_MODE_ATTACHMENT_ERROR_MESSAGE });
  }, [options.pushToast]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = event.clipboardData?.items
        ? extractAttachmentsFromClipboard(event.clipboardData.items)
        : [];
      if (files.length === 0) return;
      if (options.editingMessage) {
        rejectEditAttachment();
        return;
      }
      event.preventDefault();
      attachFiles(files);
    },
    [attachFiles, options.editingMessage, rejectEditAttachment]
  );

  const handleAttachFiles = useCallback(
    (files: File[]) => {
      if (options.editingMessage) rejectEditAttachment();
      else attachFiles(files);
    },
    [attachFiles, options.editingMessage, rejectEditAttachment]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = options.editingMessage ? "none" : "copy";
    },
    [options.editingMessage]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      const files = extractAttachmentsFromDrop(event.dataTransfer);
      if (files.length === 0) return;
      if (options.editingMessage) rejectEditAttachment();
      else attachFiles(files);
    },
    [attachFiles, options.editingMessage, rejectEditAttachment]
  );

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      setAttachments((previous) => previous.filter((item) => item.id !== id));
    },
    [setAttachments]
  );

  return {
    attachments,
    setAttachments,
    processingAttachmentCount,
    handlePaste,
    handleAttachFiles,
    handleDragOver,
    handleDrop,
    handleRemoveAttachment,
  };
}
