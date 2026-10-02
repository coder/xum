import { tool } from "ai";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
import { getArtifactsDir, listArtifactsInDir } from "@/node/services/artifactStore";

export const createArtifactListTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.artifact_list.description,
    inputSchema: TOOL_DEFINITIONS.artifact_list.schema,
    execute: async () => {
      // XUM_SCRATCH_DIR is exported exactly for runtimes whose scratch dir lives on this
      // host (local/worktree), which is also where the Artifacts tab reads from.
      const scratchDir = config.xumEnv?.XUM_SCRATCH_DIR;
      if (scratchDir == null) {
        return { success: false as const, error: ARTIFACTS_UNAVAILABLE_REASON };
      }
      const dir = getArtifactsDir(scratchDir);
      const { entries, truncated } = await listArtifactsInDir(dir);
      return {
        success: true as const,
        dir,
        // ISO timestamps read better for the model than epoch milliseconds.
        artifacts: entries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          modified: new Date(entry.modifiedMs).toISOString(),
        })),
        truncated,
      };
    },
  });
