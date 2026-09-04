import { createHash } from "node:crypto";
import assert from "@/common/utils/assert";
import { FORCE_COMPACTION_BUFFER_PERCENT } from "@/common/constants/ui";
import { EAGER_LEAD_PERCENT, MIN_HEAD_TOKENS } from "@/constants/continuousCompaction";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { selectRollingCut, type RollingCut } from "@/common/utils/compaction/rollingCut";
import { estimateMuxMessageTokens } from "@/common/utils/messages/keepRecentTail";
import { isDurableContextBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import type { HistoryService } from "./historyService";
import type { CompactionHandler } from "./compactionHandler";
import { log } from "./log";

export interface ContinuousCompactionContext {
  enabled: boolean;
  model: string;
  contextWindowTokens: number;
  thresholdPercent: number;
  systemMessageTokens?: number;
  attachmentTokens?: number;
}

type Phase = "on-send" | "mid-stream" | "stream-end";
type Verdict = "none" | "applied" | "fallback";
interface StreamSnapshot {
  messageId: string;
  parts: MuxMessage["parts"];
  stepStartIndices: readonly number[];
}
interface Dependencies {
  workspaceId: string;
  historyService: HistoryService;
  compactionHandler: CompactionHandler;
  streamManager: {
    getStreamInfo(workspaceId: string): StreamSnapshot | undefined;
    isStreaming(workspaceId: string): boolean;
  };
  prepare(): Promise<void>;
  // Includes usage recording: the generation fence must be AFTER the last await.
  summarize(
    head: MuxMessage[],
    signal: AbortSignal,
    context: ContinuousCompactionContext
  ): Promise<{ text: string; model: string } | null>;
  fastApply(
    apply: (pendingFollowUp?: CompactionFollowUpRequest) => Promise<boolean>
  ): Promise<boolean>;
}
interface StagedSummary {
  generation: number;
  epoch: number;
  boundarySequence?: number;
  headEnd: { id: string; sequence: number };
  cut: RollingCut;
  headFingerprint: string;
  text: string;
  model: string;
}

/** Only durable request-affecting metadata participates: committing a partial is not an edit. */
function fingerprint(rows: MuxMessage[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    const metadata = row.metadata;
    const muxMetadata = metadata?.muxMetadata && { ...metadata.muxMetadata };
    if (muxMetadata) {
      delete muxMetadata.requestedModel;
      delete muxMetadata.transcriptAnchor;
      if (muxMetadata.type === "compaction-request") delete muxMetadata.displayStatus;
      if (muxMetadata.type === "compaction-summary") delete muxMetadata.pendingFollowUp;
    }
    hash.update(
      JSON.stringify({
        id: row.id,
        sequence: metadata?.historySequence,
        role: row.role,
        parts: row.parts,
        synthetic: metadata?.synthetic,
        uiVisible: metadata?.uiVisible,
        kind: metadata?.kind,
        fileAtMentionSnapshot: metadata?.fileAtMentionSnapshot,
        agentSkillSnapshot: metadata?.agentSkillSnapshot,
        mcpPromptSnapshot: metadata?.mcpPromptSnapshot,
        muxMetadata,
      })
    );
  }
  return hash.digest("hex").slice(0, 32);
}

function boundaryIdentity(rows: MuxMessage[]): { epoch: number; boundarySequence?: number } {
  const boundary = rows.findLast(isDurableContextBoundaryMarker);
  return {
    epoch: boundary?.metadata?.compactionEpoch ?? 0,
    boundarySequence: boundary?.metadata?.historySequence,
  };
}

/** Background summary + recent pages. Only the short apply is serialized with the turn. */
export class ContinuousCompactor {
  private generation = 0;
  private staged: StagedSummary | null = null;
  private job: { generation: number; abort: AbortController; done: Promise<void> } | null = null;
  private applying: Promise<Verdict> | null = null;

  constructor(private readonly deps: Dependencies) {
    assert(deps.workspaceId.length > 0, "ContinuousCompactor requires a workspace");
  }

  reset(reason: string): void {
    this.generation++;
    this.job?.abort.abort();
    this.job = null;
    this.staged = null;
    log.debug("[continuous-compaction] reset", { workspaceId: this.deps.workspaceId, reason });
  }

  isApplying(): boolean {
    return this.applying !== null;
  }

  async waitForIdle(): Promise<void> {
    await this.applying;
  }

  observe(
    usagePercent: number,
    context: ContinuousCompactionContext & { phase: Phase }
  ): Promise<Verdict> {
    if (!context.enabled || context.thresholdPercent >= 100) {
      this.reset("disabled");
      return Promise.resolve("none");
    }
    if (
      !Number.isFinite(usagePercent) ||
      !Number.isFinite(context.contextWindowTokens) ||
      context.contextWindowTokens <= 0
    ) {
      return Promise.resolve("none");
    }
    if (this.applying) return this.applying;
    // Install the latch before any read or callback can synchronously re-enter observe.
    const generation = this.generation;
    const applying = Promise.resolve().then(() =>
      generation === this.generation
        ? this.observeUnlocked(usagePercent, context)
        : ("none" as const)
    );
    this.applying = applying;
    return applying.finally(() => {
      if (this.applying === applying) this.applying = null;
    });
  }

  private async observeUnlocked(
    usagePercent: number,
    context: ContinuousCompactionContext & { phase: Phase }
  ): Promise<Verdict> {
    if (usagePercent >= context.thresholdPercent && this.staged) {
      const staged = this.staged;
      const rows = await this.readSnapshot();
      if (rows && this.isValid(staged, rows)) {
        const applied =
          context.phase === "mid-stream"
            ? await this.deps.fastApply((pendingFollowUp) =>
                this.applyDurably(staged, context, pendingFollowUp)
              )
            : await this.applyDurably(staged, context);
        if (applied) return "applied";
      }
      if (this.staged === staged) this.staged = null;
    }
    if (
      usagePercent >= Math.max(0, context.thresholdPercent - EAGER_LEAD_PERCENT) &&
      !this.staged &&
      !this.job
    ) {
      const job = {
        generation: this.generation,
        abort: new AbortController(),
        done: Promise.resolve(),
      };
      this.job = job;
      job.done = this.startEagerJob(job, context)
        .catch((error: unknown) => {
          if (!job.abort.signal.aborted)
            log.warn("[continuous-compaction] summarizer failed", error);
        })
        .finally(() => {
          if (this.job === job) this.job = null;
        });
    }
    return usagePercent >= context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT
      ? "fallback"
      : "none";
  }

  private async readSnapshot(): Promise<MuxMessage[] | null> {
    const result = await this.deps.historyService.getHistoryFromLatestBoundary(
      this.deps.workspaceId
    );
    if (!result.success) {
      log.warn("[continuous-compaction] history unavailable", result.error);
      return null;
    }
    const rows = result.data;
    const live = this.deps.streamManager.getStreamInfo(this.deps.workspaceId);
    if (live) {
      const index = rows.findIndex((row) => row.id === live.messageId);
      if (index < 0) return null;
      rows[index] = { ...rows[index], parts: structuredClone(live.parts) };
    }
    return rows;
  }

  private async startEagerJob(
    job: NonNullable<ContinuousCompactor["job"]>,
    context: ContinuousCompactionContext
  ): Promise<void> {
    await this.deps.prepare();
    if (job.generation !== this.generation) return;
    const rows = await this.readSnapshot();
    if (!rows || job.generation !== this.generation) return;
    const live = this.deps.streamManager.getStreamInfo(this.deps.workspaceId);
    if (live) {
      const completedEnd = live.stepStartIndices.at(-1) ?? 0;
      // Until one exact completed step exists there is no safe mandatory tail.
      if (completedEnd === 0) return;
      const index = rows.findIndex((row) => row.id === live.messageId);
      if (index < 0) return;
      rows[index] = { ...rows[index], parts: structuredClone(live.parts.slice(0, completedEnd)) };
    }
    const cut = selectRollingCut(rows, live ?? null, {
      contextWindowTokens: context.contextWindowTokens,
      // Reserve the minimum head budget for the as-yet-unknown summary. Actual
      // summary + current tail are checked again immediately before applying.
      summaryTokens:
        (context.systemMessageTokens ?? 0) +
        Math.min(MIN_HEAD_TOKENS, context.contextWindowTokens * 0.1),
      attachmentTokens: context.attachmentTokens ?? 0,
      forceThresholdTokens:
        (context.contextWindowTokens *
          (context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT)) /
        100,
    });
    if (!cut) return;
    const headEnd = cut.head.at(-1);
    assert(
      headEnd?.metadata?.historySequence !== undefined,
      "Rolling head must have a durable sequence"
    );
    const stagedBase = {
      generation: job.generation,
      ...boundaryIdentity(rows),
      cut,
      headEnd: { id: headEnd.id, sequence: headEnd.metadata.historySequence },
      headFingerprint: fingerprint(cut.head),
    };
    const summary = await this.deps.summarize(cut.head, job.abort.signal, context);
    if (!summary || job.generation !== this.generation || job.abort.signal.aborted) return;
    assert(summary.text.trim().length > 0, "Continuous summarizer returned empty text");
    this.staged = { ...stagedBase, ...summary };
    log.debug("[continuous-compaction] staged", {
      workspaceId: this.deps.workspaceId,
      headTokens: cut.headTokens,
      tailTokens: cut.tailTokens,
    });
  }

  private headFromRows(staged: StagedSummary, rows: MuxMessage[]): MuxMessage[] | null {
    const end = rows.findIndex(
      (row) =>
        row.id === staged.headEnd.id && row.metadata?.historySequence === staged.headEnd.sequence
    );
    if (end < 0) return null;
    const head = rows.slice(0, end + 1);
    if (staged.cut.stepCut) {
      const row = head[end];
      const partIndex = staged.cut.stepCut.partIndex;
      if (row.id !== staged.cut.stepCut.messageId || row.parts.length < partIndex) return null;
      head[end] = { ...row, parts: row.parts.slice(0, partIndex) };
    }
    return head;
  }

  private isValid(staged: StagedSummary, rows: MuxMessage[]): boolean {
    if (staged.generation !== this.generation) return false;
    const identity = boundaryIdentity(rows);
    if (identity.epoch !== staged.epoch || identity.boundarySequence !== staged.boundarySequence)
      return false;
    const head = this.headFromRows(staged, rows);
    return head !== null && fingerprint(head) === staged.headFingerprint;
  }

  private materializeTail(staged: StagedSummary, rows: MuxMessage[]): MuxMessage[] {
    const end = rows.findIndex((row) => row.id === staged.headEnd.id);
    const copiedCluster = new Set(staged.cut.tail.map((row) => row.id));
    return rows.flatMap((row, index) => {
      if (staged.cut.stepCut?.messageId === row.id) {
        const partIndex = staged.cut.stepCut.partIndex;
        return [
          {
            ...row,
            parts: row.parts.slice(partIndex),
            metadata: {
              ...row.metadata,
              stepStartPartIndices: row.metadata?.stepStartPartIndices
                ?.filter((start) => start >= partIndex && start < row.parts.length)
                .map((start) => start - partIndex),
            },
          },
        ];
      }
      return index > end || copiedCluster.has(row.id) ? [row] : [];
    });
  }

  private async applyDurably(
    staged: StagedSummary,
    context: ContinuousCompactionContext,
    pendingFollowUp?: CompactionFollowUpRequest
  ): Promise<boolean> {
    assert(
      !this.deps.streamManager.isStreaming(this.deps.workspaceId),
      "Cannot apply a boundary while a stream is active"
    );
    let rows = await this.readSnapshot();
    if (!rows || !this.isValid(staged, rows)) return false;
    const head = this.headFromRows(staged, rows);
    assert(head !== null, "Validated rolling head disappeared");
    await this.deps.compactionHandler.preparePendingStateFromMessages(head);
    // Pending-state persistence yields; a reset/edit during it must still invalidate this job.
    rows = await this.readSnapshot();
    if (!rows || !this.isValid(staged, rows)) return false;
    assert(
      !this.deps.streamManager.isStreaming(this.deps.workspaceId),
      "Stream started during continuous apply"
    );
    const partial = await this.deps.historyService.readPartial(this.deps.workspaceId);
    assert(!partial, "Continuous apply requires the partial to be committed first");
    if (staged.generation !== this.generation) return false;
    const tail = this.materializeTail(staged, rows);
    const summaryTokens = estimateMuxMessageTokens(
      createMuxMessage("estimate", "assistant", staged.text)
    );
    const inputTokens =
      summaryTokens +
      (context.systemMessageTokens ?? 0) +
      (context.attachmentTokens ?? 0) +
      tail.reduce((sum, row) => sum + estimateMuxMessageTokens(row), 0);
    if (
      inputTokens >=
      (context.contextWindowTokens * (context.thresholdPercent + FORCE_COMPACTION_BUFFER_PERCENT)) /
        100
    )
      return false;
    const applied = await this.deps.compactionHandler.persistContinuousCompaction({
      messages: rows,
      text: staged.text,
      model: staged.model,
      tail,
      systemMessageTokens: context.systemMessageTokens ?? 0,
      attachmentTokens: context.attachmentTokens ?? 0,
      pendingFollowUp,
    });
    if (applied) this.reset("applied");
    return applied;
  }
}
