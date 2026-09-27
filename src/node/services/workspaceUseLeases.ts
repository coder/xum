import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { getErrorMessage } from "@/common/utils/errors";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";

import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  acquireCrossProcessLock,
  CrossProcessLockTimeoutError,
  inspectCrossProcessLock,
} from "@/node/utils/main/crossProcessLock";

/**
 * Cross-process evidence that a backend is using a workspace (#4476).
 *
 * Two backends can share one Xum root (the desktop app beside a `xum server`, or
 * XUM_ALLOW_MULTIPLE_INSTANCES), and both may use one workspace at the same time. What must not
 * happen is a structural mutation (rename, remove, archive with delete or snapshot) moving or
 * deleting a checkout under the other backend's live activity, which it cannot see in memory.
 *
 * Protocol (Dekker ordering on atomic lock-file publications):
 * - A user publishes its lease file, THEN probes the workspace's mutation gate; a live gate makes
 *   it withdraw the lease and throw WorkspaceMutationInProgressError.
 * - A mutator publishes the gate, THEN scans the lease files (withMutationGate).
 * So at least one side always observes the other. Nobody waits on another process: both sides
 * refuse instead, and every lock dies with its process under the kit's liveness contract.
 *
 * Why one file per (backend, kind): crossProcessLock is single-holder, so shared use needs one
 * file per holder, and the kind in the name lets a refusal say what is running without a new
 * record schema. The path is unique to this instance, so acquiring it never contends.
 */
export type WorkspaceUseKind = "turn" | "terminal" | "init" | "mcp" | "exec";

/** Thrown by hold() while a structural mutation of the workspace is in progress. */
export class WorkspaceMutationInProgressError extends Error {}

/** Thrown by withMutationGate() when the workspace is in use or already being mutated. */
export class WorkspaceBusyError extends Error {}

export interface WorkspaceMutationGateOptions {
  /**
   * Per workspace, this backend's own lease kinds that do not block the mutation, because the
   * mutator ends or tolerates them itself (remove closes its own terminals, for example). Keyed by
   * workspace: a mutator usually ends activity only in the workspace it mutates, not in sub-agents
   * sharing its checkout. Other backends' leases always block: this backend cannot stop them.
   */
  ignoreOwnKinds?: ReadonlyMap<string, ReadonlySet<WorkspaceUseKind>>;
  /**
   * Background processes leave their own cross-process evidence (spawn records), so the gate asks
   * instead of leasing: true when any runs in the workspace, in this or any other process.
   */
  hasRunningBackgroundProcesses: (workspaceId: string) => Promise<boolean>;
}

export interface WorkspaceUseLease {
  /** Idempotent: a second call never releases another holder's share. */
  release(): Promise<void>;
}

/** Renewal cadence for the lock kit only (new locks: no older build reclaims them by age). */
const USE_LOCK_STALE_MS = 5 * 60 * 1000;

// Always a digest: ids from older builds can contain path separators, be "." or "..", exceed a
// file name's length, differ only in case (aliases on case-insensitive filesystems) or be
// reserved names on Windows. Lowercase hex of fixed length is none of these.
// UTF-16 code units are hashed as-is: UTF-8 would map distinct lone surrogates to one byte string.
const safeName = (workspaceId: string) =>
  createHash("sha256").update(Buffer.from(workspaceId, "utf16le")).digest("hex");

/** Directory holding every backend's use-lease files for one workspace. */
export function workspaceUseLockDir(rootDir: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "workspaceUseLockDir requires a workspace id");
  return path.join(rootDir, "locks", "workspace-use", safeName(workspaceId));
}

/** The per-workspace mutation gate a structural mutator holds while it runs. */
export function workspaceMutationLockPath(rootDir: string, workspaceId: string): string {
  assert(workspaceId.length > 0, "workspaceMutationLockPath requires a workspace id");
  return path.join(rootDir, "locks", "workspace-mutation", `${safeName(workspaceId)}.lock`);
}

interface HeldFile {
  count: number;
  release: () => Promise<void>;
}

/** One instance per backend (ServiceContainer). */
export class WorkspaceUseLeases {
  /** Names this backend's lease files; distinct per instance, so two stacks never share one. */
  readonly instanceToken = randomUUID();
  private readonly held = new Map<string, Map<WorkspaceUseKind, HeldFile>>();
  // Serializes a workspace's 0→1 and 1→0 transitions (they await file I/O).
  private readonly transitions = new MutexMap<string>();

  constructor(private readonly rootDir: string) {
    assert(rootDir.length > 0, "WorkspaceUseLeases requires a root directory");
  }

  /** How many holds this backend has on the workspace (of one kind, or of every kind). */
  heldCount(workspaceId: string, kind?: WorkspaceUseKind): number {
    const files = this.held.get(workspaceId);
    if (files == null) return 0;
    if (kind != null) return files.get(kind)?.count ?? 0;
    let total = 0;
    for (const file of files.values()) total += file.count;
    return total;
  }

  /**
   * Run a structural mutation (rename, remove, archive with delete or snapshot) of the given
   * workspaces, or throw WorkspaceBusyError without running it. The caller lists every workspace
   * whose activity the mutation would disturb (children sharing the checkout, too). Never waits:
   * the gate is try-locked, and any live use refuses. The gates stay held until `fn` settles, so
   * no backend can start a leased activity in these workspaces meanwhile (hold() refuses).
   */
  async withMutationGate<T>(
    workspaceIds: readonly string[],
    options: WorkspaceMutationGateOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const release = await this.acquireMutationGate(workspaceIds, options);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /**
   * withMutationGate() for mutators whose protected section is not one callback (rename and
   * archive release their other locks in an existing finally): the caller must await the
   * returned release once the mutation settles.
   */
  async acquireMutationGate(
    workspaceIds: readonly string[],
    options: WorkspaceMutationGateOptions
  ): Promise<() => Promise<void>> {
    assert(workspaceIds.length > 0, "acquireMutationGate requires at least one workspace");
    // Sorted, so two mutators over overlapping sets take the gates in one order.
    const ids = [...new Set(workspaceIds)].sort();
    const releases: Array<() => Promise<void>> = [];
    // Every gate is released even if one release fails; the first failure is rethrown.
    const releaseAll = async () => {
      const results = [];
      for (const release of [...releases].reverse()) {
        results.push(
          await release().then(
            () => undefined,
            (error: unknown) => ({ error })
          )
        );
      }
      const failed = results.find((result) => result != null);
      if (failed != null) throw failed.error;
    };
    try {
      for (const id of ids) {
        try {
          releases.push(
            await acquireCrossProcessLock({
              lockPath: workspaceMutationLockPath(this.rootDir, id),
              acquireTimeoutMs: 0,
              staleMs: USE_LOCK_STALE_MS,
              timeoutMessage: `Workspace ${id} is already being renamed, removed or archived.`,
            })
          );
        } catch (error) {
          if (error instanceof CrossProcessLockTimeoutError) {
            throw new WorkspaceBusyError(error.message);
          }
          throw error;
        }
      }
      // Gates published: now scan the uses (see the protocol above). This backend's own lease
      // files are judged by their counts, read under the transition lock: a hold that published
      // its file and probed the gate before it existed has not counted itself yet, and would
      // otherwise be missed. Once the lock is free, every later transition sees the gate.
      for (const id of ids) {
        await this.transitions.withLock(id, () => this.assertUnused(id, options));
      }
    } catch (error) {
      await releaseAll();
      throw error;
    }
    let released: Promise<void> | undefined;
    return () => (released ??= releaseAll());
  }

  private async assertUnused(
    workspaceId: string,
    options: WorkspaceMutationGateOptions
  ): Promise<void> {
    // The held entries themselves, so no kind can be left out of the check.
    for (const [kind, file] of this.held.get(workspaceId) ?? []) {
      if (options.ignoreOwnKinds?.get(workspaceId)?.has(kind) === true) continue;
      if (file.count > 0) {
        throw new WorkspaceBusyError(
          `Workspace ${workspaceId} has a running ${kind} in this Xum process; ` +
            "try again when it finishes."
        );
      }
    }
    const dir = workspaceUseLockDir(this.rootDir, workspaceId);
    let names: string[];
    try {
      names = await fsPromises.readdir(dir);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        names = [];
      } else {
        // Leases exist but cannot be listed: their holders cannot be ruled out.
        throw new WorkspaceBusyError(
          `Workspace ${workspaceId}'s use records in ${dir} cannot be read, so another Xum ` +
            `process may be using it (${getErrorMessage(error)}).`
        );
      }
    }
    for (const name of names) {
      // Only published lease files: the kit's temp and takeover-guard files end differently.
      if (!name.endsWith(".lock") || name.startsWith(`${this.instanceToken}.`)) continue;
      const probe = await inspectCrossProcessLock(path.join(dir, name));
      // A dead holder's file is left alone: only its own path's owner ever writes it.
      if (probe.state !== "held") continue;
      const kind = name.split(".").at(-2) ?? "activity";
      throw new WorkspaceBusyError(
        `Workspace ${workspaceId} is in use by another Xum process: a ${kind} in ` +
          `${probe.holder}; try again when it finishes (${probe.why}).`
      );
    }
    if (await options.hasRunningBackgroundProcesses(workspaceId)) {
      throw new WorkspaceBusyError(
        `Workspace ${workspaceId} has a running background process (in this, another or a ` +
          "crashed Xum process); stop it and try again."
      );
    }
  }

  /**
   * Record that this backend uses the workspace until the returned lease is released. Throws
   * WorkspaceMutationInProgressError while a live mutator holds the workspace's gate; callers
   * must let it abort the activity (never swallow it), or the mutator's scan could miss them.
   */
  async hold(workspaceId: string, kind: WorkspaceUseKind): Promise<WorkspaceUseLease> {
    await this.transitions.withLock(workspaceId, async () => {
      const existing = this.held.get(workspaceId)?.get(kind);
      assert(existing == null || existing.count > 0, "a tracked use lease file must have holders");
      let release: (() => Promise<void>) | undefined;
      if (existing == null) {
        const lockPath = path.join(
          workspaceUseLockDir(this.rootDir, workspaceId),
          `${this.instanceToken}.${kind}.lock`
        );
        release = await acquireCrossProcessLock({
          lockPath,
          acquireTimeoutMs: 0,
          staleMs: USE_LOCK_STALE_MS,
          timeoutMessage: `Workspace use lease ${lockPath} is unexpectedly held.`,
        });
      }
      // Publish first, probe second: see the protocol above. A nested hold (file already
      // published) probes too: a mutator that ignores this kind of this backend's own activity
      // (remove closing its terminals) must not see a new one admitted behind its scan.
      const gate = await inspectCrossProcessLock(
        workspaceMutationLockPath(this.rootDir, workspaceId)
      );
      if (gate.state === "held") {
        await release?.();
        throw new WorkspaceMutationInProgressError(
          `Workspace ${workspaceId} is being renamed, removed or archived by ${gate.holder}; ` +
            `try again when it finishes (${gate.why}).`
        );
      }
      if (existing != null) {
        existing.count++;
        return;
      }
      assert(release != null, "a first hold publishes its lease file");
      const files = this.held.get(workspaceId) ?? new Map<WorkspaceUseKind, HeldFile>();
      files.set(kind, { count: 1, release });
      this.held.set(workspaceId, files);
    });

    // Idempotent, and concurrent callers share (and await) the one release.
    let releasing: Promise<void> | undefined;
    return {
      release: () =>
        (releasing ??= this.transitions.withLock(workspaceId, async () => {
          const files = this.held.get(workspaceId);
          const file = files?.get(kind);
          assert(
            files != null && file != null && file.count > 0,
            `use lease ${kind} over-released`
          );
          file.count--;
          if (file.count === 0) {
            files.delete(kind);
            if (files.size === 0) this.held.delete(workspaceId);
            await file.release();
          }
        })),
    };
  }
}

const leasesByBackend = new WeakMap<object, WorkspaceUseLeases>();

/**
 * This backend's WorkspaceUseLeases. A backend is identified by its Config instance: each
 * ServiceContainer (and each CLI run) owns exactly one, and the services that start activities
 * (AgentSession, TerminalService) all share it without extra wiring.
 */
export function workspaceUseLeasesFor(config: { readonly rootDir: string }): WorkspaceUseLeases {
  let leases = leasesByBackend.get(config);
  if (leases == null) {
    leases = new WorkspaceUseLeases(config.rootDir);
    leasesByBackend.set(config, leases);
  }
  return leases;
}
