import { describe, expect, spyOn, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type {
  ProviderModelFactory,
  ResolveAndCreateModelResult,
} from "@/node/services/providerModelFactory";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  setupProviders,
  type TestEnvironment,
} from "../../../tests/ipc/setup";
import {
  HAIKU_MODEL,
  cleanupTempGitRepo,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
} from "../../../tests/ipc/helpers";

// A Stop ends the stream auto-retry loop: once a sub-agent's Stop latch drops, no backoff that was
// pending or armed during the Stop starts the stopped task again. The real ServiceContainer; only
// the language model is substituted. Setup checks use assert, not expect, so a setup failure
// cannot read like the target assertion.

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// First auto-retry backoff (calculateBackoffDelay(1)) plus slack for the resumed request.
const PAST_FIRST_BACKOFF_MS = 2_000 + 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

/** The first request fails with a retryable provider error; later ones answer "done". */
function failsOnceModel(requests: { count: number }): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: () => {
      requests.count += 1;
      const failing = requests.count === 1;
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (failing) {
              controller.enqueue({ type: "error", error: new Error("upstream connection reset") });
              controller.close();
              return;
            }
            controller.enqueue({ type: "text-start", id: "a" });
            controller.enqueue({ type: "text-delta", id: "a", delta: "done" });
            controller.enqueue({ type: "text-end", id: "a" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            });
            controller.close();
          },
        }),
      });
    },
  });
}

/** Stream starts per workspace: a stopped workspace's count must not grow. */
function countStreams(env: TestEnvironment): (workspaceId: string) => number {
  const counts = new Map<string, number>();
  env.services.aiService.on("stream-start", (event: { workspaceId?: string }) => {
    if (event.workspaceId == null) return;
    counts.set(event.workspaceId, (counts.get(event.workspaceId) ?? 0) + 1);
  });
  return (workspaceId) => counts.get(workspaceId) ?? 0;
}

/** Holds handleStreamError of one workspace at its goal accounting restore, before it arms a retry. */
function holdErrorHandling(env: TestEnvironment, held: (workspaceId: string) => boolean) {
  const goals = env.services.workspaceGoalService;
  const restore = goals.restoreGoalAccountingSnapshot.bind(goals);
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  spyOn(goals, "restoreGoalAccountingSnapshot").mockImplementation(async (workspaceId, ...rest) => {
    if (held(workspaceId)) {
      entered.resolve(workspaceId);
      await release.promise;
    }
    return restore(workspaceId, ...rest);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

function useModel(env: TestEnvironment, model: MockLanguageModelV3): void {
  const factory = (
    env.services.aiService as unknown as { providerModelFactory: ProviderModelFactory }
  ).providerModelFactory;
  spyOn(factory, "resolveAndCreateModel").mockImplementation(() =>
    Promise.resolve(
      Ok({
        model,
        effectiveModelString: HAIKU_MODEL,
        canonicalModelString: HAIKU_MODEL,
        canonicalProviderName: "anthropic",
        canonicalModelId: HAIKU_MODEL.slice(HAIKU_MODEL.indexOf(":") + 1),
        wireProviderName: "anthropic",
      } satisfies ResolveAndCreateModelResult)
    )
  );
}

async function withWorkspace(
  run: (env: TestEnvironment, workspaceId: string) => Promise<void>
): Promise<void> {
  const env = await createTestEnvironment();
  const repoPath = await createTempGitRepo();
  try {
    await setupProviders(env, { anthropic: { apiKey: "mock-model-key" } });
    const created = await createWorkspace(env, repoPath, generateBranchName("stop-retry"));
    if (!created.success) throw new Error(created.error);
    await env.services.initStateManager.waitForInit(created.metadata.id);
    await run(env, created.metadata.id);
  } finally {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(repoPath);
  }
}

describe("a Stop ends the auto-retry loop", () => {
  test("a parent's Stop keeps a sub-agent in its retry backoff from restarting", async () => {
    await withWorkspace(async (env, parentId) => {
      const requests = { count: 0 };
      useModel(env, failsOnceModel(requests));
      const { taskService, workspaceService } = env.services;
      const created = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Survey the repository",
        title: "Retrying child",
      });
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      assert(
        await waitFor(() => workspaceService.hasPendingAutoRetry(childId), 10_000),
        "the child's failed first stream schedules an auto-retry"
      );

      // What the renderer's Stop button sends for the parent; it cascades to the sub-agent.
      const stopped = await workspaceService.interruptStream(parentId, {
        disableAutoRetry: true,
        retireBashMonitorAttention: true,
      });
      assert(stopped.success, "the parent's Stop succeeds");
      assert(
        await waitFor(() => !taskService.isWorkspaceStopInProgress(childId), 5_000),
        "the child's stop latch drops"
      );
      const afterStop = requests.count;
      await sleep(PAST_FIRST_BACKOFF_MS);

      expect(requests.count).toBe(afterStop);
    });
  }, 60_000);

  test("a parent's Stop during a sub-agent's stream error handling arms no retry", async () => {
    await withWorkspace(async (env, parentId) => {
      const requests = { count: 0 };
      useModel(env, failsOnceModel(requests));
      const { taskService, workspaceService, workspaceGoalService } = env.services;
      // handleStreamError awaits the goal accounting restore before it schedules the retry.
      const restore = workspaceGoalService.restoreGoalAccountingSnapshot.bind(workspaceGoalService);
      const entered = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      spyOn(workspaceGoalService, "restoreGoalAccountingSnapshot").mockImplementation(
        async (workspaceId, ...rest) => {
          if (workspaceId !== parentId) {
            entered.resolve(workspaceId);
            await release.promise;
          }
          return restore(workspaceId, ...rest);
        }
      );
      const created = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Survey the repository",
        title: "Failing child",
      });
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      assert((await entered.promise) === childId, "the child's error handling is held");

      const stopping = workspaceService.interruptStream(parentId, {
        disableAutoRetry: true,
        retireBashMonitorAttention: true,
      });
      assert(
        await waitFor(() => taskService.isWorkspaceStopInProgress(childId), 5_000),
        "the cascade latches the child"
      );
      release.resolve();
      assert((await stopping).success, "the parent's Stop succeeds");
      assert(
        await waitFor(() => !taskService.isWorkspaceStopInProgress(childId), 5_000),
        "the child's stop latch drops"
      );
      const afterStop = requests.count;
      await sleep(PAST_FIRST_BACKOFF_MS);

      expect(requests.count).toBe(afterStop);
    });
  }, 60_000);
  test("a workflow step's hard timeout keeps a sub-agent in its retry backoff from restarting", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel({ count: 0 }));
      const { taskService, workspaceService } = env.services;
      // The terminal failure wakes the parent, which streams too: count the child's streams only.
      const streams = countStreams(env);
      const created = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Survey the repository",
        title: "Timed-out child",
      });
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      assert(
        await waitFor(() => workspaceService.hasPendingAutoRetry(childId), 10_000),
        "the child's failed first stream schedules an auto-retry"
      );

      await taskService.failAgentTaskForHardTimeout(childId, {
        workflowRunId: "wfr_hard_timeout",
        stepId: "survey",
        inputHash: "hash",
        reason: "The step timed out",
      });
      const afterTimeout = streams(childId);
      assert(afterTimeout > 0, "the child's first stream started");
      await sleep(PAST_FIRST_BACKOFF_MS);

      expect(streams(childId)).toBe(afterTimeout);
    });
  }, 60_000);

  test("interrupting a workspace turn keeps its retry backoff from restarting the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      const requests = { count: 0 };
      useModel(env, failsOnceModel(requests));
      const { taskService, workspaceService, workspaceTurnManager } = env.services;
      const turn = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Survey the repository",
        title: "Retrying turn",
        workspace: { mode: "new" },
      });
      if (!turn.success) throw new Error(turn.error);
      const targetId = turn.data.workspaceId;
      assert(
        await waitFor(() => workspaceService.hasPendingAutoRetry(targetId), 20_000),
        "the turn's failed first stream schedules an auto-retry"
      );

      // What task_stop runs for a workspace-turn ID.
      const interrupted = await workspaceTurnManager.interruptWorkspaceTurn(
        ownerId,
        turn.data.taskId
      );
      assert(interrupted.success, "the turn interrupt succeeds");
      assert(
        await waitFor(() => !taskService.isWorkspaceStopInProgress(targetId), 5_000),
        "the target's stop latch drops"
      );
      const afterStop = requests.count;
      await sleep(PAST_FIRST_BACKOFF_MS);

      expect(requests.count).toBe(afterStop);
    });
  }, 90_000);
  test("interrupting a workspace turn during its stream error handling arms no retry", async () => {
    await withWorkspace(async (env, ownerId) => {
      useModel(env, failsOnceModel({ count: 0 }));
      const { taskService, workspaceService, workspaceTurnManager } = env.services;
      const streams = countStreams(env);
      const hold = holdErrorHandling(env, (workspaceId) => workspaceId !== ownerId);
      const turn = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Survey the repository",
        title: "Failing turn",
        workspace: { mode: "new" },
      });
      if (!turn.success) throw new Error(turn.error);
      const targetId = turn.data.workspaceId;
      assert((await hold.entered) === targetId, "the turn's error handling is held");

      // The interrupt's latch drops after its stream stop, while the error handling still runs.
      const interrupted = await workspaceTurnManager.interruptWorkspaceTurn(
        ownerId,
        turn.data.taskId
      );
      assert(interrupted.success, "the turn interrupt succeeds");
      assert(!taskService.isWorkspaceStopInProgress(targetId), "the target's stop latch dropped");
      hold.release();
      assert(
        await waitFor(() => workspaceService.getActiveTurnGeneration(targetId) == null, 5_000),
        "the target's error handling ends"
      );
      const afterStop = streams(targetId);
      await sleep(PAST_FIRST_BACKOFF_MS);

      expect(streams(targetId)).toBe(afterStop);
    });
  }, 90_000);

  test("a hard timeout during a sub-agent's stream error handling arms no retry", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel({ count: 0 }));
      const { taskService, workspaceService } = env.services;
      const streams = countStreams(env);
      const hold = holdErrorHandling(env, (workspaceId) => workspaceId !== parentId);
      const created = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Survey the repository",
        title: "Failing child",
      });
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      assert((await hold.entered) === childId, "the child's error handling is held");
      // The error handling ends after the timeout's queue clear and stream stop, but before its
      // terminal failure samples live work, so no stop record (and no latch) covers it.
      const terminate = taskService.terminateAllDescendantAgentTasks.bind(taskService);
      spyOn(taskService, "terminateAllDescendantAgentTasks").mockImplementation(
        async (workspaceId, ...rest) => {
          if (workspaceId === childId) {
            hold.release();
            assert(
              await waitFor(() => workspaceService.getActiveTurnGeneration(childId) == null, 5_000),
              "the child's error handling ends"
            );
          }
          return terminate(workspaceId, ...rest);
        }
      );

      await taskService.failAgentTaskForHardTimeout(childId, {
        workflowRunId: "wfr_hard_timeout",
        stepId: "survey",
        inputHash: "hash",
        reason: "The step timed out",
      });
      const afterTimeout = streams(childId);
      await sleep(PAST_FIRST_BACKOFF_MS);

      expect(streams(childId)).toBe(afterTimeout);
    });
  }, 60_000);
});
