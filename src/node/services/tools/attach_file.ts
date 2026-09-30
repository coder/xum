import { tool } from "ai";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import type { AttachFileToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { readAttachFileFromPath } from "@/node/utils/attachments/readAttachmentFromPath";

function formatDisplayOnlyFileLabel(file: { filename?: string; mediaType: string }): string {
  return file.filename != null ? `${file.filename} (${file.mediaType})` : file.mediaType;
}

export const createAttachFileTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.attach_file.description,
    inputSchema: TOOL_DEFINITIONS.attach_file.schema,
    execute: async (
      { path, mediaType, filename },
      { abortSignal }
    ): Promise<AttachFileToolResult> => {
      assert(typeof path === "string" && path.trim().length > 0, "attach_file requires a path");

      try {
        const result = await readAttachFileFromPath({
          path,
          mediaType,
          filename,
          cwd: config.cwd,
          runtime: config.runtime,
          abortSignal,
        });

        if (result.type === "display") {
          const label = formatDisplayOnlyFileLabel(result.file);
          return {
            type: "content",
            value: [
              {
                type: "text",
                text:
                  `[File shown to user: ${label}. ` +
                  "Only images, SVG, and PDF can be sent to the model as attachments; this file was shown to the user for preview/download but its contents were NOT sent to you. Use file_read if you need to read its contents.]",
              },
              createDisplayOnlyFilePart(result.file),
            ],
          };
        }

        const attachment = result.attachment;
        assert(attachment.data.length > 0, "attach_file produced empty attachment data");

        return {
          type: "content",
          value: [
            {
              type: "text",
              text: `[Attachment prepared: ${attachment.filename ?? attachment.mediaType}]`,
            },
            {
              type: "media",
              data: attachment.data,
              mediaType: attachment.mediaType,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
            },
          ],
        };
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        };
      }
    },
  });
};
