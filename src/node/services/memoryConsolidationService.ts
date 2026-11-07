/**
 * Memory-consolidation orchestration ("dream" agent, issue #3534, phase 2).
 *
 * Owns everything around the runner (memoryConsolidation.ts): experiment
 * gating, per-workspace debounce, trigger funneling (compaction / launch-idle
 * sweep / archive / manual), model resolution (inherit cascade), and journal
 * persistence for the Memory tab's "last consolidated" line.
 *
 * Failure posture: best-effort everywhere. Triggers fire-and-forget; a
 * failed run logs and waits for the next trigger. Nothing here may block a
 * stream, compaction, archival, or app launch.
 *
 * Internals are Effect-native (coderOauthService.ts documents the house
 * shape): pipelines are `Effect.gen` programs whose success channel carries
 * the wire `Result<_, string>` skip/record union, and the public Promise
 * methods are thin `Effect.runPromise` facades so pre-Effect callers keep
 * working unchanged. Two kinds of locks deliberately stay outside Effect
 * (wrap-around-locks): the sidecar `MutexMap` critical sections remain
 * callback-owned Promise seams with byte-identical interiors, and the
 * per-workspace `inFlight` / `harvestInFlight` reservation maps remain
 * synchronous check-and-reserve seams in `maybeRun` / `maybeHarvestThenSweep`
 * (see those methods for why the reservation must not sit behind an await).
 */
import assert from "@/common/utils/assert";
import { Duration, Effect } from "effect";
import { EventEmitter } from "events";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { Result } from "@/common/types/result";

import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import {
  MEMORY_CONSOLIDATION_DEBOUNCE_MS,
  MEMORY_CONSOLIDATION_IDLE_MS,
  MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP,
  MEMORY_CONSOLIDATION_TIMEOUT_MS,
} from "@/common/constants/memory";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  MemoryConsolidationRecordSchema,
  MemoryHarvestRecordSchema,
  type MemoryConsolidationRecordPayload,
  type MemoryConsolidationStatusChangeEventPayload,
  type MemoryConsolidationStatusPayload,
  type MemoryConsolidationTrigger,
  type MemoryHarvestRecordPayload,
} from "@/common/orpc/schemas/memory";
import { defaultModel } from "@/common/utils/ai/models";
import { resolveAgentAiSettings } from "@/common/utils/ai/resolveAgentAiSettings";
import {
  deriveSideChannelModelCandidates,
  trackPendingUsageWrite,
} from "@/node/services/branchSummary";
import { USAGE_WRITE_DRAIN_WINDOW_MS } from "@/constants/streamDrain";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { assertNever } from "@/common/utils/assertNever";
import { Err, Ok } from "@/common/types/result";
import type { Config } from "@/node/config";
import { resolveHeadlessAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import type { AgentDefinitionPackage } from "@/common/types/agentDefinition";
import { log } from "@/node/services/log";
import { nodeRuntimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";
import type { HistoryService } from "@/node/services/historyService";
import type { MuxMessage } from "@/common/types/message";
import {
  analyzedFloorRowId,
  budgetSpent,
  rowsAfterFloor,
  runMemoryHarvest,
  selectOpenEpoch,
  type ChunkStreamGate,
  type HarvestEpoch,
  type HarvestProgress,
} from "@/node/services/memoryHarvest";
import { runMemoryConsolidation } from "@/node/services/memoryConsolidation";
import type { MemoryScopeContext, MemoryService } from "@/node/services/memoryService";
import { memoryLogicalKey, type MemoryMetaService } from "@/node/services/memoryMeta";
import { KeyedTurnQueue } from "@/node/utils/concurrency/keyedTurnQueue";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { acquireCrossProcessLock } from "@/node/utils/main/crossProcessLock";
export type MemoryConsolidationRecord = MemoryConsolidationRecordPayload;

type MemoryHarvestRecord = MemoryHarvestRecordPayload;

/**
 * Sidecar wire format. Each top-level bucket is validated independently so a
 * malformed harvest record cannot hide otherwise valid consolidation coverage.
 */
const ConsolidationRecordMapSchema = z.record(z.string(), MemoryConsolidationRecordSchema);
interface ConsolidationSidecarFile {
  workspaces: Record<string, MemoryConsolidationRecord>;
  projects: Record<string, MemoryConsolidationRecord>;
  harvestsByWorkspace: Record<string, Record<string, MemoryHarvestRecord>>;
}

interface MemoryConsolidationRunOptions {
  /**
   * Launch sweep sets this only after a scope-specific coverage check says the
   * project sidecar record, not the workspace record, is the debounce anchor.
   */
  skipWorkspaceDebounce?: boolean;
  skipHarvestRecovery?: boolean;
  /**
   * Set by maybeRun when a sub-agent's trigger is redirected to its owner: the
   * child's own durable removal tombstone then gates the owner run too, since
   * a child mid-teardown must not mutate the shared notebook.
   */
  actingWorkspaceId?: string;
}

interface ExperimentsCheck {
  isExperimentEnabled(experimentId: string): boolean;
}

interface ModelFactoryLike {
  /**
   * One-snapshot model creation returning the pinned pricing identity (see
   * AIService.createModelWithPinnedMetadata): headless usage recording must
   * attribute spend to the identity the model was created for, not to a
   * post-completion re-resolution that a Coder catalog refresh can change.
   */
  createModelWithPinnedMetadata(
    modelString: string,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<{ model: LanguageModel; metadataModel: string }, { type: string }>>;
}

/**
 * Resolve headless agent settings — the inherit cascade from PRD #3534
 * (uniform with other agents): per-workspace agent override → global agent
 * default → definition AI defaults → pinned selected model (or legacy workspace
 * session fallback) → app default. Interactive callers supply their fully resolved model so unrelated
 * agent buckets cannot change the route. Effort defaults to off rather than
 * inheriting expensive parent-chat reasoning. Shared with the debug CLI.
 */
export function resolveHeadlessAgentSettings(
  config: Config,
  workspaceId: string,
  agentId: string,
  selectedModel?: string,
  definitionAiDefaults?: AgentDefinitionPackage["frontmatter"]["ai"]
) {
  const cfg = config.loadConfigOrDefault();
  const workspace = config.findWorkspace(workspaceId);
  const workspaceEntry = workspace
    ? cfg.projects.get(workspace.projectPath)?.workspaces.find((entry) => entry.id === workspaceId)
    : undefined;
  const agentBucket = workspaceEntry?.aiSettingsByAgent?.[agentId];
  // Route confinement (r31 security): absent an explicit agent override
  // (workspace bucket above, global agent default inside the resolver), the
  // fallback must stay on the workspace's SELECTED route. The old fallback
  // read only legacy `aiSettings`, which updateAgentAISettings never rewrites
  // — a workspace whose current model is a per-agent private/gateway route
  // could fall through a stale legacy model (or the built-in default) and
  // ship transcript-derived content off-route. Same candidate derivation as
  // branch summaries: selected agent's model, other per-agent models, then
  // the legacy model as a compatibility fallback.
  // Interactive headless tools pin the already-resolved parent route, including
  // global agent defaults. Other buckets may be stale or belong to another provider.
  // Legacy callers (dream) retain their existing session fallback.
  const fallbackModels = selectedModel
    ? [selectedModel]
    : workspaceEntry
      ? deriveSideChannelModelCandidates(workspaceEntry)
      : [];
  return resolveAgentAiSettings({
    targetAgentId: agentId,
    profile: "interactive",
    agentAiDefaults: cfg.agentAiDefaults,
    targetDefinitionAiDefaults: definitionAiDefaults,
    targetWorkspaceSettings: agentBucket,
    fallbacks: fallbackModels.length > 0 ? fallbackModels.map((model) => ({ model })) : undefined,
    defaultModel,
  }).selected;
}

export function resolveHeadlessAgentModelString(
  ...args: Parameters<typeof resolveHeadlessAgentSettings>
): string {
  return resolveHeadlessAgentSettings(...args).model;
}

export { resolveHeadlessAgentDefinition };

export async function resolveHeadlessAgentBody(
  muxRoot: string,
  agentId: string
): Promise<string | null> {
  // Outside the agent loop: headless memory runs read the host Xum home.
  return (await resolveHeadlessAgentDefinition(muxRoot, agentId, nodeRuntimeFactory))?.body ?? null;
}

export function resolveDreamModelString(config: Config, workspaceId: string): string {
  return resolveHeadlessAgentModelString(config, workspaceId, "dream");
}

export function resolveDreamAgentBody(muxRoot: string): Promise<string | null> {
  return resolveHeadlessAgentBody(muxRoot, "dream");
}

export function resolveConsolidationProjectPath(workspace: {
  projectPath: string;
  attributionProjectPath?: string;
  projects?: ReadonlyArray<{ projectPath: string }>;
}): string {
  // Task/fork multi-project workspaces can live under a real project bucket;
  // only the workspace's actual project refs prove a single stable identity.
  if (workspace.projectPath === MULTI_PROJECT_CONFIG_KEY) return "";
  if ((workspace.projects?.length ?? 0) > 1) return "";
  return (
    workspace.projects?.[0]?.projectPath ??
    workspace.attributionProjectPath ??
    workspace.projectPath
  );
}

/**
 * Newest completed run across all workspaces, or null when none have run.
 * Every run consolidates global scope, so the newest run anywhere doubles as
 * the last time global memory was covered.
 */
function findNewestWorkspaceRecord(
  workspaces: Record<string, MemoryConsolidationRecord>
): MemoryConsolidationRecord | null {
  return Object.values(workspaces).reduce<MemoryConsolidationRecord | null>(
    (latest, record) => (latest === null || record.lastRunAt > latest.lastRunAt ? record : latest),
    null
  );
}

/**
 * Effective ordering timestamp for a harvest record: when it completed, or when
 * it started if still pending. findNewestHarvestRecord and pruneHarvestRecords
 * must rank records the same way, so both derive recency from this single key.
 */
function harvestRecordTime(record: MemoryHarvestRecord): number {
  return record.completedAt ?? record.startedAt;
}

function findNewestHarvestRecord(
  records: Record<string, MemoryHarvestRecord> | undefined
): MemoryHarvestRecord | null {
  if (records === undefined) return null;
  return Object.values(records).reduce<MemoryHarvestRecord | null>((latest, record) => {
    const recordTime = harvestRecordTime(record);
    const latestTime = latest === null ? -1 : harvestRecordTime(latest);
    return recordTime > latestTime ? record : latest;
  }, null);
}

const HARVEST_RECORD_RETENTION = 20;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStalePendingHarvestRecord(record: MemoryHarvestRecord, now = Date.now()): boolean {
  // Each chunk has its own timeout, so a run of several chunks outlives one timeout while it is
  // alive: it is stale once a timeout has passed since its last sign of life, not since it started.
  return (
    record.status === "pending" &&
    now - (record.progressAt ?? record.startedAt) > MEMORY_CONSOLIDATION_TIMEOUT_MS
  );
}

function normalizeHarvestRecord(record: MemoryHarvestRecord): MemoryHarvestRecord {
  if (!isStalePendingHarvestRecord(record) || record.attemptCount < HARVEST_MAX_ATTEMPTS) {
    return record;
  }
  return {
    ...record,
    status: "failed",
    completedAt: record.completedAt ?? Date.now(),
    error: record.error ?? "stale pending harvest exceeded retry attempts",
  };
}

function parseConsolidationRecordMap(value: unknown): Record<string, MemoryConsolidationRecord> {
  const parsed = ConsolidationRecordMapSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function parseHarvestRecords(value: unknown): Record<string, Record<string, MemoryHarvestRecord>> {
  if (!isPlainRecord(value)) return {};
  const parsed: Record<string, Record<string, MemoryHarvestRecord>> = {};
  for (const [workspaceId, workspaceRecords] of Object.entries(value)) {
    if (!isPlainRecord(workspaceRecords)) continue;
    const records: Record<string, MemoryHarvestRecord> = {};
    for (const [boundaryKey, record] of Object.entries(workspaceRecords)) {
      const candidate = MemoryHarvestRecordSchema.safeParse(record);
      if (candidate.success) records[boundaryKey] = normalizeHarvestRecord(candidate.data);
    }
    if (Object.keys(records).length > 0) parsed[workspaceId] = records;
  }
  return parsed;
}

function pruneHarvestRecords(records: Record<string, MemoryHarvestRecord>): void {
  const ranked = Object.entries(records).sort(
    ([, left], [, right]) => harvestRecordTime(right) - harvestRecordTime(left)
  );
  for (const [boundaryKey] of ranked.slice(HARVEST_RECORD_RETENTION)) {
    delete records[boundaryKey];
  }
}

/**
 * Cross-process half of the dream-stream queue. It lives in `<root>/locks`, not inside
 * `<root>/memory`, because a memory mutation can delete directories there while it is held.
 */
export function dreamStreamLockPath(rootDir: string): string {
  return path.join(rootDir, "locks", "memory-dream-stream.lock");
}

/** The skip reason of a run the debounce window refused (callers match on "debounced"). */
const DEBOUNCED_SKIP_REASON =
  "debounced: a recent consolidation run already covered this workspace";

/** Where a dream stream's turn ended up (see runDreamStreamExclusively). */
type DreamStreamTurn<T> =
  | { outcome: "ran"; value: T }
  /** The signal aborted while the run waited for its turn: `stream` never started. */
  | { outcome: "cancelled" }
  /** The cross-process lock could not be taken: `stream` never started. */
  | { outcome: "lock-failed"; error: string };

/**
 * Usage captured while a stream holds a queue turn, recorded once the turn is released.
 * `recordHeadlessUsage` takes the session directory's lock, and a stall there must not hold every
 * later run behind the same queue (see runDreamStreamExclusively and the analyzer queue). Best
 * effort, in capture order: telemetry never fails a pass.
 */
function createDeferredUsageRecorder(label: string, workspaceId: string) {
  const captured: Array<() => Promise<void>> = [];
  return {
    /** For `recordUsage`: queues `record` and returns at once. */
    defer: (record: () => Promise<void>): Promise<void> => {
      captured.push(record);
      return Promise.resolve();
    },
    flush: async (): Promise<void> => {
      for (const record of captured.splice(0)) {
        await record().catch((error: unknown) => {
          log.warn(`[${label}] could not record usage`, {
            workspaceId,
            error: getErrorMessage(error),
          });
        });
      }
    },
  };
}

/** Resolves true once `turn` settles, or false if `signal` aborts first (a pre-aborted signal never waits). */
function waitForTurnOrAbort(turn: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void turn.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    });
  });
}

export const HARVEST_MAX_ATTEMPTS = 3;

/** Completed, or failed with retries exhausted: nothing may retry it. */
function isTerminalHarvestRecord(record: MemoryHarvestRecord): boolean {
  return (
    record.status === "completed" ||
    (record.status === "failed" && record.attemptCount >= HARVEST_MAX_ATTEMPTS)
  );
}

/**
 * The record fields an analyzer run's progress fills. `acceptedCandidates` / `skippedCandidates`
 * keep their old names because older binaries still parse the record: they now count the memory
 * edits that landed and the ones the tool rejected.
 */
function harvestProgressFields(
  progress: HarvestProgress
): Pick<
  MemoryHarvestRecord,
  | "nextChunk"
  | "ops"
  | "budgetUsed"
  | "nextChunkOps"
  | "readThroughRowId"
  | "usage"
  | "acceptedCandidates"
  | "skippedCandidates"
> {
  const applied = progress.ops.filter((op) => op.applied).length;
  return {
    nextChunk: progress.nextChunk,
    ops: progress.ops,
    budgetUsed: progress.budgetUsed,
    nextChunkOps: progress.nextChunkOps,
    readThroughRowId: progress.readThroughRowId,
    usage: progress.usage,
    acceptedCandidates: applied,
    skippedCandidates: progress.ops.length - applied,
  };
}

/**
 * What one analyzer run reads, and the identity of its record. A closed epoch is keyed by its
 * summary message and keeps the compaction metadata, which recovery needs to read the epoch again.
 * The open epoch (the rows after the latest boundary, analyzed when the workspace is archived)
 * has neither: nothing recovers it, the next archive retries a failed record.
 */
interface HarvestSource {
  workspaceId: string;
  boundaryKey: string;
  compactionEpoch: number;
  completionMetadata?: CompactionCompletionMetadata;
  readEpoch: () => Promise<Result<HarvestEpoch>>;
}

/** What an attempt learns before it streams; shared so a failure record can carry it. */
interface HarvestAttemptState {
  /** Absent until the job's first attempt reached the epoch; see MemoryHarvestRecord. */
  analyzedFloorRowId?: string | null;
}

/** What a run's analyzer turn returns, instead of a harvest, when the records show every row read. */
const ALL_ROWS_ANALYZED = "all-rows-analyzed";

/** The record fields of a run in flight: its progress and what the attempt learned. */
function harvestAttemptFields(
  progress: HarvestProgress,
  state: HarvestAttemptState
): ReturnType<typeof harvestProgressFields> & Pick<MemoryHarvestRecord, "analyzedFloorRowId"> {
  return {
    ...harvestProgressFields(progress),
    analyzedFloorRowId: state.analyzedFloorRowId,
  };
}

function harvestRecordIdentity(
  source: HarvestSource
): Pick<MemoryHarvestRecord, "boundaryKey" | "compactionEpoch" | "completionMetadata"> {
  return {
    boundaryKey: source.boundaryKey,
    compactionEpoch: source.compactionEpoch,
    completionMetadata: source.completionMetadata,
  };
}

/**
 * Where an attempt at a job starts, from the record its earlier attempts left (none for the
 * first). A retry resumes where the failed attempt stopped: its chunks already wrote to memory.
 */
export function harvestResumeState(existing: MemoryHarvestRecord | undefined): {
  progress: HarvestProgress;
  attemptState: HarvestAttemptState;
} {
  // A first attempt has no record: read each field off an empty one rather than check per field.
  const earlier: Partial<MemoryHarvestRecord> = existing ?? {};
  return {
    progress: {
      nextChunk: earlier.nextChunk ?? 0,
      ops: earlier.ops ?? [],
      budgetUsed: earlier.budgetUsed,
      nextChunkOps: earlier.nextChunkOps,
      // Kept across an attempt that fails before it reads a chunk (the epoch or the model cannot be
      // loaded): its failure record would otherwise drop what the earlier attempt's chunks read.
      readThroughRowId: earlier.readThroughRowId,
      usage: earlier.usage,
    },
    // A retry keeps the floor of the first attempt: the chunk cursor counts chunks of the rows
    // after it.
    attemptState: { analyzedFloorRowId: earlier.analyzedFloorRowId },
  };
}

/**
 * The failed record that replaces `record` when it is a pending one whose last allowed attempt
 * went stale: nothing may retry it. Undefined for any other record. The rule of
 * normalizeHarvestRecord, applied to the record a job just read.
 */
export function staleExhaustedHarvestFailure(
  record: MemoryHarvestRecord | undefined
): MemoryHarvestRecord | undefined {
  if (
    record?.status !== "pending" ||
    !isStalePendingHarvestRecord(record) ||
    record.attemptCount < HARVEST_MAX_ATTEMPTS
  ) {
    return undefined;
  }
  return {
    ...record,
    status: "failed",
    completedAt: Date.now(),
    error: record.error ?? "stale pending harvest exceeded retry attempts",
  };
}

/**
 * Harvest-record key of the open epoch: its newest row's id. A compaction key is a message id too
 * and no message id starts with this prefix. The key changes when a row arrives, so an archive
 * that finds the same newest row has nothing new to analyze. A row id, unlike a history sequence,
 * is never reused: a rewound chat can grow back to the same sequence.
 */
const OPEN_EPOCH_KEY_PREFIX = "open:";

/**
 * The ids of the rows that open-epoch runs read up to: every row up to each was analyzed. That is
 * the record's `readThroughRowId`, not always the newest row its key names: a run that skipped
 * chunks for its budget never read the rows after it. A completed record from before the field
 * read everything up to its key's row. A failed run counts through the last chunk it read
 * cleanly: those chunks' edits landed, and a later run, an archive after a new row or the
 * compaction that closes the epoch, would otherwise read the rows again with a fresh budget. A
 * pending record counts the same way: a run saves its cursor after each chunk, and the run queued
 * behind it (an archive and the compaction of its epoch can overlap) starts when the turn is
 * released, before the completed record is saved. A record without the field read nothing known.
 * Read from the records, so a pruned record only loses its floor, which re-reads rows instead of
 * skipping any.
 */
function analyzedOpenEpochRowIds(
  records: Record<string, MemoryHarvestRecord> | undefined
): Set<string> {
  const ids = new Set<string>();
  for (const [boundaryKey, record] of Object.entries(records ?? {})) {
    if (!boundaryKey.startsWith(OPEN_EPOCH_KEY_PREFIX)) continue;
    const readEverythingToKey =
      record.status === "completed" && record.readThroughRowId === undefined;
    const readThrough = readEverythingToKey
      ? boundaryKey.slice(OPEN_EPOCH_KEY_PREFIX.length)
      : record.readThroughRowId;
    if (typeof readThrough === "string") ids.add(readThrough);
  }
  return ids;
}

/**
 * Mutations the earlier records of the epoch `rows` belong to have spent. The epoch has one budget
 * (MEMORY_ANALYZER_OP_BUDGET), but a record is one run: every archive after new rows and the
 * compaction that closes the epoch each make a new record, and each starts from this number, so
 * the epoch's edits add up to one budget instead of one per record. A record's `budgetUsed`
 * already includes what it started with, so the most spent record is the total. An open-epoch
 * record belongs to the epoch when the row its key names is one of `rows`, matched by id like the
 * floors: a rewound chat can reuse an epoch number but never a row id, so the abandoned
 * timeline's edits do not spend the new one's budget. Read from the records, so a pruned record
 * only loses what it spent, which the newer records of the epoch carry.
 */
function epochBudgetSpent(
  records: Record<string, MemoryHarvestRecord> | undefined,
  rows: ReadonlyArray<Pick<MuxMessage, "id">>
): number {
  const rowIds = new Set(rows.map((row) => row.id));
  let spent = 0;
  for (const [boundaryKey, record] of Object.entries(records ?? {})) {
    if (!boundaryKey.startsWith(OPEN_EPOCH_KEY_PREFIX)) continue;
    if (!rowIds.has(boundaryKey.slice(OPEN_EPOCH_KEY_PREFIX.length))) continue;
    spent = Math.max(spent, budgetSpent({ ops: record.ops ?? [], budgetUsed: record.budgetUsed }));
  }
  return spent;
}

/** Terminal marker for a bucket whose transcript is being deleted (see finalizeHarvestsForRemoval). */
function finalizeHarvestRecordForRemoval(record: MemoryHarvestRecord): MemoryHarvestRecord {
  return {
    ...record,
    status: "failed",
    completedAt: record.completedAt ?? Date.now(),
    attemptCount: HARVEST_MAX_ATTEMPTS,
    error: "workspace removed before the harvest could be retried; transcript no longer available",
  };
}

export class MemoryConsolidationService extends EventEmitter {
  private readonly sidecarPath: string;
  /** Serializes sidecar read-modify-write cycles (journal persistence only). */
  private readonly locks = new MutexMap<string>();
  /**
   * Per-workspace run lock holding the active run's promise. Reserved
   * SYNCHRONOUSLY in maybeRun before any await so two near-simultaneous
   * triggers can never both start a run; archive triggers queue behind the
   * active run via the stored promise.
   */
  private readonly inFlight = new Map<string, Promise<Result<MemoryConsolidationRecord, string>>>();

  /**
   * Tail of the service-wide memory-stream queue (see runDreamStreamExclusively): dream streams
   * and each analyzer chunk's stream.
   * `inFlight` is per owner workspace, so two workspaces of one project (or any
   * two, through global memory) could otherwise run the organizer over the same
   * files at once. Never rejects: each link settles when its stream is done or
   * its wait was cancelled.
   */
  private dreamStreamTail: Promise<void> = Promise.resolve();

  /**
   * Analyzer-job queue, keyed by the workspace-memory owner. `harvestInFlight` is per compaction
   * boundary, so two boundaries of one workspace, or an owner and its sub-agent (which share the
   * owner's /memories/workspace store), could otherwise run their chunks interleaved: a job
   * should read what the one ahead of it wrote, and its chunks follow one another.
   *
   * This queue alone does not keep the model's read-to-insert sequences apart: the numeric
   * `insert` line offset it read goes stale after another stream's insert, and a dream, or a
   * second backend's analyzer, is not behind this queue. That is the dream exclusion's job
   * (runDreamStreamExclusively), which every chunk's stream takes (runAnalyzerChunkExclusively).
   *
   * LOCK ORDER: a job's turn here, then the exclusion, never the reverse. The exclusion is held
   * for one stream, and nothing that runs inside it waits for a turn here or runs an analyzer
   * (the in-process tail is not reentrant), so no chain of waits can close into a cycle.
   */
  private readonly analyzerStreams = new KeyedTurnQueue();

  /**
   * Per-run removal controllers (r60): workspace removal must abort and
   * drain in-flight dream/harvest runs BEFORE deleting the session
   * directory — their timeout signal alone never fires during removal, so a
   * detached run could still mutate global/project memory and append its
   * refinement journal row into the deleted session directory, recreating
   * it. Each run combines its hard timeout with one of these controllers
   * (AbortSignal.any); cancelInFlightConsolidation aborts them and awaits
   * the runs bounded.
   */
  private readonly runControllers = new Map<string, Set<AbortController>>();

  /**
   * Workspaces whose teardown has begun in THIS process (r61). The one-shot
   * abort loop in cancelInFlightConsolidation cannot reach follow-on runs
   * registered after it finishes — a cancelled harvest still starts the
   * post-harvest sweep, and a cancelled run still starts retryable-harvest
   * recovery, each with a fresh un-aborted signal. Entry points refuse and
   * new controllers start pre-aborted while a workspace is in this set.
   * Entries are cleared only when removal aborts before its point of no
   * return (releaseRemovalCancellation); once the tombstone is published,
   * removal is terminal. Cross-PROCESS
   * teardown is covered by the durable removal tombstone instead (see
   * workspaceRemoval.ts), checked at memory mutation commit points.
   */
  private readonly removalCancelled = new Set<string>();

  /**
   * Coalesces duplicate completion signals for one physical compaction boundary. Also holds a
   * workspace's active archive pass, which a later archive queues behind.
   */
  private readonly harvestInFlight = new Map<
    string,
    Promise<Result<MemoryConsolidationRecord, string>>
  >();

  /**
   * Archive passes of sub-agents in flight, by the owner whose workspace memory their analysis
   * writes to. A task-tree archive starts each child's pass in the background before the owner's,
   * and the owner's final dream must not start while one of them can still write: whatever it
   * wrote afterward would miss the owner's one chance to promote it (see trackDescendantArchivePass).
   */
  private readonly descendantArchivePasses = new Map<string, Set<Promise<void>>>();

  constructor(
    private readonly config: Config,
    private readonly memoryService: MemoryService,
    private readonly metaService: MemoryMetaService,
    private readonly historyService: HistoryService,
    private readonly modelFactory: ModelFactoryLike,
    private readonly experiments: ExperimentsCheck,
    /**
     * Optional cost telemetry sink. Headless consolidation/harvest streams
     * bypass StreamManager, so without this their spend never reaches
     * session-usage.json / per-workspace cost displays.
     */
    private readonly sessionUsageService?: SessionUsageService
  ) {
    super();
    this.sidecarPath = path.join(config.rootDir, "memory-consolidation.json");
  }

  private enabled(): boolean {
    return (
      this.experiments.isExperimentEnabled(EXPERIMENT_IDS.MEMORY) &&
      this.experiments.isExperimentEnabled(EXPERIMENT_IDS.MEMORY_CONSOLIDATION)
    );
  }

  /** Self-healing load: malformed buckets are dropped independently. */
  private loadEffect(): Effect.Effect<ConsolidationSidecarFile> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      // The whole read+parse stays inside the caught thunk, exactly the old
      // try scope: a parser throw must self-heal to the empty file, never
      // defect through a read facade.
      const parsed = yield* Effect.tryPromise({
        try: async (): Promise<ConsolidationSidecarFile | undefined> => {
          const raw = await fsPromises.readFile(self.sidecarPath, "utf-8");
          const json = JSON.parse(raw) as unknown;
          if (!isPlainRecord(json)) return undefined;
          return {
            workspaces: parseConsolidationRecordMap(json.workspaces),
            projects: parseConsolidationRecordMap(json.projects),
            harvestsByWorkspace: parseHarvestRecords(json.harvestsByWorkspace),
          };
        },
        catch: () => undefined,
      }).pipe(
        // Missing or corrupt JSON — start fresh (the next save overwrites the file).
        Effect.catch(() => Effect.succeed(undefined))
      );
      return parsed ?? { workspaces: {}, projects: {}, harvestsByWorkspace: {} };
    });
  }

  /**
   * Promise facade over {@link loadEffect}; the sidecar MutexMap critical
   * sections call this so their interiors stay plain Promise seams.
   */
  private load(): Promise<ConsolidationSidecarFile> {
    return Effect.runPromise(this.loadEffect());
  }

  getRecord(workspaceId: string): Promise<MemoryConsolidationRecord | null> {
    return Effect.runPromise(this.getRecordEffect(workspaceId));
  }

  private getRecordEffect(workspaceId: string): Effect.Effect<MemoryConsolidationRecord | null> {
    return Effect.map(this.loadEffect(), (file) => file.workspaces[workspaceId] ?? null);
  }

  /**
   * Whether the 6 h window refuses this trigger. Manual runs bypass it (an explicit /dream is
   * explicit intent), and so does archive: it is the workspace's one-shot final pass, the only
   * chance to promote durable lessons to global scope, and archival typically follows a
   * compaction-triggered run within the window. `skipWorkspaceDebounce` is the launch sweep's
   * decision that project-level coverage justifies a run despite a recent workspace record.
   * Always reads the sidecar from disk: another backend may have journaled since the last read.
   */
  private isDebouncedEffect(
    workspaceId: string,
    trigger: MemoryConsolidationTrigger,
    options: MemoryConsolidationRunOptions
  ): Effect.Effect<boolean> {
    if (trigger === "manual" || trigger === "archive" || options.skipWorkspaceDebounce === true) {
      return Effect.succeed(false);
    }
    return Effect.map(
      this.getRecordEffect(workspaceId),
      (record) =>
        record !== null && Date.now() - record.lastRunAt < MEMORY_CONSOLIDATION_DEBOUNCE_MS
    );
  }

  getStatus(workspaceId: string): Promise<MemoryConsolidationStatusPayload> {
    return Effect.runPromise(this.getStatusEffect(workspaceId));
  }

  private getStatusEffect(workspaceId: string): Effect.Effect<MemoryConsolidationStatusPayload> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const file = yield* self.loadEffect();
      const workspace = self.config.findWorkspace(workspaceId);
      const projectPath = workspace == null ? "" : resolveConsolidationProjectPath(workspace);
      const globalRecord = findNewestWorkspaceRecord(file.workspaces);
      // The workspace record describes the STORE the tab shows: for a
      // sub-agent that is the owner's (runs are redirected there, see
      // maybeRun); harvests stay per acting workspace.
      const ownerWorkspaceId = self.memoryService.resolveWorkspaceMemoryOwnerId(workspaceId);
      return {
        workspaceRecord: file.workspaces[ownerWorkspaceId] ?? null,
        projectRecord: projectPath === "" ? null : (file.projects[projectPath] ?? null),
        globalRecord,
        latestHarvestRecord: findNewestHarvestRecord(file.harvestsByWorkspace[workspaceId]),
        projectAvailable: projectPath !== "",
      };
    });
  }

  private emitStatusChange(workspaceId: string, projectPath: string): void {
    const event: MemoryConsolidationStatusChangeEventPayload = {
      kind: "consolidation_status",
      workspaceId,
      projectPath,
    };
    this.emit("statusChange", event);
  }

  /**
   * Journal mutation. The sidecar read-modify-write stays a callback-owned
   * MutexMap Promise seam with a byte-identical interior (wrap-around-locks);
   * the pipeline is uninterruptible so the durable write can never be
   * separated from the status invalidation below.
   */
  private saveRecordEffect(
    workspaceId: string,
    projectPath: string,
    record: MemoryConsolidationRecord
  ): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          self.locks.withLock(self.sidecarPath, async () => {
            const file = await self.load();
            file.workspaces[workspaceId] = record;
            if (projectPath !== "") {
              file.projects[projectPath] = record;
            }
            await writeFileAtomic(self.sidecarPath, JSON.stringify(file, null, 2));
          })
        );
        // The sidecar write does not touch memory files, so open Memory tabs need
        // this explicit status invalidation even when a run made zero mutations.
        self.emitStatusChange(workspaceId, projectPath);
      })
    );
  }

  private saveHarvestRecordEffect(
    workspaceId: string,
    boundaryKey: string,
    record: MemoryHarvestRecord,
    projectPath: string
  ): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const saved = yield* Effect.promise(() =>
          self.locks.withLock(self.sidecarPath, async () => {
            const file = await self.load();
            file.harvestsByWorkspace[workspaceId] ??= {};
            const existing = file.harvestsByWorkspace[workspaceId][boundaryKey];
            // A terminal record is never reopened: removal finalization
            // (finalizeHarvestsForRemoval) races the bounded cancellation
            // drain's residual harvest runs on this file, and a residual
            // pending/retryable-failure write landing afterwards would turn
            // a bucket whose transcript is gone back into a retry candidate.
            // Only a genuine completion may replace it (the writes happened).
            if (existing !== undefined && isTerminalHarvestRecord(existing)) {
              if (record.status !== "completed") return false;
            }
            file.harvestsByWorkspace[workspaceId][boundaryKey] = record;
            pruneHarvestRecords(file.harvestsByWorkspace[workspaceId]);
            await writeFileAtomic(self.sidecarPath, JSON.stringify(file, null, 2));
            return true;
          })
        );
        if (saved) self.emitStatusChange(workspaceId, projectPath);
      })
    );
  }

  private recoverRetryableHarvestsEffect(workspaceId: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const sidecar = yield* self.loadEffect();
      // Harvest buckets are keyed by the ACTING workspace, but a sub-agent's
      // runs redirect to its owner (see maybeRun) and the launch sweep skips
      // children, so an owner run must retry every tree member's bucket or a
      // child's failed/stale harvest would never be recovered.
      const cfg = self.config.loadConfigOrDefault();
      const records = Object.entries(sidecar.harvestsByWorkspace)
        .filter(
          ([bucketId]) =>
            !self.removalCancelled.has(bucketId) &&
            (bucketId === workspaceId ||
              self.memoryService.resolveWorkspaceMemoryOwnerId(bucketId, () => cfg) === workspaceId)
        )
        .flatMap(([, bucket]) => Object.values(bucket));
      if (records.length === 0) return;

      const retryable = records
        .filter((record) => {
          // Nothing to read the epoch again from: the open epoch's record has no metadata.
          if (record.completionMetadata === undefined) return false;
          if (record.attemptCount >= HARVEST_MAX_ATTEMPTS) return false;
          return record.status === "failed" || isStalePendingHarvestRecord(record);
        })
        .sort((left, right) => left.startedAt - right.startedAt);

      for (const record of retryable) {
        assert(
          record.completionMetadata !== undefined,
          "retryable harvest record must have metadata"
        );
        const metadata = record.completionMetadata;
        const result: Result<MemoryConsolidationRecord, string> = yield* Effect.tryPromise({
          try: async () => self.maybeHarvestThenSweep(metadata),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed<Result<MemoryConsolidationRecord, string>>(Err(getErrorMessage(error)))
          )
        );
        if (!result.success) {
          log.debug("[MemoryConsolidation] harvest recovery skipped", {
            workspaceId,
            reason: result.error,
          });
        }
      }
    });
  }

  /**
   * True once teardown began for this workspace in any other backend over
   * the same Xum root (durable removal tombstone, r61). The in-process half
   * of the teardown gate is the synchronous `removalCancelled` check in the
   * maybeRun/maybeHarvestThenSweep funnels; this durable half is an fs probe
   * and therefore runs inside the locked pipelines, behind the in-flight
   * reservation, where its nondeterministic completion order can no longer
   * decide which of two racing triggers wins the run lock.
   */
  private isRemovalTombstonedEffect(workspaceId: string): Effect.Effect<boolean> {
    return Effect.promise(() => isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId));
  }

  /**
   * Register one run's removal controller; disposed when the run settles.
   * A run made on a sub-agent's behalf over the OWNER's store (a redirected
   * trigger, the post-harvest sweep) is registered under the acting child's
   * id too: the child's removal drain (cancelInFlightConsolidation) must abort
   * it — a cancelled child harvest deliberately falls through to this sweep,
   * which could otherwise keep mutating the shared notebook for its whole
   * run after the removal's bounded drain returned.
   */
  private trackRunController(
    workspaceId: string,
    actingWorkspaceId?: string
  ): {
    controller: AbortController;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const ids = [
      workspaceId,
      ...(actingWorkspaceId !== undefined && actingWorkspaceId !== workspaceId
        ? [actingWorkspaceId]
        : []),
    ];
    // r61: a run registered after teardown began (follow-on sweep/recovery
    // racing the entry checks) must start already aborted.
    if (ids.some((id) => this.removalCancelled.has(id))) {
      controller.abort();
    }
    const sets = ids.map((id) => {
      const set = this.runControllers.get(id) ?? new Set<AbortController>();
      set.add(controller);
      this.runControllers.set(id, set);
      return [id, set] as const;
    });
    return {
      controller,
      dispose: () => {
        for (const [id, set] of sets) {
          set.delete(controller);
          if (set.size === 0 && this.runControllers.get(id) === set) {
            this.runControllers.delete(id);
          }
        }
      },
    };
  }

  /**
   * Workspace-removal drain (r60): abort every in-flight dream/harvest run
   * for this workspace and await them BOUNDED. The stream abort settles a
   * run promptly, but one wedged in pre-stream awaits or tool filesystem
   * I/O must not hang removal — after the window, residual runs are handed
   * to the shared usage-write registry (clearPendingBranchSummary drains it
   * right after this in the removal flow) for one more bounded chance, and
   * anything that outlives even that cannot commit durable memory: its
   * combined signal is aborted, so MemoryService refuses pre-commit inside
   * the target mutation lock. Idempotent; no-runs is a fast no-op.
   */
  cancelInFlightConsolidation(workspaceId: string): Promise<void> {
    return Effect.runPromise(this.cancelInFlightConsolidationEffect(workspaceId));
  }

  /**
   * Removal aborted BEFORE its point of no return (no tombstone published, the
   * workspace stays registered and intact — e.g. a non-forced removal whose
   * checkout deletion was refused): lift the teardown gate again, or the
   * surviving workspace would refuse every Dream run and post-compaction
   * harvest until restart. The drained in-flight runs are gone regardless
   * (retryable harvests recover on the next trigger).
   */
  releaseRemovalCancellation(workspaceId: string): void {
    this.removalCancelled.delete(workspaceId);
  }

  /**
   * Removal teardown for harvest state: the workspace's transcript is about
   * to be deleted, so its failed/stale-pending harvest records can never be
   * retried (recovery needs the compaction epoch's messages) — and once the
   * config entry is gone they could not even be associated with the memory
   * owner. Mark them terminal now so nothing lingers as "retryable".
   */
  async finalizeHarvestsForRemoval(workspaceId: string): Promise<void> {
    // One read-check-write under the sidecar lock: residual harvest runs
    // (cancelInFlightConsolidation's drain is bounded) may still be recording
    // outcomes, and a completion landing between an unlocked read and this
    // write must not be overwritten with a failure.
    const finalized = await this.locks.withLock(this.sidecarPath, async () => {
      const file = await this.load();
      const records = file.harvestsByWorkspace[workspaceId];
      if (records === undefined) return false;
      let changed = false;
      for (const [boundaryKey, record] of Object.entries(records)) {
        if (isTerminalHarvestRecord(record)) continue;
        records[boundaryKey] = finalizeHarvestRecordForRemoval(record);
        changed = true;
      }
      if (changed) await writeFileAtomic(this.sidecarPath, JSON.stringify(file, null, 2));
      return changed;
    });
    if (!finalized) return;
    const workspace = this.config.findWorkspace(workspaceId);
    this.emitStatusChange(
      workspaceId,
      workspace == null ? "" : resolveConsolidationProjectPath(workspace)
    );
  }

  /**
   * Teardown pipeline: uninterruptible end-to-end so the r61 mark, the abort
   * loop, and the residual-run handoff can never be separated, with the
   * bounded drain explicitly opted back into interruptibility — it is a wait,
   * and Effect.timeout must be able to interrupt it to keep removal from
   * wedging behind a run stuck in pre-stream awaits.
   */
  cancelInFlightConsolidationEffect(workspaceId: string): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        // Mark BEFORE aborting (r61): follow-on runs launched by the aborted
        // runs' own completion paths (post-harvest sweep, retryable-harvest
        // recovery) must find the workspace already tearing down.
        self.removalCancelled.add(workspaceId);
        for (const controller of self.runControllers.get(workspaceId) ?? []) {
          try {
            controller.abort();
          } catch (error) {
            // Stream internals attach abort listeners that can rethrow the abort
            // reason synchronously out of abort() (observed under Bun); the
            // removal drain must keep going — the signal IS aborted regardless.
            log.debug("[MemoryConsolidation] abort listener threw during removal drain", { error });
          }
        }
        const waits: Array<Promise<void>> = [];
        const active = self.inFlight.get(workspaceId);
        if (active !== undefined) {
          waits.push(
            active.then(
              () => undefined,
              () => undefined
            )
          );
        }
        for (const [key, run] of self.harvestInFlight) {
          if (key.startsWith(`${workspaceId}:`)) {
            waits.push(
              run.then(
                () => undefined,
                () => undefined
              )
            );
          }
        }
        if (waits.length === 0) return;
        const settled = yield* Effect.interruptible(
          Effect.promise(() => Promise.allSettled(waits).then(() => true as const)).pipe(
            Effect.timeout(Duration.millis(USAGE_WRITE_DRAIN_WINDOW_MS)),
            Effect.catch(() => Effect.succeed(false as const))
          )
        );
        if (!settled) {
          for (const wait of waits) {
            void trackPendingUsageWrite(workspaceId, wait);
          }
        }
      })
    );
  }

  /**
   * Funnel for every trigger. Checks experiment + debounce, then runs and
   * journals. Returns the record on a completed run, or a skip reason.
   *
   * Deliberately a plain async method, not an Effect facade: the in-flight
   * map is a per-workspace try-lock whose check-and-reserve below must
   * complete in ONE synchronous frame from the caller's perspective, so which
   * trigger wins the lock is decided by call order alone. The pre-Effect
   * shape awaited the durable removal tombstone (an fs probe) BEFORE the
   * check, which let libuv threadpool completion order pick the winner
   * between two racing triggers — the "rejects a second trigger" flake: when
   * the later trigger won, the earlier caller got the in-flight refusal and
   * the test then awaited a run gated on a promise it would only release
   * after that refusal, timing out. Only the synchronous r61 half of the
   * teardown gate stays here; the tombstone probe moved behind the
   * reservation (see isRemovalTombstonedEffect).
   */
  async maybeRun(
    workspaceId: string,
    trigger: MemoryConsolidationTrigger,
    options: MemoryConsolidationRunOptions = {}
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    if (!this.enabled()) return Err("memory-consolidation experiment is disabled");
    // Sub-agents share their task-tree owner's /memories/workspace store
    // (MemoryService.resolveWorkspaceMemoryOwnerId): a child's manual or
    // post-compaction run consolidates the OWNER's notebook under the owner's
    // in-flight lock, so it never races the owner's own runs and the child's
    // harvested candidates are actually swept. Archive is the owner's own
    // one-shot promotion pass; a child archive must not trigger it. Compared
    // by resolved owner, not parentWorkspaceId: a dangling/cyclic chain falls
    // back to a private store that must stay consolidatable.
    //
    // The acting child's own teardown gate comes BEFORE the redirect:
    // cancelInFlightConsolidation(child) marks only the child id, and an
    // owner-keyed run reserved after that would neither be refused by the
    // owner's check below nor be cancellable by the child's removal drain.
    if (
      this.removalCancelled.has(workspaceId) ||
      (options.actingWorkspaceId !== undefined &&
        this.removalCancelled.has(options.actingWorkspaceId))
    ) {
      return Err("workspace is being removed; consolidation refused");
    }
    const ownerWorkspaceId = this.memoryService.resolveWorkspaceMemoryOwnerId(workspaceId);
    if (ownerWorkspaceId !== workspaceId) {
      if (trigger === "archive") {
        return Err(
          "sub-agent workspaces share their owner's workspace memory; the owner's archive pass promotes it"
        );
      }
      // The owner run's recovery covers this child's harvest bucket too. The
      // child's durable tombstone is probed behind the reservation, like the
      // owner's (actingWorkspaceId).
      return this.maybeRun(ownerWorkspaceId, trigger, {
        ...options,
        actingWorkspaceId: options.actingWorkspaceId ?? workspaceId,
      });
    }
    const active = this.inFlight.get(workspaceId);
    if (active !== undefined) {
      // Archive is the workspace's one-shot final pass (workspace→global
      // promotion) and its caller never retries — queue it behind the active
      // run instead of dropping it. Other triggers are repetitive
      // housekeeping and may be dropped.
      if (trigger !== "archive") return Err("a consolidation run is already in flight");
      await active.catch(() => undefined);
      return this.maybeRun(workspaceId, trigger, options);
    }
    // Reserve the run lock in the same synchronous frame as the checks above:
    // the suspensions in runLockedEffect (tombstone probe, sidecar read,
    // agent body, model creation) are a wide window where a racing trigger
    // would otherwise also pass the check and start a second concurrent run
    // over the same directories. runPromise starts the fiber synchronously,
    // and the map is populated before this frame yields either way.
    const removal = this.trackRunController(workspaceId, options.actingWorkspaceId);
    const run = Effect.runPromise(
      this.runLockedEffect(workspaceId, trigger, options, removal.controller.signal)
    );
    this.inFlight.set(workspaceId, run);
    let result: Result<MemoryConsolidationRecord, string>;
    try {
      result = await run;
    } finally {
      this.inFlight.delete(workspaceId);
      removal.dispose();
    }
    // Removal cancelled this run: recovery would spawn child harvests outside
    // the cancellation registry being drained (their controllers were never
    // registered), mutating the shared workspace memory during destructive teardown.
    // A child-initiated run is keyed by the OWNER, so the acting child's own
    // cancellation must gate it too.
    if (
      options.skipHarvestRecovery !== true &&
      !this.removalCancelled.has(workspaceId) &&
      (options.actingWorkspaceId === undefined ||
        !this.removalCancelled.has(options.actingWorkspaceId))
    ) {
      await Effect.runPromise(this.recoverRetryableHarvestsEffect(workspaceId));
    }
    return result;
  }

  /**
   * Run one memory-writing stream once every earlier queued one has settled, so at most
   * one dream stream or analyzer chunk stream (runAnalyzerChunkExclusively) runs at a time
   * across ALL workspaces. The in-process queue orders this backend's runs; behind
   * it, a cross-process lock excludes a second backend on the same root (the
   * target locks only serialize single memory commands, not the model's
   * read/decide/write pass). Nothing starts, and `cancelled` comes back, when
   * `signal` aborts first: removal must cancel a run that is still waiting its
   * turn. Waiting happens after maybeRun's synchronous in-flight reservation,
   * so that per-workspace try-lock keeps its call-order semantics.
   *
   * `stream` is the whole turn: everything it awaits holds up every later stream, so it holds the
   * provider/tool stream and, for a dream, the run's journal write (which the next run's debounce
   * recheck must see before it gets the turn) and nothing else (see runTurn in runLockedEffect).
   * It must not wait for an analyzer turn or run an analyzer, or start another stream behind this
   * queue: the in-process tail is not reentrant.
   */
  private async runDreamStreamExclusively<T>(
    signal: AbortSignal,
    stream: () => Promise<T>
  ): Promise<DreamStreamTurn<T>> {
    const previous = this.dreamStreamTail;
    let release!: () => void;
    const turnDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Linked before the first await so queue order is call order. A cancelled
    // waiter still releases its link, which lets successors pass it.
    this.dreamStreamTail = previous.then(() => turnDone);
    try {
      if (!(await waitForTurnOrAbort(previous, signal))) return { outcome: "cancelled" };
      let releaseLock: () => Promise<void>;
      try {
        releaseLock = await acquireCrossProcessLock({
          lockPath: dreamStreamLockPath(this.config.rootDir),
          // A holder's stream is cut at this timeout, so one full timeout outlasts any healthy
          // holder. A wedged live holder is never taken over (fail closed): this run errors and
          // the next trigger retries.
          acquireTimeoutMs: MEMORY_CONSOLIDATION_TIMEOUT_MS,
          staleMs: MEMORY_CONSOLIDATION_TIMEOUT_MS,
          timeoutMessage: "Another Xum process is running a memory consolidation.",
          signal,
        });
      } catch (error) {
        if (signal.aborted) return { outcome: "cancelled" };
        return { outcome: "lock-failed", error: getErrorMessage(error) };
      }
      try {
        return { outcome: "ran", value: await stream() };
      } finally {
        await releaseLock();
      }
    } finally {
      release();
    }
  }

  /**
   * The gate of one analyzer job's chunks (see ChunkStreamGate): each chunk's model stream runs
   * inside the dream exclusion, so it never interleaves its read-to-insert sequences with a
   * dream's or another analyzer's, in this process or another. A chunk, not the job, takes the
   * exclusion: its lock waiters give up after one consolidation timeout, which a job of many
   * chunks could outlast. `signal` is the job's removal: a chunk still waiting is cancelled.
   */
  private runAnalyzerChunkExclusively(signal: AbortSignal): ChunkStreamGate {
    return async (stream) => {
      const turn = await this.runDreamStreamExclusively(signal, stream);
      switch (turn.outcome) {
        case "ran":
          return { started: true, value: turn.value };
        case "cancelled":
          return {
            started: false,
            reason: "workspace removal cancelled it while it waited for its turn",
          };
        case "lock-failed":
          return {
            started: false,
            reason: `could not take the consolidation lock: ${turn.error}`,
          };
        default:
          return assertNever(turn);
      }
    };
  }

  /** The actual run; only ever invoked by maybeRun while holding the lock. */
  private runLockedEffect(
    workspaceId: string,
    trigger: MemoryConsolidationTrigger,
    options: MemoryConsolidationRunOptions,
    removalSignal: AbortSignal
  ): Effect.Effect<Result<MemoryConsolidationRecord, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      // Durable cross-process teardown gate (r61); see isRemovalTombstonedEffect
      // for why this runs behind the in-flight reservation.
      if (yield* self.isRemovalTombstonedEffect(workspaceId)) {
        return Err("workspace is being removed; consolidation refused");
      }
      if (
        options.actingWorkspaceId !== undefined &&
        (yield* self.isRemovalTombstonedEffect(options.actingWorkspaceId))
      ) {
        return Err("workspace is being removed; consolidation refused");
      }

      // Cheap early exit, before the model is created and a turn is queued for. It is not the
      // gate: another backend can journal while this run waits, so the turn rechecks (below).
      if (yield* self.isDebouncedEffect(workspaceId, trigger, options)) {
        return Err(DEBOUNCED_SKIP_REASON);
      }

      const workspace = self.config.findWorkspace(workspaceId);
      if (!workspace) return Err(`workspace not found: ${workspaceId}`);
      // Sub-agents share their task-tree owner's /memories/workspace store
      // (MemoryService.resolveWorkspaceMemoryOwnerId), so a Dream run from a
      // child would consolidate the owner's notebook concurrently with the
      // owner's own runs. Children still analyze their epochs into the shared
      // workspace memory; only the owner runs the dream over it.

      const agentBody = yield* Effect.promise(() => resolveDreamAgentBody(self.config.rootDir));
      if (agentBody === null) return Err("dream agent definition is missing");

      const modelString = resolveDreamModelString(self.config, workspaceId);
      const modelResult = yield* Effect.promise(async () =>
        self.modelFactory.createModelWithPinnedMetadata(modelString, {
          agentInitiated: true,
          workspaceId,
        })
      );
      if (!modelResult.success) {
        return Err(`could not create model ${modelString}: ${modelResult.error.type}`);
      }

      const projectPath = resolveConsolidationProjectPath(workspace);
      // A child's redirected run sweeps under the owner's identity; the
      // child's own removal tombstone still refuses every read and commit of
      // the run (MemoryScopeContext.guardedWorkspaceId) — a remover in another
      // backend cannot abort this controller.
      const ctx: MemoryScopeContext = {
        runtime: null,
        checkoutCwd: "",
        workspaceId,
        projectPath,
        ...(options.actingWorkspaceId !== undefined && options.actingWorkspaceId !== workspaceId
          ? { guardedWorkspaceId: options.actingWorkspaceId }
          : {}),
      };

      // The stream's usage is recorded after its queue slot is released, not inside it.
      const usageRecorder = createDeferredUsageRecorder("MemoryConsolidation", workspaceId);
      const consolidate = () =>
        runMemoryConsolidation({
          model: modelResult.data.model,
          pricingModel: modelResult.data.metadataModel,
          agentBody,
          memoryService: self.memoryService,
          metaService: self.metaService,
          ctx,
          dryRun: false,
          finalPass: trigger === "archive",
          // Hard timeout: a wedged provider stream must not hold the in-flight
          // lock forever (and stall the sequential launch sweep behind it).
          // Created when this run's turn in the queue arrives (the call happens
          // inside runDreamStreamExclusively), so it bounds the stream and
          // never the wait behind other workspaces.
          // Combined with the removal controller (r60): workspace removal must
          // abort the stream AND flip the tool-level pre-commit checks so a
          // detached mutation cannot land after the session directory is gone.
          abortSignal: AbortSignal.any([
            AbortSignal.timeout(MEMORY_CONSOLIDATION_TIMEOUT_MS),
            removalSignal,
          ]),
          recordUsage: (usage, providerMetadata) =>
            usageRecorder.defer(async () => {
              const recorded = await self.sessionUsageService?.recordHeadlessUsage(
                workspaceId,
                modelString,
                usage,
                providerMetadata,
                {
                  analyticsSource: "memory_consolidation",
                  // Creation-time identity: a catalog refresh mid-run must not
                  // re-attribute this spend (see ModelFactoryLike).
                  metadataModel: modelResult.data.metadataModel,
                }
              );
              // The sidecar row only reaches dashboard totals via an explicit
              // ingest pass; request one (forwarded by ServiceContainer) so sweep
              // spend doesn't strand until an unrelated stream-end or restart.
              if (recorded) {
                self.emit("analyticsIngest", { workspaceId });
              }
            }),
        });

      // Everything that must happen while this run holds the turn (the in-process tail and the
      // cross-process lock), and nothing slower: the next run reads the journal the moment the
      // turn is released. The debounce is rechecked here, from disk, because another backend
      // that was ahead of this run may have journaled after the pre-queue check passed; and the
      // success record is saved here, before release, so that read sees it. The save is the
      // sidecar's brief in-process lock plus one atomic write. Usage recording is not part of the
      // turn (see `usageRecorder`).
      const runTurn = async (): Promise<Result<MemoryConsolidationRecord, string>> => {
        if (await Effect.runPromise(self.isDebouncedEffect(workspaceId, trigger, options))) {
          return Err(DEBOUNCED_SKIP_REASON);
        }
        const result = await consolidate();
        // A stream failure (provider error or the run timeout) means the pass did
        // NOT cover the memory state: skip the journal record so the debounce and
        // launch sweep retry later instead of reporting a successful consolidation
        // that never happened.
        if (result.streamError !== undefined) {
          return Err(`consolidation stream failed: ${result.streamError}`);
        }
        const record: MemoryConsolidationRecord = {
          lastRunAt: Date.now(),
          trigger,
          summary: result.summary,
          ops: result.ops,
          usage: result.usage,
        };
        await Effect.runPromise(self.saveRecordEffect(workspaceId, projectPath, record));
        return Ok(record);
      };
      const turn = yield* Effect.promise(async () =>
        self.runDreamStreamExclusively(removalSignal, runTurn)
      );
      // Removal reached this run while it was still queued: no stream started.
      if (turn.outcome === "cancelled") {
        return Err("workspace is being removed; consolidation refused");
      }
      // No stream started: a stream without the cross-process lock could overlap another
      // backend's. Nothing is journaled, so the next trigger retries.
      if (turn.outcome === "lock-failed") {
        return Err(`could not take the consolidation lock: ${turn.error}`);
      }
      // Debounced behind another run, or the stream failed: nothing was journaled.
      if (!turn.value.success) return turn.value;
      const record = turn.value.data;

      yield* Effect.promise(usageRecorder.flush);

      log.debug("[MemoryConsolidation] run complete", {
        workspaceId,
        trigger,
        ops: record.ops.length,
        applied: record.ops.filter((op) => op.applied).length,
        globalWrites: record.ops.filter((op) => op.path.startsWith("/memories/global/")).length,
        usage: record.usage,
      });
      return Ok(record);
    });
  }

  /**
   * Same funnel contract as maybeRun (see its doc): the boundary-key
   * coalescing check-and-reserve must stay in one synchronous frame, so only
   * the synchronous r61 teardown half lives here and the durable tombstone
   * probe runs inside harvestThenSweepLockedEffect.
   */
  async maybeHarvestThenSweep(
    metadata: CompactionCompletionMetadata
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    if (!this.enabled()) return Err("memory-consolidation experiment is disabled");
    if (this.removalCancelled.has(metadata.workspaceId)) {
      return Err("workspace is being removed; harvest refused");
    }

    const boundaryRunKey = `${metadata.workspaceId}:${metadata.summaryMessageId}`;
    const active = this.harvestInFlight.get(boundaryRunKey);
    if (active !== undefined) return active;

    const removal = this.trackRunController(metadata.workspaceId);
    const run = Effect.runPromise(
      this.harvestThenSweepLockedEffect(metadata, removal.controller.signal)
    );
    this.harvestInFlight.set(boundaryRunKey, run);
    try {
      return await run;
    } finally {
      this.harvestInFlight.delete(boundaryRunKey);
      removal.dispose();
    }
  }

  /**
   * Archive's final pass: analyze the epoch the workspace is still in (no compaction closed it, so
   * nothing has read it), then run the dream, so the dream can promote what the analyzer wrote.
   * Best effort: an analysis that fails or is refused never stops the dream, the one chance to
   * promote before workspace memory is deleted. Undebounced, like every archive run.
   *
   * A sub-agent's archive analyzes its own open epoch too, into the owner's workspace memory (its
   * analyzer context redirects there, as a compaction's does), but the dream is the owner's: the
   * child's archive is refused after the analysis, as maybeRun does, and the owner's archive pass
   * promotes what the child wrote.
   */
  async maybeRunArchivePass(
    workspaceId: string
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    if (!this.enabled()) return Err("memory-consolidation experiment is disabled");
    if (this.removalCancelled.has(workspaceId)) {
      return Err("workspace is being removed; consolidation refused");
    }
    // Registered in this synchronous frame, before any await, and for the whole call, queueing
    // behind an earlier pass included: the owner's pass must never find a gap to slip through.
    const endDescendantPass = this.trackDescendantArchivePass(workspaceId);
    try {
      const runKey = `${workspaceId}:archive-pass`;
      const active = this.harvestInFlight.get(runKey);
      if (active !== undefined) {
        // Queued, not coalesced, like maybeRun's archive: rows added since the active pass read
        // the epoch (an unarchive and a new archive inside one pass) are for this pass to analyze.
        await active.catch(() => undefined);
        return await this.maybeRunArchivePass(workspaceId);
      }
      const run = this.analyzeOpenEpochThenRunArchive(workspaceId);
      this.harvestInFlight.set(runKey, run);
      try {
        return await run;
      } finally {
        this.harvestInFlight.delete(runKey);
      }
    } finally {
      endDescendantPass();
    }
  }

  /**
   * Marks `workspaceId`'s archive pass as in flight for the owner of its workspace memory, when it
   * is a sub-agent's: its analysis writes into the owner's store, and the owner's own pass waits
   * for it (see awaitDescendantArchivePasses). Returns the call that ends the mark. An owner's
   * pass is not marked: nothing waits on it.
   */
  private trackDescendantArchivePass(workspaceId: string): () => void {
    const ownerId = this.memoryService.resolveWorkspaceMemoryOwnerId(workspaceId);
    if (ownerId === workspaceId) return () => undefined;
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const passes = this.descendantArchivePasses.get(ownerId) ?? new Set<Promise<void>>();
    passes.add(ended);
    this.descendantArchivePasses.set(ownerId, passes);
    return () => {
      passes.delete(ended);
      if (passes.size === 0 && this.descendantArchivePasses.get(ownerId) === passes) {
        this.descendantArchivePasses.delete(ownerId);
      }
      end();
    };
  }

  /**
   * Resolves once no archive pass of a sub-agent of `ownerId` is in flight, or when `signal`
   * aborts (the owner's removal: nothing is left to wait for). A pass that starts while this
   * waits is waited for too. A pass ends once its chunk streams have (each is cut at its own
   * timeout) and its usage and records are saved, or at its workspace's removal, so this adds no
   * timer of its own. Recording the usage takes the session directory's lock, which has no
   * timeout: a holder that never lets go holds this wait too.
   */
  private async awaitDescendantArchivePasses(ownerId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      const passes = this.descendantArchivePasses.get(ownerId);
      if (passes === undefined || passes.size === 0) return;
      log.debug("[MemoryConsolidation] archive pass waiting for sub-agent archive analyses", {
        workspaceId: ownerId,
        passes: passes.size,
      });
      const waited = await waitForTurnOrAbort(
        Promise.all(passes).then(() => undefined),
        signal
      );
      if (!waited) return;
    }
  }

  private async analyzeOpenEpochThenRunArchive(
    workspaceId: string
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    const removal = this.trackRunController(workspaceId);
    try {
      try {
        const analyzed = await Effect.runPromise(
          this.analyzeOpenEpochEffect(workspaceId, removal.controller.signal)
        );
        if (!analyzed.success) {
          log.debug("[MemoryConsolidation] open-epoch analysis skipped", {
            workspaceId,
            reason: analyzed.error,
          });
        }
      } catch (error) {
        log.warn(
          "[MemoryConsolidation] open-epoch analysis failed; running the final pass anyway",
          { workspaceId, error: getErrorMessage(error) }
        );
      }
      // The sub-agents of a task-tree archive analyze into this workspace's memory in the
      // background: the dream is the one promotion pass before that memory is deleted, so it starts
      // after they settle, whether or not this pass's own analysis worked.
      await this.awaitDescendantArchivePasses(workspaceId, removal.controller.signal);
    } finally {
      removal.dispose();
    }
    return this.maybeRun(workspaceId, "archive");
  }

  /**
   * Analyzer run over the rows after the latest context boundary. The record key is the newest
   * row (see OPEN_EPOCH_KEY_PREFIX): the same rows are never analyzed twice, new rows get a new
   * run that reads only them (see analyzedOpenEpochRowIds), and an epoch with nothing to read makes
   * no model call and no record.
   */
  private analyzeOpenEpochEffect(
    workspaceId: string,
    removalSignal: AbortSignal
  ): Effect.Effect<Result<void, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const scope = yield* self.harvestScopeEffect(workspaceId);
      if (!scope.success) return Err(scope.error);
      const history = yield* Effect.promise(() =>
        self.historyService.getHistoryFromLatestBoundary(workspaceId)
      );
      if (!history.success) return Err(`could not read workspace history: ${history.error}`);
      const openEpoch = selectOpenEpoch(history.data);
      const newest = openEpoch.messages.at(-1);
      if (newest === undefined) return Ok(undefined);

      yield* self.runHarvestJobEffect(
        {
          workspaceId,
          boundaryKey: `${OPEN_EPOCH_KEY_PREFIX}${newest.id}`,
          compactionEpoch: openEpoch.compactionEpoch,
          readEpoch: () => Promise.resolve(Ok({ messages: openEpoch.messages })),
        },
        scope.data,
        removalSignal
      );
      return Ok(undefined);
    });
  }

  private harvestThenSweepLockedEffect(
    metadata: CompactionCompletionMetadata,
    removalSignal: AbortSignal
  ): Effect.Effect<Result<MemoryConsolidationRecord, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const scope = yield* self.harvestScopeEffect(metadata.workspaceId);
      if (!scope.success) return Err(scope.error);
      yield* self.runHarvestJobEffect(
        {
          workspaceId: metadata.workspaceId,
          boundaryKey: metadata.summaryMessageId,
          compactionEpoch: metadata.compactionEpoch,
          completionMetadata: metadata,
          readEpoch: () =>
            self.historyService.getMessagesForCompactionEpoch(metadata.workspaceId, metadata),
        },
        scope.data,
        removalSignal
      );

      // A sub-agent's analyzer writes into the owner's store: wait on and run the OWNER's
      // dream (see maybeRun) so what the analyzer wrote is organized — still as the acting
      // CHILD, so the child's in-process cancellation, durable tombstone and removal drain
      // bind the owner-keyed run too.
      return yield* Effect.promise(() =>
        self.runCompactionSweepAfterHarvest(
          self.memoryService.resolveWorkspaceMemoryOwnerId(metadata.workspaceId),
          metadata.workspaceId
        )
      );
    });
  }

  /** The durable teardown gate and the memory scope that every analyzer run starts with. */
  private harvestScopeEffect(
    workspaceId: string
  ): Effect.Effect<Result<MemoryScopeContext, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      // Durable cross-process teardown gate (r61); see isRemovalTombstonedEffect.
      if (yield* self.isRemovalTombstonedEffect(workspaceId)) {
        return Err("workspace is being removed; harvest refused");
      }
      const workspace = self.config.findWorkspace(workspaceId);
      if (!workspace) return Err(`workspace not found: ${workspaceId}`);
      return Ok<MemoryScopeContext>({
        runtime: null,
        checkoutCwd: "",
        workspaceId,
        projectPath: resolveConsolidationProjectPath(workspace),
      });
    });
  }

  /**
   * One analyzer run of `source`, with its record: skip a completed one or one out of attempts,
   * otherwise run it (resuming at the chunk an earlier attempt reached) and journal the outcome.
   * Never fails: the pre-Effect body was one whole try/catch, so any failure is journaled.
   */
  private runHarvestJobEffect(
    source: HarvestSource,
    ctx: MemoryScopeContext,
    removalSignal: AbortSignal
  ): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const { workspaceId, boundaryKey } = source;
      const projectPath = ctx.projectPath;
      const sidecar = yield* self.loadEffect();
      const existing = sidecar.harvestsByWorkspace[workspaceId]?.[boundaryKey];
      const existingAttemptCount = existing?.attemptCount ?? 0;
      const { progress, attemptState } = harvestResumeState(existing);

      const staleFailure = staleExhaustedHarvestFailure(existing);
      if (staleFailure !== undefined) {
        yield* self.saveHarvestRecordEffect(workspaceId, boundaryKey, staleFailure, projectPath);
      }

      if (existing?.status !== "completed" && existingAttemptCount < HARVEST_MAX_ATTEMPTS) {
        const startedAt = Date.now();
        yield* self.saveHarvestRecordEffect(
          workspaceId,
          boundaryKey,
          {
            status: "pending",
            startedAt,
            attemptCount: existingAttemptCount + 1,
            ...harvestRecordIdentity(source),
            ...harvestAttemptFields(progress, attemptState),
          },
          projectPath
        );

        // Any failure — a typed throw below, a rejected await, or a defect such
        // as the completed-record save rejecting — journals a failed record, so
        // the fold handles the error channel AND defects identically.
        const journalHarvestFailure = (error: unknown): Effect.Effect<void> =>
          Effect.gen(function* () {
            yield* self.saveHarvestRecordEffect(
              workspaceId,
              boundaryKey,
              {
                status: "failed",
                startedAt,
                completedAt: Date.now(),
                attemptCount: existingAttemptCount + 1,
                ...harvestRecordIdentity(source),
                ...harvestAttemptFields(progress, attemptState),
                error: getErrorMessage(error),
              },
              projectPath
            );
            log.warn("[MemoryConsolidation] harvest failed", {
              workspaceId,
              boundaryKey,
              error: getErrorMessage(error),
            });
          });

        yield* self
          .runHarvestAttemptEffect(source, ctx, startedAt, {
            existingAttemptCount,
            removalSignal,
            progress,
            attemptState,
            earlierRecords: sidecar.harvestsByWorkspace[workspaceId],
          })
          .pipe(Effect.catch(journalHarvestFailure), Effect.catchDefect(journalHarvestFailure));
      }
    });
  }

  /**
   * The old try-block of harvestThenSweepLocked; fails with the thrown cause. Runs the analyzer
   * over the epoch and persists a resume cursor after each clean chunk.
   */
  private runHarvestAttemptEffect(
    source: HarvestSource,
    ctx: MemoryScopeContext,
    startedAt: number,
    opts: {
      existingAttemptCount: number;
      removalSignal: AbortSignal;
      /** Shared with the caller: its failure record reads what this attempt reached. */
      progress: HarvestProgress;
      /** Shared with the caller for the same reason. */
      attemptState: HarvestAttemptState;
      /** The workspace's records as they stood before this job: the earlier runs of this epoch. */
      earlierRecords: Record<string, MemoryHarvestRecord> | undefined;
    }
  ): Effect.Effect<void, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      const { workspaceId, boundaryKey } = source;
      const epoch = yield* Effect.tryPromise({
        try: async () => source.readEpoch(),
        catch: (error) => error,
      });
      if (!epoch.success) return yield* Effect.fail(new Error(epoch.error));

      const saveCompleted = (
        progress: HarvestProgress,
        outcome: Pick<MemoryHarvestRecord, "note" | "readThroughRowId"> = {}
      ): Effect.Effect<void> =>
        self.saveHarvestRecordEffect(
          workspaceId,
          boundaryKey,
          {
            status: "completed",
            startedAt,
            completedAt: Date.now(),
            attemptCount: opts.existingAttemptCount + 1,
            ...harvestRecordIdentity(source),
            ...harvestAttemptFields(progress, opts.attemptState),
            note: outcome.note,
            readThroughRowId: outcome.readThroughRowId,
          },
          ctx.projectPath
        );

      // An archive that read part of this epoch's rows already analyzed them: a second archive
      // after new rows, and the compaction that later closes the epoch, both start after them.
      // The first attempt fixes the floor in the record and a retry reuses it: the chunk cursor
      // counts chunks of the rows after that floor, and looking again could find a newer one (an
      // archive that read the epoch before it closed may complete after the first attempt).
      // A first attempt takes the floor from the records as they stand when its analyzer turn
      // arrives (below): an archive of the same epoch can still be streaming ahead of it, and
      // the rows that archive reads meanwhile reach the sidecar only as it finishes chunks. The
      // read here only spares the model and the wait when nothing is left to read already.
      const recordedFloor = opts.attemptState.analyzedFloorRowId;
      const floorFrom = (records: Record<string, MemoryHarvestRecord> | undefined) =>
        recordedFloor !== undefined
          ? recordedFloor
          : analyzedFloorRowId(epoch.data.messages, analyzedOpenEpochRowIds(records));
      // Every row was analyzed before: nothing is left to read, so no model call.
      const nothingLeftAfter = (floor: string | null) =>
        epoch.data.messages.length > 0 && rowsAfterFloor(epoch.data.messages, floor).length === 0;
      const floorBeforeWait = floorFrom(opts.earlierRecords);
      if (nothingLeftAfter(floorBeforeWait)) {
        opts.attemptState.analyzedFloorRowId = floorBeforeWait;
        return yield* saveCompleted(opts.progress);
      }

      const modelString = resolveDreamModelString(self.config, workspaceId);
      const modelResult = yield* Effect.tryPromise({
        try: async () =>
          self.modelFactory.createModelWithPinnedMetadata(modelString, {
            agentInitiated: true,
            workspaceId,
          }),
        catch: (error) => error,
      });
      if (!modelResult.success) {
        return yield* Effect.fail(
          new Error(`could not create model ${modelString}: ${modelResult.error.type}`)
        );
      }

      const adopt = (reached: HarvestProgress, resumeAt = reached.nextChunk): void => {
        opts.progress.nextChunk = resumeAt;
        opts.progress.ops = reached.ops;
        opts.progress.budgetUsed = reached.budgetUsed;
        opts.progress.nextChunkOps = reached.nextChunkOps;
        opts.progress.readThroughRowId = reached.readThroughRowId;
        opts.progress.usage = reached.usage;
      };
      const savePending = (progress: HarvestProgress): Effect.Effect<void> =>
        self.saveHarvestRecordEffect(
          workspaceId,
          boundaryKey,
          {
            status: "pending",
            startedAt,
            // The sign of life that keeps a run of many chunks from being stale (see
            // isStalePendingHarvestRecord).
            progressAt: Date.now(),
            attemptCount: opts.existingAttemptCount + 1,
            ...harvestRecordIdentity(source),
            ...harvestAttemptFields(progress, opts.attemptState),
          },
          ctx.projectPath
        );

      // One analyzer job at a time per owner store (analyzerStreams), and each chunk's stream
      // inside the dream exclusion (streamGate). The chunk timeouts start inside runMemoryHarvest,
      // once the chunk holds it, so they bound the stream and never the wait behind another one.
      const ownerId = self.memoryService.resolveWorkspaceMemoryOwnerId(workspaceId);
      // Each clean chunk's usage is recorded after the owner's turn is released, not inside it.
      const usageRecorder = createDeferredUsageRecorder("MemoryHarvest", workspaceId);
      const harvest = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await self.analyzerStreams.run(ownerId, opts.removalSignal, async () => {
              // The epoch has one edit budget, not one per record: a run after an unarchive and a
              // new row, and the compaction that closes the epoch, start from what the earlier runs
              // spent. A retry keeps its own spend if that is higher. Read once the turn has come,
              // not before the wait: a record of the same epoch that ran ahead (an archive and a
              // compaction of one epoch can overlap) reaches the sidecar only when it completes.
              const { harvestsByWorkspace } = await self.load();
              // The floor comes from this read too, for the same reason as the budget below.
              const floor = floorFrom(harvestsByWorkspace[workspaceId]);
              opts.attemptState.analyzedFloorRowId = floor;
              if (nothingLeftAfter(floor)) return ALL_ROWS_ANALYZED;
              opts.progress.budgetUsed = Math.max(
                budgetSpent(opts.progress),
                epochBudgetSpent(harvestsByWorkspace[workspaceId], epoch.data.messages)
              );
              const result = await runMemoryHarvest({
                model: modelResult.data.model,
                pricingModel: modelResult.data.metadataModel,
                memoryService: self.memoryService,
                metaService: self.metaService,
                ctx,
                messages: rowsAfterFloor(epoch.data.messages, floor),
                summary: epoch.data.summary,
                resume: opts.progress,
                // The cursor reaches disk after each clean chunk: a crash or a later chunk's failure
                // must not make the retry write the earlier chunks' memory again.
                onChunkComplete: async (reached) => {
                  adopt(reached);
                  await Effect.runPromise(savePending(reached));
                },
                // Removal (r60); each chunk adds its own timeout (see runMemoryHarvest).
                abortSignal: opts.removalSignal,
                streamGate: self.runAnalyzerChunkExclusively(opts.removalSignal),
                recordUsage: (usage, providerMetadata) =>
                  usageRecorder.defer(async () => {
                    const recorded = await self.sessionUsageService?.recordHeadlessUsage(
                      workspaceId,
                      modelString,
                      usage,
                      providerMetadata,
                      {
                        analyticsSource: "memory_harvest",
                        // Creation-time identity (see ModelFactoryLike).
                        metadataModel: modelResult.data.metadataModel,
                      }
                    );
                    // Same as consolidation above: request an ingest pass so harvest
                    // spend reaches dashboard totals promptly.
                    if (recorded) {
                      self.emit("analyticsIngest", { workspaceId });
                    }
                  }),
              });
              // Edits of a chunk that failed already landed: the failure record keeps them. A
              // failure from here on (the completed record's save) resumes at the first chunk
              // nobody read: resuming past a budget skip would report the skipped chunks' rows as
              // read and lose the note.
              adopt(result, result.readChunks);
              if (result.streamError !== undefined) {
                // The failure record is saved after this turn is released, so a queued run of the
                // same epoch would seed its budget (above) without what this one spent. Saved
                // here, the next turn's load() sees it; the failure record then replaces it.
                await Effect.runPromise(savePending(result));
              }
              return result;
            });
          } finally {
            // Also after a failed chunk: the chunks that finished before it were billed.
            await usageRecorder.flush();
          }
        },
        catch: (error) => error,
      });
      // Removal reached this run while it was still queued: no chunk was read.
      if (harvest === null) {
        return yield* Effect.fail(
          new Error("workspace is being removed; harvest cancelled before its turn")
        );
      }
      // Earlier runs read every row while this one waited for its turn: no chunk, no model call.
      if (harvest === ALL_ROWS_ANALYZED) return yield* saveCompleted(opts.progress);
      if (harvest.streamError !== undefined) {
        return yield* Effect.fail(new Error(`harvest stream failed: ${harvest.streamError}`));
      }

      yield* saveCompleted(harvest, harvest);
    });
  }

  private isWorkspaceCurrentlyArchived(workspaceId: string): boolean {
    for (const project of this.config.loadConfigOrDefault().projects.values()) {
      const workspace = project.workspaces.find((entry) => entry.id === workspaceId);
      if (workspace === undefined) continue;
      return isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt);
    }
    return false;
  }

  private async runCompactionSweepAfterHarvest(
    workspaceId: string,
    actingWorkspaceId: string
  ): Promise<Result<MemoryConsolidationRecord, string>> {
    for (;;) {
      const active = this.inFlight.get(workspaceId);
      if (active !== undefined) {
        await active.catch(() => undefined);
        continue;
      }

      const trigger = this.isWorkspaceCurrentlyArchived(workspaceId) ? "archive" : "compaction";
      // Debounced like every other automatic trigger: each organizer pass costs
      // a full read of the memory files, and a compaction is no reason to pay
      // that again within the window. A debounced sweep returns its skip
      // quietly (only "already in flight" loops); what the analyzer wrote waits
      // in workspace memory for the next run. Archive stays undebounced.
      const result = await this.maybeRun(workspaceId, trigger, {
        skipHarvestRecovery: true,
        ...(actingWorkspaceId !== workspaceId ? { actingWorkspaceId } : {}),
      });
      if (!result.success && result.error === "a consolidation run is already in flight") {
        continue;
      }
      return result;
    }
  }

  /**
   * Fire-and-forget wrapper for trigger sites; never throws. Runs as a
   * detached fiber (the idleDispatcher runFork template): runFork executes
   * synchronously up to maybeRun's first suspension — the same observable
   * ordering as the previous void-promise chain, so the in-flight
   * reservation still lands in trigger-call order — and both folds keep the
   * never-throws contract.
   */
  triggerInBackground(workspaceId: string, trigger: MemoryConsolidationTrigger): void {
    // Cheap synchronous pre-check so disabled installs pay zero I/O.
    if (!this.enabled()) return;
    Effect.runFork(
      Effect.tryPromise({
        try: async () =>
          trigger === "archive"
            ? this.maybeRunArchivePass(workspaceId)
            : this.maybeRun(workspaceId, trigger),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() => {
            if (!result.success) {
              log.debug("[MemoryConsolidation] skipped", {
                workspaceId,
                trigger,
                reason: result.error,
              });
            }
          })
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn("[MemoryConsolidation] background run failed", {
              workspaceId,
              trigger,
              error: getErrorMessage(error),
            });
          })
        )
      )
    );
  }

  /** See triggerInBackground for the detached-fiber shape. */
  triggerHarvestThenSweepInBackground(metadata: CompactionCompletionMetadata): void {
    if (!this.enabled()) return;
    Effect.runFork(
      Effect.tryPromise({
        try: async () => this.maybeHarvestThenSweep(metadata),
        catch: (error) => error,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() => {
            if (!result.success) {
              log.debug("[MemoryConsolidation] harvest/sweep skipped", {
                workspaceId: metadata.workspaceId,
                reason: result.error,
              });
            }
          })
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn("[MemoryConsolidation] background harvest/sweep failed", {
              workspaceId: metadata.workspaceId,
              error: getErrorMessage(error),
            });
          })
        )
      )
    );
  }

  /**
   * App-launch sweep (launch-only by design, PRD #3534): consolidate
   * workspaces idle ≥ MEMORY_CONSOLIDATION_IDLE_MS that have memory writes
   * newer than their last run. `recencyByWorkspace` comes from the host-local
   * extension metadata (last user interaction).
   *
   * Cost rails: archived workspaces never qualify (they got their final pass
   * at archive time and would otherwise stay "idle" forever); global-scope
   * writes are anchored on the newest run across ALL workspaces — global
   * scope is shared, so one pass covers it, and anchoring per-workspace would
   * let each run's own global cleanup re-qualify every other workspace in an
   * endless multi-launch loop; at most MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP
   * workspaces run per launch.
   */
  runLaunchSweep(recencyByWorkspace: Map<string, number>): Promise<void> {
    return Effect.runPromise(this.runLaunchSweepEffect(recencyByWorkspace));
  }

  private runLaunchSweepEffect(recencyByWorkspace: Map<string, number>): Effect.Effect<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (!self.enabled()) return;
      const now = Date.now();
      const meta = yield* self.metaService.effects.getEntries();
      const sidecar = yield* self.loadEffect();
      // Newest completed run anywhere = last time global scope was covered
      // (every run consolidates global). Derived, so no sidecar schema change.
      // Advanced after each successful run below: a global-only write needs ONE
      // covering pass, not one per idle workspace in the same sweep.
      let globalLastRunAt = findNewestWorkspaceRecord(sidecar.workspaces)?.lastRunAt ?? 0;
      const archivedById = new Map<string, boolean>();
      const projectPathByWorkspace = new Map<string, string>();
      const cfg = self.config.loadConfigOrDefault();
      for (const [configProjectPath, project] of cfg.projects) {
        for (const workspace of project.workspaces) {
          if (workspace.id === undefined) continue;
          archivedById.set(
            workspace.id,
            isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
          );
          projectPathByWorkspace.set(
            workspace.id,
            resolveConsolidationProjectPath({
              projectPath: configProjectPath,
              projects: workspace.projects,
            })
          );
        }
      }
      const projectLastRunAt = new Map<string, number>(
        Object.entries(sidecar.projects).map(([projectPath, record]) => [
          projectPath,
          record.lastRunAt,
        ])
      );

      // Shared stores: a child's writes are keyed under its owner, so the
      // owner's row absorbs every tree member's recency (a notebook is idle
      // only when the WHOLE tree is) and child rows are then dropped —
      // running a child would just redirect to the owner anyway.
      const treeRecency = new Map<string, number>();
      for (const [workspaceId, recency] of recencyByWorkspace) {
        const ownerId = self.memoryService.resolveWorkspaceMemoryOwnerId(workspaceId, () => cfg);
        treeRecency.set(ownerId, Math.max(treeRecency.get(ownerId) ?? 0, recency));
      }

      let started = 0;
      for (const [workspaceId, recency] of treeRecency) {
        if (started >= MEMORY_CONSOLIDATION_LAUNCH_SWEEP_CAP) break;
        if (now - recency < MEMORY_CONSOLIDATION_IDLE_MS) continue;
        if (archivedById.get(workspaceId) === true) continue;
        const lastRunAt = sidecar.workspaces[workspaceId]?.lastRunAt ?? 0;
        const projectPath = projectPathByWorkspace.get(workspaceId) ?? "";
        const projectRunAt = projectPath === "" ? 0 : (projectLastRunAt.get(projectPath) ?? 0);
        // "Writes since last run": any workspace-scope entry for this workspace,
        // project-scope entry for its single-project identity, or global entry
        // newer than the newest run anywhere qualifies.
        // Prefixes are derived via memoryLogicalKey (relPath "" =>
        // "<scope>:<id>:") so the encoding always matches the meta key scheme.
        const workspaceKeyPrefix = memoryLogicalKey("workspace", "", {
          projectPath: "",
          workspaceId,
        });
        const projectKeyPrefix =
          projectPath === ""
            ? null
            : memoryLogicalKey("project", "", {
                projectPath,
                workspaceId,
              });
        let hasWorkspaceWrites = false;
        let hasProjectWrites = false;
        let hasGlobalWrites = false;
        for (const [key, entry] of meta) {
          if (entry.lastWriteAt === null) continue;
          if (key.startsWith(workspaceKeyPrefix) && entry.lastWriteAt > lastRunAt) {
            hasWorkspaceWrites = true;
            continue;
          }
          if (
            projectKeyPrefix !== null &&
            key.startsWith(projectKeyPrefix) &&
            entry.lastWriteAt > projectRunAt
          ) {
            hasProjectWrites = true;
            continue;
          }
          if (key.startsWith("global:") && entry.lastWriteAt > globalLastRunAt) {
            hasGlobalWrites = true;
          }
        }
        if (!hasWorkspaceWrites && !hasProjectWrites && !hasGlobalWrites) continue;
        // Project coverage is anchored separately from workspace coverage. Recent
        // legacy workspace-only records must not debounce away the first project
        // pass, but once project coverage exists, project-only writes obey the
        // project debounce anchor before another sibling spends a provider run.
        const projectDebounceAllowsRun =
          hasProjectWrites && now - projectRunAt >= MEMORY_CONSOLIDATION_DEBOUNCE_MS;
        const projectDebounceWouldSkip =
          hasProjectWrites &&
          !hasWorkspaceWrites &&
          !hasGlobalWrites &&
          projectRunAt !== 0 &&
          now - projectRunAt < MEMORY_CONSOLIDATION_DEBOUNCE_MS;
        if (projectDebounceWouldSkip) continue;
        const workspaceDebounceWouldSkip =
          lastRunAt !== 0 && now - lastRunAt < MEMORY_CONSOLIDATION_DEBOUNCE_MS;
        const skipWorkspaceDebounce = workspaceDebounceWouldSkip && projectDebounceAllowsRun;
        if (workspaceDebounceWouldSkip && !skipWorkspaceDebounce) continue;
        started++;
        // Sequential, not parallel: the sweep is background housekeeping and
        // must not stampede the provider on launch.
        const result: Result<MemoryConsolidationRecord, string> = yield* Effect.tryPromise({
          try: async () => self.maybeRun(workspaceId, "launch", { skipWorkspaceDebounce }),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed<Result<MemoryConsolidationRecord, string>>(Err(getErrorMessage(error)))
          )
        );
        if (!result.success) {
          log.debug("[MemoryConsolidation] launch sweep skipped workspace", {
            workspaceId,
            reason: result.error,
          });
          continue;
        }
        // This run covered global scope; later candidates in this sweep only
        // qualify via their own workspace writes or genuinely newer global ones.
        if (projectPath !== "") {
          projectLastRunAt.set(projectPath, result.data.lastRunAt);
        }
        globalLastRunAt = Math.max(globalLastRunAt, result.data.lastRunAt);
      }
    });
  }
}
