import { tool } from "ai";
import { getArtifactKind } from "@/common/utils/artifactKind";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { isScratchDirOnHost } from "@/node/runtime/runtimeScratchDir";
import { listArtifactsOnRuntime } from "@/node/services/artifactRuntimeStore";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  hostSupportsDescriptorPaths,
  listArtifactsInDir,
} from "@/node/services/artifactStore";
import { listArtifactIndexes } from "@/node/services/artifactVersionStore";

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
      // A devcontainer writes its host-mounted dir from inside the container: the host lists it
      // only with descriptor-pinned folders, else the container lists it (artifactsOperations).
      const runtimeMode = config.xumEnv?.XUM_RUNTIME;
      const containerWritable = runtimeMode === "devcontainer";
      const listing =
        isScratchDirOnHost(runtimeMode) &&
        (!containerWritable || (await hostSupportsDescriptorPaths()))
          ? {
              dir: getArtifactsDir(scratchDir),
              ...(await listArtifactsInDir(getArtifactsDir(scratchDir), {
                requireDescriptorPaths: containerWritable,
              })),
            }
          : await listArtifactsOnRuntime(
              config.runtime,
              `${scratchDir.replace(/\/+$/, "")}/${ARTIFACTS_DIR_NAME}`,
              abortSignal
            );
      // Latest published/snapshotted version per artifact (M4), so the model can refer to "v3".
      const latestByPath = new Map<string, { version: number; label: string | null }>();
      if (config.workspaceSessionDir != null) {
        for (const index of await listArtifactIndexes(config.workspaceSessionDir)) {
          const latest = index.versions.at(-1);
          if (latest)
            latestByPath.set(index.path, { version: latest.version, label: latest.label });
        }
      }
      const live = listing.entries.map((entry) => {
        const latest = latestByPath.get(entry.path);
        return {
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          // ISO timestamps read better for the model than epoch milliseconds.
          modified: new Date(entry.modifiedMs).toISOString(),
          ...(latest ? { latestVersion: latest.version, latestLabel: latest.label } : {}),
        };
      });
      // Deleted files whose versions are kept: the post-compaction index only gives a count,
      // so this is where the model finds them again. A truncated listing may just not have
      // reached a file, so nothing is called deleted then.
      const livePaths = new Set(listing.entries.map((entry) => entry.path));
      const deleted = listing.truncated
        ? []
        : [...latestByPath]
            .filter(([path]) => !livePaths.has(path))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, latest]) => ({
              path,
              kind: getArtifactKind(path),
              deleted: true as const,
              latestVersion: latest.version,
              latestLabel: latest.label,
            }));
      return {
        success: true as const,
        dir: listing.dir,
        artifacts: [...live, ...deleted],
        truncated: listing.truncated,
      };
    },
  });
