import { tool } from "ai";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { isBinaryArtifactKind } from "@/common/utils/artifactKind";
import { assert } from "@/common/utils/assert";
import {
  getShelfScopeDir,
  MAX_SHELF_FILE_BYTES,
  readShelfEntry,
} from "@/node/services/artifactShelf";

/** Content returned to the model is cut here; the full entry stays on the shelf. */
export const ARTIFACT_READ_MAX_CHARS = 100_000;

/**
 * `artifact_read` (Artifacts M5c): read one shelf entry. Read-only by construction: it only reads
 * through readShelfEntry, and nothing else lets an agent write the shelf except the artifact
 * tool's pin.
 */
export const createArtifactReadTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.artifact_read.description,
    inputSchema: TOOL_DEFINITIONS.artifact_read.schema,
    execute: async (input) => {
      const shelfRoot = config.artifactShelfRoot;
      assert(shelfRoot, "artifact_read requires artifactShelfRoot");
      const projectIdentity =
        (config.projects?.length ?? 0) > 1 ? "" : (config.workspaceProjectPath ?? "");
      const scopeDir = getShelfScopeDir(shelfRoot, input.scope, projectIdentity);
      if (typeof scopeDir !== "string") return { success: false as const, error: scopeDir.error };
      const read = await readShelfEntry(shelfRoot, scopeDir, input.path, MAX_SHELF_FILE_BYTES);
      if (read.status === "missing") {
        return {
          success: false as const,
          error: `No ${input.scope} shelf entry named "${input.path}" (see artifact_list with scope "shelf")`,
        };
      }
      if (read.status === "too_large") {
        return {
          success: false as const,
          error: `Shelf entry is ${read.size} bytes; too large to read`,
        };
      }
      if (isBinaryArtifactKind(read.meta.kind)) {
        return {
          success: false as const,
          error: `"${input.path}" is a ${read.meta.kind} artifact; artifact_read returns text artifacts only`,
        };
      }
      // A text kind comes from the file name; NUL bytes mean binary content (as the live reader
      // decides), which must not be decoded and returned as text.
      if (read.bytes.includes(0)) {
        return {
          success: false as const,
          error: `"${input.path}" holds binary content; artifact_read returns text artifacts only`,
        };
      }
      const text = read.bytes.toString("utf8");
      const truncated = text.length > ARTIFACT_READ_MAX_CHARS;
      return {
        success: true as const,
        scope: input.scope,
        name: input.path,
        title: read.meta.title,
        kind: read.meta.kind,
        version: read.meta.version,
        sourcePath: read.meta.sourcePath,
        content: truncated ? text.slice(0, ARTIFACT_READ_MAX_CHARS) : text,
        ...(truncated
          ? {
              truncated: true,
              note: `Showing the first ${ARTIFACT_READ_MAX_CHARS} of ${text.length} characters.`,
            }
          : {}),
      };
    },
  });
