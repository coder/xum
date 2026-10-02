import { tool } from "ai";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { isScratchDirOnHost } from "@/node/runtime/runtimeScratchDir";
import { listArtifactsOnRuntime } from "@/node/services/artifactRuntimeStore";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  listArtifactsInDir,
} from "@/node/services/artifactStore";

export const createArtifactListTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.artifact_list.description,
    inputSchema: TOOL_DEFINITIONS.artifact_list.schema,
    execute: async (_input, { abortSignal }) => {
      // XUM_SCRATCH_DIR is exported exactly where the workspace has a scratch dir, which is
      // also where the Artifacts tab reads from (artifactsOperations).
      const scratchDir = config.xumEnv?.XUM_SCRATCH_DIR;
      if (scratchDir == null) {
        return { success: false as const, error: ARTIFACTS_UNAVAILABLE_REASON };
      }
      // SSH and Docker scratch dirs live on the runtime: list them through it, never the host.
      const listing = isScratchDirOnHost(config.xumEnv?.XUM_RUNTIME)
        ? {
            dir: getArtifactsDir(scratchDir),
            ...(await listArtifactsInDir(getArtifactsDir(scratchDir))),
          }
        : await listArtifactsOnRuntime(
            config.runtime,
            `${scratchDir.replace(/\/+$/, "")}/${ARTIFACTS_DIR_NAME}`,
            abortSignal
          );
      return {
        success: true as const,
        dir: listing.dir,
        // ISO timestamps read better for the model than epoch milliseconds.
        artifacts: listing.entries.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          modified: new Date(entry.modifiedMs).toISOString(),
        })),
        truncated: listing.truncated,
      };
    },
  });
