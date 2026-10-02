import type { APIClient } from "@/browser/contexts/API";
import { createCustomEvent, CUSTOM_EVENTS } from "@/common/constants/events";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { readArtifactSelection, writeArtifactSelection } from "./artifactSelection";

export interface OpenArtifactTarget {
  workspaceId: string;
  /** Artifacts-relative path, or a checkout-relative path when `pinned`. */
  path: string;
  /** Version to show; null/absent means "Latest (live)". Ignored for pinned files. */
  versionId?: number | null;
  /** A pinned workspace file (Concept C) rather than an artifact. */
  pinned?: boolean;
}

/**
 * The one way to open the Artifacts tab on something (chat cards, attach_file, file cards,
 * Review, palette). The selection is persisted first, so the panel (which reads the same state
 * with a listener) shows it whether it is already mounted or mounts because of the event;
 * RightSidebar (or the small-viewport dialog) only has to bring the tab into view.
 */
export function openArtifact(target: OpenArtifactTarget): void {
  assert(target.workspaceId.length > 0, "openArtifact: workspaceId is required");
  assert(target.path.length > 0, "openArtifact: path is required");
  const pinned = target.pinned === true;
  const versionId = pinned ? null : (target.versionId ?? null);
  assert(
    versionId == null || (Number.isInteger(versionId) && versionId > 0),
    "openArtifact: versionId must be a positive integer"
  );
  writeArtifactSelection(target.workspaceId, {
    scope: pinned ? "pinned" : "artifact",
    path: target.path,
    version: versionId,
  });
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_ARTIFACT, {
      workspaceId: target.workspaceId,
      path: target.path,
      ...(versionId != null ? { versionId } : {}),
      ...(pinned ? { pinned: true } : {}),
    })
  );
}

/**
 * Bring the Artifacts tab into view without changing its selection (palette "Open Artifacts").
 * The event still carries the current selection so its payload stays truthful; the handlers
 * only use the workspace id.
 */
export function openArtifactsTab(workspaceId: string): void {
  assert(workspaceId.length > 0, "openArtifactsTab: workspaceId is required");
  const { path, scope, version: versionId } = readArtifactSelection(workspaceId);
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.OPEN_ARTIFACT, {
      workspaceId,
      path: path ?? "",
      ...(versionId != null && scope === "artifact" ? { versionId } : {}),
      ...(scope === "pinned" ? { pinned: true } : {}),
    })
  );
}

/** Latest pin-and-open request per workspace; an older response must not open over it. */
const latestPinRequest = new Map<string, number>();
let nextPinRequestId = 0;

/**
 * "Open as artifact" for any checkout file: pin it (absolute inside the checkout or relative),
 * then open the stored checkout-relative path. Failures surface as a chat toast, the same
 * channel the command palette uses for feedback. `relativeTo: "tool-cwd"` resolves a relative
 * path like file tools do (a sub-project's cwd), instead of from the checkout root.
 */
export async function pinAndOpenArtifact(
  api: APIClient,
  workspaceId: string,
  path: string,
  options?: { relativeTo?: "tool-cwd" | "checkout" }
): Promise<void> {
  const requestId = ++nextPinRequestId;
  latestPinRequest.set(workspaceId, requestId);
  const isLatest = () => latestPinRequest.get(workspaceId) === requestId;
  let error: string;
  try {
    const result = await api.artifacts.pinFile({
      workspaceId,
      path,
      ...(options?.relativeTo != null ? { relativeTo: options.relativeTo } : {}),
    });
    if (!isLatest()) return;
    if (result.success) {
      openArtifact({ workspaceId, path: result.data.path, pinned: true });
      return;
    }
    error = result.error;
  } catch (caught: unknown) {
    if (!isLatest()) return;
    error = getErrorMessage(caught);
  }
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.ANALYTICS_REBUILD_TOAST, {
      type: "error",
      title: "Could not open as artifact",
      message: error,
    })
  );
}
