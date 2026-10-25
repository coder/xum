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
 * error, which the next enqueue() returns once so the main agent can take over the page.
 */
import type { LanguageModel } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { assert } from "@/common/utils/assert";
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
import type { Result } from "@/common/types/result";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { Config } from "@/node/config";
import { AGENT_INTERFACE_STATUS_TEMPLATE } from "./agentInterfaceStatusPage";
import {
  type AvailableArtifactsLocation,
  readArtifactBytesAtLocation,
  resolveArtifactsLocation,
  writeArtifactAtLocation,
} from "./artifactsOperations";
import { log } from "./log";
import {
  resolveHeadlessAgentBody,
  resolveHeadlessAgentSettings,
} from "./memoryConsolidationService";
import type { SessionUsageService } from "./sessionUsageService";
import { runStatusPageAgent, type StatusPageUpdate } from "./statusPageAgent";

export const STATUS_PAGE_AGENT_ID = "status_page";
export const STATUS_PAGE_AGENT_ANALYTICS_SOURCE = "status_page_agent";

type StatusPageWorkspaceMetadata = Parameters<typeof resolveArtifactsLocation>[2] &
  Partial<Pick<FrontendWorkspaceMetadata, "archivedAt" | "unarchivedAt">>;

/**
 * AIService.createModelWithPinnedMetadata: usage is attributed to the pricing identity the model
 * was created for, not to a re-resolution that a Coder catalog refresh can change.
 */
interface StatusPageModelFactory {
  createModelWithPinnedMetadata(
    modelString: string,
    opts?: { agentInitiated?: boolean; workspaceId?: string }
  ): Promise<Result<{ model: LanguageModel; metadataModel: string }, { type: string }>>;
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
}

/** The narrow surface the status_update tool needs. */
export type StatusPageAgentQueue = Pick<StatusPageAgentService, "enqueue">;

interface PendingBatch {
  updates: StatusPageUpdate[];
  fallbackModel: string;
}

function isGone(metadata: StatusPageWorkspaceMetadata | null): boolean {
  // Archived workspaces stay listed; a write must not restart a stopped dedicated workspace.
  return metadata == null || isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt);
}

/** Keep the newest updates within both caps; the newest one is always kept. */
function trimPending(updates: StatusPageUpdate[]): void {
  let chars = updates.reduce((total, update) => total + update.text.length, 0);
  while (
    updates.length > 1 &&
    (updates.length > STATUS_PAGE_AGENT_MAX_PENDING_UPDATES ||
      chars > STATUS_PAGE_AGENT_MAX_PENDING_CHARS)
  ) {
    chars -= updates.shift()?.text.length ?? 0;
  }
}

export class StatusPageAgentService {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastError = new Map<string, string>();

  constructor(private readonly deps: StatusPageAgentServiceDeps) {}

  /** Queue an update and return at once. Never throws and never waits for a pass. */
  enqueue(workspaceId: string, input: StatusPageEnqueueInput): StatusPageEnqueueResult {
    assert(workspaceId.length > 0, "workspaceId must not be empty");
    const batch = this.pending.get(workspaceId) ?? { updates: [], fallbackModel: "" };
    batch.updates.push({ text: input.update, atMs: Date.now() });
    batch.fallbackModel = input.fallbackModel;
    trimPending(batch.updates);
    this.pending.set(workspaceId, batch);
    if (!this.running.has(workspaceId)) this.startDrain(workspaceId);

    const previousError = this.lastError.get(workspaceId);
    if (previousError === undefined) return { queued: true };
    this.lastError.delete(workspaceId);
    return { queued: true, previousError };
  }

  /** Resolves once no pass is running for the workspace (tests and shutdown). */
  async whenIdle(workspaceId: string): Promise<void> {
    while (this.running.has(workspaceId)) {
      await this.running.get(workspaceId);
    }
  }

  private startDrain(workspaceId: string): void {
    const run = this.drain(workspaceId).finally(() => {
      this.running.delete(workspaceId);
      // An update that landed after the drain's last check but before this callback.
      if (this.pending.has(workspaceId)) this.startDrain(workspaceId);
    });
    this.running.set(workspaceId, run);
  }

  private async drain(workspaceId: string): Promise<void> {
    for (;;) {
      const batch = this.pending.get(workspaceId);
      if (batch === undefined) return;
      this.pending.delete(workspaceId);
      try {
        await this.runPass(workspaceId, batch);
      } catch (error) {
        const message = getErrorMessage(error);
        log.warn("Status page agent pass failed", {
          workspaceId,
          updates: batch.updates.length,
          error: message,
        });
        this.lastError.set(workspaceId, message);
      }
    }
  }

  private isActive(): boolean {
    return (
      this.deps.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS) &&
      this.deps.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE) &&
      this.deps.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS_STATUS_PAGE_AGENT)
    );
  }

  /** The workspace's metadata while a pass may touch it, else null. */
  private async writableMetadata(workspaceId: string): Promise<StatusPageWorkspaceMetadata | null> {
    if (!this.isActive() || this.deps.isWorkspaceRemoving(workspaceId)) return null;
    const metadata = await this.deps.getWorkspaceMetadata(workspaceId);
    return isGone(metadata) ? null : metadata;
  }

  /** One pass over a batch. Throws on failure; drain() keeps the error for the next enqueue. */
  private async runPass(workspaceId: string, batch: PendingBatch): Promise<void> {
    const metadata = await this.writableMetadata(workspaceId);
    if (metadata == null) return;

    const abortSignal = AbortSignal.timeout(STATUS_PAGE_AGENT_RUN_TIMEOUT_MS);
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
    if (result.page === null) return;
    // The run took a while: the user may have switched the experiments off or archived or
    // removed the workspace meanwhile. The writers also refuse to recreate a deleted scratch or
    // session dir, which covers a removal that finishes between this check and the write.
    if ((await this.writableMetadata(workspaceId)) == null) return;
    await writeArtifactAtLocation(location, AGENT_INTERFACE_STATUS_ARTIFACT, result.page, {
      abortSignal,
    });
    log.debug("Status page agent updated the page", {
      workspaceId,
      model: agent.modelString,
      updates: batch.updates.length,
      summary: result.summary,
    });
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
    const created = await this.deps.modelFactory.createModelWithPinnedMetadata(modelString, {
      agentInitiated: true,
      workspaceId,
    });
    if (!created.success) {
      throw new Error(`could not create model ${modelString}: ${created.error.type}`);
    }
    return { body, modelString, ...created.data };
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
