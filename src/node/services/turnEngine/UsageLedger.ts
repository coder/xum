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
 */
import { randomUUID } from "crypto";

import {
  hasTokenUsage,
  type MuxMetadata,
  type PersistedToolModelUsage,
} from "@/common/types/message";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { normalizeUsageModelKey } from "@/common/utils/providers/modelEntries";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import type { Logger } from "@/node/services/log";
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
  attributionModel(model: string, metadataModel: string | undefined): string {
    return model.startsWith("coder:") && metadataModel
      ? metadataModel
      : normalizeUsageModelKey(model, this.deps.getProvidersConfig());
  }
}
