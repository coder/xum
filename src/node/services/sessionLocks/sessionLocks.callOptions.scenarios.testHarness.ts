/**
 * Scenarios for sessionLocks.callOptions.test.ts. Each one drives real code
 * through the session lock calls that phase 4 moves behind SessionLocks, so
 * the call record sees each call with its options before and after the move.
 * They reuse the recipes of the tests that own each lock (named per scenario).
 */
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService } from "@/node/services/memoryService";
import { RefineService } from "@/node/services/refinement/refineService";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";
import type { AgentSessionAIService } from "../agentSession";
import { createAgentSessionHarness } from "../agentSession.testHarness";
import {
  awaitPendingBranchSummary,
  startAbandonedBranchSummaryInBackground,
} from "../branchSummary";
import { createTestConfig, createWorkspaceServiceMocks } from "../taskService.testHarness";
import { createTestHistoryService } from "../testHistoryService";
import { setTodosForSessionDir } from "../tools/todo";
import { createReviewPaneUpdateTool } from "../tools/review_pane";
import { createTestToolConfig, mockToolCallOptions } from "../tools/testHelpers";
import {
  createWorkspaceTurnManagerHarness,
  startWorkspaceTurnForTest,
} from "../workspaceTurnManager.testHarness";
import { removeSessionDirUnderMemoryLocks } from "../workspaceRemoval";
import { workspaceUseLeasesFor } from "../workspaceUseLeases";

const sendOptions = { model: "openai:gpt-4o", agentId: "exec" };
const idle = { hasRunningBackgroundProcesses: () => Promise.resolve(false) };

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
export async function oneTurn(): Promise<void> {
  const workspaceId = "ws-record-turn";
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
    Promise.resolve(Err({ type: "unknown", raw: "provider down" }))
  );
  const b = await createAgentSessionHarness({ workspaceId, aiServiceOverrides: { streamMessage } });
  try {
    await b.session.sendMessage("hello", sendOptions);
    const sessionDir = path.join(b.config.sessionsDir, workspaceId);
    await setTodosForSessionDir(workspaceId, sessionDir, [
      { content: "Record the locks", status: "in_progress" },
    ]);
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
export async function oneRefusal(): Promise<void> {
  const workspaceId = "ws-record-refusal";
  const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
    Promise.resolve(Err({ type: "unknown", raw: "must not be reached" }))
  );
  const b = await createAgentSessionHarness({ workspaceId, aiServiceOverrides: { streamMessage } });
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
export async function oneRemoval(): Promise<void> {
  await withTempDir("removal", async (dir) => {
    const rootDir = path.join(dir, "xum-home");
    const workspaceId = "ws-record-removal";
    const sessionDir = path.join(rootDir, "sessions", workspaceId);
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
export async function oneRefineApply(): Promise<void> {
  await withTempDir("refine", async (dir) => {
    const workspaceId = "ws-record-refine";
    const workspacePath = path.join(dir, "checkout");
    await fs.mkdir(workspacePath, { recursive: true });
    // The shared HistoryService seam (AGENTS.md): its temp root is the Xum home here.
    const { historyService, config, tempDir: muxHome, cleanup } = await createTestHistoryService();
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
    try {
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
  /** Resolves at the next lock call on lockPath after this call. */
  nextLockCall: (lockPath: string) => Promise<void>
): Promise<void> {
  const { historyService, config, cleanup } = await createTestHistoryService();
  try {
    const workspaceId = "ws-record-fork";
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
