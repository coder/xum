import * as path from "path";
import { EventEmitter } from "events";
import * as fs from "fs/promises";
import { StringDecoder } from "string_decoder";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type {
  DevToolsEvent,
  DevToolsLogEntry,
  DevToolsRun,
  DevToolsRunSummary,
  DevToolsStep,
} from "@/common/types/devtools";
import type { Config } from "@/node/config";
import { log } from "@/node/services/log";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";

/**
 * Retention policy for in-memory DevTools state.
 *
 * devtools.jsonl is append-only and grows without bound: a live server was
 * observed with 58 files totalling 6.8 GB (largest 1.18 GB) and ~4 GB of live
 * heap made of replayed runs/steps, because every workspace file was read whole
 * and every run ever logged was kept. Files past V8's max string length also
 * made the whole-file read throw, and the failed load was retried on every
 * subsequent createRun/createStep.
 *
 * Policy: only the newest MAX_RETAINED_RUNS_PER_WORKSPACE runs (with their
 * steps) are kept per workspace, evicting the oldest by append order as new runs
 * arrive; and on load only the last LOAD_TAIL_BYTES of the file are replayed,
 * streamed in LOAD_CHUNK_BYTES reads so the file is never materialized in
 * memory. Steps whose run falls outside the retained window are dropped. The
 * DevTools panel therefore shows a bounded recent window rather than the full
 * history; the on-disk file is left untouched (rotation is a follow-up).
 *
 * The run bound alone does not cap memory: a single streamed step carries the
 * raw provider payload (a live heap held two 15-16 MB arrays of raw OpenAI SSE
 * events in `rawChunks`/`rawResponse` plus multi-MB `rawRequest` strings), so
 * 100 such runs are still hundreds of MB. Retained runs are therefore also
 * capped at MAX_RETAINED_BYTES_PER_WORKSPACE, measured as the length of the
 * JSON lines appended to devtools.jsonl (already serialized for the write) and
 * attributed to the owning run. The run being written is never evicted, even
 * when it alone exceeds the budget.
 */
export const MAX_RETAINED_RUNS_PER_WORKSPACE = 100;
const MAX_RETAINED_BYTES_PER_WORKSPACE = 64 * 1024 * 1024;
export const LOAD_TAIL_BYTES = 32 * 1024 * 1024;
const LOAD_CHUNK_BYTES = 1024 * 1024;

interface WorkspaceData {
  runs: Map<string, DevToolsRun>;
  steps: Map<string, DevToolsStep>;
  /** Approximate JSON bytes retained per run: the run entry plus its current steps. */
  runBytes: Map<string, number>;
  /** Approximate JSON bytes of each retained step, so an update replaces rather than adds. */
  stepBytes: Map<string, number>;
  retainedBytes: number;
  loaded: boolean;
  /** Incremented on each clear() for defense-in-depth against stale state. */
  clearGeneration: number;
}

export interface DevToolsServiceOptions {
  maxRetainedBytesPerWorkspace?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Yield the lines in the last `maxTailBytes` of a file without ever holding the
 * whole file in memory. When the read starts mid-file, the partial first line
 * is discarded so replay begins on a line boundary.
 */
async function* readTailLines(filePath: string, maxTailBytes: number): AsyncGenerator<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let position = Math.max(0, size - maxTailBytes);
    const chunk = Buffer.alloc(LOAD_CHUNK_BYTES);
    let skipPartialFirstLine = false;
    if (position > 0) {
      // A cut that lands right after a newline starts on a complete line; only skip when
      // the preceding byte shows we are mid-line.
      const { bytesRead } = await handle.read(chunk, 0, 1, position - 1);
      skipPartialFirstLine = bytesRead === 0 || chunk[0] !== 0x0a;
    }
    const decoder = new StringDecoder("utf-8");
    let pending = "";

    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      pending += decoder.write(chunk.subarray(0, bytesRead));

      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (skipPartialFirstLine) {
          skipPartialFirstLine = false;
          continue;
        }
        yield line;
      }
    }

    pending += decoder.end();
    if (pending.length > 0 && !skipPartialFirstLine) {
      yield pending;
    }
  } finally {
    await handle.close();
  }
}

function jsonLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : json.length;
}

/**
 * Bytes of `existing` that `update` overwrites. Subtracting them keeps a step
 * that is re-sent (or finalized) from being counted once per update; the values
 * replaced are normally `null` placeholders, so this is cheap even for large
 * payloads.
 */
function replacedStepBytes(existing: DevToolsStep, update: Partial<DevToolsStep>): number {
  let bytes = 0;
  for (const key of Object.keys(update) as Array<keyof DevToolsStep>) {
    bytes += jsonLength(existing[key]);
  }
  return bytes;
}

function evictRun(data: WorkspaceData, runId: string): void {
  data.runs.delete(runId);
  for (const [stepId, step] of data.steps) {
    if (step.runId === runId) {
      data.steps.delete(stepId);
      data.stepBytes.delete(stepId);
    }
  }
  data.retainedBytes -= data.runBytes.get(runId) ?? 0;
  data.runBytes.delete(runId);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractText(item))
      .filter((item) => item.length > 0)
      .join(" ");
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }

  if ("content" in value) {
    return extractText(value.content);
  }

  if ("parts" in value) {
    return extractText(value.parts);
  }

  return "";
}

function truncateMessage(message: string, maxLength = 80): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 3)}...`;
}

function getStepSortKey(step: DevToolsStep): string {
  return `${String(step.stepNumber).padStart(8, "0")}:${step.startedAt}:${step.id}`;
}

function applyStepBackwardCompatibilityDefaults(step: DevToolsStep): DevToolsStep {
  return {
    ...step,
    rawRequest: step.rawRequest ?? null,
    requestHeaders: step.requestHeaders ?? null,
    responseHeaders: step.responseHeaders ?? null,
    rawResponse: step.rawResponse ?? null,
    rawChunks: step.rawChunks ?? null,
  };
}

type PendingRunMetadata = Partial<Pick<DevToolsRun, "toolPolicy" | "requestHistorySequence">>;

export class DevToolsService extends EventEmitter {
  private readonly workspaces = new Map<string, WorkspaceData>();
  private readonly loadingPromises = new Map<string, Promise<void>>();
  private readonly writeQueues = new Map<string, Promise<void>>();

  /**
   * Queued run metadata grouped by workspace and request metadata ID.
   *
   * Multiple streamMessage calls can overlap within one workspace, so we keep
   * one pending metadata payload per request instead of a single workspace slot.
   */
  private readonly pendingRunMetadata = new Map<string, Map<string, PendingRunMetadata>>();
  private readonly maxRetainedBytesPerWorkspace: number;

  constructor(
    private readonly config: Config,
    options?: DevToolsServiceOptions
  ) {
    super();
    this.maxRetainedBytesPerWorkspace =
      options?.maxRetainedBytesPerWorkspace ?? MAX_RETAINED_BYTES_PER_WORKSPACE;
  }

  get enabled(): boolean {
    return this.config.getLlmDebugLogsEnabled();
  }

  /**
   * Queue metadata to be merged into the next run created for this workspace.
   *
   * This bridges the timing gap between policy resolution in AIService (before
   * any provider call) and lazy run creation in DevTools middleware (on first
   * provider invocation). Metadata is consumed exactly once by createRun.
   */
  setPendingRunMetadata(
    workspaceId: string,
    metadataId: string,
    metadata: PendingRunMetadata
  ): void {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.setPendingRunMetadata requires a workspaceId"
    );
    assert(
      metadataId.trim().length > 0,
      "DevToolsService.setPendingRunMetadata requires a metadataId"
    );

    if (!this.enabled) {
      return;
    }

    const byWorkspace =
      this.pendingRunMetadata.get(workspaceId) ?? new Map<string, PendingRunMetadata>();
    byWorkspace.set(metadataId, metadata);
    this.pendingRunMetadata.set(workspaceId, byWorkspace);
  }

  /**
   * Drop queued run metadata for a workspace.
   *
   * When metadataId is provided, clear only that request's entry.
   * This prevents one request's cleanup path from deleting metadata queued by
   * overlapping requests in the same workspace.
   */
  clearPendingRunMetadata(workspaceId: string, metadataId?: string): void {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.clearPendingRunMetadata requires a workspaceId"
    );

    const byWorkspace = this.pendingRunMetadata.get(workspaceId);
    if (!byWorkspace) {
      return;
    }

    if (metadataId == null) {
      this.pendingRunMetadata.delete(workspaceId);
      return;
    }

    assert(
      metadataId.trim().length > 0,
      "DevToolsService.clearPendingRunMetadata requires a non-empty metadataId"
    );

    byWorkspace.delete(metadataId);
    if (byWorkspace.size === 0) {
      this.pendingRunMetadata.delete(workspaceId);
    }
  }

  async createRun(workspaceId: string, run: DevToolsRun, metadataId?: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createRun requires a workspaceId");
    assert(run.workspaceId === workspaceId, "DevToolsService.createRun run/workspace mismatch");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    // Apply queued run metadata (for example, effective tool policy) captured
    // before the stream reached provider middleware. Lookup is keyed by request
    // metadata ID so overlapping requests cannot overwrite each other.
    const byWorkspace = this.pendingRunMetadata.get(workspaceId);
    const normalizedMetadataId = metadataId?.trim();
    if (byWorkspace && normalizedMetadataId != null && normalizedMetadataId.length > 0) {
      const pendingMetadata = byWorkspace.get(normalizedMetadataId);
      if (pendingMetadata != null) {
        Object.assign(run, pendingMetadata);
        byWorkspace.delete(normalizedMetadataId);
      }

      if (byWorkspace.size === 0) {
        this.pendingRunMetadata.delete(workspaceId);
      }
    }

    const entry: DevToolsLogEntry = { type: "run", run };
    const json = JSON.stringify(entry);
    this.insertRun(data, run, json.length);
    await this.appendToFile(workspaceId, entry, json);

    const summary = this.buildRunSummary(data, run.id);
    this.emitWorkspaceEvent(workspaceId, { type: "run-created", run: summary });
  }

  async createStep(workspaceId: string, step: DevToolsStep): Promise<void> {
    if (!this.enabled) {
      return;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.createStep requires a workspaceId");
    assert(step.runId.trim().length > 0, "DevToolsService.createStep requires step.runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    // Self-healing: if the run was cleared during an active stream,
    // recreate it so steps aren't orphaned.
    if (!data.runs.has(step.runId)) {
      const autoRun: DevToolsRun = {
        id: step.runId,
        workspaceId,
        startedAt: step.startedAt,
      };
      const runEntry: DevToolsLogEntry = { type: "run", run: autoRun };
      const runJson = JSON.stringify(runEntry);
      this.insertRun(data, autoRun, runJson.length);
      await this.appendToFile(workspaceId, runEntry, runJson);
      this.emitWorkspaceEvent(workspaceId, {
        type: "run-created",
        run: this.buildRunSummary(data, autoRun.id),
      });
    }

    const entry: DevToolsLogEntry = { type: "step", step };
    const json = JSON.stringify(entry);
    this.setStep(data, step, json.length);
    await this.appendToFile(workspaceId, entry, json);

    this.emitWorkspaceEvent(workspaceId, { type: "step-created", step });
    if (data.runs.has(step.runId)) {
      const summary = this.buildRunSummary(data, step.runId);
      this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
    }
  }

  async updateStep(
    workspaceId: string,
    stepId: string,
    update: Partial<DevToolsStep>
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "DevToolsService.updateStep requires a workspaceId");
    assert(stepId.trim().length > 0, "DevToolsService.updateStep requires stepId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    const existing = data.steps.get(stepId);
    if (!existing) {
      log.warn(
        `DevToolsService.updateStep skipped missing step ${stepId} in workspace ${workspaceId}`
      );
      return;
    }

    const mergedStep: DevToolsStep = {
      ...existing,
      ...update,
    };
    const entry: DevToolsLogEntry = { type: "step-update", stepId, update };
    const json = JSON.stringify(entry);
    this.setStep(data, mergedStep, this.updatedStepBytes(data, existing, update, json.length));

    await this.appendToFile(workspaceId, entry, json);

    this.emitWorkspaceEvent(workspaceId, {
      type: "step-updated",
      step: mergedStep,
    });

    if (data.runs.has(mergedStep.runId)) {
      const summary = this.buildRunSummary(data, mergedStep.runId);
      this.emitWorkspaceEvent(workspaceId, { type: "run-updated", run: summary });
    }
  }

  async finalizeStaleSteps(workspaceId: string): Promise<void> {
    // Stale cleanup runs regardless of the current enabled state: steps that were
    // started while logging was ON should be properly finalized even if the user
    // later disables debug logging.
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.finalizeStaleSteps requires a workspaceId"
    );

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
  }

  async getRuns(workspaceId: string): Promise<DevToolsRunSummary[]> {
    if (!this.enabled) {
      return [];
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.getRuns requires a workspaceId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    return Array.from(data.runs.keys())
      .map((runId) => this.buildRunSummary(data, runId))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getRunWithSteps(
    workspaceId: string,
    runId: string
  ): Promise<{ run: DevToolsRunSummary; steps: DevToolsStep[] } | null> {
    if (!this.enabled) {
      return null;
    }

    assert(workspaceId.trim().length > 0, "DevToolsService.getRunWithSteps requires a workspaceId");
    assert(runId.trim().length > 0, "DevToolsService.getRunWithSteps requires runId");

    await this.ensureLoaded(workspaceId);
    const data = this.getOrCreateWorkspaceData(workspaceId);

    if (!data.runs.has(runId)) {
      return null;
    }

    const summary = this.buildRunSummary(data, runId);
    const steps = Array.from(data.steps.values())
      .filter((step) => step.runId === runId)
      .sort((a, b) => getStepSortKey(a).localeCompare(getStepSortKey(b)));

    return {
      run: summary,
      steps,
    };
  }

  async clear(workspaceId: string): Promise<void> {
    assert(workspaceId.trim().length > 0, "DevToolsService.clear requires a workspaceId");

    // Wait for any in-flight load to finish before clearing, otherwise the
    // pending loadFromDisk can repopulate stale data after the clear.
    const pendingLoad = this.loadingPromises.get(workspaceId);
    if (pendingLoad) {
      await pendingLoad;
    }

    const data = this.getOrCreateWorkspaceData(workspaceId);
    data.runs.clear();
    data.steps.clear();
    data.runBytes.clear();
    data.stepBytes.clear();
    data.retainedBytes = 0;
    data.clearGeneration += 1;
    data.loaded = true;
    this.pendingRunMetadata.delete(workspaceId);

    // Enqueue truncation so clear() cannot race with pending appends.
    await this.enqueueWrite(workspaceId, () =>
      this.commitToSessionFileUnlessRemoved(workspaceId, (filePath) =>
        fs.writeFile(filePath, "", "utf-8")
      )
    );

    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
  }

  /**
   * Remove all DevTools state for a workspace: in-memory data and the on-disk
   * devtools.jsonl. Called when a workspace is archived or removed — debug logs
   * grow large and are only useful for live workspaces (worst case after
   * unarchive is an empty DevTools panel).
   *
   * Runs regardless of `enabled`: files written while logging was on must be
   * cleaned up even if the user has since disabled debug logging.
   */
  async removeWorkspaceData(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.removeWorkspaceData requires a workspaceId"
    );

    // Wait for any in-flight load to finish so it cannot repopulate state
    // after the removal below.
    const pendingLoad = this.loadingPromises.get(workspaceId);
    if (pendingLoad) {
      await pendingLoad;
    }

    // Deleting the entry (rather than clearing it in place) makes stale queued
    // appends no-ops via the existence guard in appendToFile.
    this.workspaces.delete(workspaceId);
    this.pendingRunMetadata.delete(workspaceId);

    // Enqueue the deletion so it serializes behind any pending appends.
    await this.enqueueWrite(workspaceId, async () => {
      await fs.rm(this.getSessionFilePath(workspaceId), { force: true });
    });

    this.emitWorkspaceEvent(workspaceId, { type: "cleared" });
  }

  private emitWorkspaceEvent(workspaceId: string, event: DevToolsEvent): void {
    this.emit(`update:${workspaceId}`, event);
  }

  /** Whether removeWorkspaceData() has anything to remove: live in-memory state or the on-disk log. */
  async hasWorkspaceData(workspaceId: string): Promise<boolean> {
    assert(
      workspaceId.trim().length > 0,
      "DevToolsService.hasWorkspaceData requires a workspaceId"
    );
    if (this.workspaces.has(workspaceId)) {
      return true;
    }
    try {
      await fs.access(this.getSessionFilePath(workspaceId));
      return true;
    } catch {
      return false;
    }
  }

  private getSessionFilePath(workspaceId: string): string {
    return path.join(this.config.sessionsDir, workspaceId, "devtools.jsonl");
  }

  private getOrCreateWorkspaceData(workspaceId: string): WorkspaceData {
    let data = this.workspaces.get(workspaceId);
    if (data) {
      return data;
    }

    data = {
      runs: new Map<string, DevToolsRun>(),
      steps: new Map<string, DevToolsStep>(),
      runBytes: new Map<string, number>(),
      stepBytes: new Map<string, number>(),
      retainedBytes: 0,
      loaded: false,
      clearGeneration: 0,
    };
    this.workspaces.set(workspaceId, data);
    return data;
  }

  private insertRun(data: WorkspaceData, run: DevToolsRun, bytes: number): void {
    data.runs.set(run.id, run);
    this.addRunBytes(data, run.id, bytes);
    this.enforceRetention(data, run.id);
  }

  private setStep(data: WorkspaceData, step: DevToolsStep, bytes: number): void {
    const previousBytes = data.stepBytes.get(step.id) ?? 0;
    data.steps.set(step.id, step);
    data.stepBytes.set(step.id, bytes);
    this.addRunBytes(data, step.runId, bytes - previousBytes);
    this.enforceRetention(data, step.runId);
  }

  /** Size of `existing` after applying `update`, given the update's serialized length. */
  private updatedStepBytes(
    data: WorkspaceData,
    existing: DevToolsStep,
    update: Partial<DevToolsStep>,
    updateJsonBytes: number
  ): number {
    const previousBytes = data.stepBytes.get(existing.id) ?? 0;
    return Math.max(0, previousBytes + updateJsonBytes - replacedStepBytes(existing, update));
  }

  private addRunBytes(data: WorkspaceData, runId: string, delta: number): void {
    data.runBytes.set(runId, (data.runBytes.get(runId) ?? 0) + delta);
    data.retainedBytes += delta;
  }

  /**
   * Drop the oldest runs (by append order) and their steps until both the run
   * and byte bounds hold. `writingRunId` is the run the caller just inserted or
   * grew; it is never evicted, so a single oversized run stays visible (and its
   * pending disk append is not suppressed by the appendToFile existence guard).
   */
  private enforceRetention(data: WorkspaceData, writingRunId: string): void {
    while (
      data.runs.size > MAX_RETAINED_RUNS_PER_WORKSPACE ||
      data.retainedBytes > this.maxRetainedBytesPerWorkspace
    ) {
      const oldestRunId = data.runs.keys().next().value;
      if (oldestRunId === undefined || oldestRunId === writingRunId) {
        return;
      }
      evictRun(data, oldestRunId);
    }
  }

  private async ensureLoaded(workspaceId: string): Promise<void> {
    const data = this.getOrCreateWorkspaceData(workspaceId);
    if (data.loaded) {
      return;
    }

    // Serialize concurrent loads for the same workspace: if another call is already
    // loading this workspace, await its promise instead of starting a second load.
    // This prevents duplicate disk reads and — critically — prevents stale-step
    // finalization from running while a concurrent request has a legitimate
    // in-progress step.
    const existingPromise = this.loadingPromises.get(workspaceId);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    const loadPromise = this.loadFromDisk(workspaceId, data);
    this.loadingPromises.set(workspaceId, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.loadingPromises.delete(workspaceId);
    }
  }

  private async loadFromDisk(workspaceId: string, data: WorkspaceData): Promise<void> {
    const filePath = this.getSessionFilePath(workspaceId);

    try {
      for await (const line of readTailLines(filePath, LOAD_TAIL_BYTES)) {
        this.replayLogLine(workspaceId, data, line);
      }
    } catch (error) {
      // Any failure still marks the workspace loaded with whatever partial state
      // was replayed. Leaving `loaded` false made every later createRun/createStep
      // re-run the failing load against a multi-hundred-MB file.
      if (!(isRecord(error) && error.code === "ENOENT")) {
        log.warn("DevTools: failed to load devtools.jsonl, continuing with partial state", {
          workspaceId,
          error: getErrorMessage(error),
        });
      }
    }

    data.loaded = true;
    await this.finalizeStaleStepsForLoadedWorkspace(workspaceId, data);
  }

  private replayLogLine(workspaceId: string, data: WorkspaceData, line: string): void {
    if (!line.trim()) {
      return;
    }

    try {
      const entry = JSON.parse(line) as DevToolsLogEntry;
      switch (entry.type) {
        case "run": {
          this.insertRun(data, entry.run, line.length);
          break;
        }
        case "step": {
          // Steps for runs outside the retained window (cut off by the tail
          // read or already evicted) have no reader; skip them.
          if (!data.runs.has(entry.step.runId)) {
            break;
          }
          this.setStep(data, applyStepBackwardCompatibilityDefaults(entry.step), line.length);
          break;
        }
        case "step-update": {
          const existing = data.steps.get(entry.stepId);
          if (existing) {
            this.setStep(
              data,
              applyStepBackwardCompatibilityDefaults({
                ...existing,
                ...entry.update,
              }),
              this.updatedStepBytes(data, existing, entry.update, line.length)
            );
          }
          break;
        }
        default: {
          log.warn("Skipping unknown devtools.jsonl entry type", {
            workspaceId,
          });
        }
      }
    } catch {
      log.warn("Skipping corrupted devtools.jsonl line");
    }
  }

  private async finalizeStaleStepsForLoadedWorkspace(
    workspaceId: string,
    data: WorkspaceData
  ): Promise<void> {
    assert(
      data.loaded,
      "DevToolsService.finalizeStaleStepsForLoadedWorkspace requires loaded workspace data"
    );

    const staleSteps = Array.from(data.steps.values()).filter(
      (step) => step.durationMs == null && step.error == null
    );
    if (staleSteps.length === 0) {
      return;
    }

    const nowMs = Date.now();
    for (const step of staleSteps) {
      const startedAtMs = new Date(step.startedAt).getTime();
      const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;

      await this.updateStep(workspaceId, step.id, {
        durationMs,
        error: "Interrupted (stale)",
      });
    }
  }

  private buildRunSummary(data: WorkspaceData, runId: string): DevToolsRunSummary {
    const run = data.runs.get(runId);
    assert(run, `DevToolsService.buildRunSummary missing run ${runId}`);

    const steps = Array.from(data.steps.values())
      .filter((step) => step.runId === runId)
      .sort((a, b) => getStepSortKey(a).localeCompare(getStepSortKey(b)));

    const firstStep = steps[0];

    let firstMessage = "";
    if (firstStep?.input && isRecord(firstStep.input)) {
      const prompt = firstStep.input.prompt;
      if (isUnknownArray(prompt)) {
        for (let index = prompt.length - 1; index >= 0; index -= 1) {
          const message = prompt[index];
          if (!isRecord(message) || message.role !== "user") {
            continue;
          }

          const text = extractText(message.content ?? message);
          if (!text.trim()) {
            continue;
          }

          firstMessage = truncateMessage(text.trim());
          break;
        }
      }
    }

    const hasError = steps.some((step) => Boolean(step.error));
    const isInProgress = steps.some((step) => step.durationMs == null && !step.error);

    let totalDurationMs: number | null = 0;
    for (const step of steps) {
      if (step.durationMs == null) {
        totalDurationMs = null;
        break;
      }
      totalDurationMs += step.durationMs;
    }

    return {
      ...run,
      stepCount: steps.length,
      firstMessage,
      hasError,
      isInProgress,
      totalDurationMs,
      modelId: firstStep?.modelId ?? null,
    };
  }

  /**
   * Serialize all disk writes per workspace so clear() and appendToFile()
   * can never complete out of order.
   */
  private enqueueWrite(workspaceId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(workspaceId) ?? Promise.resolve();
    // Always chain regardless of prior failure so the queue never stalls.
    const next = prev.then(fn, () => fn());
    this.writeQueues.set(workspaceId, next);
    return next;
  }

  /** `json` is the caller's serialization of `entry`, shared with retention accounting. */
  private async appendToFile(
    workspaceId: string,
    entry: DevToolsLogEntry,
    json: string
  ): Promise<void> {
    return this.enqueueWrite(workspaceId, async () => {
      // Defense-in-depth: skip stale writes after clear() by requiring current entities.
      const data = this.workspaces.get(workspaceId);
      if (!data) {
        return;
      }
      if (entry.type === "run" && !data.runs.has(entry.run.id)) {
        return;
      }
      if (entry.type === "step" && !data.steps.has(entry.step.id)) {
        return;
      }
      if (entry.type === "step-update" && !data.steps.has(entry.stepId)) {
        return;
      }

      await this.commitToSessionFileUnlessRemoved(workspaceId, (filePath) =>
        fs.appendFile(filePath, `${json}\n`, "utf-8")
      );
    });
  }

  /**
   * r64: devtools.jsonl commits recreate the session directory via mkdir,
   * and with XUM_ALLOW_MULTIPLE_INSTANCES=1 a foreign backend's in-flight
   * stream survives the remover's process-local cancellation entirely — its
   * step finalization would resurrect the directory the remover just
   * deleted. Run every directory-creating disk commit inside the same
   * sessionDir target mutation lock removal's tombstone+delete critical
   * section holds, and recheck the durable removal tombstone in-lock (same
   * posture as SessionUsageService.recordHeadlessUsage). Dropping the entry
   * is correct: debug logs for a removed workspace have no reader. Callers
   * never hold other target locks here, so this single-key acquisition
   * cannot ABBA with removal's sorted multi-key acquisition.
   */
  private async commitToSessionFileUnlessRemoved(
    workspaceId: string,
    write: (filePath: string) => Promise<void>
  ): Promise<void> {
    await withTargetMutationLock(
      this.config.rootDir,
      path.join(this.config.sessionsDir, workspaceId),
      async () => {
        if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
          log.debug("Skipping DevTools write for removed workspace", { workspaceId });
          return;
        }
        const filePath = this.getSessionFilePath(workspaceId);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await write(filePath);
      }
    );
  }
}
