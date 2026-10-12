/**
 * Replay verification: proves "model-visible ⟹ logged" for a recorded
 * session by rebuilding each turn's provider request from durable logs
 * (chat.jsonl + turn-envelope rows + blob store) and byte-comparing it against
 * the request the provider actually received (devtools.jsonl, llmDebugLogs).
 *
 * Guarantee scope: same log + same config + same binary. Request-time inputs
 * beyond chat.jsonl (plan-transition content, post-compaction attachments,
 * per-send cache TTL, resolved wire provider) are read back from the
 * turn-envelope row (see replayRequestBuilder.ts); turns whose envelope
 * predates those fields report FAIL/SKIPPED with the reason rather than
 * silently passing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { asSchema } from "ai";
import type {
  DevToolsLogEntry,
  DevToolsRun,
  DevToolsStep,
  DevToolsUsage,
} from "@/common/types/devtools";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { DurableEvent } from "@/common/types/durableEvent";
import type { MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { AnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import assert from "@/common/utils/assert";
import { isDeferLoadingTool } from "@/common/utils/tools/toolCatalog";
import {
  CONTEXT_BOUNDARY_KINDS,
  findLatestContextBoundaryIndex,
  getContextBoundaryKind,
} from "@/common/utils/messages/compactionBoundary";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import type { HistoryService } from "@/node/services/historyService";
import {
  hashToolSchema,
  isProviderDefinedToolRecord,
  providerToolFingerprint,
} from "@/node/services/turnEnvelope";
import { auditStepPrefixes, type StepPrefixAudit } from "./cacheAudit";
import { buildReplayRequest } from "./replayRequestBuilder";

export const DEVTOOLS_LOG_FILE_NAME = "devtools.jsonl";

/** One turn-envelope durable event (narrowed from the event union). */
export type TurnEnvelopeEvent = Extract<DurableEvent, { kind: "turn-envelope" }>;

/** The first provider round-trip of one recorded run (the log-built request). */
export interface RecordedProviderRequest {
  runId: string;
  stepId: string;
  startedAt: string;
  modelId: string;
  prompt: unknown;
  tools: unknown;
  usage: DevToolsUsage | null;
  /** Pairing key from the run row; absent on runs recorded by older binaries. */
  requestHistorySequence?: number;
}

/** Every step of one recorded run, for the step-by-step prefix rule (cacheAudit.ts). */
export interface RecordedStepRequest {
  runId: string;
  stepId: string;
  stepNumber: number;
  /** ISO start time: the audit treats a gap longer than the cache TTL as an expired entry. */
  startedAt: string;
  modelId: string;
  /** AI SDK provider id, e.g. "anthropic.messages"; null when the SDK did not report one. */
  provider: string | null;
  prompt: unknown;
  tools: unknown;
  /** The step's AI SDK call options: they carry thinking, effort and tool choice. */
  providerOptions?: unknown;
  toolChoice?: unknown;
  requestHistorySequence?: number;
  /** See DevToolsRun.contextEpoch; absent on runs recorded by older binaries. */
  contextEpoch?: string;
}

/** One parse of devtools.jsonl, shared by the first-request replay and the step audit. */
export interface DevtoolsLogSnapshot {
  runs: Array<{ run: DevToolsRun; steps: DevToolsStep[] }>;
  /** Steps of known runs in the order the log recorded them (overlapping runs interleave). */
  stepsInLogOrder: Array<{ run: DevToolsRun; step: DevToolsStep }>;
  stepUsageUpdates: Map<string, DevToolsUsage | null>;
  /** Steps whose finalization recorded an error (aborted or rejected calls). */
  failedStepIds: Set<string>;
}

/**
 * Tolerant devtools.jsonl reader (self-heal doctrine): malformed lines and
 * unknown entry types are skipped. Returns runs in log order with their steps.
 */
export async function readDevtoolsLog(sessionDir: string): Promise<DevtoolsLogSnapshot> {
  const runs = new Map<string, { run: DevToolsRun; steps: DevToolsStep[] }>();
  const stepUsageUpdates = new Map<string, DevToolsUsage | null>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir, DEVTOOLS_LOG_FILE_NAME), "utf-8");
  } catch {
    return { runs: [], stepsInLogOrder: [], stepUsageUpdates, failedStepIds: new Set() };
  }

  const orphanSteps: DevToolsStep[] = [];
  const failedStepIds = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry: DevToolsLogEntry;
    try {
      entry = JSON.parse(line) as DevToolsLogEntry;
    } catch {
      continue;
    }
    if (entry.type === "run") {
      // DevToolsService appends a healed duplicate header (without the run metadata) when a
      // retention-evicted run logs another step. The first header carries the metadata, so
      // keep it; the duplicate's steps attach to it by run id below.
      if (!runs.has(entry.run.id)) runs.set(entry.run.id, { run: entry.run, steps: [] });
    } else if (entry.type === "step") {
      orphanSteps.push(entry.step);
    } else if (entry.type === "step-update") {
      if (entry.update.usage !== undefined) {
        stepUsageUpdates.set(entry.stepId, entry.update.usage);
      }
      if (entry.update.error != null) {
        failedStepIds.add(entry.stepId);
      }
    }
  }
  const stepsInLogOrder: DevtoolsLogSnapshot["stepsInLogOrder"] = [];
  for (const step of orphanSteps) {
    const owner = runs.get(step.runId);
    if (owner == null) continue;
    owner.steps.push(step);
    stepsInLogOrder.push({ run: owner.run, step });
  }
  for (const { steps } of runs.values()) {
    steps.sort((a, b) => a.stepNumber - b.stepNumber);
  }
  return { runs: [...runs.values()], stepsInLogOrder, stepUsageUpdates, failedStepIds };
}

/**
 * Parse devtools.jsonl into per-run first-step requests. Later steps of a run
 * are SDK-internal tool loops whose extra messages come from the streamed
 * output (persisted at turn end), so the log-purity comparison targets
 * step 0 — the request assembled from chat.jsonl.
 */
export async function readRecordedRequests(sessionDir: string): Promise<RecordedProviderRequest[]> {
  return recordedRequestsFromLog(await readDevtoolsLog(sessionDir));
}

function recordedRequestsFromLog(log: DevtoolsLogSnapshot): RecordedProviderRequest[] {
  const { runs, stepUsageUpdates } = log;
  const requests: RecordedProviderRequest[] = [];
  for (const { run, steps } of runs) {
    const step = steps.at(0);
    if (step?.input == null) {
      continue;
    }
    const requestHistorySequence = run.requestHistorySequence;
    requests.push({
      runId: run.id,
      stepId: step.id,
      startedAt: step.startedAt,
      modelId: step.modelId,
      prompt: step.input.prompt,
      tools: step.input.tools,
      usage: stepUsageUpdates.get(step.id) ?? step.usage,
      ...(requestHistorySequence != null ? { requestHistorySequence } : {}),
    });
  }
  return requests;
}

/**
 * Every recorded step with an input, in the order the log recorded them. Overlapping runs in one
 * workspace interleave (A0, B0, A1), and that order is the order the provider saw the requests.
 */
export function recordedStepsFromLog(log: DevtoolsLogSnapshot): RecordedStepRequest[] {
  return log.stepsInLogOrder.flatMap(({ run, step }) =>
    // A step that failed without usage never produced a cache read or write (aborted or
    // rejected before Anthropic processed it), so like the runtime monitor it is not a request.
    step.input == null ||
    (log.failedStepIds.has(step.id) && log.stepUsageUpdates.get(step.id) == null)
      ? []
      : [
          {
            runId: run.id,
            stepId: step.id,
            stepNumber: step.stepNumber,
            startedAt: step.startedAt,
            modelId: step.modelId,
            provider: step.provider,
            prompt: step.input.prompt,
            tools: step.input.tools,
            ...(step.input.providerOptions != null
              ? { providerOptions: step.input.providerOptions }
              : {}),
            ...(step.input.toolChoice != null ? { toolChoice: step.input.toolChoice } : {}),
            ...(run.requestHistorySequence != null
              ? { requestHistorySequence: run.requestHistorySequence }
              : {}),
            ...(run.contextEpoch != null ? { contextEpoch: run.contextEpoch } : {}),
          },
        ]
  );
}

export async function readRecordedSteps(sessionDir: string): Promise<RecordedStepRequest[]> {
  return recordedStepsFromLog(await readDevtoolsLog(sessionDir));
}

/** First structural difference between two JSON values (depth-first). */
export interface JsonDivergence {
  path: string;
  expected: unknown;
  actual: unknown;
}

/**
 * Locate the first divergence between two JSON-compatible values. `expected`
 * is the log-rebuilt value, `actual` the recorded one. Returns null when
 * deep-equal.
 */
export function findFirstJsonDivergence(
  expected: unknown,
  actual: unknown,
  basePath = "$"
): JsonDivergence | null {
  if (expected === actual) {
    return null;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) {
      if (i >= expected.length || i >= actual.length) {
        return { path: `${basePath}[${i}]`, expected: expected[i], actual: actual[i] };
      }
      const nested = findFirstJsonDivergence(expected[i], actual[i], `${basePath}[${i}]`);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
    for (const key of keys) {
      const nested = findFirstJsonDivergence(
        expectedRecord[key],
        actualRecord[key],
        `${basePath}.${key}`
      );
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  return { path: basePath, expected, actual };
}

export interface ReplayVerifyTurnResult {
  turnIndex: number;
  envelopeSeq: number;
  assistantMessageId: string;
  runId: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  /** Present for SKIPPED (why verification was impossible). */
  reason?: string;
  systemPromptMatch?: boolean;
  toolsetMatch?: boolean;
  messagesMatch?: boolean;
  /** First differing JSON path when messagesMatch is false. */
  divergence?: JsonDivergence;
  /** Human-readable toolset delta when toolsetMatch is false. */
  toolsetDiff?: string;
}

export interface ReplayVerifySessionResult {
  turns: ReplayVerifyTurnResult[];
  /** Prefix rule over every recorded step (not only each turn's first request). */
  stepPrefix: StepPrefixAudit;
  /** Correlation notes (count mismatches between logs). */
  notes: string[];
}

export interface AssistantTurn {
  message: MuxMessage;
  requestHistorySequence: number;
}

/**
 * Assistant rows that finished a provider request build (one per
 * streamMessage call) — the chat.jsonl side of the pairing with turn-envelope
 * rows and recorded devtools runs.
 */
export function collectAssistantTurns(historyMessages: MuxMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const message of historyMessages) {
    const requestHistorySequence = message.metadata?.requestHistorySequence;
    if (message.role === "assistant" && requestHistorySequence != null) {
      turns.push({ message, requestHistorySequence });
    }
  }
  return turns;
}

/**
 * Load ALL history rows (sealed archive + active chat.jsonl), oldest→newest.
 * Turn-envelope rows and recorded devtools requests span every compaction
 * epoch, so verification must see the full transcript —
 * getHistoryFromLatestBoundary would drop pre-compaction assistant turns and
 * misalign every pairing after the first boundary.
 */
export async function collectFullHistory(
  historyService: HistoryService,
  workspaceId: string
): Promise<Result<MuxMessage[]>> {
  const messages: MuxMessage[] = [];
  const result = await historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  return result.success ? Ok(messages) : result;
}

/**
 * Rows the original request build saw, reconstructed from the full history:
 * every row the request contained has historySequence <= the turn's
 * requestHistorySequence (rows appended later, including that turn's assistant
 * row, are higher), and the build read from the latest durable context
 * boundary — same slicing semantics as getHistoryFromLatestBoundary
 * (compaction summaries are included, reset markers are not).
 */
export function sliceEpochForTurn(
  historyMessages: MuxMessage[],
  requestHistorySequence: number
): MuxMessage[] {
  const prefix = historyMessages.filter((message) => {
    const sequence = message.metadata?.historySequence;
    assert(sequence != null, `history row ${message.id} is missing historySequence`);
    return sequence <= requestHistorySequence;
  });
  const boundaryIndex = findLatestContextBoundaryIndex(prefix);
  if (boundaryIndex < 0) {
    return prefix;
  }
  const start =
    getContextBoundaryKind(prefix[boundaryIndex]) === CONTEXT_BOUNDARY_KINDS.RESET
      ? boundaryIndex + 1
      : boundaryIndex;
  return prefix.slice(start);
}

/**
 * Extract the system text from a recorded LanguageModel prompt: the leading
 * system rows joined (a cached stable row plus an optional volatile row).
 */
function recordedSystemText(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const row of prompt as Array<{ role?: unknown; content?: unknown }>) {
    if (row?.role !== "system" || typeof row.content !== "string") break;
    parts.push(row.content);
  }
  return parts.length === 0 ? undefined : parts.join("");
}

/** Hash the recorded wire tools into manifest form (name-sorted). */
function manifestFromRecordedTools(tools: unknown): Array<{ name: string; schemaHash: string }> {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .flatMap((tool) => {
      const record = tool as { name?: unknown; inputSchema?: unknown; args?: unknown };
      const name = record.name;
      if (typeof name !== "string") {
        return [];
      }
      // Provider-defined tools serialize as {type, id, args} with no
      // inputSchema; fingerprint the wire identity exactly like
      // turnEnvelope.buildToolsetManifest does at request time.
      if (isProviderDefinedToolRecord(record)) {
        return [
          { name, schemaHash: hashToolSchema(providerToolFingerprint(record.id, record.args)) },
        ];
      }
      // The wire inputSchema is already plain JSON schema (post asSchema).
      const schema = record.inputSchema ?? asSchema(undefined).jsonSchema;
      return [{ name, schemaHash: hashToolSchema(schema) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Deferred tool names from the recorded wire tools: the AI SDK copies each tool's
 * providerOptions onto its wire definition, so the native deferLoading marker survives.
 */
function deferLoadingNamesFromRecordedTools(tools: unknown): Set<string> {
  if (!Array.isArray(tools)) {
    return new Set();
  }
  return new Set(
    tools.flatMap((tool) => {
      const record = tool as { name?: unknown; providerOptions?: unknown };
      return typeof record.name === "string" && isDeferLoadingTool(record) ? [record.name] : [];
    })
  );
}

function describeManifestDiff(
  envelope: Array<{ name: string; schemaHash: string }>,
  recorded: Array<{ name: string; schemaHash: string }>
): string {
  const envelopeByName = new Map(envelope.map((entry) => [entry.name, entry.schemaHash]));
  const recordedByName = new Map(recorded.map((entry) => [entry.name, entry.schemaHash]));
  const parts: string[] = [];
  for (const [name] of envelopeByName) {
    if (!recordedByName.has(name)) {
      parts.push(`missing-on-wire:${name}`);
    }
  }
  for (const [name, hash] of recordedByName) {
    const envelopeHash = envelopeByName.get(name);
    if (envelopeHash === undefined) {
      parts.push(`unlogged:${name}`);
    } else if (envelopeHash !== hash) {
      parts.push(`schema-changed:${name}`);
    }
  }
  return parts.join(", ");
}

/** One pairing of the three log streams for a single stream turn. */
interface TurnPairing {
  envelope?: TurnEnvelopeEvent;
  record?: RecordedProviderRequest;
  turn?: AssistantTurn;
  /** Present when pairing already knows verification is impossible. */
  skipReason?: string;
}

/**
 * Pair envelopes, recorded requests, and assistant turns. When envelopes carry
 * requestHistorySequence (current binaries), pairing joins on that key, so a
 * missing member (failed stream, devtools toggled off, retry) skips only its
 * own turn instead of shifting — and cascading false FAILs onto — every later
 * turn. Fully-legacy logs fall back to ordinal pairing with a note.
 */
function pairSessionTurns(
  envelopes: TurnEnvelopeEvent[],
  recorded: RecordedProviderRequest[],
  turns: AssistantTurn[],
  notes: string[]
): TurnPairing[] {
  const hasKeyedEnvelopes = envelopes.some(
    (envelope) => envelope.data.requestHistorySequence != null
  );
  if (!hasKeyedEnvelopes) {
    if (envelopes.length !== recorded.length || envelopes.length !== turns.length) {
      notes.push(
        `count mismatch: ${envelopes.length} turn-envelope rows, ${recorded.length} recorded requests, ` +
          `${turns.length} assistant turns — legacy logs without requestHistorySequence pair ordinally, ` +
          `leftovers are SKIPPED (devtools logging toggles, retries, or compaction can cause this)`
      );
    }
    const pairCount = Math.max(envelopes.length, recorded.length, turns.length);
    return Array.from({ length: pairCount }, (_, i) => ({
      envelope: envelopes[i],
      record: recorded[i],
      turn: turns[i],
    }));
  }

  const turnsBySeq = new Map<number, AssistantTurn>();
  for (const turn of turns) {
    if (turnsBySeq.has(turn.requestHistorySequence)) {
      notes.push(
        `multiple assistant rows share requestHistorySequence ${turn.requestHistorySequence} — verifying the last`
      );
    }
    turnsBySeq.set(turn.requestHistorySequence, turn);
  }

  const recordedBySeq = new Map<number, RecordedProviderRequest[]>();
  let unkeyedRecorded = 0;
  for (const record of recorded) {
    if (record.requestHistorySequence == null) {
      unkeyedRecorded++;
      continue;
    }
    const list = recordedBySeq.get(record.requestHistorySequence) ?? [];
    list.push(record);
    recordedBySeq.set(record.requestHistorySequence, list);
  }
  if (unkeyedRecorded > 0) {
    notes.push(
      `${unkeyedRecorded} recorded request(s) lack requestHistorySequence (recorded by an older binary) — not matchable`
    );
  }

  // A retry re-emits an envelope for the same request; only the last attempt
  // can correspond to the surviving assistant row.
  const lastEnvelopeIndexBySeq = new Map<number, number>();
  envelopes.forEach((envelope, index) => {
    const seq = envelope.data.requestHistorySequence;
    if (seq != null) {
      lastEnvelopeIndexBySeq.set(seq, index);
    }
  });

  const matchedSeqs = new Set<number>();
  const pairings = envelopes.map((envelope, index): TurnPairing => {
    const seq = envelope.data.requestHistorySequence;
    if (seq == null) {
      return {
        envelope,
        skipReason: "legacy envelope without requestHistorySequence — cannot re-anchor",
      };
    }
    if (lastEnvelopeIndexBySeq.get(seq) !== index) {
      return {
        envelope,
        skipReason: `superseded by a later attempt for requestHistorySequence ${seq} (retry)`,
      };
    }
    matchedSeqs.add(seq);
    const turn = turnsBySeq.get(seq);
    const record = recordedBySeq.get(seq)?.at(-1);
    if (turn == null) {
      return {
        envelope,
        record,
        skipReason: `no assistant row with requestHistorySequence ${seq} (stream failed before append, or history was truncated)`,
      };
    }
    if (record == null) {
      return {
        envelope,
        turn,
        skipReason: `no recorded devtools request with requestHistorySequence ${seq} (devtools logging off for this turn?)`,
      };
    }
    return { envelope, record, turn };
  });

  const unmatchedTurns = turns.filter(
    (turn) => !matchedSeqs.has(turn.requestHistorySequence)
  ).length;
  if (unmatchedTurns > 0) {
    notes.push(
      `${unmatchedTurns} assistant turn(s) have no turn-envelope row (recorded before envelope emission shipped?)`
    );
  }
  return pairings;
}

/**
 * The prefix rule over every recorded step of a session (see auditStepPrefixes).
 * Compaction runs send another system prompt and the summary request by
 * design, so they are skipped. Their summary row drops requestHistorySequence,
 * so they are keyed on the compaction request row: the newest row the run was
 * built from.
 */
export function auditStepPrefixesFromLog(
  log: DevtoolsLogSnapshot,
  historyMessages: MuxMessage[]
): StepPrefixAudit {
  const compactionSequences = new Set(
    historyMessages.flatMap((message) => {
      const metadata = message.metadata;
      // A compaction request row, or a compact-agent turn: the resume path sends agentId
      // "compact" without a request row, and its run carries that turn's request sequence.
      if (
        message.role === "user" &&
        metadata?.muxMetadata?.type === "compaction-request" &&
        metadata.historySequence != null
      ) {
        return [metadata.historySequence];
      }
      if (
        message.role === "assistant" &&
        metadata?.agentId === "compact" &&
        metadata.requestHistorySequence != null
      ) {
        return [metadata.requestHistorySequence];
      }
      return [];
    })
  );
  // Only chat-turn runs carry requestHistorySequence (TurnRequestBuilder sets it with the turn's
  // prompt-cache scope). Headless side calls (refinement, branch summaries, continuous compaction,
  // intuition, evaluation) log runs without it: like the runtime monitor, ignore them, so they
  // neither break nor replace the chat baseline. Older logs without the field are not audited.
  return auditStepPrefixes(
    recordedStepsFromLog(log),
    (step) =>
      step.requestHistorySequence != null && compactionSequences.has(step.requestHistorySequence),
    (step) => step.requestHistorySequence == null
  );
}

export async function auditRecordedStepPrefixes(
  sessionDir: string,
  historyMessages: MuxMessage[]
): Promise<StepPrefixAudit> {
  return auditStepPrefixesFromLog(await readDevtoolsLog(sessionDir), historyMessages);
}

/** Narrow the persisted envelope string to the AnthropicCacheTtl union. */
function parseAnthropicCacheTtl(value: string | undefined): AnthropicCacheTtl | undefined {
  return value === "5m" || value === "1h" ? value : undefined;
}

/**
 * Verify every turn of a session: rebuild the provider request from durable
 * logs and byte-compare against the recorded devtools request.
 * `historyMessages` must be the FULL history (all compaction epochs, see
 * collectFullHistory); each turn is re-sliced to the epoch its request build
 * actually saw.
 */
export async function replayVerifySession(params: {
  sessionDir: string;
  workspaceId: string;
  historyMessages: MuxMessage[];
  providersConfig?: ProvidersConfigMap | null;
}): Promise<ReplayVerifySessionResult> {
  const journal = new DurableEventJournal(params.sessionDir);
  const events = await journal.read();
  const envelopes = events.filter(
    (event): event is TurnEnvelopeEvent => event.kind === "turn-envelope"
  );
  // One snapshot for both checks: a live log can grow between two reads.
  const devtoolsLog = await readDevtoolsLog(params.sessionDir);
  const recorded = recordedRequestsFromLog(devtoolsLog);
  const turns = collectAssistantTurns(params.historyMessages);

  const notes: string[] = [];
  const pairings = pairSessionTurns(envelopes, recorded, turns, notes);
  const stepPrefix = auditStepPrefixesFromLog(devtoolsLog, params.historyMessages);

  const results: ReplayVerifyTurnResult[] = [];
  for (const [i, pairing] of pairings.entries()) {
    const { envelope, record, turn } = pairing;

    if (pairing.skipReason != null || envelope == null || record == null || turn == null) {
      results.push({
        turnIndex: i,
        envelopeSeq: envelope?.seq ?? -1,
        assistantMessageId: turn?.message.id ?? "",
        runId: record?.runId ?? "",
        status: "SKIPPED",
        reason:
          pairing.skipReason ??
          `unpaired turn (envelope=${envelope != null}, recorded=${record != null}, assistant=${turn != null})`,
      });
      continue;
    }

    const fail = (reason: string): void => {
      results.push({
        turnIndex: i,
        envelopeSeq: envelope.seq,
        assistantMessageId: turn.message.id,
        runId: record.runId,
        status: "FAIL",
        reason,
      });
    };

    // Per-turn isolation: one corrupted turn (missing blob, malformed
    // metadata, unsupported model string, assertion inside the rebuild
    // pipeline) must FAIL that turn only, never crash the whole verification.
    try {
      const systemPrompt = await journal.blobs.getText(envelope.data.systemPromptHash);
      if (systemPrompt == null) {
        fail(`system prompt blob ${envelope.data.systemPromptHash} missing from blob store`);
        continue;
      }

      let planContentForTransition: string | undefined;
      if (envelope.data.planTransitionContentHash != null) {
        const planContent = await journal.blobs.getText(envelope.data.planTransitionContentHash);
        if (planContent == null) {
          fail(
            `plan-transition blob ${envelope.data.planTransitionContentHash} missing from blob store`
          );
          continue;
        }
        planContentForTransition = planContent;
      }

      let postCompactionAttachments: PostCompactionAttachment[] | undefined;
      if (envelope.data.postCompactionAttachmentsHash != null) {
        const attachmentsJson = await journal.blobs.getText(
          envelope.data.postCompactionAttachmentsHash
        );
        if (attachmentsJson == null) {
          fail(
            `post-compaction attachments blob ${envelope.data.postCompactionAttachmentsHash} missing from blob store`
          );
          continue;
        }
        postCompactionAttachments = JSON.parse(attachmentsJson) as PostCompactionAttachment[];
      }

      let partialContinuation: MuxMessage | undefined;
      if (envelope.data.partialContinuationHash != null) {
        const continuationJson = await journal.blobs.getText(envelope.data.partialContinuationHash);
        if (continuationJson == null) {
          fail(
            `partial-continuation blob ${envelope.data.partialContinuationHash} missing from blob store`
          );
          continue;
        }
        partialContinuation = JSON.parse(continuationJson) as MuxMessage;
      }

      // 1) System prompt: blob bytes vs the wire's system message.
      const systemPromptMatch = recordedSystemText(record.prompt) === systemPrompt;

      // 2) Toolset: envelope manifest vs re-hashed wire tool schemas.
      const recordedManifest = manifestFromRecordedTools(record.tools);
      const toolsetMatch =
        JSON.stringify(envelope.data.toolsetManifest) === JSON.stringify(recordedManifest);

      // 3) Messages: rebuild the full LanguageModel prompt from log rows and
      // byte-compare against the recorded request.
      const historySlice = sliceEpochForTurn(params.historyMessages, turn.requestHistorySequence);

      const rebuilt = await buildReplayRequest({
        historyMessages: historySlice,
        systemPrompt,
        modelString: envelope.data.modelString,
        thinkingLevel: envelope.data.thinkingLevel as ThinkingLevel,
        effectiveAgentId: turn.message.metadata?.agentId ?? "exec",
        // Prefer the independently-recorded sentinel names: forced first-step
        // scoping (e.g. xAI search) narrows the wire manifest while the live
        // sentinel listed the full active set. Manifest names remain the
        // legacy fallback for rows written before sentinelToolNames existed.
        toolNamesForSentinel:
          envelope.data.sentinelToolNames ??
          envelope.data.toolsetManifest.map((entry) => entry.name),
        routeProvider: turn.message.metadata?.routeProvider,
        providersConfig: params.providersConfig,
        wireProviderName: envelope.data.wireProviderName,
        anthropicCacheTtl: parseAnthropicCacheTtl(envelope.data.anthropicCacheTtl),
        systemPromptVolatileSuffixLength: envelope.data.systemPromptVolatileSuffixLength,
        planContentForTransition,
        planFilePath: envelope.data.planTransitionFilePath,
        postCompactionAttachments,
        partialContinuation,
        deferLoadingToolNames: deferLoadingNamesFromRecordedTools(record.tools),
        workspaceId: params.workspaceId,
      });

      // JSON round-trip the rebuilt prompt so both sides are plain JSON values
      // (the recorded prompt already survived a devtools.jsonl round-trip).
      const rebuiltJson: unknown = JSON.parse(JSON.stringify(rebuilt.lmPrompt));
      const messagesMatch = JSON.stringify(rebuiltJson) === JSON.stringify(record.prompt);

      const pass = systemPromptMatch && toolsetMatch && messagesMatch;
      results.push({
        turnIndex: i,
        envelopeSeq: envelope.seq,
        assistantMessageId: turn.message.id,
        runId: record.runId,
        status: pass ? "PASS" : "FAIL",
        systemPromptMatch,
        toolsetMatch,
        messagesMatch,
        ...(messagesMatch
          ? {}
          : { divergence: findFirstJsonDivergence(rebuiltJson, record.prompt) ?? undefined }),
        ...(toolsetMatch
          ? {}
          : { toolsetDiff: describeManifestDiff(envelope.data.toolsetManifest, recordedManifest) }),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  return { turns: results, stepPrefix, notes };
}
