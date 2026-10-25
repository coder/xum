/**
 * Scenarios for sessionLocks.callOptions.test.ts. Each one drives real code
 * through the session lock calls that phase 4 moves behind SessionLocks, so
 * the call record sees each call with its options before and after the move.
 * They reuse the recipes of the tests that own each lock (named per scenario).
 */
import { mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { SESSION_MEMORY_DIR_NAME } from "@/common/constants/memory";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { Config } from "@/node/config";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService } from "@/node/services/memoryService";
import { RefineService } from "@/node/services/refinement/refineService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import { markRemotePlanMigratedForDeletion } from "@/node/utils/runtime/planLocation";
import type { AgentSessionAIService } from "../agentSession";
import { createAgentSessionHarness } from "../agentSession.testHarness";
import { recordArtifactVersion } from "../artifactVersionStore";
import {
  awaitPendingBranchSummary,
  startAbandonedBranchSummaryInBackground,
} from "../branchSummary";
import { InitStateManager } from "../initStateManager";
import { nodeSessionLocks } from "./nodeSessionLocks";
import { addPinnedPath } from "../pinnedArtifactFiles";
import { acquireRollbackFileLock } from "../refinement/refinementRollback";
import { SessionTimingService } from "../sessionTimingService";
import { SessionUsageService } from "../sessionUsageService";
import { upsertSubagentFailureArtifact } from "../subagentFailureArtifacts";
import { updateSubagentGitPatchArtifactsFile } from "../subagentGitPatchArtifacts";
import {
  updateSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
} from "../subagentReportArtifacts";
import { updateSubagentTranscriptArtifactsFile } from "../subagentTranscriptArtifacts";
import { TaskHandleStore } from "../taskHandleStore";
import { createTestConfig, createWorkspaceServiceMocks } from "../taskService.testHarness";
import { setTodosForSessionDir } from "../tools/todo";
import { createReviewPaneUpdateTool } from "../tools/review_pane";
import { createTestToolConfig, mockToolCallOptions } from "../tools/testHelpers";
import type { TelemetryService } from "../telemetryService";
import { createTestHistoryService } from "../testHistoryService";
import { WorkflowRunStore } from "../workflows/WorkflowRunStore";
import { WorkspaceGoalService } from "../workspaceGoalService";
import {
  createMockAIService,
  createWorkspaceServiceHarness,
} from "../workspaceService.testHarness";
import {
  createWorkspaceTurnManagerHarness,
  startWorkspaceTurnForTest,
} from "../workspaceTurnManager.testHarness";
import { removeSessionDirUnderMemoryLocks } from "../workspaceRemoval";
import { workspaceUseLeasesFor } from "../workspaceUseLeases";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";

/**
 * Each scenario names the temp roots and workspace ids that it creates, and
 * the memory target keys of the removal, so the record masks them by name.
 */
export interface LockNames {
  root(dir: string, label: string): void;
  id(workspaceId: string): void;
  target(key: string): void;
}

const sendOptions = { model: "openai:gpt-4o", agentId: "exec" };
const idle = { hasRunningBackgroundProcesses: () => Promise.resolve(false) };

let currentStep: string | undefined;

/**
 * The step of a scenario that makes the current lock calls, or undefined. The
 * record adds it to each row, so two lock calls of one file stay two rows.
 */
export function lockCallStep(): string | undefined {
  return currentStep;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  currentStep = name;
  try {
    return await fn();
  } finally {
    currentStep = undefined;
  }
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `xum-lock-record-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * One turn (agentSession.useLease.test.ts): the user row goes through the
 * history locks and the turn takes its use lease. The provider then fails.
 * Then the session-dir writes of the loop tools and the journal blob lock.
 */
export async function oneTurn(names: LockNames): Promise<void> {
  const workspaceId = "ws-record-turn";
  names.id(workspaceId);
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
    Promise.resolve(Err({ type: "unknown", raw: "provider down" }))
  );
  const b = await createAgentSessionHarness({ workspaceId, aiServiceOverrides: { streamMessage } });
  names.root(b.config.rootDir, "turn");
  try {
    await b.session.sendMessage("hello", sendOptions);
    const sessionDir = path.join(b.config.sessionsDir, workspaceId);
    await setTodosForSessionDir(
      workspaceId,
      sessionDir,
      [{ content: "Record the locks", status: "in_progress" }],
      nodeSessionLocks,
      nodeSessionFiles
    );
    const reviewPane = createReviewPaneUpdateTool(
      createTestToolConfig(b.config.sessionsDir, {
        workspaceId,
        sessionsDir: b.config.sessionsDir,
      })
    );
    await reviewPane.execute!(
      { operation: "replace", hunks: [{ path: "src/a.ts:1-2", comment: "look" }] },
      mockToolCallOptions
    );
    await new DurableEventJournal(sessionDir).withBlobLock(() => Promise.resolve());
  } finally {
    await b.session.dispose();
    await b.cleanup();
  }
}

/**
 * Refusals: a send while another backend holds the mutation gate
 * (agentSession.useLease.test.ts), and a turn handle that another live
 * backend owns (workspaceTurnManager.foreignOwner.test.ts).
 */
export async function oneRefusal(names: LockNames): Promise<void> {
  const workspaceId = "ws-record-refusal";
  names.id(workspaceId);
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
    Promise.resolve(Err({ type: "unknown", raw: "must not be reached" }))
  );
  const b = await createAgentSessionHarness({ workspaceId, aiServiceOverrides: { streamMessage } });
  names.root(b.config.rootDir, "refusal");
  const leasesA = workspaceUseLeasesFor(await createTestConfig(b.config.rootDir));
  try {
    const finished = Promise.withResolvers<void>();
    const inside = Promise.withResolvers<void>();
    const mutation = leasesA.withMutationGate([workspaceId], idle, async () => {
      inside.resolve();
      await finished.promise;
    });
    await inside.promise;
    await b.session.sendMessage("blocked", sendOptions);
    finished.resolve();
    await mutation;
  } finally {
    await b.session.dispose();
    await b.cleanup();
  }

  await withTempDir("owner", async (rootDir) => {
    names.root(rootDir, "owner");
    await startWorkspaceTurnForTest(rootDir);
    // B refuses idle admission, so it only probes the owner lock (#4801).
    const { taskService: backendB } = createWorkspaceTurnManagerHarness(
      await createTestConfig(rootDir),
      {
        workspaceService: createWorkspaceServiceMocks({
          acquireIdleTurnExclusion: mock(() => Err(new Error("admission in flight"))),
        }).workspaceService,
      }
    );
    const internal = backendB as unknown as { countActiveWorkspaceTurns: () => Promise<number> };
    await internal.countActiveWorkspaceTurns();
  });
}

/** One removal (workspaceRemoval.test.ts): refine, target and history locks. */
export async function oneRemoval(names: LockNames): Promise<void> {
  await withTempDir("removal", async (dir) => {
    names.root(dir, "removal");
    const rootDir = path.join(dir, "xum-home");
    const workspaceId = "ws-record-removal";
    names.id(workspaceId);
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
    // The memory stores that removal locks (workspaceRemoval.ts), and the session dir.
    for (const key of ["", "memory", SESSION_MEMORY_DIR_NAME]) {
      names.target(path.join(sessionDir, key));
    }
    names.target(path.join(rootDir, "memory"));
    await fs.mkdir(sessionDir, { recursive: true });
    await removeSessionDirUnderMemoryLocks({
      rootDir,
      sessionDir,
      workspaceId,
      attemptId: "record-attempt",
    });
  });
}

function finishChunk(): LanguageModelV3StreamPart {
  return {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  };
}

/**
 * One refine pass and one apply (refineService.test.ts): the pass takes the
 * staging lock, and the apply takes the apply lock.
 */
export async function oneRefineApply(names: LockNames): Promise<void> {
  await withTempDir("refine", async (dir) => {
    names.root(dir, "refine-checkout");
    const workspaceId = "ws-record-refine";
    names.id(workspaceId);
    const workspacePath = path.join(dir, "checkout");
    await fs.mkdir(workspacePath, { recursive: true });
    // The shared HistoryService seam (AGENTS.md): its temp root is the Xum home here.
    const { historyService, config, tempDir: muxHome, cleanup } = await createTestHistoryService();
    names.root(muxHome, "refine");
    // The seeding runs inside the try, so a failed append or config edit
    // still removes the temp root of createTestHistoryService() (#7326 Finding 3).
    try {
      await fs.mkdir(path.join(muxHome, "memory"), { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.set("/projects/demo", {
          workspaces: [{ id: workspaceId, name: workspaceId, path: workspacePath }],
        });
        return cfg;
      });
      const metaService = new MemoryMetaService(muxHome);
      const model = new MockLanguageModelV3({
        doStream: () =>
          Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: "Nothing worth distilling." },
                { type: "text-end", id: "t1" },
                finishChunk(),
              ] satisfies LanguageModelV3StreamPart[],
            }),
          }),
      });
      const enabled = new Set<ExperimentId>([
        EXPERIMENT_IDS.RLM,
        EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
      ]);
      const service = new RefineService(
        config,
        new MemoryService(config, metaService),
        metaService,
        historyService,
        {
          createModelWithPinnedMetadata: (modelString: string) =>
            Promise.resolve(Ok({ model, metadataModel: modelString })),
          getWorkspaceMetadata: () => Promise.resolve(Err("no metadata in this scenario")),
        },
        { isExperimentEnabled: (id) => enabled.has(id) },
        { emitChatMessage: () => undefined }
      );
      for (const [index, text] of ["Run the tests.", "Lesson: run bun install first."].entries()) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`user-${index}`, "user", text, { timestamp: 1_000 + index })
        );
      }
      await service.run(workspaceId);
      await service.apply(workspaceId, "no-proposal-rendered");
    } finally {
      await cleanup();
    }
  });
}

/**
 * One fork (branchSummary.test.ts): the writer takes the pending marker, and
 * a send of another backend waits on it while it exists.
 */
export async function oneFork(
  names: LockNames,
  /** Resolves at the next lock call on lockPath after this call. */
  nextLockCall: (lockPath: string) => Promise<void>
): Promise<void> {
  const { historyService, config, cleanup } = await createTestHistoryService();
  names.root(config.rootDir, "fork");
  try {
    const workspaceId = "ws-record-fork";
    names.id(workspaceId);
    names.id("ws-record-fork-foreign");
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    await startAbandonedBranchSummaryInBackground({
      historyService,
      aiService: {
        createModelWithPinnedOptions: () => Promise.reject(new Error("not reached: RLM is off")),
        getWorkspaceMetadata: () => Promise.resolve(Err("no metadata in this scenario")),
      },
      workspaceId,
      sessionDir,
      abandonedMessages: [],
      guardTailMessageId: "none",
    });
    await awaitPendingBranchSummary(workspaceId);
    // The scenario holds the marker as the foreign writer, so the wait path runs.
    const marker = await acquireProcessFileLock({
      lockPath: path.join(sessionDir, "branch-summary.lock"),
      timeoutMs: 1_000,
      label: "scenario branch summary marker",
    });
    const waitCall = nextLockCall(path.join(sessionDir, "branch-summary.lock"));
    const waiting = awaitPendingBranchSummary("ws-record-fork-foreign", sessionDir);
    await waitCall;
    await marker[Symbol.asyncDispose]();
    await waiting;
  } finally {
    await cleanup();
  }
}

/**
 * Usage, timing and goal files (sessionUsageService.test.ts,
 * sessionTimingService.test.ts, workspaceGoalService.board.test.ts): a
 * headless usage row takes the session-dir target lock and then the usage
 * file lock; a timing clear and a serialized goal read take their file locks.
 */
export async function oneUsageAndGoal(names: LockNames): Promise<void> {
  const workspaceId = "ws-record-usage";
  names.id(workspaceId);
  const { config, historyService, cleanup } = await createTestHistoryService();
  names.root(config.rootDir, "usage");
  // The headless usage row locks the session dir as a memory target.
  names.target(path.join(config.sessionsDir, workspaceId));
  try {
    const recorded = await new SessionUsageService(config, historyService).recordHeadlessUsage(
      workspaceId,
      "anthropic:claude-haiku-4-5",
      { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      undefined,
      { analyticsSource: "memory_consolidation" }
    );
    // recordHeadlessUsage never throws: a missing result means the ledger write was skipped.
    if (recorded === undefined) throw new Error("headless usage was not recorded");
    const telemetry = { capture: () => undefined } as unknown as TelemetryService;
    await new SessionTimingService(config, telemetry).clearTimingFile(workspaceId);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const goals = new WorkspaceGoalService(config, historyService, extensionMetadata);
    await goals.readGoalSerialized(workspaceId);
  } finally {
    await cleanup();
  }
}

/**
 * One child report (subagent*Artifacts.test.ts): the parent's artifact index
 * writes, and the publication lock a delegated turn takes to publish its
 * outcome (taskService.delegatedTurnRepro.test.ts).
 */
export async function oneChildReport(names: LockNames): Promise<void> {
  await withTempDir("child", async (dir) => {
    names.root(dir, "child");
    const workspaceId = "ws-record-parent";
    names.id(workspaceId);
    const workspaceSessionDir = path.join(dir, "sessions", workspaceId);
    const child = {
      workspaceId,
      workspaceSessionDir,
      childTaskId: "ws-record-child",
      parentWorkspaceId: workspaceId,
      ancestorWorkspaceIds: [workspaceId],
    };
    // subagentReportArtifacts.ts has two lock calls: a step name keeps them apart.
    await step("upsert report", () =>
      upsertSubagentReportArtifact({ ...child, reportMarkdown: "Done." })
    );
    await upsertSubagentFailureArtifact({ ...child, errorType: "unknown", errorMessage: "down" });
    const unchanged = { workspaceId, workspaceSessionDir, update: () => undefined };
    await step("update reports", () => updateSubagentReportArtifactsFile(unchanged));
    await updateSubagentTranscriptArtifactsFile(unchanged);
    await updateSubagentGitPatchArtifactsFile(unchanged);
    await new TaskHandleStore(new Config(dir)).withWorkspaceTurnPublicationLock("wst_record", () =>
      Promise.resolve()
    );
  });
}

/**
 * One init seen by two backends (initStateManager.test.ts, "while another
 * backend on the same root runs the init"), then the plan-migration lock of
 * an SSH row before its plan is deleted.
 */
export async function oneInitAndPlan(names: LockNames): Promise<void> {
  await withTempDir("init", async (dir) => {
    names.root(dir, "init");
    const workspaceId = "ws-record-init";
    names.id(workspaceId);
    const backendA = new InitStateManager(new Config(dir));
    const backendB = new InitStateManager(new Config(dir));
    backendA.startInit(workspaceId, "/path/to/hook");
    // startInit queues its "running" write on the workspace file lock (after its record lock):
    // a no-op turn on that lock waits for the write, with no polling.
    await workspaceFileLocks.withLock(workspaceId, () => Promise.resolve());
    // B finds the running record: it probes the init lease, then A's record lock (held).
    await backendB.replayInit(workspaceId);
    const replayed = await backendB.readInitStatus(workspaceId);
    if (replayed?.status !== "running") throw new Error("B must leave A's running init alone");
    // The final write, then releaseRecordClaim's barrier on the workspace file lock.
    await backendA.endInit(workspaceId, 0);

    await markRemotePlanMigratedForDeletion(
      {
        getInstallationId: () => Promise.resolve("install-record"),
        isRemotePlanMigrated: () => false,
        markRemotePlanMigrated: () => Promise.resolve(),
        sessionsDir: path.join(dir, "sessions"),
      },
      {
        id: workspaceId,
        runtimeConfig: { type: "ssh", host: "plans.invalid", srcBaseDir: "~/xum" },
      },
      // The scenario records the Node lock calls.
      nodeSessionLocks
    );
  });
}

/**
 * One full clear (workspaceService.planReviewFeedback.test.ts): it holds the
 * refine serialization lock across the truncation.
 */
export async function oneWorkspaceRefine(names: LockNames): Promise<void> {
  const harness = await createWorkspaceServiceHarness({
    aiService: createMockAIService({ isStreaming: mock(() => false) }),
  });
  names.root(harness.config.rootDir, "clear");
  // A full clear deletes the plan files under the local Xum home (expandTilde ->
  // getXumHome). Point that home at the temp root, or the test deletes a real
  // ~/.xum plan of the same name.
  const previousRoot = process.env.XUM_ROOT;
  process.env.XUM_ROOT = harness.config.rootDir;
  try {
    const workspaceId = "ws-record-clear";
    names.id(workspaceId);
    const projectPath = "/tmp/xum-lock-record/project";
    await harness.config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "clear",
      projectName: "project",
      projectPath,
      runtimeConfig: { type: "local" },
    });
    await harness.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("row-1", "user", "Clear me.", { timestamp: 1_000 })
    );
    const cleared = await harness.service.truncateHistory(workspaceId, 1.0);
    if (!cleared.success) throw new Error(`full clear failed: ${cleared.error}`);
  } finally {
    if (previousRoot === undefined) delete process.env.XUM_ROOT;
    else process.env.XUM_ROOT = previousRoot;
    await harness.cleanup();
  }
}

/**
 * Session-dir stores (pinnedArtifactFiles, artifactVersionStore and
 * WorkflowRunStore tests): a pin, an artifact version, a workflow run with
 * its lease, the rollback lock and one journal append.
 */
export async function oneArtifactAndRun(names: LockNames): Promise<void> {
  await withTempDir("artifact", async (dir) => {
    names.root(dir, "artifact");
    const workspaceId = "ws-record-artifact";
    names.id(workspaceId);
    const sessionDir = path.join(dir, "sessions", workspaceId);
    await addPinnedPath(sessionDir, "report.md");
    await recordArtifactVersion({
      sessionDir,
      relPath: "report.md",
      bytes: Buffer.from("# Report\n"),
      label: null,
      abortSignal: new AbortController().signal,
    });
    const runs = new WorkflowRunStore({ sessionDir });
    // createRunIfAbsent and releaseLease pass the time left of a deadline as acquireTimeoutMs.
    // Date.now stands still during them, so the record holds the whole budget in every run.
    // acquireLease takes the zero-timeout path.
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      await createAndReleaseRun(runs, workspaceId);
    } finally {
      clock.mockRestore();
    }
    const rollback = await acquireRollbackFileLock(sessionDir);
    await rollback[Symbol.asyncDispose]();
    const journal = new DurableEventJournal(sessionDir);
    const { ref, size } = await journal.blobs.put("handle payload");
    await journal.append({
      workspaceId,
      kind: "result-handle",
      data: { handle: "vars.__h1", preview: "p", blobHash: ref, size },
    });
  });
}

/** One run created under its create lock, its lease taken, then released. */
async function createAndReleaseRun(runs: WorkflowRunStore, workspaceId: string): Promise<void> {
  await runs.createRunIfAbsent({
    id: "wfr_record",
    workspaceId,
    workflow: { name: "record", description: "Record", scope: "built-in", executable: true },
    source: "export default function workflow() { return {}; }\n",
    args: {},
    now: "2026-06-19T00:00:00.000Z",
  });
  if (!(await runs.acquireLease("wfr_record", "record-owner"))) {
    throw new Error("the lease of a new run must be free");
  }
  await runs.releaseLease("wfr_record", "record-owner");
}
