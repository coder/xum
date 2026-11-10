/**
 * The in-process lifecycle gates of each workspace: which workspaces are being renamed, removed
 * or archived right now in this backend.
 *
 * WorkspaceService sets and clears these Sets around rename(), remove() and archive(). They live
 * outside it so services split out of WorkspaceService (for example WorkspaceExternalEditors) can
 * read them from their own layer: a layer cannot reach the WorkspaceService instance. The core
 * graph builds one instance (WorkspaceLifecycleGatesLive) and every consumer shares it.
 */
export class WorkspaceLifecycleGates {
  /** Workspaces in rename(); streaming and new sends wait or refuse meanwhile. */
  readonly renaming = new Set<string>();
  /** Workspaces in remove(); new sessions, streams and commands refuse meanwhile. */
  readonly removing = new Set<string>();
  /**
   * Workspaces in archive(); runtime-affecting operations (e.g. SSH) must not wake a dedicated
   * workspace meanwhile.
   */
  readonly archiving = new Set<string>();
}
