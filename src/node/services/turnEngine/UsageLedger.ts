/**
 * UsageLedger: the one owner of a StreamManager turn's usage accounting
 * (turn-engine layer 3b).
 *
 * Shape: like PartialJournal, a plain class that StreamManager constructs with its
 * SessionUsageService and providers-config accessor. The per-turn state stays as fields
 * on WorkspaceStreamInfo.
 *
 * Invariants:
 * - Each attempt's usage reaches the session ledger once: settle clears the in-flight key
 *   before its write, the same write marks the in-flight file settled, and a failed write
 *   keeps the file for the next ledger read instead of recording again.
 * - A refused fallback hop is recorded as a toolModelUsages entry plus one settle; the
 *   error path then does not record the cumulative counters again.
 * - Sidecar (headless) rows never touch the session ledger (skipSessionLedger).
 */
import { randomUUID } from "crypto";

import {
  hasTokenUsage,
  MODEL_FALLBACK_REFUSAL_TOOL_NAME,
  type MuxMetadata,
  type PersistedToolModelUsage,
} from "@/common/types/message";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeUsageModelKey } from "@/common/utils/providers/modelEntries";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import type { Logger } from "@/node/services/log";
import { nodeClock } from "@/node/utils/hostClock";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

export interface UsageLedgerState {
  toolModelUsages: PersistedToolModelUsage[];
  // Key of this attempt's in-flight usage file (SessionUsageService.recordInFlightUsage);
  // set by the first finished step, cleared when the attempt settles or is discarded.
  inFlightUsageKey?: string;
  // Cumulative usage across all steps (for live cost display during streaming)
  cumulativeUsage: LanguageModelV2Usage;
  // Cumulative provider metadata across all steps (for live cost display with cache tokens)
  cumulativeProviderMetadata?: Record<string, unknown>;
  // Terminal model_refusal usage persisted on no-fallback error partials so live
  // and rebuilt session costs include the refused attempt.
  terminalRefusalUsage?: LanguageModelV2Usage;
  terminalRefusalProviderMetadata?: Record<string, unknown>;
  // Last step's usage (for context window display during streaming)
  lastStepUsage?: LanguageModelV2Usage;
  // Last step's provider metadata (for context window cache display)
  lastStepProviderMetadata?: Record<string, unknown>;
}

/** The turn fields the ledger prices and keys usage with (all on WorkspaceStreamInfo). */
export interface UsageTurn extends UsageLedgerState {
  readonly messageId: string;
  readonly model: string;
  readonly metadataModel: string;
  readonly workspaceName?: string;
  readonly initialMetadata?: Partial<MuxMetadata>;
}

/** Drop reason for a partial that never reaches chat.jsonl. */
export type DroppedStreamSource = "aborted_stream" | "errored_stream";
/** Sidecar analytics label: drop reason, or the refusal-specific label. */
type HeadlessDropSource = DroppedStreamSource | "refused_stream";

export interface UsageSnapshot {
  usage?: LanguageModelV2Usage;
  providerMetadata?: Record<string, unknown>;
}

export interface UsageLedgerDeps {
  readonly sessionUsageService?: SessionUsageService;
  readonly getProvidersConfig: () => ProvidersConfigMap | null;
  readonly workspaceLogger: (
    workspaceId: string,
    turn?: Pick<UsageTurn, "workspaceName">
  ) => Logger;
}

export function markProviderMetadataCostsIncluded(
  providerMetadata: Record<string, unknown> | undefined,
  costsIncluded: boolean | undefined
): Record<string, unknown> | undefined {
  if (!costsIncluded) return providerMetadata;

  const muxMetadata = providerMetadata?.mux;
  const existingMux =
    muxMetadata && typeof muxMetadata === "object"
      ? (muxMetadata as Record<string, unknown>)
      : undefined;

  return {
    ...(providerMetadata ?? {}),
    mux: {
      ...(existingMux ?? {}),
      costsIncluded: true,
    },
  };
}

export function cloneUsage(usage: LanguageModelV2Usage): LanguageModelV2Usage {
  return { ...usage };
}

/**
 * Fresh all-zero usage object for refusals where the provider billed nothing
 * (or usage never arrived). A new object per call — downstream code mutates
 * usage objects (e.g. reasoning-token backfill), so a shared singleton would
 * leak counts across records.
 */
function zeroTokenUsage(): LanguageModelV2Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export class UsageLedger {
  constructor(private readonly deps: UsageLedgerDeps) {}

  /**
   * After each finished step, write the attempt's priced cumulative usage to its own
   * in-flight file, so a Xum restart mid-turn loses at most the unfinished step. Priced like
   * the abort path. One write per finished step, never per token.
   */
  async recordInFlight(workspaceId: string, turn: UsageTurn): Promise<void> {
    const sessionUsageService = this.deps.sessionUsageService;
    if (!sessionUsageService || !hasTokenUsage(turn.cumulativeUsage)) {
      return;
    }
    const usage = createDisplayUsage(
      turn.cumulativeUsage,
      turn.model,
      markProviderMetadataCostsIncluded(
        turn.cumulativeProviderMetadata,
        turn.initialMetadata?.costsIncluded
      ),
      turn.metadataModel
    );
    if (!usage) {
      return;
    }
    const key = turn.inFlightUsageKey ?? randomUUID();
    try {
      await sessionUsageService.recordInFlightUsage(
        workspaceId,
        key,
        turn.messageId,
        this.attributionModel(turn.model, turn.metadataModel),
        usage
      );
      turn.inFlightUsageKey = key;
    } catch (error) {
      this.deps
        .workspaceLogger(workspaceId, turn)
        .warn("Failed to record in-flight session usage", { error });
    }
  }

  /**
   * Record the attempt's final usage. The same ledger write marks its in-flight file settled
   * (then the file is deleted), so a crash at any point counts the attempt once.
   */
  async settle(
    workspaceId: string,
    turn: UsageTurn,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    logMessage: string,
    logLevel: "warn" | "error",
    model: string = turn.model
  ): Promise<void> {
    const key = turn.inFlightUsageKey;
    // Cleared first: a later step (a fallback after a refusal) starts a new in-flight file.
    turn.inFlightUsageKey = undefined;
    const result = await this.recordUsage(
      workspaceId,
      turn,
      model,
      usage,
      providerMetadata,
      logMessage,
      logLevel,
      key
    );
    if (key === undefined) {
      return;
    }
    if (result === "skipped") {
      await this.discardKey(workspaceId, turn, key);
    } else if (result === "failed") {
      // The file is the only durable record of the finished steps: keep it, and let the
      // next ledger read fold it.
      this.deps.sessionUsageService?.releaseInFlightUsage(workspaceId, key);
    }
  }

  /**
   * The attempt ends without usage to record (its usage is dropped, or recorded through
   * another path): delete its in-flight file. Totals match those before in-flight files.
   */
  async discardInFlight(workspaceId: string, turn: UsageTurn): Promise<void> {
    const key = turn.inFlightUsageKey;
    if (key === undefined) {
      return;
    }
    turn.inFlightUsageKey = undefined;
    await this.discardKey(workspaceId, turn, key);
  }

  /**
   * Attribute a refused fallback attempt's token usage to the refusing model
   * before the fallback swap wipes per-attempt counters. The toolModelUsages
   * entry is the durable record (session-usage rebuilds scan it per-model); the
   * live settle keeps in-memory session totals consistent with it.
   */
  async recordRefusedAttempt(
    workspaceId: string,
    turn: UsageTurn,
    refusedModel: string,
    snapshot: UsageSnapshot
  ): Promise<void> {
    const { usage, providerMetadata } = snapshot;
    // Zero-usage refusals (provider billed nothing / usage never arrived) are
    // still real refused attempts: record an explicit all-zero entry so
    // analytics counts the refusal, but skip the session ledger below — no
    // zero-cost noise in the costs UI.
    //
    // The persisted entry carries the ATTRIBUTION key, not the raw stream
    // identity: sidecar refused_stream rows are keyed by
    // recordHeadlessUsageLocked's canonical model, so a raw gateway/Coder
    // identity here (e.g. coder:openai/gpt-5 vs openai:gpt-5) would
    // split one model across two analytics buckets when queries group
    // committed hop rows and sidecar rows together.
    turn.toolModelUsages.push({
      toolName: MODEL_FALLBACK_REFUSAL_TOOL_NAME,
      // Record time: wall clock until #7282 moves its consumers to HostClock.
      timestamp: nodeClock.nowMs(),
      model: this.attributionModel(refusedModel, turn.metadataModel),
      metadataModel: turn.metadataModel,
      usage: usage ?? zeroTokenUsage(),
      ...(providerMetadata ? { providerMetadata } : {}),
    });

    if (!usage) {
      return;
    }

    await this.settle(
      workspaceId,
      turn,
      usage,
      providerMetadata,
      "Failed to record refused-attempt session usage (fallback unaffected)",
      "warn",
      refusedModel
    );
  }

  async recordTerminalRefusal(
    workspaceId: string,
    turn: UsageTurn,
    refusedModel: string,
    snapshot: UsageSnapshot
  ): Promise<void> {
    const { usage, providerMetadata } = snapshot;
    // Same zero-usage policy as recordRefusedAttempt: the terminal
    // refusal must reach the analytics sidecar (persistStreamError writes
    // terminalRefusalUsage as a "refused_stream" row) even when the provider
    // billed nothing, but the session ledger stays free of zero-cost entries.
    turn.terminalRefusalUsage = usage ?? zeroTokenUsage();
    turn.terminalRefusalProviderMetadata = providerMetadata;

    if (!usage) {
      return;
    }

    await this.settle(
      workspaceId,
      turn,
      usage,
      providerMetadata,
      "Failed to record terminal-refusal session usage",
      "warn",
      refusedModel
    );
  }

  /**
   * Route a dropped partial's billed usage to the headless-usage sidecar:
   * the parent stream's cumulative usage plus every tool-internal model call
   * (toolModelUsages). Used by the abort and error paths when the partial
   * fails commitPartial's durability predicate — metadata stamped on such a
   * partial dies with it, so the sidecar is the only route to the events
   * table. skipSessionLedger everywhere: parent usage was recorded via
   * settle and tool usage at report time (AIService).
   */
  async recordDroppedPartialUsage(
    workspaceId: string,
    turn: Pick<UsageTurn, "model" | "metadataModel" | "toolModelUsages">,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    analyticsSource: DroppedStreamSource,
    // Label for the stream's OWN usage row only. The error path passes
    // "refused_stream" when the turn died as a terminal model refusal (the
    // stream usage is then terminalRefusalUsage), so refusals are not
    // conflated with generic errored_stream rows in analytics.
    streamUsageSource: HeadlessDropSource = analyticsSource
  ): Promise<void> {
    // Thread the request-pinned metadata identities through the sidecar
    // write: recordHeadlessUsage would otherwise re-resolve the raw model
    // against the CURRENT config, so a Coder instance removed/retagged
    // mid-turn would persist an unknown or repriced identity in analytics.
    if (usage !== undefined) {
      await this.deps.sessionUsageService?.recordHeadlessUsage(
        workspaceId,
        turn.model,
        cloneUsage(usage),
        providerMetadata,
        {
          analyticsSource: streamUsageSource,
          skipSessionLedger: true,
          metadataModel: turn.metadataModel,
        }
      );
    }
    for (const toolUsage of turn.toolModelUsages) {
      // Refused fallback hops ARE refusals regardless of how the turn ended
      // (aborted, errored, exhausted chain); every other tool-internal usage
      // entry keeps the turn's drop reason.
      const entrySource: HeadlessDropSource =
        toolUsage.toolName === MODEL_FALLBACK_REFUSAL_TOOL_NAME
          ? "refused_stream"
          : analyticsSource;
      await this.deps.sessionUsageService?.recordHeadlessUsage(
        workspaceId,
        toolUsage.model,
        cloneUsage(toolUsage.usage),
        toolUsage.providerMetadata,
        {
          analyticsSource: entrySource,
          skipSessionLedger: true,
          metadataModel: toolUsage.metadataModel,
        }
      );
    }
  }

  private async recordUsage(
    workspaceId: string,
    turn: Pick<UsageTurn, "workspaceName" | "metadataModel">,
    model: string,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    logMessage: string,
    logLevel: "warn" | "error",
    settlesInFlightKey: string | undefined
  ): Promise<"recorded" | "skipped" | "failed"> {
    const sessionUsageService = this.deps.sessionUsageService;
    if (!sessionUsageService || !usage) {
      return "skipped";
    }
    const messageUsage = createDisplayUsage(usage, model, providerMetadata, turn.metadataModel);
    if (!messageUsage) {
      return "skipped";
    }
    const workspaceLog = this.deps.workspaceLogger(workspaceId, turn);
    const ledgerModel = this.attributionModel(model, turn.metadataModel);
    try {
      await sessionUsageService.recordUsage(
        workspaceId,
        ledgerModel,
        messageUsage,
        settlesInFlightKey !== undefined ? { settlesInFlightKey } : undefined
      );
      return "recorded";
    } catch (error) {
      (logLevel === "error" ? workspaceLog.error : workspaceLog.warn)(logMessage, { error });
      return "failed";
    }
  }

  private async discardKey(workspaceId: string, turn: UsageTurn, key: string): Promise<void> {
    try {
      await this.deps.sessionUsageService?.discardInFlightUsage(workspaceId, key);
    } catch (error) {
      this.deps
        .workspaceLogger(workspaceId, turn)
        .warn("Failed to discard in-flight session usage", { error });
    }
  }

  /**
   * Usage-attribution key, mirroring SessionUsageService.recordHeadlessUsageLocked.
   * Coder identities keep the stream's PINNED record-time metadata identity
   * (streamInfo.metadataModel), NOT a live re-resolution of the raw model: a
   * catalog refresh can remove/retag the instance while the turn is active,
   * and re-resolving would key the ledger differently from the pricing
   * identity createDisplayUsage used, so repricing would later change or
   * strip the row. Non-Coder models resolve to the canonical usage key —
   * their metadata identity can be a mappedToModel alias target (a pricing
   * identity, deliberately not the attribution bucket).
   */
  private attributionModel(model: string, metadataModel: string | undefined): string {
    return model.startsWith("coder:") && metadataModel
      ? metadataModel
      : normalizeUsageModelKey(model, this.deps.getProvidersConfig());
  }
}
