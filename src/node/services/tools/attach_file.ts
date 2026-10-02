import { tool } from "ai";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import type { ArtifactUiOnlyPayload, AttachFileToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  readAttachFileFromPath,
  type LoadedFileFromPath,
} from "@/node/utils/attachments/readAttachmentFromPath";
import {
  getToolArtifactsLocation,
  registerAttachedArtifact,
} from "@/node/services/artifactVersionsOperations";
import { log } from "@/node/services/log";

function formatDisplayOnlyFileLabel(file: { filename?: string; mediaType: string }): string {
  return file.filename != null ? `${file.filename} (${file.mediaType})` : file.mediaType;
}

/**
 * Register an artifacts-dir document as an artifact version (Artifacts M4). Never fails the
 * attachment: the version is a side benefit, so errors are logged and dropped.
 */
async function registerArtifactIfInside(
  config: ToolConfiguration,
  loaded: LoadedFileFromPath,
  abortSignal: AbortSignal | undefined
): Promise<ArtifactUiOnlyPayload | null> {
  if (!config.experiments?.artifacts || config.workspaceSessionDir == null) return null;
  // A cancelled call publishes nothing (the same rule as the artifact tool's publish).
  if (abortSignal?.aborted) return null;
  const location = await getToolArtifactsLocation(config);
  if (location == null) return null;
  try {
    return await registerAttachedArtifact({
      sessionDir: config.workspaceSessionDir,
      location,
      resolvedPath: loaded.resolvedPath,
      // Raster images are resized, but registered kinds are text documents and SVG, whose
      // bytes attach_file passes through unchanged.
      bytes: Buffer.from(loaded.data, "base64"),
      resolveRuntimePath: (p) => config.runtime.resolvePath(p),
      abortSignal,
    });
  } catch (error) {
    log.warn("attach_file could not register an artifact version", {
      error: getErrorMessage(error),
    });
    return null;
  }
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

        const loaded = result.type === "display" ? result.file : result.attachment;
        const artifact = await registerArtifactIfInside(config, loaded, abortSignal);
        // ui_only never reaches the model (stripped before provider requests); the card uses it.
        const uiOnly = artifact != null ? { ui_only: { artifact } } : {};

        if (result.type === "display") {
          const label = formatDisplayOnlyFileLabel(result.file);
          return {
            ...uiOnly,
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
          ...uiOnly,
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
