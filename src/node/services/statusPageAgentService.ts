/**
 * Status page agent queue (experiment: artifacts-status-page-agent, under Artifacts and Agent
 * interface view).
 *
 * The main agent's status_update tool hands short updates to enqueue(), which returns at once.
 * Per workspace, one background drain at a time runs the status_page agent (runStatusPageAgent)
 * over ALL updates pending when the pass starts, so updates that arrive during a run are batched
 * into the next one. A pass reads status.html, lets the agent edit an in-memory draft with the
 * model the user picked in Settings > Agents > Status Page (falling back to the main agent's
 * model), and writes the page back once when it changed.
 *
 * Failures never reach the main agent's turn: they are logged and kept as the workspace's last
 * error, which the next enqueue() returns once so the main agent can take over the page. Updates
 * dropped unapplied (queue caps, a pass cut short by a closed gate, discard()) are counted and
 * reported the same way, so the main agent knows to repeat what still matters.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { assert } from "@/common/utils/assert";
import { buildProviderOptions, buildRequestHeaders } from "@/common/utils/ai/providerOptions";
import {
  AGENT_INTERFACE_STATUS_ARTIFACT,
  STATUS_PAGE_AGENT_MAX_PAGE_BYTES,
  STATUS_PAGE_AGENT_MAX_PENDING_CHARS,
  STATUS_PAGE_AGENT_MAX_PENDING_UPDATES,
  STATUS_PAGE_AGENT_RUN_TIMEOUT_MS,
} from "@/common/constants/artifacts";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getErrorMessage } from "@/common/utils/errors";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import type { ProjectsConfig } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { resolveAgentEnabledOverride } from "./agentDefinitions/agentEnablement";
import { AGENT_INTERFACE_STATUS_TEMPLATE } from "./agentInterfaceStatusPage";
import {
  type AvailableArtifactsLocation,
  readArtifactBytesAtLocation,
  resolveArtifactsLocation,
  writeArtifactAtLocation,
} from "./artifactsOperations";
import { log } from "./log";
import type { PinnedModelOptions } from "./providerModelFactory";
import {
  resolveHeadlessAgentBody,
  resolveHeadlessAgentSettings,
} from "./memoryConsolidationService";
import type { SessionUsageService } from "./sessionUsageService";
import {
  runStatusPageAgent,
  type StatusPageProviderOptions,
  type StatusPageUpdate,
} from "./statusPageAgent";

export const STATUS_PAGE_AGENT_ID = "status_page";
export const STATUS_PAGE_AGENT_ANALYTICS_SOURCE = "status_page_agent";

type StatusPageWorkspaceMetadata = Parameters<typeof resolveArtifactsLocation>[2] &
  Partial<Pick<FrontendWorkspaceMetadata, "archivedAt" | "unarchivedAt">>;

/**
 * AIService.createModelWithPinnedOptions: usage is attributed to the pricing identity the model
 * was created for, and the request options follow the route it was created on, not a
 * re-resolution that a Coder catalog refresh can change.
 */
interface StatusPageModelFactory {
  createModelWithPinnedOptions(
    modelString: string,
    opts?: { agentInitiated?: boolean; workspaceId?: string; thinkingLevel?: "off" }
  ): Promise<
    Result<
      Pick<
        PinnedModelOptions,
        | "model"
        | "metadataModel"
        | "optionsModelString"
        | "optionsProvidersConfig"
        | "optionsMuxProviderOptions"
        | "optionsRouteProvider"
      >,
      { type: string }
    >
  >;
}

export interface StatusPageAgentServiceDeps {
  config: Config;
  isExperimentEnabled: (experimentId: ExperimentId) => boolean;
  getWorkspaceMetadata: (workspaceId: string) => Promise<StatusPageWorkspaceMetadata | null>;
  /** True while the workspace is being removed or archived; checked again before the write. */
  isWorkspaceRemoving: (workspaceId: string) => boolean;
  modelFactory: StatusPageModelFactory;
  sessionUsageService?: Pick<SessionUsageService, "recordHeadlessUsage">;
  /** Headless usage reaches dashboard totals only through an ingest pass. */
  requestAnalyticsIngest?: (workspaceId: string) => void;
}

/** What the status_update tool hands over: the update and the main agent's model string. */
export interface StatusPageEnqueueInput {
  update: string;
  /** Used when no Status Page model is configured (the workspace's model this turn). */
  fallbackModel: string;
}

export interface StatusPageEnqueueResult {
  queued: true;
  /** The last failed pass's error, returned once. */
  previousError?: string;
  /** How many earlier updates were dropped without being applied, returned once. */
  discardedUpdates?: number;
}

/** The narrow surface the status_update tool needs. */
export type StatusPageAgentQueue = Pick<StatusPageAgentService, "enqueue">;

/** What a pass did with its batch. */
type PassOutcome = "applied" | "discarded";

interface PendingBatch {
  updates: StatusPageUpdate[];
  fallbackModel: string;
}

/** The Enabled switch on the Settings > Agents > Status Page card (on unless switched off). */
export function isStatusPageAgentEnabledInSettings(cfg: ProjectsConfig): boolean {
  return resolveAgentEnabledOverride(cfg, STATUS_PAGE_AGENT_ID) !== false;
}

function isGone(metadata: StatusPageWorkspaceMetadata | null): boolean {
  // Archived workspaces stay listed; a write must not restart a stopped dedicated workspace.
  return metadata == null || isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt);
}

/** Keep the newest updates within both caps; the newest one is always kept. Returns the drop count. */
function trimPending(updates: StatusPageUpdate[]): number {
  let chars = updates.reduce((total, update) => total + update.text.length, 0);
  let dropped = 0;
  while (
    updates.length > 1 &&
    (updates.length > STATUS_PAGE_AGENT_MAX_PENDING_UPDATES ||
      chars > STATUS_PAGE_AGENT_MAX_PENDING_CHARS)
  ) {
    chars -= updates.shift()?.text.length ?? 0;
    dropped++;
  }
  return dropped;
}

export class StatusPageAgentService {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastError = new Map<string, string>();
  /** Updates of the last failed pass, applied with the next update instead of being lost. */
  private readonly failedUpdates = new Map<string, StatusPageUpdate[]>();
  /** Updates dropped without being applied since the last enqueue() reported them. */
  private readonly discarded = new Map<string, number>();
  /** Bumped by discard(), so a pass that was running then knows its batch went stale. */
  private readonly discardEpochs = new Map<string, number>();
  /** Aborts the running drain's model call (cancelInFlightPass). */
  private readonly cancels = new Map<string, AbortController>();

  constructor(private readonly deps: StatusPageAgentServiceDeps) {}

  /** Queue an update and return at once. Never throws and never waits for a pass. */
  enqueue(workspaceId: string, input: StatusPageEnqueueInput): StatusPageEnqueueResult {
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    const batch = this.pending.get(workspaceId) ?? { updates: [], fallbackModel: "" };
    batch.updates.push({ text: input.update, atMs: Date.now() });
    batch.fallbackModel = input.fallbackModel;
    this.countDiscarded(workspaceId, trimPending(batch.updates));
    this.pending.set(workspaceId, batch);
    if (!this.running.has(workspaceId)) this.startDrain(workspaceId);

    const result: StatusPageEnqueueResult = { queued: true };
    const previousError = this.lastError.get(workspaceId);
    if (previousError !== undefined) result.previousError = previousError;
    const discardedUpdates = this.discarded.get(workspaceId);
    if (discardedUpdates !== undefined) result.discardedUpdates = discardedUpdates;
    this.lastError.delete(workspaceId);
    this.discarded.delete(workspaceId);
    return result;
  }

  /**
   * Drop queued and failed updates and the last error: the main agent owns the page again (the
   * mode is off for its turn), so they are stale once the mode comes back. The drop is counted
   * so the first update after that says earlier ones were not applied. A running pass is not
   * stopped, but its batch is stale too: it writes nothing and, if it fails, stores no error or
   * updates to come back with (the gates alone would miss a mode switched on again by then).
   */
  discard(workspaceId: string): void {
    const queued =
      (this.pending.get(workspaceId)?.updates.length ?? 0) +
      (this.failedUpdates.get(workspaceId)?.length ?? 0);
    this.pending.delete(workspaceId);
    this.failedUpdates.delete(workspaceId);
    this.lastError.delete(workspaceId);
    this.countDiscarded(workspaceId, queued);
    // Only a running pass can go stale; startDrain drops the entry once its drain settles, so
    // idle workspaces keep none.
    if (this.running.has(workspaceId)) {
      this.discardEpochs.set(workspaceId, this.discardEpoch(workspaceId) + 1);
    }
  }

  /**
   * Workspace removal: abort a running pass and wait for it, so no model call or usage record
   * outlives the removal (it reads the usage once and deletes the session dir), then forget the
   * workspace. Never rejects.
   */
  async cancelInFlightPass(workspaceId: string): Promise<void> {
    this.pending.delete(workspaceId);
    this.cancels.get(workspaceId)?.abort();
    await this.whenIdle(workspaceId);
    this.failedUpdates.delete(workspaceId);
    this.lastError.delete(workspaceId);
    this.discarded.delete(workspaceId);
  }

  private discardEpoch(workspaceId: string): number {
    return this.discardEpochs.get(workspaceId) ?? 0;
  }

  private countDiscarded(workspaceId: string, count: number): void {
    if (count > 0) this.discarded.set(workspaceId, (this.discarded.get(workspaceId) ?? 0) + count);
  }

  /** Resolves once no pass is running for the workspace (tests and shutdown). */
  async whenIdle(workspaceId: string): Promise<void> {
    while (this.running.has(workspaceId)) {
      await this.running.get(workspaceId);
    }
  }

  private startDrain(workspaceId: string): void {
    const cancel = new AbortController();
    this.cancels.set(workspaceId, cancel);
    const run = this.drain(workspaceId, cancel.signal).finally(() => {
      this.running.delete(workspaceId);
      this.cancels.delete(workspaceId);
      this.discardEpochs.delete(workspaceId);
      // An update that landed after the drain's last check but before this callback.
      if (this.pending.has(workspaceId)) this.startDrain(workspaceId);
    });
    this.running.set(workspaceId, run);
  }

  private async drain(workspaceId: string, cancelSignal: AbortSignal): Promise<void> {
    while (!cancelSignal.aborted) {
      const batch = this.takeBatch(workspaceId);
      if (batch === undefined) return;
      const epoch = this.discardEpoch(workspaceId);
      try {
        if ((await this.runPass(workspaceId, batch, epoch, cancelSignal)) === "discarded") {
          this.countDiscarded(workspaceId, batch.updates.length);
        }
        // A later pass recovered the page (or the gate closed): the main agent must not be told
        // to take over.
        this.lastError.delete(workspaceId);
      } catch (error) {
        // Workspace removal (cancelInFlightPass) forgets the workspace anyway.
        if (cancelSignal.aborted) return;
        if (this.discardEpoch(workspaceId) !== epoch) {
          // discard() ran during the pass: this failure is as stale as the batch.
          this.countDiscarded(workspaceId, batch.updates.length);
          continue;
        }
        const message = getErrorMessage(error);
        log.warn("Status page agent pass failed", {
          workspaceId,
          updates: batch.updates.length,
          error: message,
        });
        this.lastError.set(workspaceId, message);
        // Not retried at once (a broken model would loop); they ride along with the next update.
        this.failedUpdates.set(workspaceId, batch.updates);
      }
    }
  }

  /** The pending batch, preceded by the updates of a failed pass, within the queue caps. */
  private takeBatch(workspaceId: string): PendingBatch | undefined {
    const batch = this.pending.get(workspaceId);
    if (batch === undefined) return undefined;
    this.pending.delete(workspaceId);
    const carried = this.failedUpdates.get(workspaceId);
    if (carried !== undefined) {
      this.failedUpdates.delete(workspaceId);
      batch.updates.unshift(...carried);
      this.countDiscarded(workspaceId, trimPending(batch.updates));
    }
    return batch;
  }

  private isActive(): boolean {
    return (
      this.deps.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS) &&
      this.deps.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE) &&
      this.deps.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT) &&
      isStatusPageAgentEnabledInSettings(this.deps.config.loadConfigOrDefault())
    );
  }

  /** The workspace's metadata while a pass may touch it, else null. */
  private async writableMetadata(workspaceId: string): Promise<StatusPageWorkspaceMetadata | null> {
    if (!this.isActive() || this.deps.isWorkspaceRemoving(workspaceId)) return null;
    const metadata = await this.deps.getWorkspaceMetadata(workspaceId);
    return isGone(metadata) ? null : metadata;
  }

  /**
   * One pass over a batch. Throws on failure; drain() keeps the error for the next enqueue.
   * "discarded" when a closed gate or a discard() since `epoch` cut the pass short before its
   * draft was written.
   */
  private async runPass(
    workspaceId: string,
    batch: PendingBatch,
    epoch: number,
    cancelSignal: AbortSignal
  ): Promise<PassOutcome> {
    const metadata = await this.writableMetadata(workspaceId);
    if (metadata == null) return "discarded";

    const abortSignal = AbortSignal.any([
      cancelSignal,
      AbortSignal.timeout(STATUS_PAGE_AGENT_RUN_TIMEOUT_MS),
    ]);
    const location = await resolveArtifactsLocation(
      this.deps.config.sessionsDir,
      workspaceId,
      metadata,
      { abortSignal }
    );
    if (location.kind === "unavailable") {
      throw new Error(`artifacts are unavailable: ${location.reason}`);
    }
    const currentPage = await readCurrentPage(location, abortSignal);
    const agent = await this.resolveAgent(workspaceId, batch.fallbackModel);

    const result = await runStatusPageAgent({
      model: agent.model,
      providerOptions: agent.providerOptions,
      headers: agent.headers,
      pricingModel: agent.metadataModel,
      agentBody: agent.body,
      currentPage,
      updates: batch.updates,
      abortSignal,
      recordUsage: this.usageRecorder(workspaceId, agent.modelString, agent.metadataModel),
    });
    if (result.streamError !== undefined) {
      throw new Error(`${agent.modelString}: ${result.streamError}`);
    }
    // The run took a while: the user may have switched the experiments off or archived or
    // removed the workspace meanwhile. The writers also refuse to recreate a deleted scratch or
    // session dir, which covers a removal that finishes between this check and the write.
    if (
      (await this.writableMetadata(workspaceId)) == null ||
      this.discardEpoch(workspaceId) !== epoch
    ) {
      return "discarded";
    }
    // Each update reports something new, so an unchanged page means the agent did not apply
    // them (it only replied, or every edit failed): retry them and tell the main agent.
    if (result.page === null) {
      throw new Error("the status page agent left the page unchanged");
    }
    // Someone (often the main agent, after a failure note) edited the page during the run: keep
    // that edit, and let the next pass apply these updates on top of it. Not a lock: an edit
    // between this read and the write below can still be lost.
    if ((await readCurrentPage(location, abortSignal)) !== currentPage) {
      throw new Error(
        `${AGENT_INTERFACE_STATUS_ARTIFACT} changed while the status page agent ran, so its draft was dropped to keep that edit`
      );
    }
    await writeArtifactAtLocation(location, AGENT_INTERFACE_STATUS_ARTIFACT, result.page, {
      abortSignal,
    });
    log.debug("Status page agent updated the page", {
      workspaceId,
      model: agent.modelString,
      updates: batch.updates.length,
      summary: result.summary,
    });
    return "applied";
  }

  /**
   * The status_page body and model: the Settings > Agents > Status Page choice (or a workspace
   * override), else the main agent's model this turn.
   */
  private async resolveAgent(workspaceId: string, fallbackModel: string) {
    const body = await resolveHeadlessAgentBody(this.deps.config.rootDir, STATUS_PAGE_AGENT_ID);
    if (body === null) throw new Error("status_page agent definition is missing");
    const modelString = resolveHeadlessAgentSettings(
      this.deps.config,
      workspaceId,
      STATUS_PAGE_AGENT_ID,
      fallbackModel
    ).model;
    const created = await this.deps.modelFactory.createModelWithPinnedOptions(modelString, {
      agentInitiated: true,
      workspaceId,
      thinkingLevel: "off",
    });
    if (!created.success) {
      throw new Error(`could not create model ${modelString}: ${created.error.type}`);
    }
    const pinned = created.data;
    // Thinking off as far as the model allows (its card has no reasoning control). A request
    // without options would get the provider's default, which is on for some models.
    const thinkingLevel = enforceThinkingPolicy(
      pinned.optionsModelString,
      "off",
      undefined,
      pinned.optionsProvidersConfig
    );
    const providerOptions = buildProviderOptions(
      pinned.optionsModelString,
      thinkingLevel,
      undefined,
      undefined,
      pinned.optionsMuxProviderOptions,
      workspaceId,
      undefined,
      pinned.optionsProvidersConfig,
      pinned.optionsRouteProvider
    ) as StatusPageProviderOptions;
    const headers = buildRequestHeaders(
      pinned.optionsModelString,
      pinned.optionsMuxProviderOptions,
      workspaceId,
      pinned.optionsProvidersConfig,
      pinned.optionsRouteProvider
    );
    return {
      body,
      modelString,
      model: pinned.model,
      metadataModel: pinned.metadataModel,
      providerOptions,
      headers,
    };
  }

  private usageRecorder(workspaceId: string, modelString: string, metadataModel: string) {
    return async (usage: LanguageModelV2Usage, providerMetadata?: Record<string, unknown>) => {
      const recorded = await this.deps.sessionUsageService?.recordHeadlessUsage(
        workspaceId,
        modelString,
        usage,
        providerMetadata,
        // Creation-time identity: a catalog refresh mid-run must not re-attribute this spend.
        { analyticsSource: STATUS_PAGE_AGENT_ANALYTICS_SOURCE, metadataModel }
      );
      if (recorded) this.deps.requestAnalyticsIngest?.(workspaceId);
    };
  }
}

async function readCurrentPage(
  location: AvailableArtifactsLocation,
  abortSignal: AbortSignal
): Promise<string> {
  const read = await readArtifactBytesAtLocation(
    location,
    AGENT_INTERFACE_STATUS_ARTIFACT,
    STATUS_PAGE_AGENT_MAX_PAGE_BYTES,
    abortSignal
  );
  switch (read.status) {
    case "ok":
      return read.bytes.toString("utf8");
    case "missing":
      // The turn seeds the page, but it may have been deleted since; start from the template.
      return AGENT_INTERFACE_STATUS_TEMPLATE;
    case "too_large":
      throw new Error(
        `${AGENT_INTERFACE_STATUS_ARTIFACT} is ${read.size} bytes, over the ${STATUS_PAGE_AGENT_MAX_PAGE_BYTES}-byte limit`
      );
    case "invalid":
      throw new Error(`could not read ${AGENT_INTERFACE_STATUS_ARTIFACT}: ${read.error}`);
  }
}
