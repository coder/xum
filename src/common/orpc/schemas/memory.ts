import { z } from "zod";
import { MEMORY_SCOPES } from "@/common/constants/memory";

/**
 * Schemas for the Memory tab oRPC surface (experiment: "memory").
 * Paths are always virtual (/memories/<scope>/...); the backend MemoryService
 * owns the physical mapping and the security envelope.
 */

export const MemoryScopeSchema = z.enum(MEMORY_SCOPES);

export const MemoryActorSchema = z.enum(["agent", "user"]);

/** One memory file in the bulk list (all scopes, one IPC call). */
export const MemoryFileInfoSchema = z.object({
  /** Virtual path (e.g. /memories/global/prefs.md). */
  path: z.string(),
  scope: MemoryScopeSchema,
  /** Sanitized single-line frontmatter description (may be empty). */
  description: z.string(),
  /** User pin state from the host-local sidecar (never stored in the file). */
  pinned: z.boolean(),
  /** Recorded uses (reads, writes, pins) from the host-local sidecar. */
  accessCount: z.number(),
  /** Timestamp of the most recent use; null when never used. */
  lastAccessedAt: z.number().nullable(),
});
export type MemoryFileInfo = z.infer<typeof MemoryFileInfoSchema>;

/** File change emitted by the MemoryService (agent tool + UI writes). */
export const MemoryFileChangeEventSchema = z.object({
  kind: z.literal("file").optional(),
  scope: MemoryScopeSchema,
  /** Virtual path of the changed file or directory. */
  path: z.string(),
  actor: MemoryActorSchema,
  /** Workspace whose scope context performed the change. */
  workspaceId: z.string(),
  /** Stable project identity of the emitting scope context. */
  projectPath: z.string(),
});

/** Sidecar-only consolidation coverage changed; subscribers should refetch status. */
export const MemoryConsolidationStatusChangeEventSchema = z.object({
  kind: z.literal("consolidation_status"),
  /** Workspace whose run advanced its workspace coverage record. */
  workspaceId: z.string(),
  /** Single-project identity covered by the run, or "" for multi-project workspaces. */
  projectPath: z.string(),
});
export type MemoryConsolidationStatusChangeEventPayload = z.infer<
  typeof MemoryConsolidationStatusChangeEventSchema
>;

export const MemoryChangeEventSchema = z.union([
  MemoryFileChangeEventSchema,
  MemoryConsolidationStatusChangeEventSchema,
]);
export type MemoryChangeEventPayload = z.infer<typeof MemoryChangeEventSchema>;

/**
 * Save failures distinguish conflicts (sha precondition failed; the UI shows
 * a conflict banner and offers reload) from plain errors.
 */
export const MemorySaveErrorSchema = z.object({
  kind: z.enum(["conflict", "error"]),
  message: z.string(),
});
export type MemorySaveError = z.infer<typeof MemorySaveErrorSchema>;

/**
 * One journaled mutating command from a consolidation ("dream") run.
 * Single source of truth: the node services derive their types from these
 * schemas (z.infer), so a field added on the node side cannot silently be
 * stripped by oRPC output validation.
 */
export const MemoryConsolidationOpSchema = z.object({
  command: z.enum(["create", "str_replace", "insert", "delete", "rename"]),
  path: z.string(),
  newPath: z.string().optional(),
  applied: z.boolean(),
  note: z.string().optional(),
});
export type MemoryConsolidationOp = z.infer<typeof MemoryConsolidationOpSchema>;

/** Persisted record of the latest consolidation run for a workspace. */
export const MemoryConsolidationRecordSchema = z.object({
  lastRunAt: z.number(),
  trigger: z.enum(["compaction", "launch", "archive", "manual"]),
  summary: z.string(),
  ops: z.array(MemoryConsolidationOpSchema),
  /** Token cost of the run (absent for records persisted before telemetry). */
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  /** USD the run cost, priced from what each step reported. Optional so older records parse. */
  spentUsd: z.number().nonnegative().optional(),
  /** Why the run ended before the model finished: the cost ceiling stopped it. */
  note: z.string().optional(),
});
export type MemoryConsolidationRecordPayload = z.infer<typeof MemoryConsolidationRecordSchema>;

export const CompactionCompletionMetadataSchema = z.object({
  workspaceId: z.string(),
  summaryMessageId: z.string(),
  summaryHistorySequence: z.number(),
  compactionEpoch: z.number(),
  previousBoundaryHistorySequence: z.number().optional(),
  compactionRequestMessageId: z.string(),
  // RLM keep-recent floor: preserved-tail copies appended after the boundary.
  preservedTailMessageCount: z.number().optional(),
});

/**
 * A persisted count that feeds a limit: whole and not negative. A negative `budgetUsed` would add
 * to the epoch's edit budget instead of spending it (-100 allowed 108 edits), a negative
 * `attemptCount` would widen `HARVEST_MAX_ATTEMPTS` the same way, and a negative or fractional
 * chunk cursor starts the run at a chunk that does not exist. A record that fails this is dropped
 * on load, like any invalid record, so the epoch restarts with a fresh budget that is still
 * bounded by the limit. The record's other fields cannot be trusted either.
 */
const PersistedCountSchema = z.number().int().nonnegative();

/**
 * One analyzer run over a closed or open compaction epoch (the "harvest"). The two candidate
 * counts keep their names and stay required so older binaries still parse the record: they hold
 * the memory edits that landed and the ones the memory tool rejected. `nextChunk` and `ops` are
 * optional for the same reason, and for records written before the analyzer.
 */
export const MemoryHarvestRecordSchema = z.object({
  status: z.enum(["pending", "completed", "failed"]),
  startedAt: z.number(),
  /**
   * When the run last finished a chunk. A pending record counts as stale a timeout after this, not
   * after `startedAt`, so a run of many chunks is not stale while its chunks keep finishing.
   * Optional so older binaries parse the record and for records that never reached a chunk.
   */
  progressAt: z.number().optional(),
  completedAt: z.number().optional(),
  attemptCount: PersistedCountSchema,
  boundaryKey: z.string(),
  compactionEpoch: z.number(),
  acceptedCandidates: z.number(),
  skippedCandidates: z.number(),
  /** First transcript chunk not yet analyzed; a retry resumes here. */
  nextChunk: PersistedCountSchema.optional(),
  /** Every memory command the analyzer ran for this epoch, across attempts. */
  ops: z.array(MemoryConsolidationOpSchema).optional(),
  /**
   * Mutations the epoch's budget has spent, dispatch failures included, which `ops` alone
   * undercounts. A retry resumes the budget from it. Optional so older binaries parse the record.
   */
  budgetUsed: PersistedCountSchema.optional(),
  /** How many of the last `ops` came from the chunk `nextChunk`, which no attempt finished. */
  nextChunkOps: PersistedCountSchema.optional(),
  /**
   * The row of this epoch an earlier open-epoch run had analyzed up to when the first attempt
   * began (null: none), so the run reads the rows after it. A retry reuses it instead of
   * looking again: an open-epoch run that completes later must not move the rows under the saved
   * chunk cursor. Absent before an attempt reached the epoch, and in older records.
   */
  analyzedFloorRowId: z.string().nullish(),
  error: z.string().optional(),
  /**
   * Why a completed run did not read or finish every chunk: the epoch's edit budget ran out and
   * the remaining chunks were skipped, or the cost ceiling stopped the job. Optional so older
   * binaries parse the record.
   */
  note: z.string().optional(),
  /**
   * The newest row of the epoch the run read completely (null: none). It is behind the newest row
   * when the run skipped chunks for its budget: the floor of a later run is this row, not the
   * newest one. A failed run records the last chunk it read cleanly, whose edits landed. Absent in
   * older records, which read up to the row their key names (a failed one read nothing known).
   */
  readThroughRowId: z.string().nullish(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  /**
   * USD the epoch's job has cost across its attempts, priced from what each step reported. A retry
   * continues from it, so it feeds the cost ceiling like a count feeds a limit: not negative (see
   * PersistedCountSchema). Optional so older binaries parse the record.
   */
  spentUsd: z.number().nonnegative().optional(),
  completionMetadata: CompactionCompletionMetadataSchema.optional(),
});
export type MemoryHarvestRecordPayload = z.infer<typeof MemoryHarvestRecordSchema>;

export const MemoryConsolidationStatusSchema = z.object({
  workspaceRecord: MemoryConsolidationRecordSchema.nullable(),
  projectRecord: MemoryConsolidationRecordSchema.nullable(),
  globalRecord: MemoryConsolidationRecordSchema.nullable(),
  latestHarvestRecord: MemoryHarvestRecordSchema.nullable(),
  projectAvailable: z.boolean(),
});
export type MemoryConsolidationStatusPayload = z.infer<typeof MemoryConsolidationStatusSchema>;
export type MemoryConsolidationTrigger = MemoryConsolidationRecordPayload["trigger"];
