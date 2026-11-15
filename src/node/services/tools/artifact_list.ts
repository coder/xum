import { tool } from "ai";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ArtifactShelfEntry } from "@/common/orpc/schemas/artifacts";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { listShelf } from "@/node/services/artifactShelfOperations";
import { isScratchDirOnHost } from "@/node/runtime/runtimeScratchDir";
import { listArtifactsOnRuntime } from "@/node/services/artifactRuntimeStore";
import { ARTIFACTS_UNAVAILABLE_REASON } from "@/node/services/artifactsOperations";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  hostSupportsDescriptorPaths,
  listArtifactsInDir,
} from "@/node/services/artifactStore";
import {
  getArtifactId,
  listArtifactRecords,
  listStoredArtifactIds,
  withPublishedKinds,
} from "@/node/services/artifactRecordStore";
import { summarizeArtifactState } from "@/node/services/artifactInteractions";

/** State summaries read in parallel per batch (local session files). */
const STATE_READ_BATCH = 16;

/** artifact_list scope "shelf" (M5c): project then global shelf entries, with their source. */
async function listShelfForTool(config: ToolConfiguration) {
  if (config.artifactShelfRoot == null) {
    return { success: false as const, error: "The artifact shelf is not available here" };
  }
  const projectIdentity =
    (config.projects?.length ?? 0) > 1 ? "" : (config.workspaceProjectPath ?? "");
  const listing = await listShelf(config.artifactShelfRoot, projectIdentity);
  const toItem = (entry: ArtifactShelfEntry) => ({
    scope: entry.scope,
    name: entry.name,
    title: entry.title,
    kind: entry.kind,
    size: entry.size,
    source: { workspaceId: entry.sourceWorkspaceId, path: entry.sourcePath },
    pinnedBy: entry.pinnedBy,
    pinned: new Date(entry.pinnedAtMs).toISOString(),
  });
  return {
    success: true as const,
    shelf: [
      ...(listing.project.available ? listing.project.entries.map(toItem) : []),
      ...listing.global.map(toItem),
    ],
    ...(listing.project.available ? {} : { projectShelf: listing.project.reason }),
  };
}

export const createArtifactListTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.artifact_list.description,
    inputSchema: TOOL_DEFINITIONS.artifact_list.schema,
    execute: async (input, { abortSignal }) => {
      if (input.scope === "shelf") return listShelfForTool(config);
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
      const records =
        config.workspaceSessionDir != null
          ? await listArtifactRecords(config.workspaceSessionDir)
          : [];
      const titleByPath = new Map(records.map((record) => [record.path, record.title]));
      const entries = withPublishedKinds(listing.entries, records);
      // window.xum.setState of the artifact (M5b). Only sandboxed HTML/SVG can set state,
      // and only artifacts with a stored directory (record or state) can have any, so the rest
      // skip the read. The reads run a bounded batch at a time instead of one by one.
      const stateByPath = new Map<string, Awaited<ReturnType<typeof summarizeArtifactState>>>();
      const sessionDir = config.workspaceSessionDir;
      if (sessionDir != null) {
        const storedIds = new Set(await listStoredArtifactIds(sessionDir));
        const candidates = entries.filter(
          (entry) =>
            (entry.kind === "html" || entry.kind === "svg") &&
            storedIds.has(getArtifactId(entry.path))
        );
        for (let start = 0; start < candidates.length; start += STATE_READ_BATCH) {
          const batch = candidates.slice(start, start + STATE_READ_BATCH);
          const summaries = await Promise.all(
            batch.map((entry) => summarizeArtifactState(sessionDir, entry.path))
          );
          batch.forEach((entry, i) => {
            const summary = summaries[i];
            if (summary != null) stateByPath.set(entry.path, summary);
          });
        }
      }
      const artifacts = entries.map((entry) => {
        const title = titleByPath.get(entry.path);
        const state = stateByPath.get(entry.path);
        return {
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          // ISO timestamps read better for the model than epoch milliseconds.
          modified: new Date(entry.modifiedMs).toISOString(),
          ...(title != null ? { title } : {}),
          ...(state != null
            ? {
                state: state.state,
                ...(state.truncated ? { stateTruncated: true } : {}),
              }
            : {}),
        };
      });
      return {
        success: true as const,
        dir: listing.dir,
        artifacts,
        truncated: listing.truncated,
      };
    },
  });
