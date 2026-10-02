import { tool } from "ai";
import * as path from "path";
import { TOOL_DEFINITIONS, type ArtifactToolResult } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { assert } from "@/common/utils/assert";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
import {
  getToolArtifactsLocation,
  publishArtifactVersion,
  resolveArtifactToolPath,
} from "@/node/services/artifactVersionsOperations";

/**
 * `artifact` tool (Artifacts M4): publish a file from $XUM_SCRATCH_DIR/artifacts as a labeled
 * version. The result stays tiny on purpose: the chat card renders from it alone (it must
 * survive compaction and older-history paging), and the model gains nothing from content.
 */
export const createArtifactTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.artifact.description,
    inputSchema: TOOL_DEFINITIONS.artifact.schema,
    execute: async (input, { abortSignal }): Promise<ArtifactToolResult> => {
      const sessionDir = config.workspaceSessionDir;
      assert(sessionDir, "artifact tool requires workspaceSessionDir");
      const location = getToolArtifactsLocation(config);
      if (location == null) return { success: false, error: ARTIFACTS_UNAVAILABLE_REASON };
      const relPath = resolveArtifactToolPath(location, input.path);
      if (typeof relPath !== "string") return { success: false, error: relPath.error };
      const title = input.title?.trim() ? input.title.trim() : path.posix.basename(relPath);
      try {
        const published = await publishArtifactVersion({
          sessionDir,
          location,
          relPath,
          source: "publish",
          label: title,
          kind: input.kind ?? undefined,
          // Persisted for M5's shelf; omitted pin keeps a previously requested one.
          pin: input.pin ?? undefined,
          abortSignal,
        });
        if (!published.success) return { success: false, error: published.error };
        return {
          success: true,
          id: published.result.artifactId,
          version: published.result.version.version,
          path: relPath,
          bytes: published.result.version.size,
          kind: published.kind,
          // A republish of identical bytes reuses the latest version (and its label).
          title: published.result.version.label ?? title,
          pin: published.result.pin,
        };
      } catch (error) {
        return { success: false, error: `Publishing failed: ${getErrorMessage(error)}` };
      }
    },
  });
