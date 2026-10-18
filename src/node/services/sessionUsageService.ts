import * as path from "path";
import * as fs from "fs/promises";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { isWorkspaceRemovalTombstoned } from "@/node/services/workspaceRemoval";
import { withTargetMutationLock } from "@/node/services/refinement/targetMutationLocks";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import type { ChatUsageDisplay, LongContextTokens } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getAssistantMessageModelUsages } from "@/common/utils/tokens/messageModelUsages";
import {
  normalizeUsage,
  withCacheWriteMetadata,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";
import type { RolledUpChildEntry } from "@/common/orpc/schemas/chatStats";
import { SessionUsageTokenStatsCacheSchema } from "@/common/orpc/schemas/chatStats";
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

  version: 1;
}

/**
 * Service for managing cumulative session usage tracking.
 *
 * Replaces O(n) message iteration with a persistent JSON file that stores
 * per-model usage breakdowns. Usage is accumulated on stream-end, never
 * subtracted, making costs immune to message deletion. The file also holds
 * running streams' usage, step by step (recordInFlightUsage), so a long turn
 * shows its spend and a crash or restart loses at most the unfinished step.
 * In-process readers (getSessionUsage) still see only settled usage.
 */
/** A running stream's priced cumulative usage, already added to its byModel bucket. */
interface InFlightUsage {
  model: string;
  usage: ChatUsageDisplay;
}

const USAGE_COMPONENTS = ["input", "cached", "cacheCreate", "output", "reasoning"] as const;

function subtractLongContextTokens(
  total: LongContextTokens,
  part: LongContextTokens
): LongContextTokens {
  const minus = (a: number, b: number) => Math.max(0, a - b);
  return {
    input: minus(total.input, part.input),
    cached: minus(total.cached, part.cached),
    cacheCreate: minus(total.cacheCreate, part.cacheCreate),
    cacheCreate1h: minus(total.cacheCreate1h, part.cacheCreate1h),
    output: minus(total.output, part.output),
  };
}

/** An unpriced part added no cost to the total; an unpriced total stays unpriced. */
function subtractCost(total: number | undefined, part: number | undefined): number | undefined {
  return total === undefined || part === undefined ? total : total - part;
}

/**
 * `total` minus `part`, where `part` was earlier summed into `total` with sumUsageHistory.
 * Keeps total's flags (unknown costs, gateway billing, tier): the remaining entries carry them too.
 */
function subtractUsage(total: ChatUsageDisplay, part: ChatUsageDisplay): ChatUsageDisplay {
  const result: ChatUsageDisplay = { ...total };
  for (const key of USAGE_COMPONENTS) {
    result[key] = {
      tokens: total[key].tokens - part[key].tokens,
      cost_usd: subtractCost(total[key].cost_usd, part[key].cost_usd),
    };
  }
  const cacheCreate1hTokens = (total.cacheCreate1hTokens ?? 0) - (part.cacheCreate1hTokens ?? 0);
  if (cacheCreate1hTokens > 0) {
    result.cacheCreate1hTokens = cacheCreate1hTokens;
  } else {
    delete result.cacheCreate1hTokens;
  }
  if (total.longContextTokens && part.longContextTokens) {
    result.longContextTokens = subtractLongContextTokens(
      total.longContextTokens,
      part.longContextTokens
    );
  }
  return result;
}

/** No tokens and no cost: zero-token rows can still carry exact billed cost (xAI). */
function isEmptyUsage(usage: ChatUsageDisplay): boolean {
  return USAGE_COMPONENTS.every(
    (key) => usage[key].tokens === 0 && Math.abs(usage[key].cost_usd ?? 0) < 1e-12
  );
}

/**
 * True when summing `entry` into `bucket` keeps the bucket's pricing flags. Subtraction
 * cannot undo merged flags (e.g. one gateway-billed entry marks the whole bucket
 * costsIncluded), so an in-flight entry is only written into a bucket it cannot re-flag.
 */
function keepsUsageFlags(bucket: ChatUsageDisplay | undefined, entry: ChatUsageDisplay): boolean {
  return (
    bucket === undefined ||
    ((bucket.costsIncluded === true) === (entry.costsIncluded === true) &&
      (bucket.hasUnknownCosts === true) === (entry.hasUnknownCosts === true) &&
      bucket.serviceTier === entry.serviceTier)
  );
}

/** Adds (or, with "subtract", removes) one in-flight entry in `file`'s byModel. */
function applyInFlightUsage(
  file: SessionUsageFile,
  entry: InFlightUsage,
  direction: "add" | "subtract"
): void {
  const existing = file.byModel[entry.model];
  if (direction === "add") {
    file.byModel[entry.model] = existing
      ? (sumUsageHistory([existing, entry.usage]) ?? entry.usage)
      : entry.usage;
    return;
  }
  if (!existing) {
    return;
  }
  const remaining = subtractUsage(existing, entry.usage);
  // A bucket that only ever held this stream's usage leaves no empty model row behind.
  if (isEmptyUsage(remaining)) {
    delete file.byModel[entry.model];
  } else {
    file.byModel[entry.model] = remaining;
  }
}

export class SessionUsageService {
  private readonly SESSION_USAGE_FILE = "session-usage.json";
  private readonly fileLocks = workspaceFileLocks;
  /**
   * workspaceId → streamId → usage of running streams that session-usage.json already
   * holds (recordInFlightUsage). In memory only: after a restart the file keeps that
   * usage as the dead stream's spend, which is the point.
   */
  private readonly inFlightUsage = new Map<string, Map<string, InFlightUsage>>();
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly getProvidersConfig: () => ProvidersConfigMap | null;

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

  private createEmptyUsageFile(): SessionUsageFile {
    return { byModel: {}, version: 1 };
  }

  private async readFile(workspaceId: string): Promise<SessionUsageFile> {
    try {
      const data = await fs.readFile(this.getFilePath(workspaceId), "utf-8");
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
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
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
       * This is the final usage of a stream that recorded in-flight usage: replace that
       * entry in the same write, so the stream counts exactly once.
       */
      settlesInFlightStreamId?: string;
    }
  ): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readFile(workspaceId);
      const streamId = options?.settlesInFlightStreamId;
      const inFlight =
        streamId === undefined ? undefined : this.inFlightUsage.get(workspaceId)?.get(streamId);
      if (inFlight) {
        applyInFlightUsage(current, inFlight, "subtract");
      }
      // CRITICAL: Accumulate, don't overwrite
      applyInFlightUsage(current, { model, usage }, "add");
      if (options?.skipLastRequestUpdate !== true) {
        current.lastRequest = { model, usage, timestamp: Date.now() };
      }
      await this.writeFile(workspaceId, current);
      if (streamId !== undefined) {
        this.deleteInFlightEntry(workspaceId, streamId);
      }
    });
  }

  /**
   * Record a running stream's priced cumulative usage so far, replacing the stream's
   * previous in-flight entry. Before this, the file changed only when a stream ended:
   * a long turn read $0 for its whole run and a restart lost all of its spend.
   * The stream ends by passing `settlesInFlightStreamId` to recordUsage, or by
   * discardInFlightUsage when its usage is not recorded at all.
   */
  async recordInFlightUsage(
    workspaceId: string,
    streamId: string,
    model: string,
    usage: ChatUsageDisplay
  ): Promise<void> {
    assert(streamId.length > 0, "recordInFlightUsage requires a streamId");
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readFile(workspaceId);
      const previous = this.inFlightUsage.get(workspaceId)?.get(streamId);
      if (previous) {
        applyInFlightUsage(current, previous, "subtract");
      }
      const next = { model, usage };
      // A mixed-flag bucket keeps the old behavior: the stream counts only when it settles.
      const writesNext = keepsUsageFlags(current.byModel[model], usage);
      if (writesNext) {
        applyInFlightUsage(current, next, "add");
      }
      await this.writeFile(workspaceId, current);
      // Only after the write: the map must always describe what the file holds.
      this.deleteInFlightEntry(workspaceId, streamId);
      if (writesNext) {
        this.setInFlightEntry(workspaceId, streamId, next);
      }
    });
  }

  private setInFlightEntry(workspaceId: string, streamId: string, entry: InFlightUsage): void {
    let streams = this.inFlightUsage.get(workspaceId);
    if (!streams) {
      streams = new Map();
      this.inFlightUsage.set(workspaceId, streams);
    }
    streams.set(streamId, entry);
  }

  /** Remove a stream's in-flight usage from the file (the stream records no usage). */
  async discardInFlightUsage(workspaceId: string, streamId: string): Promise<void> {
    if (!this.inFlightUsage.get(workspaceId)?.has(streamId)) {
      return;
    }
    return this.fileLocks.withLock(workspaceId, async () => {
      const inFlight = this.inFlightUsage.get(workspaceId)?.get(streamId);
      if (!inFlight) {
        return;
      }
      const current = await this.readFile(workspaceId);
      applyInFlightUsage(current, inFlight, "subtract");
      await this.writeFile(workspaceId, current);
      this.deleteInFlightEntry(workspaceId, streamId);
    });
  }

  /**
   * Keep a stream's in-flight usage in the file as settled spend (its final write failed):
   * forget it in memory only, so getSessionUsage stops subtracting it.
   */
  releaseInFlightUsage(workspaceId: string, streamId: string): void {
    this.deleteInFlightEntry(workspaceId, streamId);
  }

  private deleteInFlightEntry(workspaceId: string, streamId: string): void {
    const streams = this.inFlightUsage.get(workspaceId);
    streams?.delete(streamId);
    if (streams?.size === 0) {
      this.inFlightUsage.delete(workspaceId);
    }
  }

  private addInFlightUsage(workspaceId: string, file: SessionUsageFile): void {
    for (const inFlight of this.inFlightUsage.get(workspaceId)?.values() ?? []) {
      applyInFlightUsage(file, inFlight, "add");
    }
  }

  /**
   * The file minus running streams' in-flight usage. The Costs tab adds the live stream
   * on top of this view (and its own copy at stream end), so it must exclude that stream.
   */
  private withoutInFlightUsage(workspaceId: string, file: SessionUsageFile): SessionUsageFile {
    const streams = this.inFlightUsage.get(workspaceId);
    if (!streams) {
      return file;
    }
    const settled: SessionUsageFile = { ...file, byModel: { ...file.byModel } };
    for (const inFlight of streams.values()) {
      applyInFlightUsage(settled, inFlight, "subtract");
    }
    return settled;
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
          if (await isWorkspaceRemovalTombstoned(this.config.rootDir, workspaceId)) {
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
        }
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
        await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
        await fs.appendFile(sidecarPath, `${line}\n`);
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
          await this.rebuildFromMessagesInternal(workspaceId, messages);
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
      const raw = await fs.readFile(this.getFilePath(workspaceId), "utf-8");
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
          await this.rebuildFromMessagesInternal(parentWorkspaceId, messages);
          current = await this.readFile(parentWorkspaceId);
        } else {
          current = this.createEmptyUsageFile();
        }
      }

      if (current.rolledUpFrom?.[childWorkspaceId]) {
        return { didRollUp: false };
      }

      for (const [model, usage] of entries) {
        const existing = current.byModel[model];
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        current.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
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
   * Read current session usage. Returns undefined if file missing/corrupted
   * and no messages to rebuild from.
   */
  async getSessionUsage(workspaceId: string): Promise<SessionUsageFile | undefined> {
    return this.fileLocks.withLock(workspaceId, async () => {
      try {
        const filePath = this.getFilePath(workspaceId);
        const data = await fs.readFile(filePath, "utf-8");
        return this.withoutInFlightUsage(workspaceId, JSON.parse(data) as SessionUsageFile);
      } catch (error) {
        // File missing or corrupted - try to rebuild from messages
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          const messages = await this.collectFullHistory(workspaceId);
          if (messages.length > 0) {
            await this.rebuildFromMessagesInternal(workspaceId, messages);
            return this.withoutInFlightUsage(workspaceId, await this.readFile(workspaceId));
          }
          return undefined; // Truly empty session
        }
        // Parse error - try rebuild
        log.warn(`session-usage.json corrupted for ${workspaceId}, rebuilding`);
        const messages = await this.collectFullHistory(workspaceId);
        if (messages.length > 0) {
          await this.rebuildFromMessagesInternal(workspaceId, messages);
          return this.withoutInFlightUsage(workspaceId, await this.readFile(workspaceId));
        }
        return undefined;
      }
    });
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
      // The new file holds no in-flight usage to subtract later.
      this.inFlightUsage.delete(workspaceId);
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
        try {
          const filePath = this.getFilePath(workspaceId);
          const data = await fs.readFile(filePath, "utf-8");
          results[workspaceId] = this.withoutInFlightUsage(
            workspaceId,
            JSON.parse(data) as SessionUsageFile
          );
        } catch {
          results[workspaceId] = undefined;
        }
      })
    );
    return results;
  }

  /**
   * Rebuild session usage from messages (for migration/recovery).
   * Internal version - called within lock.
   */
  private async rebuildFromMessagesInternal(
    workspaceId: string,
    messages: MuxMessage[]
  ): Promise<void> {
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
      const model = usageBucketKey(rawModel, metadataModel);
      const existing = result.byModel[model];
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      result.byModel[model] = existing ? sumUsageHistory([existing, usage])! : usage;
    };

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

    // History does not hold running streams yet: put their in-flight usage back, or a crash
    // before their next step would lose it.
    this.addInFlightUsage(workspaceId, result);
    await this.writeFile(workspaceId, result);
    log.info(`Rebuilt session-usage.json for ${workspaceId} from ${messages.length} messages`);
  }

  /**
   * Public rebuild method (acquires lock).
   */
  async rebuildFromMessages(workspaceId: string, messages: MuxMessage[]): Promise<void> {
    return this.fileLocks.withLock(workspaceId, async () => {
      await this.rebuildFromMessagesInternal(workspaceId, messages);
    });
  }
}
