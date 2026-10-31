import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import type { Config } from "@/node/config";
import type { CompletedMessagePart, StreamEndEvent } from "@/common/types/stream";
import type { ParsedThinkingInput, ThinkingLevel } from "@/common/types/thinking";
import {
  BackgroundWorkAttentionPolicySchema,
  type BackgroundWorkAttentionPolicy,
} from "@/common/types/backgroundWorkAttention";
import {
  WorkspaceTurnFinalMessageRefSchema,
  type WorkspaceTurnFinalMessageRef,
} from "@/common/types/workspaceTurn";
import { log } from "@/node/services/log";
import { isErrnoWithCode } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import type { ProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";

export type { WorkspaceTurnFinalMessageRef };

export const WORKSPACE_TURN_TASK_ID_PREFIX = "wst_";
const TASK_HANDLES_DIR = "task-handles";
/**
 * A hold covers one handle read and write, plus the owner's mirror claim, a config edit that can
 * itself wait up to a minute for the project registration lock. A longer wait means a wedged holder.
 */
const WORKSPACE_TURN_PUBLICATION_LOCK_TIMEOUT_MS = 120_000;

export type WorkspaceTurnTaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "interrupted"
  | "error";

export type ActiveWorkspaceTurnTaskStatus = Extract<
  WorkspaceTurnTaskStatus,
  "queued" | "starting" | "running"
>;

const ACTIVE_WORKSPACE_TURN_TASK_STATUSES = new Set<WorkspaceTurnTaskStatus>([
  "queued",
  "starting",
  "running",
]);

export function isActiveWorkspaceTurnTaskStatus(
  status: WorkspaceTurnTaskStatus | null | undefined
): status is ActiveWorkspaceTurnTaskStatus {
  return status != null && ACTIVE_WORKSPACE_TURN_TASK_STATUSES.has(status);
}

export interface WorkspaceTurnTaskHandleRecord {
  kind: "workspace_turn";
  handleId: string;
  ownerWorkspaceId: string;
  workspaceId: string;
  turnId: string;
  status: WorkspaceTurnTaskStatus;
  createdAt: string;
  updatedAt: string;
  createdWorkspace: boolean;
  disposableWorkspace: boolean;
  title?: string;
  prompt?: string;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput | ThinkingLevel;
  messageId?: string;
  reportMarkdown?: string;
  finalMessageRef?: WorkspaceTurnFinalMessageRef;
  finalMessage?: {
    messageId: string;
    parts?: CompletedMessagePart[];
    metadata: StreamEndEvent["metadata"];
  };
  deferredMessageIds?: string[];
  error?: string;
  /**
   * How the owner workspace's stream-end treats this workspace turn while active.
   * Missing/legacy records default to `blocking_until_terminal`.
   */
  attentionPolicy?: BackgroundWorkAttentionPolicy;
  /**
   * ISO timestamp set only after a terminal `notify_on_terminal` wake-up was
   * accepted/sent for this handle. Restart-safe one-shot dedupe: a present marker
   * prevents a duplicate wake-up during stale recovery or duplicate settlement.
   */
  /** ISO timestamp proving a post-upgrade settlement requires direct-parent result delivery. */
  directParentResultDeliveryRequiredAt?: string;
  /** ISO timestamp set after that continuation result is delivered to its direct parent. */
  directParentResultDeliveredAt?: string;
  terminalAttentionNotifiedAt?: string;
}

const WorkspaceTurnTaskHandleRecordSchema = z
  .object({
    kind: z.literal("workspace_turn"),
    handleId: z.string().min(1),
    ownerWorkspaceId: z.string().min(1),
    workspaceId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.enum(["queued", "starting", "running", "completed", "interrupted", "error"]),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    createdWorkspace: z.boolean(),
    disposableWorkspace: z.boolean(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    modelString: z.string().optional(),
    thinkingLevel: z.unknown().optional(),
    messageId: z.string().optional(),
    reportMarkdown: z.string().optional(),
    finalMessageRef: WorkspaceTurnFinalMessageRefSchema.optional(),
    finalMessage: z
      .object({
        messageId: z.string().min(1),
        parts: z.array(z.unknown()).optional(),
        metadata: z.unknown(),
      })
      .passthrough()
      .optional(),
    deferredMessageIds: z.array(z.string().min(1)).optional(),
    error: z.string().optional(),
    attentionPolicy: BackgroundWorkAttentionPolicySchema.optional(),
    directParentResultDeliveryRequiredAt: z.string().optional(),
    directParentResultDeliveredAt: z.string().optional(),
    terminalAttentionNotifiedAt: z.string().optional(),
  })
  .strict();

const WORKSPACE_TURN_TASK_ID_PATTERN = /^wst_[a-z0-9][a-z0-9_-]*$/;

export function isWorkspaceTurnTaskId(
  value: unknown
): value is `${typeof WORKSPACE_TURN_TASK_ID_PREFIX}${string}` {
  return typeof value === "string" && WORKSPACE_TURN_TASK_ID_PATTERN.test(value);
}

function assertValidWorkspaceTurnTaskId(handleId: string): void {
  assert(
    isWorkspaceTurnTaskId(handleId),
    "workspace turn handle IDs must use the wst_ prefix and safe filename characters"
  );
}

/**
 * dev, ino, size, mtime and ctime of a file or directory. Any write changes them: an atomic
 * replace brings a new inode, and an in-place write (builds before #4413) moves the stamps. An
 * equal fingerprint means nothing was written there in between. That holds only for stamps older
 * than the timestamp granularity at the first stat (git's racy-clean rule): `null` marks an
 * observation too recent to vouch for anything, and never matches.
 */
type Fingerprint = string;

interface HandleScanRow {
  readonly handleId: string;
  readonly file: Fingerprint | null;
  /** null: corrupt, schema-rejected or mismatched. Such a row is never selected. */
  readonly status: WorkspaceTurnTaskStatus | null;
}

/**
 * What the last scan saw in one owner's session directory. An owner without task-handles has no
 * rows, proven by its session directory, which creating task-handles changes. An owner with
 * task-handles is re-listed on every scan and each row is proven by its own file's fingerprint:
 * a directory's stamps miss in-place writes. Only primitives: parsed records would pin every
 * owner's history (F29), and callers mutate the records a scan returns.
 */
type OwnerScanIndex =
  | {
      readonly provenBy: "session-dir";
      readonly proof: Fingerprint | null;
      readonly rows: readonly [];
    }
  | {
      readonly provenBy: "handle-files";
      readonly rows: readonly HandleScanRow[];
    };

interface ScanContext {
  /** null selects every status. */
  readonly statuses: ReadonlySet<WorkspaceTurnTaskStatus> | null;
  readonly startMs: number;
}

/** FAT's 2 s stamps are the coarsest local filesystem; 1 s more covers clock slew. */
const RACY_TIMESTAMP_MARGIN_MS = 3_000;

function fingerprintIfSafe(stats: fs.BigIntStats, scanStartMs: number): Fingerprint | null {
  const racyFromNs = BigInt(Math.floor(scanStartMs - RACY_TIMESTAMP_MARGIN_MS)) * 1_000_000n;
  if (stats.mtimeNs >= racyFromNs || stats.ctimeNs >= racyFromNs) return null;
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

function isSelected(
  scan: ScanContext,
  status: WorkspaceTurnTaskStatus | null
): status is WorkspaceTurnTaskStatus {
  return status != null && (scan.statuses == null || scan.statuses.has(status));
}

async function unlessMissing<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return null;
    throw error;
  }
}

export class TaskHandleStore {
  private readonly scanIndex = new Map<string, OwnerScanIndex>();
  /** Bumped after each write by this store, so a scan that overlapped it publishes no proof. */
  private readonly writeGenerations = new Map<string, number>();
  private readonly now: () => number;

  /**
   * `locks` takes the publication lock (phase 4: SessionLocks). The workspace-turn manager passes
   * its history service's locks; other callers keep the Node default. `now` is the wall clock the
   * global scan compares file stamps with.
   */
  constructor(
    private readonly config: Config,
    private readonly locks: SessionLocks = nodeSessionLocks,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async upsertWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void> {
    this.assertValidRecord(record);
    const dir = this.getOwnerHandleDir(record.ownerWorkspaceId);
    await fsPromises.mkdir(dir, { recursive: true });
    try {
      // Replace atomically. Waiters, task_await and task_list read handles without the settlement
      // lock, and a truncate-then-write update let them see an empty file, which reads as a missing
      // handle ("Workspace turn not found or out of scope", coder/xum#4410).
      await writeFileAtomic(
        this.getHandlePath(record.ownerWorkspaceId, record.handleId),
        JSON.stringify(record, null, 2)
      );
    } finally {
      // Also on failure: the rename can land before a failing directory fsync. A first write
      // creates task-handles, and the session directory's stamps alone cannot prove that visible:
      // they can share a timestamp tick with the last scan.
      this.forgetScannedHandle(record.ownerWorkspaceId);
    }
  }

  /**
   * Whether the handle file still holds `record`'s outcome generation: the same turn, status and
   * updatedAt. Every outcome write mints a fresh updatedAt; metadata-only writes after settlement
   * (attention policy, delivery markers) keep it, so they do not count as replacing the record.
   * Synchronous so a caller can test it inside a config edit transform (#4926). A missing or
   * corrupt file reads as replaced; other read errors propagate, as in getWorkspaceTurn.
   */
  stillHoldsWorkspaceTurnGenerationSync(record: WorkspaceTurnTaskHandleRecord): boolean {
    let current: unknown;
    try {
      current = JSON.parse(
        // eslint-disable-next-line local/no-sync-fs-methods -- callers check inside a synchronous config edit transform, under its lock (#4926).
        fs.readFileSync(this.getHandlePath(record.ownerWorkspaceId, record.handleId), "utf-8")
      );
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || error instanceof SyntaxError) return false;
      throw error;
    }
    const held = current as Partial<WorkspaceTurnTaskHandleRecord> | null;
    return (
      held?.turnId === record.turnId &&
      held.status === record.status &&
      held.updatedAt === record.updatedAt
    );
  }

  /**
   * #5362: run `fn` holding a per-handle cross-process lock, so a read-then-write of the handle
   * cannot interleave with another backend's read-then-write of the same handle. Hold it only
   * across the read, the write and the config edits that must commit with them; never across
   * sends, and never take it again inside `fn` (it is not reentrant). The lock file exists only
   * while held: release unlinks it.
   */
  async withWorkspaceTurnPublicationLock<T>(
    handleId: string,
    fn: (lock: ProcessFileLock) => Promise<T>
  ): Promise<T> {
    assertValidWorkspaceTurnTaskId(handleId);
    await using lock = await this.locks.acquireProcessFileLock({
      lockPath: path.join(
        this.config.rootDir,
        "locks",
        "workspace-turn-publications",
        `${handleId}.lock`
      ),
      timeoutMs: WORKSPACE_TURN_PUBLICATION_LOCK_TIMEOUT_MS,
      label: "workspace turn publication lock",
    });
    return await fn(lock);
  }

  async updateWorkspaceTurn(
    ownerWorkspaceId: string,
    handleId: string,
    mutator: (record: WorkspaceTurnTaskHandleRecord) => WorkspaceTurnTaskHandleRecord
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    assert(ownerWorkspaceId.trim().length > 0, "updateWorkspaceTurn requires ownerWorkspaceId");
    assert(handleId.trim().length > 0, "updateWorkspaceTurn requires handleId");
    const current = await this.getWorkspaceTurn(ownerWorkspaceId, handleId);
    if (current == null) {
      return null;
    }
    const next = mutator(current);
    await this.upsertWorkspaceTurn(next);
    return next;
  }

  async getWorkspaceTurn(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    assert(ownerWorkspaceId.trim().length > 0, "getWorkspaceTurn requires ownerWorkspaceId");
    assert(handleId.trim().length > 0, "getWorkspaceTurn requires handleId");
    if (!isWorkspaceTurnTaskId(handleId)) {
      return null;
    }
    const record = await this.readWorkspaceTurnFile(ownerWorkspaceId, handleId);
    return record?.ownerWorkspaceId === ownerWorkspaceId ? record : null;
  }

  /**
   * Whether a record file exists for the handle, readable or not (#4983). getWorkspaceTurn()
   * answers null for a corrupt record and for one a newer build wrote (strict schema), so only
   * this proves a handle never persisted. Errors other than ENOENT propagate (fail closed).
   */
  async hasWorkspaceTurnFile(ownerWorkspaceId: string, handleId: string): Promise<boolean> {
    try {
      await fsPromises.lstat(this.getHandlePath(ownerWorkspaceId, handleId));
      return true;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  async listWorkspaceTurns(
    ownerWorkspaceId: string,
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    assert(ownerWorkspaceId.trim().length > 0, "listWorkspaceTurns requires ownerWorkspaceId");
    const dir = this.getOwnerHandleDir(ownerWorkspaceId);
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      throw error;
    }

    const statuses = options.statuses != null ? new Set(options.statuses) : null;
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -".json".length))
        .filter(isWorkspaceTurnTaskId)
        .map((handleId) => this.readWorkspaceTurnFile(ownerWorkspaceId, handleId))
    );
    return records
      .filter((record): record is WorkspaceTurnTaskHandleRecord => {
        if (record == null) return false;
        return statuses == null || statuses.has(record.status);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listAllWorkspaceTurns(
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    return (await this.scanAllWorkspaceTurns(options)).records;
  }

  /**
   * listAllWorkspaceTurns plus whether every owner directory was read. A skipped (unreadable)
   * directory still yields the other owners' records; `complete` lets a caller that must see every
   * record, such as the startup stale-turn sweep, retry later instead of trusting a partial pass.
   */
  async scanAllWorkspaceTurns(
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<{ records: WorkspaceTurnTaskHandleRecord[]; complete: boolean }> {
    const scanStartMs = this.now();
    assert(Number.isFinite(scanStartMs), "TaskHandleStore clock must return finite milliseconds");
    let entries: Array<{ isDirectory: () => boolean; name: string }>;
    try {
      entries = await fsPromises.readdir(this.config.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return { records: [], complete: true };
      throw error;
    }

    const scan: ScanContext = {
      statuses: options.statuses != null ? new Set(options.statuses) : null,
      startMs: scanStartMs,
    };
    const owners = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    let complete = true;
    const recordsByOwner = await Promise.all(
      owners.map(async (ownerWorkspaceId) => {
        try {
          return await this.scanOwnerWorkspaceTurns(ownerWorkspaceId, scan);
        } catch (error: unknown) {
          // Startup reconciliation is best-effort: one unreadable session must not prevent every
          // other workspace (or the app itself) from loading.
          log.warn("Skipping unreadable workspace-turn handle directory", {
            ownerWorkspaceId,
            error,
          });
          this.scanIndex.delete(ownerWorkspaceId);
          complete = false;
          return [];
        }
      })
    );
    const listed = new Set(owners);
    for (const ownerWorkspaceId of this.scanIndex.keys()) {
      if (!listed.has(ownerWorkspaceId)) this.scanIndex.delete(ownerWorkspaceId);
    }
    return {
      records: recordsByOwner.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      complete,
    };
  }

  /** One owner's selected records in readdir order. Throws when the owner is unreadable. */
  private async scanOwnerWorkspaceTurns(
    ownerWorkspaceId: string,
    scan: ScanContext
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    const generation = this.writeGenerations.get(ownerWorkspaceId);
    const previous = this.scanIndex.get(ownerWorkspaceId);
    if (await this.stillHasNoHandles(ownerWorkspaceId, previous, scan)) return [];

    const parsed = new Map<string, WorkspaceTurnTaskHandleRecord>();
    const index = await this.refreshOwnerScanIndex(ownerWorkspaceId, previous, scan, parsed);
    const overlappedWrite = this.writeGenerations.get(ownerWorkspaceId) !== generation;
    if (index == null || (index.provenBy === "session-dir" && overlappedWrite)) {
      this.scanIndex.delete(ownerWorkspaceId);
    } else {
      this.scanIndex.set(ownerWorkspaceId, index);
    }
    return index == null
      ? []
      : await this.readSelectedHandles(ownerWorkspaceId, index.rows, scan, parsed);
  }

  private async stillHasNoHandles(
    ownerWorkspaceId: string,
    entry: OwnerScanIndex | undefined,
    scan: ScanContext
  ): Promise<boolean> {
    if (entry?.provenBy !== "session-dir" || entry.proof == null) return false;
    const stats = await unlessMissing(
      fsPromises.stat(path.join(this.config.sessionsDir, ownerWorkspaceId), { bigint: true })
    );
    return stats != null && fingerprintIfSafe(stats, scan.startMs) === entry.proof;
  }

  /**
   * Re-list one owner, re-reading only the handle files whose fingerprint changed, and add the
   * selected records it read to `parsed`. Each stamp is taken before the content it vouches for,
   * so a write that lands mid-scan leaves a stale fingerprint and the next scan re-reads. Returns
   * null when the session directory is gone.
   */
  private async refreshOwnerScanIndex(
    ownerWorkspaceId: string,
    previous: OwnerScanIndex | undefined,
    scan: ScanContext,
    parsed: Map<string, WorkspaceTurnTaskHandleRecord>
  ): Promise<OwnerScanIndex | null> {
    const sessionStats = await unlessMissing(
      fsPromises.stat(path.join(this.config.sessionsDir, ownerWorkspaceId), { bigint: true })
    );
    if (sessionStats == null) return null;
    const entries = await unlessMissing(fsPromises.readdir(this.getOwnerHandleDir(ownerWorkspaceId)));
    if (entries == null) {
      const proof = fingerprintIfSafe(sessionStats, scan.startMs);
      return { provenBy: "session-dir", proof, rows: [] };
    }

    const known = new Map(previous?.rows.map((row) => [row.handleId, row]));
    const rows = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => entry.slice(0, -".json".length))
        .filter(isWorkspaceTurnTaskId)
        .map((handleId) =>
          this.scanHandleFile(ownerWorkspaceId, handleId, known.get(handleId), scan, parsed)
        )
    );
    return {
      provenBy: "handle-files",
      rows: rows.filter((row): row is HandleScanRow => row != null),
    };
  }

  private async scanHandleFile(
    ownerWorkspaceId: string,
    handleId: string,
    known: HandleScanRow | undefined,
    scan: ScanContext,
    parsed: Map<string, WorkspaceTurnTaskHandleRecord>
  ): Promise<HandleScanRow | null> {
    const stats = await unlessMissing(
      fsPromises.stat(this.getHandlePath(ownerWorkspaceId, handleId), { bigint: true })
    );
    if (stats == null) return null;
    const file = fingerprintIfSafe(stats, scan.startMs);
    if (file != null && known?.file === file) return known;
    const record = await this.readWorkspaceTurnFile(ownerWorkspaceId, handleId);
    if (record != null && isSelected(scan, record.status)) parsed.set(handleId, record);
    return { handleId, file, status: record == null ? null : record.status };
  }

  /**
   * The selected rows' records: `parsed` when this scan read the file, else a fresh read whose
   * status is checked again, since the indexed status can predate the file.
   */
  private async readSelectedHandles(
    ownerWorkspaceId: string,
    rows: readonly HandleScanRow[],
    scan: ScanContext,
    parsed: ReadonlyMap<string, WorkspaceTurnTaskHandleRecord>
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    const records = await Promise.all(
      rows
        .filter((row) => isSelected(scan, row.status))
        .map(
          async (row) =>
            parsed.get(row.handleId) ??
            (await this.readWorkspaceTurnFile(ownerWorkspaceId, row.handleId))
        )
    );
    return records.filter(
      (record): record is WorkspaceTurnTaskHandleRecord =>
        record != null && isSelected(scan, record.status)
    );
  }

  /** Rows need nothing here: the write gives the handle file a new inode. */
  private forgetScannedHandle(ownerWorkspaceId: string): void {
    this.writeGenerations.set(
      ownerWorkspaceId,
      (this.writeGenerations.get(ownerWorkspaceId) ?? 0) + 1
    );
    if (this.scanIndex.get(ownerWorkspaceId)?.provenBy === "session-dir") {
      this.scanIndex.delete(ownerWorkspaceId);
    }
  }

  async isWorkspaceOwnedBy(ownerWorkspaceId: string, workspaceId: string): Promise<boolean> {
    assert(ownerWorkspaceId.trim().length > 0, "isWorkspaceOwnedBy requires ownerWorkspaceId");
    assert(workspaceId.trim().length > 0, "isWorkspaceOwnedBy requires workspaceId");
    const records = await this.listWorkspaceTurns(ownerWorkspaceId);
    return records.some((record) => record.createdWorkspace && record.workspaceId === workspaceId);
  }

  private getOwnerHandleDir(ownerWorkspaceId: string): string {
    assert(ownerWorkspaceId.trim().length > 0, "ownerWorkspaceId must be non-empty");
    return path.join(this.config.sessionsDir, ownerWorkspaceId, TASK_HANDLES_DIR);
  }

  private getHandlePath(ownerWorkspaceId: string, handleId: string): string {
    assert(handleId.trim().length > 0, "handleId must be non-empty");
    assertValidWorkspaceTurnTaskId(handleId);
    return path.join(this.getOwnerHandleDir(ownerWorkspaceId), `${handleId}.json`);
  }

  private assertValidRecord(record: WorkspaceTurnTaskHandleRecord): void {
    const parsed = WorkspaceTurnTaskHandleRecordSchema.safeParse(record);
    assert(
      parsed.success,
      `Invalid workspace turn handle record: ${parsed.success ? "" : parsed.error.message}`
    );
    assertValidWorkspaceTurnTaskId(record.handleId);
  }

  private async readWorkspaceTurnFile(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    try {
      const raw = await fsPromises.readFile(
        this.getHandlePath(ownerWorkspaceId, handleId),
        "utf-8"
      );
      const parsedJson = JSON.parse(raw) as unknown;
      const parsed = WorkspaceTurnTaskHandleRecordSchema.safeParse(parsedJson);
      if (!parsed.success) {
        log.warn("Ignoring unreadable workspace turn task handle", {
          ownerWorkspaceId,
          handleId,
          issues: parsed.error.issues,
        });
        return null;
      }
      if (
        parsed.data.handleId !== handleId ||
        parsed.data.ownerWorkspaceId !== ownerWorkspaceId ||
        !isWorkspaceTurnTaskId(parsed.data.handleId)
      ) {
        log.warn("Ignoring mismatched workspace turn task handle", {
          ownerWorkspaceId,
          handleId,
          recordOwnerWorkspaceId: parsed.data.ownerWorkspaceId,
          recordHandleId: parsed.data.handleId,
        });
        return null;
      }
      return parsed.data as WorkspaceTurnTaskHandleRecord;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || error instanceof SyntaxError) {
        if (error instanceof SyntaxError) {
          log.warn("Ignoring corrupt workspace turn task handle", { ownerWorkspaceId, handleId });
        }
        return null;
      }
      throw error;
    }
  }
}
