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

// A Stop ends the stream auto-retry loop: after the Stop, no backoff that was pending or armed
// during the Stop starts the stopped workspace again. The real ServiceContainer; only the language
// model is substituted. Each test checks the retry state itself (pending backoff, and retry events
// since the Stop), not elapsed time, so a slow runner cannot hide a retry that is still armed.
// Setup checks use assert, not expect, so a setup failure cannot read like the target assertion.

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

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
function failsOnceModel(): MockLanguageModelV3 {
  let requests = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      requests += 1;
      const failing = requests === 1;
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

/** The auto-retry events each workspace's chat received, in order. */
function watchRetries(env: TestEnvironment) {
  const events = new Map<string, string[]>();
  env.services.workspaceService.on(
    "chat",
    (event: { workspaceId: string; message: { type?: string } }) => {
      const type = event.message.type;
      if (!type?.startsWith("auto-retry-")) return;
      events.set(event.workspaceId, [...(events.get(event.workspaceId) ?? []), type]);
    }
  );
  const of = (workspaceId: string) => events.get(workspaceId) ?? [];
  return {
    of,
    /** The events from now on: call it right before the Stop. */
    from(workspaceId: string): () => string[] {
      const start = of(workspaceId).length;
      return () => of(workspaceId).slice(start);
    },
  };
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

function createChild(env: TestEnvironment, parentId: string) {
  return env.services.taskService.create({
    parentWorkspaceId: parentId,
    kind: "agent",
    agentId: "explore",
    prompt: "Survey the repository",
    title: "Failing child",
  });
}

/** The failed first stream armed a backoff that has not fired yet. */
async function assertBackoffPending(
  env: TestEnvironment,
  retries: ReturnType<typeof watchRetries>,
  workspaceId: string
): Promise<void> {
  assert(
    await waitFor(() => env.services.workspaceService.hasPendingAutoRetry(workspaceId), 20_000),
    "the failed first stream schedules an auto-retry"
  );
  assert(!retries.of(workspaceId).includes("auto-retry-starting"), "the backoff has not fired");
}

/** Target assertion: no backoff is left, and none was armed or fired since the Stop began. */
function expectRetryLoopEnded(env: TestEnvironment, workspaceId: string, since: () => string[]) {
  expect({
    pending: env.services.workspaceService.hasPendingAutoRetry(workspaceId),
    armedOrFired: since().filter((type) => type !== "auto-retry-abandoned"),
  }).toEqual({ pending: false, armedOrFired: [] });
}

describe("a Stop ends the auto-retry loop", () => {
  test("a parent's Stop keeps a sub-agent in its retry backoff from restarting", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel());
      const retries = watchRetries(env);
      const created = await createChild(env, parentId);
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      await assertBackoffPending(env, retries, childId);

      const since = retries.from(childId);
      // What the renderer's Stop button sends for the parent; it cascades to the sub-agent.
      const stopped = await env.services.workspaceService.interruptStream(parentId, {
        disableAutoRetry: true,
        retireBashMonitorAttention: true,
      });
      assert(stopped.success, "the parent's Stop succeeds");

      expectRetryLoopEnded(env, childId, since);
    });
  }, 60_000);

  test("a parent's Stop during a sub-agent's stream error handling arms no retry", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel());
      const { taskService, workspaceService } = env.services;
      const retries = watchRetries(env);
      const hold = holdErrorHandling(env, (workspaceId) => workspaceId !== parentId);
      const created = await createChild(env, parentId);
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      assert((await hold.entered) === childId, "the child's error handling is held");

      // The error handling resumes right after the cascade's cleanup abandoned the child's retry
      // loop, while the cascade still latches the child. (A retry it armed before that abandon
      // would be cancelled by it.)
      const abandon = workspaceService.abandonAutoRetry.bind(workspaceService);
      spyOn(workspaceService, "abandonAutoRetry").mockImplementation((workspaceId, reason) => {
        abandon(workspaceId, reason);
        if (workspaceId !== childId) return;
        assert(taskService.isWorkspaceStopInProgress(childId), "the cascade latches the child");
        hold.release();
      });

      const since = retries.from(childId);
      const stopped = await workspaceService.interruptStream(parentId, {
        disableAutoRetry: true,
        retireBashMonitorAttention: true,
      });
      assert(stopped.success, "the parent's Stop succeeds");
      assert(
        await waitFor(() => workspaceService.getActiveTurnGeneration(childId) == null, 5_000),
        "the child's error handling ends"
      );

      expectRetryLoopEnded(env, childId, since);
    });
  }, 60_000);

  test("a parent's Stop during a sub-agent's fired retry keeps the retry from starting a turn", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel());
      const { taskService, workspaceService } = env.services;
      const retries = watchRetries(env);
      const created = await createChild(env, parentId);
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      await assertBackoffPending(env, retries, childId);

      // Hold the fired retry before its resume, and the cascade's cleanup (which abandons the
      // retry) until that resume returned: only the resume's own gate sees the child's latch.
      const session = workspaceService.getOrCreateSession(childId);
      const resume = session.resumeStream.bind(session);
      const fired = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<Awaited<ReturnType<typeof resume>>>();
      spyOn(session, "resumeStream").mockImplementation(async (...args) => {
        if (args[1]?.acceptanceOrigin !== "automatic") return resume(...args);
        fired.resolve();
        await proceed.promise;
        const result = await resume(...args);
        resumed.resolve(result);
        return result;
      });
      const cleanupHost = taskService as unknown as {
        runWorkspaceStopCleanup: (targets: readonly string[], ...rest: unknown[]) => Promise<void>;
      };
      const cleanup = cleanupHost.runWorkspaceStopCleanup.bind(taskService);
      spyOn(cleanupHost, "runWorkspaceStopCleanup").mockImplementation(async (targets, ...rest) => {
        if (targets.includes(childId)) {
          assert(taskService.isWorkspaceStopInProgress(childId), "the cascade latched the child");
          proceed.resolve();
          await resumed.promise;
        }
        return cleanup(targets, ...rest);
      });
      await fired.promise;

      const stopped = await workspaceService.interruptStream(parentId, {
        disableAutoRetry: true,
        retireBashMonitorAttention: true,
      });
      assert(stopped.success, "the parent's Stop succeeds");

      const result = await resumed.promise;
      expect({
        started: result.success && result.data.started,
        pending: workspaceService.hasPendingAutoRetry(childId),
      }).toEqual({ started: false, pending: false });
    });
  }, 60_000);

  test("a workflow step's hard timeout keeps a sub-agent in its retry backoff from restarting", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel());
      const retries = watchRetries(env);
      const created = await createChild(env, parentId);
      if (!created.success) throw new Error(created.error);
      const childId = created.data.taskId;
      await assertBackoffPending(env, retries, childId);

      const since = retries.from(childId);
      await env.services.taskService.failAgentTaskForHardTimeout(childId, {
        workflowRunId: "wfr_hard_timeout",
        stepId: "survey",
        inputHash: "hash",
        reason: "The step timed out",
      });

      expectRetryLoopEnded(env, childId, since);
    });
  }, 60_000);

  test("a hard timeout during a sub-agent's stream error handling arms no retry", async () => {
    await withWorkspace(async (env, parentId) => {
      useModel(env, failsOnceModel());
      const { taskService, workspaceService } = env.services;
      const retries = watchRetries(env);
      const hold = holdErrorHandling(env, (workspaceId) => workspaceId !== parentId);
      const created = await createChild(env, parentId);
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

      const since = retries.from(childId);
      await taskService.failAgentTaskForHardTimeout(childId, {
        workflowRunId: "wfr_hard_timeout",
        stepId: "survey",
        inputHash: "hash",
        reason: "The step timed out",
      });

      expectRetryLoopEnded(env, childId, since);
    });
  }, 60_000);

  test("interrupting a workspace turn keeps its retry backoff from restarting the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      useModel(env, failsOnceModel());
      const { workspaceTurnManager } = env.services;
      const retries = watchRetries(env);
      const turn = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Survey the repository",
        title: "Retrying turn",
        workspace: { mode: "new" },
      });
      if (!turn.success) throw new Error(turn.error);
      const targetId = turn.data.workspaceId;
      await assertBackoffPending(env, retries, targetId);

      const since = retries.from(targetId);
      // What task_stop runs for a workspace-turn ID.
      const interrupted = await workspaceTurnManager.interruptWorkspaceTurn(
        ownerId,
        turn.data.taskId
      );
      assert(interrupted.success, "the turn interrupt succeeds");

      expectRetryLoopEnded(env, targetId, since);
    });
  }, 90_000);

  test("interrupting a workspace turn during its stream error handling arms no retry", async () => {
    await withWorkspace(async (env, ownerId) => {
      useModel(env, failsOnceModel());
      const { taskService, workspaceService, workspaceTurnManager } = env.services;
      const retries = watchRetries(env);
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

      const since = retries.from(targetId);
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

      expectRetryLoopEnded(env, targetId, since);
    });
  }, 90_000);

  test("interrupting a queued workspace turn leaves the running turn's retry armed", async () => {
    await withWorkspace(async (env, ownerId) => {
      useModel(env, failsOnceModel());
      const { taskService, workspaceService, workspaceTurnManager } = env.services;
      const hold = holdErrorHandling(env, (workspaceId) => workspaceId !== ownerId);
      const running = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Survey the repository",
        title: "Failing turn",
        workspace: { mode: "new" },
      });
      if (!running.success) throw new Error(running.error);
      const targetId = running.data.workspaceId;
      assert((await hold.entered) === targetId, "the running turn's error handling is held");
      const queued = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Then list the TODOs",
        title: "Queued turn",
        workspace: { mode: "existing", workspaceId: targetId },
      });
      if (!queued.success) throw new Error(queued.error);
      assert(queued.data.status === "queued", "the second turn waits behind the running one");
      // The running turn's error handling ends inside the interrupt's latch window: the
      // interrupt latches the target for a queued handle too, until its method-level finally.
      const queuedHandleId = queued.data.taskId;
      const updateExecution =
        workspaceTurnManager.updateAgentTaskExecutionState.bind(workspaceTurnManager);
      let latchedRelease = false;
      spyOn(workspaceTurnManager, "updateAgentTaskExecutionState").mockImplementation(
        async (workspaceId, handleId, ...rest) => {
          if (handleId === queuedHandleId && !latchedRelease) {
            latchedRelease = true;
            assert(
              taskService.isWorkspaceStopInProgress(targetId),
              "the interrupt latched the target"
            );
            hold.release();
            assert(
              await waitFor(
                () => workspaceService.getActiveTurnGeneration(targetId) == null,
                5_000
              ),
              "the running turn's error handling ends"
            );
          }
          return updateExecution(workspaceId, handleId, ...rest);
        }
      );

      const interrupted = await workspaceTurnManager.interruptWorkspaceTurn(
        ownerId,
        queuedHandleId
      );
      assert(interrupted.success, "the queued turn's interrupt succeeds");
      assert(latchedRelease, "the error handling ended inside the latch window");

      expect(workspaceService.hasPendingAutoRetry(targetId)).toBe(true);
    });
  }, 90_000);
});
