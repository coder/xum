import * as path from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import type { SessionLocks } from "@/node/services/sessionLocks/sessionLocks";
import type { SessionFiles } from "@/node/services/sessionFiles/sessionFiles";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { addModelUsage, sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getAssistantMessageModelUsages } from "@/common/utils/tokens/messageModelUsages";
import {
  normalizeUsage,
  withCacheWriteMetadata,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";
import type { RolledUpChildEntry } from "@/common/orpc/schemas/chatStats";
import {
  ChatUsageDisplaySchema,
  SessionUsageFileSchema,
  SessionUsageTokenStatsCacheSchema,
} from "@/common/orpc/schemas/chatStats";
import {
  getSelfIdentity,
  judgeHolder,
  parseProcessIdentity,
} from "@/node/utils/concurrency/processLiveness";
import { isErrnoWithCode } from "@/node/utils/fs";
import { buildAgentTaskIndex } from "@/node/services/agentTaskIndex";
import type { TokenConsumer } from "@/common/types/chatStats";
import { HEADLESS_USAGE_FILE_NAME } from "@/common/constants/paths";
import type { MuxMessage } from "@/common/types/message";
import {
  normalizeUsageModelKey,
  resolveModelForMetadata,
} from "@/common/utils/providers/modelEntries";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { log } from "./log";

export interface SessionUsageTokenStatsCacheV1 {
  /**
   * Schema version for this cache block.
   * (Kept separate so we don't have to bump session-usage.json version for derived fields.)
   */
  version: 1;

  computedAt: number;

  /**
   * Stable fingerprint of provider config used when this cache was computed.
   * Optional for backward compatibility with pre-fingerprint cache entries.
   */
  providersConfigVersion?: number;

  /** Tokenization model (impacts tokenizer + tool definition counting) */
  model: string;

  /** e.g. "o200k_base", "claude" */
  tokenizerName: string;

  /** Cheap fingerprint to validate cache freshness against current message history */
  history: {
    messageCount: number;
    maxHistorySequence?: number;
  };

  consumers: TokenConsumer[];
  totalTokens: number;
  topFilePaths?: Array<{ path: string; tokens: number }>;
  /** Exact inputs of this count; lets the backend serve it without re-reading history. */
  source?: { historyReceipt: string; inputsKey: string };
}

export interface SubagentSubtreeUsage {
  /** Usage per model, summed over the open (not yet rolled up) workspaces of one subtree. */
  byModel: Record<string, ChatUsageDisplay>;
  /** Open workspaces of the subtree that have any usage. */
  workspaceCount: number;
}

export interface OpenSubagentUsage {
  /**
   * One entry per direct child, covering that child and its open descendants. Keyed by child so
   * the store can drop a child its own copy of the parent ledger already counts: the two reads
   * are separate calls, and a removal can roll the child up between them.
   */
  children: Record<string, SubagentSubtreeUsage>;
}

export interface SessionUsageFile {
  byModel: Record<string, ChatUsageDisplay>;
  lastRequest?: {
    model: string;
    usage: ChatUsageDisplay;
    timestamp: number;
  };

  /**
   * Idempotency ledger for rolled-up sub-agent usage.
   *
   * When a child workspace is deleted, we merge its byModel usage into the parent.
   * This tracks which children have already been merged to prevent double-counting
   * if removal is retried.
   *
   * Legacy entries use `true`; newer entries include per-child totals and metadata.
   */
  rolledUpFrom?: Record<string, true | RolledUpChildEntry>;

  /** Cached token statistics (consumer/file breakdown) for Costs tab */
  tokenStatsCache?: SessionUsageTokenStatsCacheV1;

  /** When a fork reset this ledger (see SessionUsageFileSchema.forkedAt). */
  forkedAt?: number;

  /**
   * Keys of in-flight usage files already counted in byModel, newest last (bounded).
   * A settle writes the usage and its key in one ledger write and then deletes the file, so
   * a crash between the two leaves a file whose key is listed here: the next fold deletes
   * it without counting it again. Older Xum versions keep the field as opaque JSON.
   */
  settledInFlightKeys?: string[];

  version: 1;
}

/**
 * Running streams write their finished steps here, one file per stream attempt, next to
 * session-usage.json. The settled ledger is never rewritten for a running stream and never
 * subtracted from: readers add these files on top of it, a settle appends the final usage
 * once and then deletes the file, and a file left by a killed Xum is folded into the ledger
 * on the next read. An older Xum ignores the directory (it loses only the running turn's
 * spend, as it always did).
 */
const IN_FLIGHT_USAGE_DIR = "session-usage.in-flight";
/**
 * A key only needs to outlive the crash window between a settle's ledger write and its
 * file delete: every settle and read folds leftovers first, so a short list is enough.
 * Keys whose file still exists are never pruned (pruneSettledInFlightKeys).
 */
const SETTLED_IN_FLIGHT_KEYS_LIMIT = 64;
const IN_FLIGHT_KEY_PATTERN = /^[A-Za-z0-9-]+$/;

const InFlightUsageFileSchema = z.object({
  version: z.literal(1),
  /**
   * The Xum process writing this file while its stream runs: its pid and process identity
   * (judged by processLiveness.judgeHolder, the death rule Xum's cross-process locks use),
   * plus an ID unique to the SessionUsageService instance.
   */
  owner: z.object({
    pid: z.number(),
    id: z.string(),
    identity: z.record(z.string(), z.unknown()).optional(),
  }),
  messageId: z.string(),
  model: z.string(),
  /** The stream attempt's cumulative usage over its finished steps, priced. */
  usage: ChatUsageDisplaySchema,
  updatedAt: z.number(),
});
type InFlightUsageFile = z.infer<typeof InFlightUsageFileSchema>;

interface InFlightUsageEntry {
  key: string;
  filePath: string;
  /** Undefined when the file content is malformed or the file is unreadable. */
  file: InFlightUsageFile | undefined;
  /**
   * A read error (EIO, EMFILE...): the file can belong to a running stream, so it is left
   * alone and not counted, but its key still guards pruning.
   */
  unreadable: boolean;
}

/**
 * The parsed file, or undefined when its content is malformed. "unreadable" (a read error
 * such as EIO or EMFILE) leaves the file alone for a later read: it can belong to a running
 * stream.
 */
async function readInFlightUsageFile(
  files: SessionFiles,
  filePath: string
): Promise<InFlightUsageFile | undefined | "missing" | "unreadable"> {
  let raw: string;
  try {
    raw = await files.promises.readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) return "missing";
    log.warn("Failed to read an in-flight usage file; leaving it for a later read", {
      filePath,
      error,
    });
    return "unreadable";
  }
  try {
    return InFlightUsageFileSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

interface DescendantTask {
  id: string;
  parentId: string;
  /** The direct child of the root whose subtree holds this task. */
  subtreeId: string;
}

function listDescendantTasks(
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  rootId: string
): DescendantTask[] {
  const descendants: DescendantTask[] = [];
  const seen = new Set<string>([rootId]);
  const queue: Array<{ id: string; subtreeId?: string }> = [{ id: rootId }];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const childId of childrenByParent.get(parent.id) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const subtreeId = parent.subtreeId ?? childId;
      descendants.push({ id: childId, parentId: parent.id, subtreeId });
      queue.push({ id: childId, subtreeId });
    }
  }
  return descendants;
}

function getOpenDescendantModelUsage(
  descendant: DescendantTask,
  views: ReadonlyMap<string, SessionUsageFile | undefined>
): Array<[string, ChatUsageDisplay]> {
  // Mid-removal: the parent's ledger already holds this descendant's roll-up.
  if (views.get(descendant.parentId)?.rolledUpFrom?.[descendant.id]) return [];
  return Object.entries(views.get(descendant.id)?.byModel ?? {});
}

function sumOpenDescendantUsage(
  descendants: readonly DescendantTask[],
  views: ReadonlyMap<string, SessionUsageFile | undefined>
): OpenSubagentUsage {
  const children: Record<string, SubagentSubtreeUsage> = {};
  for (const descendant of descendants) {
    const entries = getOpenDescendantModelUsage(descendant, views);
    if (entries.length === 0) continue;
    const subtree = (children[descendant.subtreeId] ??= { byModel: {}, workspaceCount: 0 });
    subtree.workspaceCount++;
    for (const [model, usage] of entries) {
      addModelUsage(subtree.byModel, model, usage);
    }
  }
  return { children };
}

/**
 * Self-healing for lock-free reads: a model entry that fails the usage schema is dropped, and a
 * ledger that still fails the file schema reads as absent, so one bad entry or file neither
 * rejects a whole batch or projection nor hides the valid entries beside it. The schema strips
 * settledInFlightKeys, which the view needs, so it is validated and put back.
 */
function parseLedgerKeepingValidModels(raw: unknown): SessionUsageFile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const ledger = raw as SessionUsageFile;
  if (typeof ledger.byModel !== "object" || ledger.byModel === null) return undefined;
  const byModel = Object.fromEntries(
    Object.entries(ledger.byModel).flatMap(([model, usage]) => {
      const entry = ChatUsageDisplaySchema.safeParse(usage);
      return entry.success ? [[model, entry.data]] : [];
    })
  );
  // Use the parsed values, not the raw ones: the schema repairs some fields (a null
  // longContextTokens becomes undefined) that would still throw when usages are summed.
  const parsed = SessionUsageFileSchema.safeParse({ ...ledger, byModel });
  const keys = SettledInFlightKeysSchema.safeParse(ledger.settledInFlightKeys);
  return parsed.success && keys.success
    ? { ...parsed.data, settledInFlightKeys: keys.data }
    : undefined;
}

/** The schema strips settledInFlightKeys, but the view reads it into a Set. */
const SettledInFlightKeysSchema = z.array(z.string()).optional();

function withSettledInFlightKey(file: SessionUsageFile, key: string): void {
  const keys = (file.settledInFlightKeys ?? []).filter((existing) => existing !== key);
  keys.push(key);
  file.settledInFlightKeys = keys;
}

/**
 * Keeps the newest keys, and every key whose in-flight file still exists on disk. Without a
 * directory listing (`entries` undefined) it keeps every key.
 */
function pruneSettledInFlightKeys(
  file: SessionUsageFile,
  entries: InFlightUsageEntry[] | undefined
): void {
  const keys = file.settledInFlightKeys;
  if (!keys || keys.length <= SETTLED_IN_FLIGHT_KEYS_LIMIT || !entries) return;
  const keysWithFiles = new Set(entries.map((entry) => entry.key));
  const firstKept = keys.length - SETTLED_IN_FLIGHT_KEYS_LIMIT;
  file.settledInFlightKeys = keys.filter(
    (key, index) => index >= firstKept || keysWithFiles.has(key)
  );
}

/**
 * Service for managing cumulative session usage tracking.
 *
 * Replaces O(n) message iteration with a persistent JSON file that stores
 * per-model usage breakdowns. Usage is accumulated on stream-end, never
 * subtracted, making costs immune to message deletion.
 */
export class SessionUsageService {
  private readonly SESSION_USAGE_FILE = "session-usage.json";
  /**
   * The one workspace FIFO, from the HistoryService's SessionLocks (phase 4), so a
   * memory or foreign-holder layer reaches these writes too. Read at each use, not
   * at construction: tests that pass a partial HistoryService keep working.
   */
  private get fileLocks(): SessionLocks["workspaceFiles"] {
    return this.historyService.locks.workspaceFiles;
  }
  /**
   * The session-usage files live in the session dir, so they go through the HistoryService's
   * SessionFiles (phase 5), like its locks: a memory layer keeps them off the disk too. Read
   * at each use for the same reason as fileLocks.
   */
  private get files(): SessionFiles {
    return this.historyService.files;
  }
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly getProvidersConfig: () => ProvidersConfigMap | null;
  /** Marks this process's in-flight files (Xum runs one SessionUsageService per process). */
  private readonly inFlightOwnerId = randomUUID();
  /** In-flight keys of streams this process is still running, per workspace. */
  private readonly liveInFlightKeys = new Map<string, Set<string>>();

  constructor(
    config: Config,
    historyService: HistoryService,
    /**
     * Providers config accessor for mappedToModel alias resolution (mirrors
     * StreamManager). Without it, headless usage for custom provider models
     * configured with mappedToModel is priced against the raw custom ID
     * (unknown → $0).
     */
    getProvidersConfig?: () => ProvidersConfigMap | null
  ) {
    this.config = config;
    this.historyService = historyService;
    this.getProvidersConfig = getProvidersConfig ?? (() => null);
  }
  /** Usage rebuild needs every epoch for accurate totals. */
  private async collectFullHistory(workspaceId: string): Promise<MuxMessage[]> {
    const messages: MuxMessage[] = [];
    const result = await this.historyService.iterateFullHistoryUnderLock(
      workspaceId,
      "forward",
      (chunk) => {
        messages.push(...chunk);
      }
    );
    if (!result.success) {
      log.warn(`Failed to iterate history for ${workspaceId}: ${result.error}`);
      return [];
    }
    return messages;
  }

  private getFilePath(workspaceId: string): string {
    return path.join(this.config.sessionsDir, workspaceId, this.SESSION_USAGE_FILE);
  }

  private getInFlightFilePath(workspaceId: string, key: string): string {
    assert(IN_FLIGHT_KEY_PATTERN.test(key), `in-flight usage key is not file-safe: ${key}`);
    return path.join(this.config.sessionsDir, workspaceId, IN_FLIGHT_USAGE_DIR, `${key}.json`);
  }

  private liveKeys(workspaceId: string): Set<string> {
    let keys = this.liveInFlightKeys.get(workspaceId);
    if (!keys) {
      keys = new Set();
      this.liveInFlightKeys.set(workspaceId, keys);
    }
    return keys;
  }

  private forgetLiveKey(workspaceId: string, key: string): void {
    const keys = this.liveInFlightKeys.get(workspaceId);
    keys?.delete(key);
    if (keys?.size === 0) this.liveInFlightKeys.delete(workspaceId);
  }

  /**
   * Every in-flight file of the workspace, or undefined when the directory cannot be listed
   * (a read error): callers then count none and prune no settled key, and retry next read.
   */
  private async readInFlightEntries(
    workspaceId: string
  ): Promise<InFlightUsageEntry[] | undefined> {
    const dir = path.join(this.config.sessionsDir, workspaceId, IN_FLIGHT_USAGE_DIR);
    let names: string[];
    try {
      names = await this.files.promises.readdir(dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return [];
      log.warn("Failed to list in-flight usage files; retrying on a later read", {
        workspaceId,
        error,
      });
      return undefined;
    }
    const entries: InFlightUsageEntry[] = [];
    for (const name of names.sort()) {
      // Skips writeFileAtomic's temp files and anything else that is not ours.
      const key = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!IN_FLIGHT_KEY_PATTERN.test(key)) continue;
      const filePath = path.join(dir, name);
      const file = await readInFlightUsageFile(this.files, filePath);
      // "missing": settled or discarded since the readdir.
      if (file === "missing") continue;
      entries.push(
        file === "unreadable"
          ? { key, filePath, file: undefined, unreadable: true }
          : { key, filePath, file, unreadable: false }
      );
    }
    return entries;
  }

  /**
   * A stream whose writer is gone: written by this process and no longer running (its
   * final ledger write failed), or by a Xum process with positive evidence of death (the
   * same pid with another owner ID is an earlier process whose pid this one reuses).
   */
  private isOrphan(workspaceId: string, entry: InFlightUsageEntry): boolean {
    if (entry.unreadable) return false;
    const owner = entry.file?.owner;
    if (!owner) return true;
    if (owner.id === this.inFlightOwnerId) {
      return !(this.liveInFlightKeys.get(workspaceId)?.has(entry.key) ?? false);
    }
    const identity = owner.identity ? parseProcessIdentity(owner.identity) : undefined;
    return judgeHolder({ pid: owner.pid, identity }, false).dead;
  }

  /**
   * Counts every orphaned in-flight file in `ledger` (in place) unless its key is already
   * settled. Returns the files to delete once the ledger write succeeds; malformed files are
   * deleted uncounted (self-healing: they can never be read).
   */
  private foldOrphanedInFlightUsage(
    workspaceId: string,
    ledger: SessionUsageFile,
    entries: InFlightUsageEntry[] | undefined
  ): { foldedCount: number; filesToDelete: string[] } {
    const settledKeys = new Set(ledger.settledInFlightKeys ?? []);
    let foldedCount = 0;
    const filesToDelete: string[] = [];
    for (const entry of entries ?? []) {
      if (!this.isOrphan(workspaceId, entry)) continue;
      filesToDelete.push(entry.filePath);
      if (!entry.file) {
        log.warn("Removing malformed in-flight usage file", { workspaceId, key: entry.key });
        continue;
      }
      if (settledKeys.has(entry.key)) continue;
      addModelUsage(ledger.byModel, entry.file.model, entry.file.usage);
      withSettledInFlightKey(ledger, entry.key);
      settledKeys.add(entry.key);
      foldedCount++;
    }
    return { foldedCount, filesToDelete };
  }

  /** A stream this process is still running (the Costs tab counts it from stream events). */
  private isOwnLiveStream(workspaceId: string, entry: InFlightUsageEntry): boolean {
    return entry.file?.owner.id === this.inFlightOwnerId && !this.isOrphan(workspaceId, entry);
  }

  /** The view a reader gets: the settled ledger plus running streams it must count. */
  private addRunningStreamsToView(
    workspaceId: string,
    ledger: SessionUsageFile,
    entries: InFlightUsageEntry[] | undefined,
    includeOwnLiveStreams: boolean
  ): { view: SessionUsageFile; addedCount: number } {
    const settledKeys = new Set(ledger.settledInFlightKeys ?? []);
    const view = structuredClone(ledger);
    let addedCount = 0;
    for (const entry of entries ?? []) {
      if (!entry.file || settledKeys.has(entry.key)) continue;
      if (!includeOwnLiveStreams && this.isOwnLiveStream(workspaceId, entry)) continue;
      addModelUsage(view.byModel, entry.file.model, entry.file.usage);
      addedCount++;
    }
    return { view, addedCount };
  }

  /** Best-effort: the ledger is already written, and a file left behind has a settled key. */
  private async deleteFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await this.files.promises.rm(filePath, { force: true });
      } catch (error) {
        log.warn("Failed to delete a settled in-flight usage file", { filePath, error });
      }
    }
  }

  private createEmptyUsageFile(): SessionUsageFile {
    return { byModel: {}, version: 1 };
  }

  private async readFile(workspaceId: string): Promise<SessionUsageFile> {
    try {
      const data = await this.files.promises.readFile(this.getFilePath(workspaceId), "utf-8");
      return JSON.parse(data) as SessionUsageFile;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return this.createEmptyUsageFile();
      }
      throw error;
    }
  }

  private async writeFile(workspaceId: string, data: SessionUsageFile): Promise<void> {
    const filePath = this.getFilePath(workspaceId);
    await this.files.promises.mkdir(path.dirname(filePath), { recursive: true });
    await this.files.writeFileAtomic(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Record usage from a completed stream. Accumulates with existing usage
   * AND updates lastRequest in a single atomic write.
   * Model should already be normalized via normalizeUsageModelKey() (raw
   * Coder identities are preserved so repricing resolves instance metadata).
   */
  async recordUsage(
    workspaceId: string,
    model: string,
    usage: ChatUsageDisplay,
    options?: {
      /**
       * Accumulate into byModel without touching lastRequest. Used for
       * headless telemetry (status generation and memory sweeps) so a tiny
       * background call cannot replace the Costs tab's "Last request" data
       * for the user's actual last agent turn.
       */
      skipLastRequestUpdate?: boolean;
      /**
       * This usage is the final usage of the stream that wrote this in-flight key: append it
       * and mark the key settled in one ledger write, then delete the stream's file.
       */
      settlesInFlightKey?: string;
    }
  ): Promise<void> {
    const settlesKey = options?.settlesInFlightKey;
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readFile(workspaceId);
      const entries = await this.readInFlightEntries(workspaceId);
      const { filesToDelete } = this.foldOrphanedInFlightUsage(workspaceId, current, entries);
      // CRITICAL: Accumulate, don't overwrite. A key a rebuild already settled is counted
      // through its final message in history (markInFlightFilesCountedByHistory).
      if (settlesKey === undefined || !current.settledInFlightKeys?.includes(settlesKey)) {
        addModelUsage(current.byModel, model, usage);
      }
      if (options?.skipLastRequestUpdate !== true) {
        current.lastRequest = { model, usage, timestamp: Date.now() };
      }
      if (settlesKey !== undefined) {
        withSettledInFlightKey(current, settlesKey);
      }
      pruneSettledInFlightKeys(current, entries);
      await this.writeFile(workspaceId, current);
      // Ledger first, then the files: a crash in between leaves settled keys (counted once).
      if (settlesKey !== undefined) {
        this.forgetLiveKey(workspaceId, settlesKey);
        filesToDelete.push(this.getInFlightFilePath(workspaceId, settlesKey));
      }
      await this.deleteFiles(filesToDelete);
    });
  }

  /**
   * Write a running stream's cumulative usage over its finished steps (one write per finished
   * step, atomic). The settled ledger is untouched; readers add this file on top of it.
   */
  async recordInFlightUsage(
    workspaceId: string,
    key: string,
    messageId: string,
    model: string,
    usage: ChatUsageDisplay
  ): Promise<void> {
    const filePath = this.getInFlightFilePath(workspaceId, key);
    return this.fileLocks.withLock(workspaceId, async () => {
      // Live before the write: a concurrent read must never fold a running stream.
      const liveKeys = this.liveKeys(workspaceId);
      const wasLive = liveKeys.has(key);
      liveKeys.add(key);
      const file: InFlightUsageFile = {
        version: 1,
        owner: {
          pid: process.pid,
          id: this.inFlightOwnerId,
          identity: { ...getSelfIdentity() },
        },
        messageId,
        model,
        usage,
        updatedAt: Date.now(),
      };
      try {
        await this.files.promises.mkdir(path.dirname(filePath), { recursive: true });
        await this.files.writeFileAtomic(filePath, JSON.stringify(file));
      } catch (error) {
        // A failed first write leaves no file, and the caller keeps no key to release.
        if (!wasLive) this.forgetLiveKey(workspaceId, key);
        throw error;
      }
    });
  }

  /** The stream ended without usage to record (matches the totals before in-flight files). */
  async discardInFlightUsage(workspaceId: string, key: string): Promise<void> {
    const filePath = this.getInFlightFilePath(workspaceId, key);
    return this.fileLocks.withLock(workspaceId, async () => {
      // Disk first: if the delete fails, the key stays live, so no read in this process folds
      // usage that was meant to be dropped (a restart then counts it: it was billed).
      await this.files.promises.rm(filePath, { force: true });
      this.forgetLiveKey(workspaceId, key);
    });
  }

  /**
   * The stream's final ledger write failed: keep its file (the only durable record of its
   * finished steps) and stop treating it as running, so the next read folds it.
   */
  releaseInFlightUsage(workspaceId: string, key: string): void {
    this.forgetLiveKey(workspaceId, key);
  }

  /**
   * Best-effort usage recording for headless AI calls that bypass the
   * StreamManager pipeline (memory consolidation/harvest and status/title
   * generation). Without this, their spend is invisible to
   * per-workspace cost displays even though the provider bills it.
   *
   * Never throws: cost telemetry must not fail the feature that spent the
   * tokens.
   */
  async recordHeadlessUsage(
    workspaceId: string,
    modelString: string,
    usage: AiSdkUsageLike | undefined,
    providerMetadata?: Record<string, unknown>,
    options?: {
      /**
       * Preserve legacy subscription-covered usage at $0.
       * New OAuth requests use API-equivalent estimates instead.
       */
      costsIncluded?: boolean;
      /**
       * When set, also append the raw usage to the workspace's
       * headless-usage.jsonl sidecar so the analytics ETL can ingest it into
       * dashboard totals. Use for callers whose spend produces no chat.jsonl
       * assistant row, such as status generation and memory sweeps.
       */
      analyticsSource?: string;
      /**
       * Skip the session-usage.json byModel update. For callers that already
       * recorded this turn's usage into the ledger through another path
       * (StreamManager's abort handler) and only need the analytics sidecar.
       */
      skipSessionLedger?: boolean;
      /**
       * Request-pinned pricing identity resolved when the stream/tool call
       * started. When set, it overrides the live re-resolution below so a
       * Coder catalog refresh that removes/retags the instance mid-turn
       * cannot corrupt the persisted analytics identity.
       */
      metadataModel?: string;
    }
  ): Promise<{ model: string; usage: ChatUsageDisplay } | undefined> {
    if (!usage) return undefined;
    try {
      // r62/r63: headless writers (dream/harvest consolidation, status
      // generation) can settle AFTER workspace removal — a foreign backend's
      // run survives the remover's process-local cancellation entirely. The
      // sidecar mkdir + append and the ledger write below would recreate the
      // deleted session directory, so the durable removal tombstone gates
      // these usage commit points too — and gate + commits run INSIDE the
      // session-dir target mutation lock that removal's tombstone+delete
      // critical section also holds (r63), so the check cannot go stale
      // between here and the writes. Callers never hold memory target locks
      // while recording usage, so this single-key acquisition cannot ABBA
      // with removal's sorted multi-key acquisition. Dropping the spend row
      // is correct: the workspace whose dashboards it would feed no longer
      // exists.
      return await withTargetMutationLock(
        this.config.rootDir,
        path.join(this.config.sessionsDir, workspaceId),
        async () => {
          // The same files as the usage writes below, like HistoryService's own check.
          if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId, this.files)) {
            log.debug("Skipping headless usage write for removed workspace", { workspaceId });
            return undefined;
          }
          return await this.recordHeadlessUsageLocked(
            workspaceId,
            modelString,
            usage,
            providerMetadata,
            options
          );
        },
        this.historyService.locks
      );
    } catch (error) {
      log.warn("Failed to record headless usage", { workspaceId, modelString, error });
      return undefined;
    }
  }

  /** Body of recordHeadlessUsage; runs inside the session-dir target lock (r63). */
  private async recordHeadlessUsageLocked(
    workspaceId: string,
    modelString: string,
    usage: AiSdkUsageLike,
    providerMetadata?: Record<string, unknown>,
    options?: {
      costsIncluded?: boolean;
      analyticsSource?: string;
      skipSessionLedger?: boolean;
      metadataModel?: string;
    }
  ): Promise<{ model: string; usage: ChatUsageDisplay } | undefined> {
    try {
      // Headless callers pass live AI SDK usage. Normalize to mux's persisted
      // flat shape and re-inject cache-write tokens (moved off providerMetadata
      // in AI SDK 7) before the sidecar write and pricing below. No-ops for
      // callers that already normalized.
      providerMetadata = withCacheWriteMetadata(providerMetadata, usage);
      usage = normalizeUsage(usage);
      // Attribution key mirrors StreamManager.recordSessionUsage: Coder
      // identities use the caller's request-pinned metadata identity so a
      // catalog refresh mid-turn cannot re-key the row; all others keep the
      // canonical key (their metadataModel can be a mappedToModel pricing
      // alias, deliberately not the attribution bucket).
      const canonicalModel =
        modelString.startsWith("coder:") && options?.metadataModel
          ? options.metadataModel
          : normalizeUsageModelKey(modelString, this.getProvidersConfig());
      // Resolve mappedToModel aliases for pricing (mirrors StreamManager's
      // resolveMetadataModel): custom provider models would otherwise price
      // against the raw custom ID (unknown → $0). A caller-pinned identity
      // takes precedence over live re-resolution.
      let metadataModel: string;
      if (options?.metadataModel) {
        metadataModel = options.metadataModel;
      } else {
        try {
          metadataModel = resolveModelForMetadata(modelString, this.getProvidersConfig());
        } catch {
          metadataModel = modelString;
        }
      }
      const existingMux = providerMetadata?.mux;
      const effectiveProviderMetadata = options?.costsIncluded
        ? {
            ...(providerMetadata ?? {}),
            mux: {
              ...(typeof existingMux === "object" && existingMux !== null ? existingMux : {}),
              costsIncluded: true,
            },
          }
        : providerMetadata;
      const displayUsage = createDisplayUsage(
        usage,
        canonicalModel,
        effectiveProviderMetadata,
        metadataModel
      );
      if (!displayUsage) return undefined;
      // Sidecar append runs FIRST: it is the only source the analytics ETL
      // can replay (there is no chat-row fallback for headless spend), so a
      // crash between the two writes must leave the sidecar — a recorded
      // ledger with a missing sidecar row would strand the spend out of the
      // events table forever (startup sync would see no change to detect).
      // The ledger is merely display state and self-heals via rebuilds.
      if (options?.analyticsSource) {
        // Raw usage + provider metadata (not display costs) so the ETL prices
        // with the current tables — repricing rebuilds then cover these rows.
        // metadataModel mirrors chat rows: model stays the canonical ID for
        // attribution while pricing uses the resolved alias target.
        const line = JSON.stringify({
          timestamp: Date.now(),
          source: options.analyticsSource,
          model: canonicalModel,
          metadataModel,
          usage,
          ...(effectiveProviderMetadata !== undefined
            ? { providerMetadata: effectiveProviderMetadata }
            : {}),
        });
        const sidecarPath = path.join(
          path.dirname(this.getFilePath(workspaceId)),
          HEADLESS_USAGE_FILE_NAME
        );
        await this.files.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
        await this.files.promises.appendFile(sidecarPath, `${line}\n`);
      }
      // Ledger update is isolated: a corrupt session-usage.json (readFile
      // throws on bad JSON) must not fail the whole call once the sidecar
      // line is durable.
      let ledgerRecorded = false;
      if (options?.skipSessionLedger !== true) {
        try {
          await this.recordUsage(workspaceId, canonicalModel, displayUsage, {
            skipLastRequestUpdate: true,
          });
          ledgerRecorded = true;
        } catch (error) {
          log.warn("Failed to update session-usage ledger for headless usage", {
            workspaceId,
            modelString,
            error,
          });
        }
      }
      if (options?.analyticsSource) {
        // Sidecar callers consume the return value to trigger an analytics
        // ingest pass, so signal success once the sidecar line is durable
        // even if the ledger update failed.
        return { model: canonicalModel, usage: displayUsage };
      }
      // Without a durable sidecar, only report success when the ledger write succeeded.
      return ledgerRecorded ? { model: canonicalModel, usage: displayUsage } : undefined;
    } catch (error) {
      log.warn("Failed to record headless usage", { workspaceId, modelString, error });
      return undefined;
    }
  }

  /**
   * Persist derived token stats (consumer + file breakdown) as a cache.
   *
   * This is intentionally treated as a replaceable cache: if the cache is stale,
   * the next tokenizer.calculateStats call will overwrite it.
   */
  async setTokenStatsCache(
    workspaceId: string,
    cache: SessionUsageTokenStatsCacheV1
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "setTokenStatsCache: workspaceId empty");
    assert(cache.version === 1, "setTokenStatsCache: cache.version must be 1");
    assert(cache.totalTokens >= 0, "setTokenStatsCache: totalTokens must be >= 0");
    assert(
      cache.history.messageCount >= 0,
      "setTokenStatsCache: history.messageCount must be >= 0"
    );
    for (const consumer of cache.consumers) {
      assert(
        typeof consumer.tokens === "number" && consumer.tokens >= 0,
        `setTokenStatsCache: consumer tokens must be >= 0 (${consumer.name})`
      );
    }

    return this.fileLocks.withLock(workspaceId, async () => {
      // Defensive: don't create new session dirs for already-deleted workspaces.
      if (!this.config.findWorkspace(workspaceId)) {
        return;
      }

      let current: SessionUsageFile;
      try {
        current = await this.readFile(workspaceId);
      } catch {
        // Parse errors or other read failures - best-effort rebuild.
        log.warn(
          `session-usage.json unreadable for ${workspaceId}, rebuilding before token stats cache update`
        );
        const messages = await this.collectFullHistory(workspaceId);
        if (messages.length > 0) {
          await this.rebuildAndWriteLedger(workspaceId, messages);
          current = await this.readFile(workspaceId);
        } else {
          current = this.createEmptyUsageFile();
        }
      }

      current.tokenStatsCache = cache;
      await this.writeFile(workspaceId, current);
    });
  }

  /** Lock-free (writes are atomic renames) and never rebuilds from history: failure = miss. */
  async peekTokenStatsCache(
    workspaceId: string
  ): Promise<SessionUsageTokenStatsCacheV1 | undefined> {
    try {
      const raw = await this.files.promises.readFile(this.getFilePath(workspaceId), "utf-8");
      const file = JSON.parse(raw) as Partial<SessionUsageFile>;
      return SessionUsageTokenStatsCacheSchema.safeParse(file.tokenStatsCache).data;
    } catch {
      return undefined;
    }
  }

  /**
   * Merge child usage into the parent workspace.
   *
   * Used to preserve sub-agent costs when the child workspace is deleted.
   *
   * IMPORTANT:
   * - Does not update parent's lastRequest
   * - Uses an on-disk idempotency ledger (rolledUpFrom) to prevent double-counting
   */
  async rollUpUsageIntoParent(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childUsageByModel: Record<string, ChatUsageDisplay>,
    childMeta?: { agentType?: string; model?: string }
  ): Promise<{ didRollUp: boolean }> {
    assert(parentWorkspaceId.trim().length > 0, "rollUpUsageIntoParent: parentWorkspaceId empty");
    assert(childWorkspaceId.trim().length > 0, "rollUpUsageIntoParent: childWorkspaceId empty");
    assert(
      parentWorkspaceId !== childWorkspaceId,
      "rollUpUsageIntoParent: parentWorkspaceId must differ from childWorkspaceId"
    );

    // Defensive: don't create new session dirs for already-deleted parents.
    if (!this.config.findWorkspace(parentWorkspaceId)) {
      return { didRollUp: false };
    }

    const entries = Object.entries(childUsageByModel);
    if (entries.length === 0) {
      return { didRollUp: false };
    }

    return this.fileLocks.withLock(parentWorkspaceId, async () => {
      let current: SessionUsageFile;
      try {
        current = await this.readFile(parentWorkspaceId);
      } catch {
        // Parse errors or other read failures - best-effort rebuild.
        log.warn(
          `session-usage.json unreadable for ${parentWorkspaceId}, rebuilding before roll-up`
        );
        const messages = await this.collectFullHistory(parentWorkspaceId);
        if (messages.length > 0) {
          await this.rebuildAndWriteLedger(parentWorkspaceId, messages);
          current = await this.readFile(parentWorkspaceId);
        } else {
          current = this.createEmptyUsageFile();
        }
      }

      if (current.rolledUpFrom?.[childWorkspaceId]) {
        return { didRollUp: false };
      }

      for (const [model, usage] of entries) {
        addModelUsage(current.byModel, model, usage);
      }

      let totalTokens = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let cachedTokens = 0;
      let cacheCreateTokens = 0;
      let contextTokens = 0;
      let totalCostUsd = 0;
      let hasCosts = false;
      for (const [, usage] of entries) {
        inputTokens += usage.input.tokens;
        outputTokens += usage.output.tokens;
        reasoningTokens += usage.reasoning.tokens;
        cachedTokens += usage.cached.tokens;
        cacheCreateTokens += usage.cacheCreate.tokens;

        totalTokens +=
          usage.input.tokens +
          usage.output.tokens +
          usage.reasoning.tokens +
          usage.cached.tokens +
          usage.cacheCreate.tokens;
        contextTokens += usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens;

        for (const bucket of [
          usage.input,
          usage.output,
          usage.reasoning,
          usage.cached,
          usage.cacheCreate,
        ]) {
          if (bucket.cost_usd != null) {
            totalCostUsd += bucket.cost_usd;
            hasCosts = true;
          }
        }
      }

      assert(totalTokens >= 0, "rollUpUsageIntoParent: totalTokens must be >= 0");
      assert(inputTokens >= 0, "rollUpUsageIntoParent: inputTokens must be >= 0");
      assert(outputTokens >= 0, "rollUpUsageIntoParent: outputTokens must be >= 0");
      assert(reasoningTokens >= 0, "rollUpUsageIntoParent: reasoningTokens must be >= 0");
      assert(cachedTokens >= 0, "rollUpUsageIntoParent: cachedTokens must be >= 0");
      assert(cacheCreateTokens >= 0, "rollUpUsageIntoParent: cacheCreateTokens must be >= 0");
      assert(contextTokens >= 0, "rollUpUsageIntoParent: contextTokens must be >= 0");
      assert(!hasCosts || totalCostUsd >= 0, "rollUpUsageIntoParent: totalCostUsd must be >= 0");

      current.rolledUpFrom = {
        ...(current.rolledUpFrom ?? {}),
        [childWorkspaceId]: {
          totalTokens,
          inputTokens,
          outputTokens,
          reasoningTokens,
          cachedTokens,
          cacheCreateTokens,
          contextTokens,
          totalCostUsd: hasCosts ? totalCostUsd : undefined,
          agentType: childMeta?.agentType,
          model: childMeta?.model,
          rolledUpAtMs: Date.now(),
        },
      };
      await this.writeFile(parentWorkspaceId, current);

      return { didRollUp: true };
    });
  }

  /**
   * Read current session usage: the settled ledger plus in-flight files. Folds files that
   * killed streams left behind into the ledger first. This process's own running streams are
   * left out unless `includeLiveStreams` is set: the Costs tab adds them from live stream
   * events. Returns undefined if file missing/corrupted and nothing to rebuild or add.
   */
  async getSessionUsage(
    workspaceId: string,
    options?: { includeLiveStreams?: boolean }
  ): Promise<SessionUsageFile | undefined> {
    return this.fileLocks.withLock(workspaceId, async () => {
      const settled = await this.readSettledLedgerLocked(workspaceId);
      const entries = await this.readInFlightEntries(workspaceId);
      if (entries?.length === 0) {
        return settled;
      }
      const ledger = settled ?? this.createEmptyUsageFile();
      const { foldedCount, filesToDelete } = this.foldOrphanedInFlightUsage(
        workspaceId,
        ledger,
        entries
      );
      if (foldedCount > 0) {
        pruneSettledInFlightKeys(ledger, entries);
        await this.writeFile(workspaceId, ledger);
      }
      await this.deleteFiles(filesToDelete);
      const { view, addedCount } = this.addRunningStreamsToView(
        workspaceId,
        ledger,
        entries,
        options?.includeLiveStreams === true
      );
      return settled === undefined && foldedCount === 0 && addedCount === 0 ? undefined : view;
    });
  }

  /** The settled ledger (rebuilt from history when missing or corrupt). Caller holds the lock. */
  private async readSettledLedgerLocked(
    workspaceId: string
  ): Promise<SessionUsageFile | undefined> {
    try {
      const filePath = this.getFilePath(workspaceId);
      const data = await this.files.promises.readFile(filePath, "utf-8");
      return JSON.parse(data) as SessionUsageFile;
    } catch (error) {
      // File missing or corrupted - try to rebuild from messages
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        const messages = await this.collectFullHistory(workspaceId);
        if (messages.length > 0) {
          await this.rebuildAndWriteLedger(workspaceId, messages);
          return this.readFile(workspaceId);
        }
        return undefined; // Truly empty session
      }
      // Parse error - try rebuild
      log.warn(`session-usage.json corrupted for ${workspaceId}, rebuilding`);
      const messages = await this.collectFullHistory(workspaceId);
      if (messages.length > 0) {
        await this.rebuildAndWriteLedger(workspaceId, messages);
        return this.readFile(workspaceId);
      }
      return undefined;
    }
  }

  /**
   * Reset a workspace's persisted cost ledger while keeping copied chat history intact.
   *
   * Forked workspaces need an explicit empty session-usage.json so later reads do not
   * rebuild historical costs from the copied messages. `forkedAt` marks where the fork's
   * own history begins (see SessionUsageFileSchema); undefined writes no marker.
   */
  async resetSessionUsage(workspaceId: string, forkedAt?: number): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      await this.writeFile(workspaceId, { ...this.createEmptyUsageFile(), forkedAt });
    });
  }

  /**
   * Batch fetch session usage for multiple workspaces.
   * Optimized for displaying costs in archived workspaces list.
   */
  async getSessionUsageBatch(
    workspaceIds: string[]
  ): Promise<Record<string, SessionUsageFile | undefined>> {
    const results: Record<string, SessionUsageFile | undefined> = {};
    // Read files in parallel without rebuilding from messages (archived workspaces
    // should already have session-usage.json; skip rebuild to keep batch fast)
    await Promise.all(
      workspaceIds.map(async (workspaceId) => {
        results[workspaceId] = await this.readUsageViewLockFree(workspaceId, false);
      })
    );
    return results;
  }

  /**
   * Usage of a workspace's sub-agents (and their sub-agents) that still exist.
   *
   * A sub-agent's spend reaches its parent's ledger only when the sub-agent workspace is
   * removed (rollUpUsageIntoParent), so sub-agents that report and stay around hid most
   * delegated spend from the parent's Costs tab. The UI adds this projection to the parent's cost.
   *
   * Counted once: each open descendant's ledger already holds its own removed children, and
   * open grandchildren are visited separately. Running streams are included because no other
   * source shows a sub-agent's in-progress spend to the parent.
   */
  async getOpenSubagentUsage(workspaceId: string): Promise<OpenSubagentUsage> {
    assert(workspaceId.trim().length > 0, "getOpenSubagentUsage requires workspaceId");
    const index = buildAgentTaskIndex(this.config.loadConfigOrDefault());
    const descendants = listDescendantTasks(index.childrenByParent, workspaceId);
    if (descendants.length === 0) {
      return { children: {} };
    }
    const ids = [workspaceId, ...descendants.map((d) => d.id)];
    // The root's view only supplies rolledUpFrom, which a history rebuild never has.
    const views = new Map(
      await Promise.all(
        ids.map(
          async (id) =>
            [
              id,
              id === workspaceId
                ? await this.readUsageViewLockFree(id, true).catch(() => undefined)
                : await this.readProjectionView(id),
            ] as const
        )
      )
    );
    return sumOpenDescendantUsage(descendants, views);
  }

  /**
   * A missing or unusable ledger is rebuilt from history like a locked read would, but only in
   * memory: writing it could recreate the session folder of a sub-agent that is being removed.
   */
  private async readProjectionView(workspaceId: string): Promise<SessionUsageFile | undefined> {
    // Decide on the settled ledger, not the view: a view of only a running stream would
    // skip the rebuild and hide every settled turn. Any read failure counts as missing, so
    // one sub-agent cannot reject the whole projection and hide its siblings' spend.
    const settled = await this.readSettledLedgerLockFree(workspaceId);
    if (settled) {
      return this.readUsageViewLockFree(workspaceId, true, settled).catch(() => settled);
    }
    try {
      // collectFullHistory requires the workspace lock (in memory; it creates no files).
      return await this.fileLocks.withLock(workspaceId, async () => {
        // An empty history still runs: a running stream's in-flight file must count.
        const messages = await this.collectFullHistory(workspaceId);
        const { view: rebuilt } = this.addRunningStreamsToView(
          workspaceId,
          await this.rebuildFromMessagesInternal(workspaceId, messages),
          await this.readInFlightEntries(workspaceId),
          true
        );
        return rebuilt;
      });
    } catch (error) {
      log.warn("Failed to rebuild sub-agent usage for the projection", { workspaceId, error });
      return undefined;
    }
  }

  private async readSettledLedgerLockFree(
    workspaceId: string
  ): Promise<SessionUsageFile | undefined> {
    try {
      const filePath = this.getFilePath(workspaceId);
      return parseLedgerKeepingValidModels(
        JSON.parse(await this.files.promises.readFile(filePath, "utf-8"))
      );
    } catch {
      return undefined;
    }
  }

  private async readUsageViewLockFree(
    workspaceId: string,
    includeOwnLiveStreams: boolean,
    settledLedger?: SessionUsageFile
  ): Promise<SessionUsageFile | undefined> {
    const settled = settledLedger ?? (await this.readSettledLedgerLockFree(workspaceId));
    // Lock-free and read-only: killed streams are added to the view, not folded.
    const entries = await this.readInFlightEntries(workspaceId);
    const { view, addedCount } = this.addRunningStreamsToView(
      workspaceId,
      settled ?? this.createEmptyUsageFile(),
      entries,
      includeOwnLiveStreams
    );
    return settled === undefined && addedCount === 0 ? undefined : view;
  }

  /**
   * Rebuild session usage from messages (for migration/recovery).
   * Internal version - called within lock.
   */
  private async rebuildAndWriteLedger(workspaceId: string, messages: MuxMessage[]): Promise<void> {
    await this.writeFile(
      workspaceId,
      await this.rebuildFromMessagesInternal(workspaceId, messages)
    );
    log.info(`Rebuilt session-usage.json for ${workspaceId} from ${messages.length} messages`);
  }

  private async rebuildFromMessagesInternal(
    workspaceId: string,
    messages: MuxMessage[]
  ): Promise<SessionUsageFile> {
    const result: SessionUsageFile = this.createEmptyUsageFile();
    let lastAssistantUsage: { model: string; usage: ChatUsageDisplay } | undefined;

    // Recovery bucket key: rebuilds run AFTER mutable Coder instance metadata
    // may have changed (provider removed, retagged), so a raw coder: history
    // model can no longer be re-resolved against the current config. The
    // history already persists the record-time identity (metadataModel) and
    // prices with it below — key the bucket with it too, or the raw/incorrect
    // key gets repriced as unknown and its costs stripped. Non-Coder models
    // keep the canonical key: their metadataModel can be a mappedToModel
    // alias target (pricing identity, not the ledger bucket).
    const usageBucketKey = (rawModel: string, metadataModel: string | undefined): string =>
      rawModel.startsWith("coder:") && metadataModel
        ? metadataModel
        : normalizeUsageModelKey(rawModel, this.getProvidersConfig());

    const mergeUsageForModel = (
      rawModel: string,
      usage: ChatUsageDisplay,
      metadataModel?: string
    ): void => {
      addModelUsage(result.byModel, usageBucketKey(rawModel, metadataModel), usage);
    };

    const messageIdsWithUsage = new Set<string>();
    for (const msg of messages) {
      if (msg.role === "assistant") {
        // Include historicalUsage from legacy compaction summaries.
        // This field was removed from XumMetadata but may exist in persisted data.
        // It's a ChatUsageDisplay representing all pre-compaction costs (model-agnostic).
        const historicalUsage = (msg.metadata as { historicalUsage?: ChatUsageDisplay })
          ?.historicalUsage;
        if (historicalUsage) {
          const existing = result.byModel.historical;
          result.byModel.historical = existing
            ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
              sumUsageHistory([existing, historicalUsage])!
            : historicalUsage;
        }

        // The message's own usage plus its model-backed tool and refused-attempt usage.
        for (const entry of getAssistantMessageModelUsages(msg.metadata)) {
          messageIdsWithUsage.add(msg.id);
          mergeUsageForModel(entry.model, entry.usage, entry.metadataModel);
          if (entry.isMessageUsage) {
            lastAssistantUsage = {
              model: usageBucketKey(entry.model, entry.metadataModel),
              usage: entry.usage,
            };
          }
        }
      }
    }

    if (lastAssistantUsage) {
      result.lastRequest = {
        model: lastAssistantUsage.model,
        usage: lastAssistantUsage.usage,
        timestamp: Date.now(),
      };
    }

    await this.markInFlightFilesCountedByHistory(workspaceId, result, messageIdsWithUsage);
    return result;
  }

  /**
   * An in-flight file whose message reached history with usage is already counted by a
   * rebuild: mark it settled. Its stream can be gone (the final ledger write failed after the
   * message was saved) or still running: stream end commits the final message to history
   * before its settle takes the lock, so a rebuild can run in between.
   */
  private async markInFlightFilesCountedByHistory(
    workspaceId: string,
    rebuilt: SessionUsageFile,
    messageIdsWithUsage: Set<string>
  ): Promise<void> {
    for (const entry of (await this.readInFlightEntries(workspaceId)) ?? []) {
      const messageId = entry.file?.messageId;
      if (messageId && messageIdsWithUsage.has(messageId)) {
        withSettledInFlightKey(rebuilt, entry.key);
      }
    }
  }

  /**
   * Public rebuild method (acquires lock).
   */
  async rebuildFromMessages(workspaceId: string, messages: MuxMessage[]): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      await this.rebuildAndWriteLedger(workspaceId, messages);
    });
  }
}
