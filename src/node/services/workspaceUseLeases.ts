import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";

import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  acquireCrossProcessLock,
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
 * - A mutator publishes the gate, THEN scans the lease files (the gate helper).
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
   * Record that this backend uses the workspace until the returned lease is released. Throws
   * WorkspaceMutationInProgressError while a live mutator holds the workspace's gate; callers
   * must let it abort the activity (never swallow it), or the mutator's scan could miss them.
   */
  async hold(workspaceId: string, kind: WorkspaceUseKind): Promise<WorkspaceUseLease> {
    await this.transitions.withLock(workspaceId, async () => {
      const existing = this.held.get(workspaceId)?.get(kind);
      if (existing != null) {
        assert(existing.count > 0, "a tracked use lease file must have holders");
        existing.count++;
        return;
      }
      const lockPath = path.join(
        workspaceUseLockDir(this.rootDir, workspaceId),
        `${this.instanceToken}.${kind}.lock`
      );
      const release = await acquireCrossProcessLock({
        lockPath,
        acquireTimeoutMs: 0,
        staleMs: USE_LOCK_STALE_MS,
        timeoutMessage: `Workspace use lease ${lockPath} is unexpectedly held.`,
      });
      // Publish first, probe second: see the protocol above.
      const gate = await inspectCrossProcessLock(
        workspaceMutationLockPath(this.rootDir, workspaceId)
      );
      if (gate.state === "held") {
        await release();
        throw new WorkspaceMutationInProgressError(
          `Workspace ${workspaceId} is being renamed, removed or archived by ${gate.holder}; ` +
            `try again when it finishes (${gate.why}).`
        );
      }
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
