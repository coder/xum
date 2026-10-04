import type { FrontendWorkspaceMetadata } from "xum/common/types/workspace";
import { isWorkspaceArchived } from "xum/common/utils/archive";

type MetadataEvent =
  | { type: "snapshot"; workspaces: FrontendWorkspaceMetadata[] }
  | { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };

/** The slice of the oRPC client the pump uses; ApiClient satisfies it structurally. */
export interface WorkspaceMetadataPumpClient {
  workspace: {
    onMetadata(
      input: undefined,
      options: { signal: AbortSignal }
    ): Promise<AsyncIterable<MetadataEvent>>;
  };
}

const isListed = (workspace: FrontendWorkspaceMetadata) =>
  !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt);

/**
 * Keeps the host's workspace list live (#5109): sub-agent task status, creation, removal and
 * archiving reach the webview without a manual refresh. One subscription for all workspaces; the
 * first event is the full snapshot, then one event per changed workspace. Updates pass through
 * one at a time, so the host can compare just that workspace (users have thousands). Archived
 * workspaces arrive as removals, as workspace.list omits them. Lives outside extension.ts so it
 * can be unit tested. Best-effort: failures before abort go to `onError`.
 */
export async function pumpWorkspaceMetadata(params: {
  client: WorkspaceMetadataPumpClient;
  signal: AbortSignal;
  onSnapshot: (workspaces: FrontendWorkspaceMetadata[]) => void | Promise<void>;
  onUpdate: (
    workspaceId: string,
    metadata: FrontendWorkspaceMetadata | null
  ) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const { signal } = params;
  try {
    const iterator = await params.client.workspace.onMetadata(undefined, { signal });
    for await (const event of iterator) {
      // A replaced subscription can still deliver an event it already had in flight.
      if (signal.aborted) return;
      if ("type" in event) {
        await params.onSnapshot(event.workspaces.filter(isListed));
      } else {
        const { metadata } = event;
        await params.onUpdate(event.workspaceId, metadata && isListed(metadata) ? metadata : null);
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    params.onError(error);
  }
}
