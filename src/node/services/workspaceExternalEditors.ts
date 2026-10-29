/**
 * External editor opens of each workspace: the in-memory record, the durable
 * "external-editor-opened" marker under the session directory, this backend's "editor" use
 * lease, and the rollback of a failed launch.
 *
 * Moved out of WorkspaceService without logic changes. WorkspaceService keeps its public
 * methods as facades, and its archive, rename and removal gates ask
 * hasPendingExternalEditorOpen() and hasExternalEditorOpen().
 */
import * as path from "path";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { isSSHRuntime } from "@/common/types/runtime";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import {
  createRuntimeForWorkspace,
  ensureDaytonaSandboxReady,
} from "@/node/runtime/runtimeHelpers";
import type { HostFiles } from "@/node/services/hostFiles/hostFiles";
import { log } from "@/node/services/log";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceLifecycleGates } from "@/node/services/workspaceLifecycleGates";
import type { WorkspaceUseLease, WorkspaceUseLeases } from "@/node/services/workspaceUseLeases";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isErrnoWithCode } from "@/node/utils/fs";

const EXTERNAL_EDITOR_ROLLBACK_TOMBSTONE_CAP = 1024;

function isHomeRelativePath(remotePath: string | null | undefined): remotePath is string {
  return remotePath === "~" || remotePath?.startsWith("~/") === true;
}

export interface WorkspaceExternalEditorsDeps {
  readonly config: Pick<Config, "sessionsDir" | "loadConfigOrDefault">;
  /** The marker's file system: nodeHostFiles in the app, a memory host in unit tests. */
  readonly files: HostFiles;
  /** workspaceUseLeasesFor(config) in the app (one instance per Config). */
  readonly leases: Pick<WorkspaceUseLeases, "hold">;
  /** Shared with WorkspaceService: an open refuses while the workspace is being archived. */
  readonly gates: WorkspaceLifecycleGates;
}

export class WorkspaceExternalEditors {
  constructor(private readonly deps: WorkspaceExternalEditorsDeps) {}

  /**
   * Workspaces an external editor (VS Code/Cursor/Zed deep link or a custom editor command)
   * was opened for. Like native terminals, external editors are untrackable once open (deep
   * links leave no process handle; custom commands spawn detached), so opens are recorded
   * stickily in memory and as a durable per-workspace marker that survives app restarts.
   */
  private readonly externalEditorWorkspaces = new Set<string>();

  /** See recordExternalEditorOpenAdmitted (#4883). */
  private readonly externalEditorUseLeases = new Map<string, WorkspaceUseLease>();

  /**
   * Marker ancestry batches per workspace. A batch begins with a disk probe (did a durable
   * marker exist before this batch wrote one?) and collects one launch-evidence token per
   * recorded open; tokens are removed only by failed launches. When the last token of a
   * batch is removed, every open in the batch failed, so the batch's marker is deleted
   * unless it predated the batch (an earlier session's editor may still be running behind
   * it). Deep-link opens recorded via recordExternalEditorOpen retain their token forever
   * (they launch in the renderer immediately after recording and cannot report failures
   * back), pinning the marker. Probing per batch — not per call — prevents a marker written
   * by an earlier in-flight open of the same batch from masquerading as pre-existing
   * evidence when every open in the batch fails.
   */
  private readonly externalEditorMarkerBatches = new Map<
    string,
    { markerPreexisted: boolean; tokens: Set<symbol> }
  >();

  /**
   * Serializes marker writes against failed-launch rollbacks per workspace: an unserialized
   * rollback's unlink could interleave with a concurrent open's write and delete the marker
   * protecting that open's live editor.
   */
  private readonly externalEditorMarkerLocks = new MutexMap<string>();

  /**
   * Editor-open recordings currently in flight per workspace, counted synchronously at
   * entry and released when the recording settles. An in-flight recording has already
   * passed (or will synchronously fail) the admission checks and its launch follows without
   * rechecking, so hasExternalEditorOpen counts these alongside durable evidence — a
   * concurrent failed launch's rollback may collapse the shared marker and cache entry, and
   * without this count that collapse would make a still-recording sibling invisible to an
   * archive that then removes the environment beneath the launching editor. For editors this
   * backend launches itself, the count lasts until the launcher returns (launchExternalEditor).
   */
  private readonly pendingExternalEditorRecordings = new Map<string, number>();

  private externalEditorMarkerPath(workspaceId: string): string {
    return path.join(this.deps.config.sessionsDir, workspaceId, "external-editor-opened");
  }

  /**
   * Disk probe for the durable marker. "unknown" means the probe failed in a way that cannot
   * prove absence (EACCES, EIO, ...).
   */
  private async probeExternalEditorMarkerOnDisk(
    workspaceId: string
  ): Promise<"present" | "absent" | "unknown"> {
    try {
      await this.deps.files.promises.access(this.externalEditorMarkerPath(workspaceId));
      return "present";
    } catch (error) {
      return isErrnoWithCode(error, "ENOENT") ? "absent" : "unknown";
    }
  }

  /**
   * Rollback handles for renderer-recorded deep-link opens, keyed by the CLIENT-generated
   * launch token (client-side so the renderer can still redeem it when the recording
   * response is lost mid-connection — a backend-minted token would die with the response).
   * The renderer redeems a token via rollbackRecordedEditorOpen only when its launch
   * provably never happened (placeholder closed before navigation, or an ambiguous
   * recording RPC whose launch was abandoned). Entries for successful launches are retained
   * for the app session — they pin the batch token that keeps the durable marker protected.
   * A (buggy) reused token overwrites its old entry, whose pinned launch evidence then only
   * over-refuses (fail closed).
   */
  private readonly externalEditorLaunchRollbacks = new Map<
    string,
    { workspaceId: string; rollback: () => Promise<void> }
  >();

  /**
   * Rollback requests that arrived before their recording committed, keyed by launch token.
   * The renderer can observe a transport rejection of its recordEditorOpen RPC while the
   * backend handler is still awaiting marker persistence; its immediate rollback would find
   * no rollback entry, no-op, and the handler would then commit a durable marker for a
   * launch the renderer already abandoned — a false marker that permanently refuses future
   * model-driven archives. An unknown-token rollback therefore leaves a tombstone that the
   * recording consumes at commit time (in the same synchronous block that would register
   * the rollback entry), undoing its own admission instead of committing. Bounded FIFO:
   * tombstones whose recording never reached the backend are unredeemable, and evicting one
   * can at worst leave a sticky marker behind (over-refuses archives — fail closed).
   */
  private readonly externalEditorRollbackTombstones = new Map<string, string>();

  /**
   * Record that the user is opening this workspace in an external editor. Refuses while an
   * agent-driven archive is gating the workspace: the check shares the synchronous block with
   * the in-memory recording (mirroring TerminalService.openNative), so an archive gate armed
   * first refuses the open while an open recorded first is observed by the sink's
   * untrackable-app check before snapshot capture.
   */
  async recordExternalEditorOpen(
    workspaceId: string,
    launchToken: string,
    remotePath?: string | null
  ): Promise<Result<{ remotePath: string } | undefined>> {
    const admitted = await this.recordExternalEditorOpenForLaunch(workspaceId);
    if (!admitted.success) {
      return admitted;
    }
    // Before the tombstone check below: a rollback that arrives meanwhile is still consumed.
    const resolved = await this.resolveEditorRemotePath(workspaceId, remotePath);
    if (!resolved.success) {
      await admitted.data.rollbackAfterFailedLaunch();
      return resolved;
    }
    // A rollback for this token that raced ahead of the recording (the renderer saw the RPC
    // reject while this handler was still persisting the marker) is consumed here, in the
    // same synchronous block that would otherwise register the rollback entry: the renderer
    // has already abandoned the launch, so undo the admission instead of committing a marker
    // no editor will ever sit behind.
    if (this.externalEditorRollbackTombstones.get(launchToken) === workspaceId) {
      this.externalEditorRollbackTombstones.delete(launchToken);
      await admitted.data.rollbackAfterFailedLaunch();
      return Err(`Editor open for ${workspaceId} was rolled back before its recording finished.`);
    }
    // Deep-link opens launch in the renderer immediately after this returns; the rollback
    // entry lets the renderer report a launch that provably never happened so the marker
    // cannot outlive it (see externalEditorLaunchRollbacks for why the token is
    // client-generated). The in-flight count has already ended here, so this backend's own
    // rename or removal may still run before the client's hand-off. That is accepted (#4909):
    // the launch runs in another process, and the editor opens the folder asynchronously even
    // after the hand-off, which is the outcome those mutations already tolerate for an open editor.
    this.externalEditorLaunchRollbacks.set(launchToken, {
      workspaceId,
      rollback: admitted.data.rollbackAfterFailedLaunch,
    });
    return Ok(resolved.data);
  }

  /**
   * SSH workspaces whose runtime is provisioned after creation (Daytona, Coder) keep the
   * unresolved default srcBaseDir (`~/mux`), so their checkout path starts with `~`. An
   * editor's ssh deep link needs it absolute: resolve it on the host, which the admission
   * above has made ready. Older records keep working, since nothing is rewritten.
   */
  private async resolveEditorRemotePath(
    workspaceId: string,
    remotePath: string | null | undefined
  ): Promise<Result<{ remotePath: string } | undefined>> {
    if (!isHomeRelativePath(remotePath)) return Ok(undefined);
    const entry = findWorkspaceEntry(this.deps.config.loadConfigOrDefault(), workspaceId);
    const runtimeConfig = entry?.workspace.runtimeConfig;
    if (entry == null || !isSSHRuntime(runtimeConfig)) return Ok(undefined);
    try {
      const runtime = createRuntimeForWorkspace({
        id: workspaceId,
        runtimeConfig,
        projectPath: entry.projectPath,
        name: entry.workspace.name ?? workspaceId,
        namedWorkspacePath: entry.workspace.path,
      });
      return Ok({ remotePath: await runtime.resolvePath(remotePath) });
    } catch (error) {
      return Err(
        `Could not resolve ${remotePath} on the workspace's host: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Redeems a recordExternalEditorOpen launch token after the renderer's placeholder window
   * was closed before navigation (no editor launched). Idempotent for the renderer: unknown
   * or already redeemed tokens succeed without touching durable state (they only leave a
   * tombstone for a possibly in-flight recording), so renderer retries are safe.
   */
  async rollbackRecordedEditorOpen(
    workspaceId: string,
    launchToken: string
  ): Promise<Result<void>> {
    const entry = this.externalEditorLaunchRollbacks.get(launchToken);
    if (entry?.workspaceId !== workspaceId) {
      // Unknown token: the recording may still be in flight (its RPC rejected at the
      // transport while the handler awaits marker persistence). Tombstone the token so the
      // commit rolls itself back instead of persisting a marker for an abandoned launch
      // (see externalEditorRollbackTombstones). Already-redeemed or never-recorded tokens
      // leave an unredeemable tombstone the FIFO cap eventually evicts.
      this.externalEditorRollbackTombstones.set(launchToken, workspaceId);
      if (this.externalEditorRollbackTombstones.size > EXTERNAL_EDITOR_ROLLBACK_TOMBSTONE_CAP) {
        const oldest = this.externalEditorRollbackTombstones.keys().next().value;
        if (oldest != null) {
          this.externalEditorRollbackTombstones.delete(oldest);
        }
      }
      return Ok(undefined);
    }
    this.externalEditorLaunchRollbacks.delete(launchToken);
    await entry.rollback();
    return Ok(undefined);
  }

  /**
   * Like recordExternalEditorOpen, but for callers that launch the editor themselves and can
   * observe deterministic launch failures (the custom-editor route: EditorService validates
   * the command and spawns nothing on failure). A failed launch must call
   * rollbackAfterFailedLaunch so a marker this call created cannot become a sticky false
   * positive that permanently refuses future model-driven snapshot/Coder-stop archives.
   */
  async recordExternalEditorOpenForLaunch(
    workspaceId: string
  ): Promise<Result<{ rollbackAfterFailedLaunch: () => Promise<void> }>> {
    return this.withPendingExternalEditorOpen(workspaceId, () =>
      this.recordExternalEditorOpenAdmitted(workspaceId)
    );
  }

  /**
   * Records an editor open that this backend launches itself (a custom command) and runs
   * `launch` while the open still counts as in flight. This backend's own rename, removal and
   * checkout-deleting archive ignore its editor lease, so without the count they could move or
   * delete the checkout between the recording and the spawn (#4909), as for native terminals.
   * Deep-link opens cannot use this: they launch in the client after recordExternalEditorOpen.
   */
  async launchExternalEditor(
    workspaceId: string,
    launch: () => Promise<Result<void>>
  ): Promise<Result<void>> {
    return this.withPendingExternalEditorOpen(workspaceId, async () => {
      const recorded = await this.recordExternalEditorOpenAdmitted(workspaceId);
      if (!recorded.success) {
        // Refused (for example while a mutation holds the gate): never launch, never queue.
        return recorded;
      }
      const launched = await launch();
      if (!launched.success) {
        // Pre-spawn failures must not leave a marker that permanently blocks later archives.
        await recorded.data.rollbackAfterFailedLaunch();
      }
      return launched;
    });
  }

  private async withPendingExternalEditorOpen<T>(
    workspaceId: string,
    run: () => Promise<T>
  ): Promise<T> {
    // Pending-recording admission pairing (mirrors TerminalService.openNative): the count is
    // registered before any await — including the marker-lock wait, where a concurrent
    // failed launch's rollback may collapse the shared marker and cache entry — so
    // hasExternalEditorOpen stays true for the whole in-flight window. Refused recordings
    // record nothing durable; the count simply releases in the finally.
    this.pendingExternalEditorRecordings.set(
      workspaceId,
      (this.pendingExternalEditorRecordings.get(workspaceId) ?? 0) + 1
    );
    try {
      return await run();
    } finally {
      const remaining = (this.pendingExternalEditorRecordings.get(workspaceId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingExternalEditorRecordings.delete(workspaceId);
      } else {
        this.pendingExternalEditorRecordings.set(workspaceId, remaining);
      }
    }
  }

  /** Body of recordExternalEditorOpenForLaunch after pending-recording admission. */
  private async recordExternalEditorOpenAdmitted(
    workspaceId: string
  ): Promise<Result<{ rollbackAfterFailedLaunch: () => Promise<void> }>> {
    // Runs its synchronous checks in this call's synchronous prefix, like the inlined code did.
    const admitted = await this.admitExternalEditorUseLease(workspaceId);
    if (!admitted.success) {
      return admitted;
    }
    // Durable marker: the editor can outlive Xum, so a restart must not forget the open.
    // Persistence failure is fatal to the open (mirrors TerminalService.openNative): an
    // editor opened without the marker would be invisible to archive gating after a restart,
    // so refusing here is the only fail-closed option (the in-memory Set covers just this
    // app session).
    let admissionToken: symbol;
    try {
      admissionToken = await this.externalEditorMarkerLocks.withLock(workspaceId, () =>
        this.writeExternalEditorMarkerUnderLock(workspaceId)
      );
    } catch (error) {
      log.error("Failed to persist external editor marker", { workspaceId, error });
      return Err(
        `Cannot open an editor for ${workspaceId}: persisting the editor-open marker failed (${getErrorMessage(error)}), and without it archive safety checks would forget the editor after a restart.`
      );
    }
    return Ok({
      rollbackAfterFailedLaunch: () =>
        this.rollbackExternalEditorMarkerAfterFailedLaunch(workspaceId, admissionToken),
    });
  }

  /**
   * Admission checks of an editor open, then this backend's "editor" use lease: refuses while
   * the workspace is being archived, is unknown or is archived, and keeps one lease per
   * workspace. Has no durable effect.
   */
  private async admitExternalEditorUseLease(workspaceId: string): Promise<Result<void>> {
    if (this.deps.gates.archiving.has(workspaceId)) {
      return Err(
        `Workspace is being archived: ${workspaceId}. Unarchive it before opening an editor.`
      );
    }
    // Also a path-safety boundary: the marker path joins the raw ID beneath the sessions
    // directory, so an unknown (possibly traversal-crafted, e.g. "../../.ssh") ID must never
    // reach the filesystem, and it publishes no lease either (lease directories are not pruned).
    if (findWorkspaceEntry(this.deps.config.loadConfigOrDefault(), workspaceId) == null) {
      return Err(`Workspace not found: ${workspaceId}`);
    }
    // #4883: like a native terminal (see TerminalService.nativeTerminalUseLeases), an editor's
    // lifetime cannot be tracked, so this backend holds an "editor" use lease from the first
    // open until it archives or removes the workspace (WorkspaceService.releaseExternalAppUseLeases,
    // through takeExternalEditorUseLease) or exits.
    // #4902: every open takes a share before the row is read again below (it probes the gate),
    // so a rename, removal or archive can neither slip in between nor run meanwhile.
    let lease: WorkspaceUseLease;
    try {
      lease = await this.deps.leases.hold(workspaceId, "editor");
    } catch (error) {
      return Err(getErrorMessage(error));
    }
    const workspaceEntry = findWorkspaceEntry(this.deps.config.loadConfigOrDefault(), workspaceId);
    if (workspaceEntry == null) {
      await lease.release();
      return Err(`Workspace not found: ${workspaceId}`);
    }
    // Persisted archived state (not just an in-progress archive): a stale renderer can request
    // an editor for an already-archived workspace whose checkout may already be snapshot and
    // removed (mirrors TerminalService.openNative and the send/PTY/desktop admissions).
    // Checked before the durable marker write so a refused open cannot permanently gate
    // future snapshot archives of this workspace.
    if (
      isWorkspaceArchived(
        workspaceEntry.workspace.archivedAt,
        workspaceEntry.workspace.unarchivedAt
      )
    ) {
      await lease.release();
      return Err(`Workspace is archived: ${workspaceId}. Unarchive it before opening an editor.`);
    }
    // The editor connects to a Daytona sandbox's ssh alias on its own, so start a stopped
    // sandbox and refresh its token first. Only under the lease, as for a native terminal: an
    // archive cannot run meanwhile, so it cannot see the sandbox stopped and leave it running.
    // Before the durable marker write, so a refused open cannot gate future snapshot archives.
    const { workspace } = workspaceEntry;
    if (workspace.runtimeConfig != null) {
      const ready = await ensureDaytonaSandboxReady({
        id: workspaceId,
        runtimeConfig: workspace.runtimeConfig,
        projectPath: workspaceEntry.projectPath,
        name: workspace.name ?? workspaceId,
        namedWorkspacePath: workspace.path,
      });
      if (!ready.success) {
        await lease.release();
        return Err(ready.error);
      }
    }
    // Before any durable effect: one share per workspace is kept, after a failed launch too
    // (fail closed).
    if (this.externalEditorUseLeases.has(workspaceId)) {
      await lease.release();
    } else {
      this.externalEditorUseLeases.set(workspaceId, lease);
    }
    return Ok(undefined);
  }

  /**
   * Writes the durable marker and registers this open's launch evidence. Callers hold
   * externalEditorMarkerLocks for the workspace; it rejects when the marker cannot be persisted.
   */
  private async writeExternalEditorMarkerUnderLock(workspaceId: string): Promise<symbol> {
    // Batch-scoped ancestry (see externalEditorMarkerBatches): the pre-existence probe
    // runs once per batch, before the batch's first write, so a marker written by an
    // earlier in-flight open of this same batch cannot masquerade as evidence of a real
    // prior launch. "unknown" probes count as pre-existing (fail closed).
    let batch = this.externalEditorMarkerBatches.get(workspaceId);
    const createdBatch = batch == null;
    if (batch == null) {
      const preexisting = await this.probeExternalEditorMarkerOnDisk(workspaceId);
      batch = { markerPreexisted: preexisting !== "absent", tokens: new Set() };
      this.externalEditorMarkerBatches.set(workspaceId, batch);
    }
    const markerPath = this.externalEditorMarkerPath(workspaceId);
    try {
      await this.deps.files.promises.mkdir(path.dirname(markerPath), { recursive: true });
      await this.deps.files.promises.writeFile(markerPath, new Date().toISOString());
    } catch (error) {
      // A newly created, still-empty batch must not outlive a failed persistence attempt:
      // its probe (possibly a fail-closed "unknown" during the same filesystem hiccup)
      // would become stale ancestry for a later retry, permanently preserving a marker
      // that retry writes even when its launch fails. Discarding it makes the next
      // attempt re-probe the recovered disk. A joined batch keeps its live tokens.
      if (createdBatch && batch.tokens.size === 0) {
        this.externalEditorMarkerBatches.delete(workspaceId);
        // The failed write may still have created (or truncated) the marker file —
        // ENOSPC and I/O errors can reject after the open. When this batch's probe
        // proved absence, that artifact is ours and no launch backs it: left behind, it
        // reads as durable launch evidence across restarts and classifies as
        // pre-existing on retry. An "unknown" probe stays fail closed (never unlink
        // what might predate us); unlink failure only over-refuses archives.
        if (!batch.markerPreexisted) {
          try {
            await this.deps.files.promises.unlink(markerPath);
          } catch {
            // Best-effort (fail closed).
          }
        }
      }
      throw error;
    }
    // The sticky in-memory record is a cache of the just-written marker; before this
    // point the pending-recording count already keeps archive gates closed.
    this.externalEditorWorkspaces.add(workspaceId);
    // Launch evidence is registered under the same lock as the write so a concurrent
    // failed launch's rollback can never observe the marker without the token.
    const token = Symbol("external-editor-launch");
    batch.tokens.add(token);
    return token;
  }

  /**
   * Undo a failed editor launch's durable marker. The marker is deleted only when its whole
   * ancestry batch failed (no launch-evidence token remains, so no editor launched or can
   * still launch under it) and it did not predate the batch (an earlier session's editor may
   * still be running behind it). Serialized with marker writes so the unlink can never race
   * a concurrent open's write; deletion failure keeps the sticky marker (fail closed).
   */
  private async rollbackExternalEditorMarkerAfterFailedLaunch(
    workspaceId: string,
    token: symbol
  ): Promise<void> {
    await this.externalEditorMarkerLocks.withLock(workspaceId, async () => {
      const batch = this.externalEditorMarkerBatches.get(workspaceId);
      if (batch == null) {
        // Unknown batch (cannot happen: batches are only closed here): keep everything.
        return;
      }
      batch.tokens.delete(token);
      if (batch.tokens.size > 0) {
        return;
      }
      // Every open in the batch failed: close it so the next open starts a fresh probe.
      this.externalEditorMarkerBatches.delete(workspaceId);
      if (batch.markerPreexisted) {
        return;
      }
      try {
        await this.deps.files.promises.unlink(this.externalEditorMarkerPath(workspaceId));
      } catch (error) {
        if (!isErrnoWithCode(error, "ENOENT")) {
          // The marker may still exist, so the in-memory cache entry must stay to match it.
          log.error("Failed to roll back external editor marker after a failed launch", {
            workspaceId,
            error,
          });
          return;
        }
      }
      this.externalEditorWorkspaces.delete(workspaceId);
    });
  }

  async hasExternalEditorOpen(workspaceId: string): Promise<boolean> {
    // Recordings still in flight count as open: see pendingExternalEditorRecordings.
    if ((this.pendingExternalEditorRecordings.get(workspaceId) ?? 0) > 0) {
      return true;
    }
    if (this.externalEditorWorkspaces.has(workspaceId)) {
      return true;
    }
    const probe = await this.probeExternalEditorMarkerOnDisk(workspaceId);
    if (probe === "present") {
      this.externalEditorWorkspaces.add(workspaceId);
      return true;
    }
    // An "unknown" probe (EACCES, EIO, ...) cannot prove the marker is absent, and a false
    // "absent" would let a snapshot archive remove the checkout under a surviving editor —
    // fail closed without caching (the marker may still prove readable later).
    return probe !== "absent";
  }

  /**
   * Whether an editor-open recording is in flight for this workspace (see
   * pendingExternalEditorRecordings). Synchronous, for the gates that must decide in the same
   * tick as their probe.
   */
  hasPendingExternalEditorOpen(workspaceId: string): boolean {
    return (this.pendingExternalEditorRecordings.get(workspaceId) ?? 0) > 0;
  }

  /**
   * Hands this backend's editor use lease for the workspace to the caller and forgets it
   * (WorkspaceService.releaseExternalAppUseLeases releases it on archive or removal).
   */
  takeExternalEditorUseLease(workspaceId: string): WorkspaceUseLease | undefined {
    const lease = this.externalEditorUseLeases.get(workspaceId);
    this.externalEditorUseLeases.delete(workspaceId);
    return lease;
  }
}
