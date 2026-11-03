import { describe, expect, spyOn, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  createMuxMessage,
  type CompactionRequestData,
  type MuxMessageMetadata,
} from "@/common/types/message";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { Err, Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { createConfigStores } from "@/node/config";
import { AgentSession } from "@/node/services/agentSession";
import type { HistoryService } from "@/node/services/historyService";
import { ServiceContainer } from "@/node/services/serviceContainer";
import type { TaskHandleStore } from "@/node/services/taskHandleStore";
import type { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
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

/** The first request fails, by default with a retryable provider error; later ones answer "done". */
function failsOnceModel(
  error: unknown = new Error("upstream connection reset")
): MockLanguageModelV3 {
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
              controller.enqueue({ type: "error", error });
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

/** Streams text and stays open until the request is aborted. */
function streamsUntilStoppedModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (options: LanguageModelV3CallOptions) =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "a" });
            controller.enqueue({ type: "text-delta", id: "a", delta: "working" });
            options.abortSignal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      }),
  });
}

/** The first request fails with a retryable provider error; later ones stream until stopped. */
function failsOnceThenStreamsModel(): MockLanguageModelV3 {
  const fails = failsOnceModel();
  const streams = streamsUntilStoppedModel();
  let requests = 0;
  return new MockLanguageModelV3({
    doStream: (options) => {
      requests += 1;
      return requests === 1 ? fails.doStream(options) : streams.doStream(options);
    },
  });
}

function replaceModel(env: TestEnvironment, model: MockLanguageModelV3): void {
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

/**
 * Disposes the backend and starts a new one on the same XUM_ROOT, as a restart of Xum does, and
 * waits for the startup recovery of `workspaceId` to end. `whileRecovering` runs as that recovery
 * starts, while its session is not registered yet.
 */
async function restart(
  env: TestEnvironment,
  model: MockLanguageModelV3,
  workspaceId: string,
  whileRecovering?: (services: ServiceContainer, session: AgentSession) => Promise<void>
): Promise<ServiceContainer> {
  await env.services.dispose();
  await env.services.shutdown();
  const recovered = Promise.withResolvers<void>();
  const services = new ServiceContainer(createConfigStores(env.tempDir));
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with each session as `this`
  const runStartupRecovery = AgentSession.prototype.runStartupRecovery;
  const recovery = spyOn(AgentSession.prototype, "runStartupRecovery").mockImplementation(
    async function (this: AgentSession, ...args) {
      const target = args[0]?.id === workspaceId;
      try {
        if (target) await whileRecovering?.(services, this);
        await runStartupRecovery.apply(this, args);
      } finally {
        if (target) recovered.resolve();
      }
    }
  );
  try {
    replaceModel({ ...env, services }, model);
    await services.initialize();
    assert(
      await Promise.race([recovered.promise.then(() => true), sleep(20_000).then(() => false)]),
      "the restarted backend runs the workspace's startup recovery"
    );
    return services;
  } finally {
    recovery.mockRestore();
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

/** A new workspace turn whose first stream failed and armed a backoff that has not fired. */
async function startFailedTurn(
  env: TestEnvironment,
  ownerId: string,
  attentionPolicy?: "notify_on_terminal"
) {
  const retries = watchRetries(env);
  const turn = await env.services.workspaceTurnManager.createWorkspaceTurn({
    ownerWorkspaceId: ownerId,
    prompt: "Survey the repository",
    title: "Stopped turn",
    workspace: { mode: "new" },
    attentionPolicy,
  });
  if (!turn.success) throw new Error(turn.error);
  await assertBackoffPending(env, retries, turn.data.workspaceId);
  return { workspaceId: turn.data.workspaceId, taskId: turn.data.taskId };
}

/** The turn's backend died: a new backend on the same XUM_ROOT can take the turn's owner lock. */
async function dropTurnOwnerLock(services: ServiceContainer, handleId: string): Promise<void> {
  const locks = (
    services.workspaceTurnManager as unknown as { turnOwnerLocks: Map<string, () => Promise<void>> }
  ).turnOwnerLocks;
  const release = locks.get(handleId);
  assert(release != null, "the turn's backend holds its owner lock");
  locks.delete(handleId);
  await release();
}

/** What task_stop runs for a workspace-turn ID. */
async function interruptTurn(services: ServiceContainer, ownerId: string, taskId: string) {
  const interrupted = await services.workspaceTurnManager.interruptWorkspaceTurn(ownerId, taskId);
  assert(interrupted.success, "the turn interrupt succeeds");
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
      replaceModel(env, failsOnceModel());
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
      replaceModel(env, failsOnceModel());
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
      replaceModel(env, failsOnceModel());
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
      replaceModel(env, failsOnceModel());
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
      replaceModel(env, failsOnceModel());
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
      replaceModel(env, failsOnceModel());
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
      replaceModel(env, failsOnceModel());
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

  test.each([
    { phase: "in its retry backoff", model: failsOnceModel },
    { phase: "while it streams", model: streamsUntilStoppedModel },
    { phase: "during its stream error handling", model: failsOnceModel },
  ])(
    "a restart after interrupting a workspace turn $phase does not resume it",
    async (args) => {
      await withWorkspace(async (env, ownerId) => {
        const model = args.model();
        replaceModel(env, model);
        const { aiService, workspaceService, workspaceTurnManager } = env.services;
        const retries = watchRetries(env);
        const hold = holdErrorHandling(
          env,
          (workspaceId) =>
            args.phase === "during its stream error handling" && workspaceId !== ownerId
        );
        const turn = await workspaceTurnManager.createWorkspaceTurn({
          ownerWorkspaceId: ownerId,
          prompt: "Survey the repository",
          title: "Stopped turn",
          workspace: { mode: "new" },
        });
        if (!turn.success) throw new Error(turn.error);
        const targetId = turn.data.workspaceId;
        if (args.phase === "in its retry backoff")
          await assertBackoffPending(env, retries, targetId);
        else if (args.phase === "while it streams")
          assert(await waitFor(() => aiService.isStreaming(targetId), 20_000), "the turn streams");
        else assert((await hold.entered) === targetId, "the turn's error handling is held");

        const interrupted = await workspaceTurnManager.interruptWorkspaceTurn(
          ownerId,
          turn.data.taskId
        );
        assert(interrupted.success, "the turn interrupt succeeds");
        hold.release();
        assert(
          await waitFor(() => workspaceService.getActiveTurnGeneration(targetId) == null, 5_000),
          "the interrupted turn ends"
        );
        assert(
          !workspaceService.hasPendingAutoRetry(targetId),
          "the interrupt ended the retry loop"
        );

        const restarted = await restart(env, model, targetId);
        try {
          expect({
            pending: restarted.workspaceService.hasPendingAutoRetry(targetId),
            streaming: restarted.aiService.isStreaming(targetId),
          }).toEqual({ pending: false, streaming: false });
        } finally {
          await restarted.dispose();
          await restarted.shutdown();
        }
      });
    },
    90_000
  );

  test("a turn interrupt during startup recovery's first await ends the retry, also after another restart", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);

      // The backend exits with the turn in its backoff, so startup recovery resumes it in a
      // session that is not registered yet. The interrupt lands while that recovery awaits its
      // first read (the cancellation record).
      const restarted = await restart(env, model, turn.workspaceId, (services, session) => {
        const host = session as unknown as { compactionRecoveryBlocked: () => Promise<boolean> };
        const blocked = host.compactionRecoveryBlocked.bind(session);
        let stopped = false;
        spyOn(host, "compactionRecoveryBlocked").mockImplementation(async () => {
          const result = await blocked();
          if (!stopped) {
            stopped = true;
            await interruptTurn(services, ownerId, turn.taskId);
          }
          return result;
        });
        return Promise.resolve();
      });
      const pending = { first: restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId) };
      const again = await restart({ ...env, services: restarted }, model, turn.workspaceId);
      try {
        expect({
          ...pending,
          second: again.workspaceService.hasPendingAutoRetry(turn.workspaceId),
        }).toEqual({ first: false, second: false });
      } finally {
        await again.dispose();
        await again.shutdown();
      }
    });
  }, 90_000);

  test("a turn interrupt after startup recovery read the turn's handle keeps it from arming a retry", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);

      const restarted = await restart(env, model, turn.workspaceId, (services) => {
        const { taskService } = services;
        const read = taskService.isWorkspaceTurnStopped.bind(taskService);
        let stopped = false;
        spyOn(taskService, "isWorkspaceTurnStopped").mockImplementation(async (...args) => {
          const result = await read(...args);
          if (!stopped) {
            stopped = true;
            assert(!result, "startup recovery read the handle before the interrupt");
            await interruptTurn(services, ownerId, turn.taskId);
          }
          return result;
        });
        return Promise.resolve();
      });
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a restart while a turn interrupt's stream stop is still running does not resume the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      const { aiService } = env.services;
      const stopStream = aiService.stopStream.bind(aiService);
      const stopping = Promise.withResolvers<void>();
      let held = false;
      // The backend exits inside the interrupt's stream stop: the stop never settles.
      spyOn(aiService, "stopStream").mockImplementation((workspaceId, ...rest) => {
        if (workspaceId !== turn.workspaceId || held) return stopStream(workspaceId, ...rest);
        held = true;
        stopping.resolve();
        return new Promise(() => undefined);
      });
      void env.services.workspaceTurnManager.interruptWorkspaceTurn(ownerId, turn.taskId);
      await stopping.promise;

      const restarted = await restart(env, model, turn.workspaceId);
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a failed tail read during a turn interrupt does not keep a later turn from resuming after a restart", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceThenStreamsModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      const history = (env.services as unknown as { historyService: HistoryService })
        .historyService;
      const getLastMessages = history.getLastMessages.bind(history);
      let failing = true;
      spyOn(history, "getLastMessages").mockImplementation((workspaceId, ...rest) =>
        failing && workspaceId === turn.workspaceId
          ? Promise.reject(new Error("EIO: i/o error"))
          : getLastMessages(workspaceId, ...rest)
      );
      await interruptTurn(env.services, ownerId, turn.taskId);
      failing = false;

      // The owner's next turn on the same workspace streams when the backend exits.
      const next = await env.services.workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Then list the TODOs",
        title: "Later turn",
        workspace: { mode: "existing", workspaceId: turn.workspaceId },
      });
      if (!next.success) throw new Error(next.error);
      assert(
        await waitFor(() => env.services.aiService.isStreaming(turn.workspaceId), 20_000),
        "the later turn streams"
      );

      const restarted = await restart(env, model, turn.workspaceId);
      try {
        expect(
          restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId) ||
            restarted.aiService.isStreaming(turn.workspaceId)
        ).toBe(true);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a turn interrupt while the config is unreadable still keeps a restart from resuming the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      const { config } = env;
      const findWorkspace = config.findWorkspace.bind(config);
      // The lenient read falls back to an empty config, where the workspace is missing.
      const unreadable = spyOn(config, "findWorkspace").mockImplementation((workspaceId) =>
        workspaceId === turn.workspaceId ? null : findWorkspace(workspaceId)
      );
      try {
        await interruptTurn(env.services, ownerId, turn.taskId);
      } finally {
        unreadable.mockRestore();
      }

      const restarted = await restart(env, model, turn.workspaceId);
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a non-retryable failure that ends after a turn interrupt keeps a restart from resuming the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel(
        new APICallError({
          message: "invalid x-api-key",
          url: "https://api.anthropic.com/v1/messages",
          requestBodyValues: {},
          statusCode: 401,
          responseHeaders: {},
          responseBody: '{"type":"error","error":{"type":"authentication_error"}}',
          isRetryable: false,
        })
      );
      replaceModel(env, model);
      const { workspaceService, workspaceTurnManager } = env.services;
      const hold = holdErrorHandling(env, (workspaceId) => workspaceId !== ownerId);
      const turn = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Survey the repository",
        title: "Stopped turn",
        workspace: { mode: "new" },
      });
      if (!turn.success) throw new Error(turn.error);
      const targetId = turn.data.workspaceId;
      assert((await hold.entered) === targetId, "the turn's error handling is held");
      await interruptTurn(env.services, ownerId, turn.data.taskId);
      hold.release();
      assert(
        await waitFor(() => workspaceService.getActiveTurnGeneration(targetId) == null, 5_000),
        "the failed turn's error handling ends"
      );
      // A credential fix clears a provider-config failure's startup marker.
      await workspaceService.getOrCreateSession(targetId).handleProviderConfigChanged();

      const restarted = await restart(env, model, targetId);
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(targetId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a restart after the owner of a stopped turn was removed does not resume the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const { workspaceService } = env.services;
      const turn = await startFailedTurn(env, ownerId);
      await interruptTurn(env.services, ownerId, turn.taskId);
      // Removing the owner deletes its session folder, and the turn's handle with it.
      assert((await workspaceService.remove(ownerId, true)).success, "the owner is removed");
      assert(
        (await workspaceService.getInfo(turn.workspaceId)) != null,
        "the stopped turn's workspace stays"
      );

      const restarted = await restart(env, model, turn.workspaceId);
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a restart still resumes a workspace turn that restart recovery settled as interrupted", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      const record = await env.services.workspaceTurnManager.getWorkspaceTurnRecord(
        ownerId,
        turn.taskId
      );
      assert(record?.status === "running", "the failed turn's handle is running");

      // The restarted backend settles the stale handle before the target's startup recovery reads
      // it, as settleStaleWorkspaceTurn does: `interrupted`, with an error. Nobody stopped the turn.
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        const store = (
          services.workspaceTurnManager as unknown as { taskHandleStore: TaskHandleStore }
        ).taskHandleStore;
        await store.upsertWorkspaceTurn({
          ...record,
          status: "interrupted",
          updatedAt: new Date().toISOString(),
          error: "Workspace turn interrupted after restart",
        });
      });
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId)).toBe(true);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test.each([{ phase: "in its retry backoff" }, { phase: "while its stream runs" }])(
    "interrupting a turn that startup recovery resumed after restart recovery settled it stops it $phase",
    async (args) => {
      await withWorkspace(async (env, ownerId) => {
        const model = failsOnceThenStreamsModel();
        replaceModel(env, model);
        const turn = await startFailedTurn(env, ownerId);

        // The backend crashes: no live owner holds the turn. The startup stale-turn sweep
        // (TaskService's queue drain) wins the race with the target's startup recovery: it finds
        // nothing live and settles the handle `interrupted`, with an error. Startup recovery then
        // resumes the turn, since nobody stopped it.
        await dropTurnOwnerLock(env.services, turn.taskId);
        let services = await restart(env, model, turn.workspaceId, async (restarted) => {
          await restarted.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
        });
        try {
          const { aiService, workspaceService, workspaceTurnManager } = services;
          const retries = watchRetries({ ...env, services });
          const settled = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
          assert(
            settled?.status === "interrupted" && settled.error != null,
            "restart recovery settled the turn's handle"
          );
          assert(
            workspaceService.hasPendingAutoRetry(turn.workspaceId),
            "startup recovery resumes the turn"
          );
          if (args.phase === "while its stream runs") {
            assert(
              await waitFor(() => aiService.isStreaming(turn.workspaceId), 20_000),
              "the resumed turn streams"
            );
          }

          const since = retries.from(turn.workspaceId);
          await interruptTurn(services, ownerId, turn.taskId);
          await waitFor(() => !aiService.isStreaming(turn.workspaceId), 5_000);
          const stopped = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
          const afterStop = {
            streaming: aiService.isStreaming(turn.workspaceId),
            pending: workspaceService.hasPendingAutoRetry(turn.workspaceId),
            armedOrFired: since().filter((type) => type !== "auto-retry-abandoned"),
            handle: { status: stopped?.status, error: stopped?.error },
          };
          services = await restart({ ...env, services }, model, turn.workspaceId);
          expect({
            ...afterStop,
            resumedAfterRestart:
              services.workspaceService.hasPendingAutoRetry(turn.workspaceId) ||
              services.aiService.isStreaming(turn.workspaceId),
          }).toEqual({
            streaming: false,
            pending: false,
            armedOrFired: [],
            handle: { status: "interrupted", error: undefined },
            resumedAfterRestart: false,
          });
        } finally {
          await services.dispose();
          await services.shutdown();
        }
      });
    },
    90_000
  );

  test("interrupting a turn that restart recovery settled, during its startup recovery, keeps it from arming a retry", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);

      // Nothing of the turn runs yet when the interrupt lands: startup recovery has read the
      // settled handle as not stopped and has not armed its retry.
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        const { taskService, workspaceTurnManager } = services;
        await workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
        const settled = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        assert(
          settled?.status === "interrupted" && settled.error != null,
          "restart recovery settled the turn's handle"
        );
        const read = taskService.isWorkspaceTurnStopped.bind(taskService);
        let stopped = false;
        spyOn(taskService, "isWorkspaceTurnStopped").mockImplementation(async (...args) => {
          const result = await read(...args);
          if (!stopped) {
            stopped = true;
            assert(!result, "startup recovery read the settled handle as not stopped");
            await interruptTurn(services, ownerId, turn.taskId);
          }
          return result;
        });
      });
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test.each([
    {
      row: "a mid-stream compaction request",
      build: (turnMetadata: MuxMessageMetadata) =>
        createMuxMessage("auto-compaction-request", "user", "Summarize", {
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            source: "auto-compaction",
            parsed: {
              followUpContent: {
                text: "Continue",
                model: HAIKU_MODEL,
                agentId: "exec",
                muxMetadata: turnMetadata,
                dispatchOptions: { source: "internal-resume" },
              },
            },
          },
        }),
    },
    {
      row: "an on-send compaction of a wake that continues the turn",
      build: (turnMetadata: MuxMessageMetadata) =>
        createMuxMessage("wake-compaction-request", "user", "Summarize", {
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            source: "auto-compaction",
            parsed: {
              followUpContent: {
                text: "Wake",
                model: HAIKU_MODEL,
                agentId: "exec",
                muxMetadata: { type: "bash-monitor-wake", records: [] },
                workspaceTurnMetadata:
                  turnMetadata.type === "workspace-turn-task" ? turnMetadata : undefined,
              },
            },
          },
        }),
    },
    {
      row: "a legacy compaction request (continueMessage)",
      build: (turnMetadata: MuxMessageMetadata) =>
        createMuxMessage("legacy-compaction-request", "user", "Summarize", {
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            source: "auto-compaction",
            // Older builds stored the follow-up under `continueMessage`.
            parsed: {
              continueMessage: {
                text: "Continue",
                model: HAIKU_MODEL,
                agentId: "exec",
                muxMetadata: turnMetadata,
              },
            } as unknown as CompactionRequestData,
          },
        }),
    },
    {
      row: "a child's completed report",
      build: () =>
        createMuxMessage(
          "child-report",
          "user",
          formatSubagentReportEnvelope({
            taskId: "child-task",
            agentType: "explore",
            status: "completed",
            title: "Survey",
            reportMarkdown: "Done.",
          }),
          { synthetic: true, uiVisible: true }
        ),
    },
    {
      row: "a goal-pause boundary",
      build: () =>
        createMuxMessage("goal-pause", "user", "Goal paused", {
          synthetic: true,
          uiVisible: true,
          muxMetadata: { type: "goal-pause-boundary" },
        }),
    },
    {
      row: "a file snapshot",
      build: () =>
        createMuxMessage("file-snapshot", "user", "README.md contents", {
          synthetic: true,
          uiVisible: true,
          fileAtMentionSnapshot: ["@README.md"],
        }),
    },
    {
      row: "a hidden synthetic row",
      build: () => createMuxMessage("hidden-row", "user", "Internal note", { synthetic: true }),
    },
    {
      row: "a context-budget warning",
      build: () =>
        createMuxMessage("budget-warning", "user", "Context is almost full", {
          muxMetadata: {
            type: "context-budget-warning",
            contextTokens: 900,
            maxTokens: 1_000,
            budgetTokens: 800,
          },
        }),
    },
  ])(
    "interrupting a turn that restart recovery settled stops it after $row",
    async (args) => {
      await withWorkspace(async (env, ownerId) => {
        const model = failsOnceModel();
        replaceModel(env, model);
        const turn = await startFailedTurn(env, ownerId);
        await dropTurnOwnerLock(env.services, turn.taskId);
        const restarted = await restart(env, model, turn.workspaceId, async (services) => {
          await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
        });
        try {
          const { workspaceService, workspaceTurnManager } = restarted;
          const { historyService } = restarted as unknown as { historyService: HistoryService };
          assert(
            workspaceService.hasPendingAutoRetry(turn.workspaceId),
            "startup recovery resumes the turn"
          );
          const history = await historyService.getHistoryFromLatestBoundary(turn.workspaceId);
          const turnMetadata = history.success
            ? history.data.find((row) => row.metadata?.muxMetadata?.type === "workspace-turn-task")
                ?.metadata?.muxMetadata
            : undefined;
          assert(turnMetadata != null, "the turn's prompt is in its history");
          // Automatic rows after the turn's prompt continue the turn: retry still resumes it.
          assert(
            (await historyService.appendToHistory(turn.workspaceId, args.build(turnMetadata)))
              .success,
            "the row is in the turn's history"
          );

          await interruptTurn(restarted, ownerId, turn.taskId);

          const record = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
          expect({
            pending: workspaceService.hasPendingAutoRetry(turn.workspaceId),
            handle: { status: record?.status, error: record?.error },
          }).toEqual({ pending: false, handle: { status: "interrupted", error: undefined } });
        } finally {
          await restarted.dispose();
          await restarted.shutdown();
        }
      });
    },
    90_000
  );

  test("interrupting a turn that restart recovery settled stops it when its history cannot be read", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { workspaceService, workspaceTurnManager } = restarted;
        const { historyService } = restarted as unknown as { historyService: HistoryService };
        assert(
          workspaceService.hasPendingAutoRetry(turn.workspaceId),
          "startup recovery resumes the turn"
        );
        const read = historyService.getHistoryFromLatestBoundary.bind(historyService);
        let unreadable = true;
        spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementation(
          (workspaceId, ...rest) =>
            unreadable && workspaceId === turn.workspaceId
              ? Promise.resolve(Err("history unreadable"))
              : read(workspaceId, ...rest)
        );

        await interruptTurn(restarted, ownerId, turn.taskId);
        unreadable = false;

        const record = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        expect({
          pending: workspaceService.hasPendingAutoRetry(turn.workspaceId),
          handle: { status: record?.status, error: record?.error },
        }).toEqual({ pending: false, handle: { status: "interrupted", error: undefined } });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("interrupting a background turn that restart recovery settled retires the restart's wake", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId, "notify_on_terminal");
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { workspaceTurnManager } = restarted;
        const attention = (
          workspaceTurnManager as unknown as { terminalAttentionStore: TerminalAttentionStore }
        ).terminalAttentionStore;
        const wakesForTurn = async () =>
          (await attention.listPending(ownerId)).filter((wake) => wake.sourceId === turn.taskId);
        const settled = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        assert(
          settled?.terminalAttentionNotifiedAt != null && (await wakesForTurn()).length > 0,
          "restart recovery's settlement queued a wake for the owner"
        );

        await interruptTurn(restarted, ownerId, turn.taskId);

        const stopped = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        expect({
          notifiedAt: stopped?.terminalAttentionNotifiedAt,
          wakes: await wakesForTurn(),
        }).toEqual({ notifiedAt: undefined, wakes: [] });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a malformed compaction request in a restart-settled turn's history does not fail the interrupt", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { historyService } = restarted as unknown as { historyService: HistoryService };
        // Persisted rows from a damaged or older file: no `parsed` object to read.
        const malformed = createMuxMessage("malformed-compaction", "user", "Summarize", {
          synthetic: true,
          uiVisible: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: null as unknown as CompactionRequestData,
          },
        });
        assert(
          (await historyService.appendToHistory(turn.workspaceId, malformed)).success,
          "the malformed row is in the turn's history"
        );

        const interrupted = await restarted.workspaceTurnManager.interruptWorkspaceTurn(
          ownerId,
          turn.taskId
        );

        expect(interrupted.success).toBe(true);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("interrupting a superseded turn stays a no-op while its workspace still retries", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { workspaceService, workspaceTurnManager } = restarted;
        const store = (workspaceTurnManager as unknown as { taskHandleStore: TaskHandleStore })
          .taskHandleStore;
        const settled = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        assert(
          settled?.status === "interrupted" &&
            workspaceService.hasPendingAutoRetry(turn.workspaceId),
          "restart recovery settled the turn and startup recovery resumes it"
        );
        // Only a restart-recovery interrupt is resumable. A supersede says that other input took
        // the workspace over, so the retry there is not this turn's.
        const superseded = {
          ...settled,
          error:
            "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
        };
        await store.upsertWorkspaceTurn(superseded);

        await interruptTurn(restarted, ownerId, turn.taskId);

        expect({
          pending: workspaceService.hasPendingAutoRetry(turn.workspaceId),
          handle: await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId),
        }).toEqual({ pending: true, handle: superseded });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("interrupting a turn that restart recovery settled leaves a newer prompt's stream running", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceThenStreamsModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { aiService, workspaceService, workspaceTurnManager } = restarted;
        const retries = watchRetries({ ...env, services: restarted });
        // The user writes in the turn's workspace after the restart: a retry now replays the
        // user's row, not the turn's, so nothing resumes the turn.
        const sent = await workspaceService.sendMessage(turn.workspaceId, "Do something else", {
          model: HAIKU_MODEL,
          agentId: "exec",
        });
        assert(sent.success, "the user's message is sent");
        assert(
          await waitFor(() => aiService.isStreaming(turn.workspaceId), 20_000),
          "the user's message streams"
        );
        assert(
          !retries.of(turn.workspaceId).includes("auto-retry-starting"),
          "the stream is the user's, not the turn's retry"
        );

        // The newer turn must not see a stop in progress (stoppedSince, goal advancement).
        const latch = spyOn(restarted.taskService, "latchWorkspaceStopsInProgress");
        const epoch = restarted.taskService.getWorkspaceStopEpoch(turn.workspaceId);
        await interruptTurn(restarted, ownerId, turn.taskId);

        const record = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        expect({
          streaming: aiService.isStreaming(turn.workspaceId),
          latched: latch.mock.calls.length,
          epochMoved: restarted.taskService.getWorkspaceStopEpoch(turn.workspaceId) !== epoch,
          handle: { status: record?.status, error: record?.error },
        }).toEqual({
          streaming: true,
          latched: 0,
          epochMoved: false,
          handle: { status: "interrupted", error: "Workspace turn interrupted after restart" },
        });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a user's send that starts between a turn interrupt's first read and its latch keeps streaming", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceThenStreamsModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { aiService, workspaceService } = restarted;
        const { historyService } = restarted as unknown as { historyService: HistoryService };
        const read = historyService.getHistoryFromLatestBoundary.bind(historyService);
        let interrupting = false;
        let sent: Awaited<ReturnType<typeof workspaceService.sendMessage>> | undefined;
        // The first read still finds the turn's prompt newest. The user's message starts
        // streaming before the interrupt latches.
        spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementation(
          async (workspaceId, ...rest) => {
            const history = await read(workspaceId, ...rest);
            if (interrupting && workspaceId === turn.workspaceId) {
              interrupting = false;
              sent = await workspaceService.sendMessage(turn.workspaceId, "Do something else", {
                model: HAIKU_MODEL,
                agentId: "exec",
              });
              assert(
                await waitFor(() => aiService.isStreaming(turn.workspaceId), 20_000),
                "the user's message streams"
              );
            }
            return history;
          }
        );

        const epoch = restarted.taskService.getWorkspaceStopEpoch(turn.workspaceId);
        interrupting = true;
        await interruptTurn(restarted, ownerId, turn.taskId);

        assert(sent?.success === true, "the user's message is sent");
        // The second read finds the user's row: the interrupt drops its latch and bumps nothing.
        expect({
          streaming: aiService.isStreaming(turn.workspaceId),
          stopInProgress: restarted.taskService.isWorkspaceStopInProgress(turn.workspaceId),
          epochMoved: restarted.taskService.getWorkspaceStopEpoch(turn.workspaceId) !== epoch,
        }).toEqual({ streaming: true, stopInProgress: false, epochMoved: false });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a user's send during a turn interrupt's second read is refused, not aborted", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceThenStreamsModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { aiService, workspaceService, workspaceTurnManager } = restarted;
        const { historyService } = restarted as unknown as { historyService: HistoryService };
        const read = historyService.getHistoryFromLatestBoundary.bind(historyService);
        let reads = 0;
        let sent: Awaited<ReturnType<typeof workspaceService.sendMessage>> | undefined;
        // Both reads find the turn's prompt newest. The send starts while the second one runs.
        spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementation(
          async (workspaceId, ...rest) => {
            const history = await read(workspaceId, ...rest);
            if (reads > 0 && workspaceId === turn.workspaceId && (reads += 1) === 3) {
              sent = await workspaceService.sendMessage(turn.workspaceId, "Do something else", {
                model: HAIKU_MODEL,
                agentId: "exec",
              });
            }
            return history;
          }
        );

        reads = 1;
        await interruptTurn(restarted, ownerId, turn.taskId);

        assert(sent != null, "the user's send ran during the second read");
        const record = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        expect({
          sendAccepted: sent.success,
          streaming: aiService.isStreaming(turn.workspaceId),
          handle: { status: record?.status, error: record?.error },
        }).toEqual({
          sendAccepted: false,
          streaming: false,
          handle: { status: "interrupted", error: undefined },
        });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a rejected second read leaves no stop latch behind", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { historyService } = restarted as unknown as { historyService: HistoryService };
        const read = historyService.getHistoryFromLatestBoundary.bind(historyService);
        let reads = 0;
        spyOn(historyService, "getHistoryFromLatestBoundary").mockImplementation(
          async (workspaceId, ...rest) => {
            if (reads > 0 && workspaceId === turn.workspaceId && (reads += 1) === 3) {
              throw new Error("history read crashed");
            }
            return read(workspaceId, ...rest);
          }
        );

        reads = 1;
        const interrupted = await restarted.workspaceTurnManager
          .interruptWorkspaceTurn(ownerId, turn.taskId)
          .then(
            () => "returned",
            () => "rejected"
          );

        expect({
          interrupted,
          stopInProgress: restarted.taskService.isWorkspaceStopInProgress(turn.workspaceId),
        }).toEqual({ interrupted: "rejected", stopInProgress: false });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a failed handle write keeps the restart outcome's wake", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId, "notify_on_terminal");
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { workspaceTurnManager } = restarted;
        const internals = workspaceTurnManager as unknown as {
          taskHandleStore: TaskHandleStore;
          terminalAttentionStore: TerminalAttentionStore;
        };
        const wakesForTurn = async () =>
          (await internals.terminalAttentionStore.listPending(ownerId)).filter(
            (wake) => wake.sourceId === turn.taskId
          );
        assert((await wakesForTurn()).length > 0, "restart recovery queued a wake");
        const upsert = internals.taskHandleStore.upsertWorkspaceTurn.bind(
          internals.taskHandleStore
        );
        let failedWrite = false;
        // Only the Stop's own write (no error) fails.
        spyOn(internals.taskHandleStore, "upsertWorkspaceTurn").mockImplementation(
          async (record) => {
            if (!failedWrite && record.handleId === turn.taskId && record.error == null) {
              failedWrite = true;
              throw new Error("disk full");
            }
            return upsert(record);
          }
        );

        const interrupted = await workspaceTurnManager
          .interruptWorkspaceTurn(ownerId, turn.taskId)
          .then(
            () => "returned",
            () => "rejected"
          );

        const record = await workspaceTurnManager.getWorkspaceTurnRecord(ownerId, turn.taskId);
        assert(failedWrite, "the Stop's handle write failed");
        expect({
          interrupted,
          error: record?.error,
          wakes: (await wakesForTurn()).length,
        }).toEqual({
          interrupted: "rejected",
          error: "Workspace turn interrupted after restart",
          wakes: 1,
        });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a user's send during a turn interrupt's handle write is refused, not aborted", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceThenStreamsModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      await dropTurnOwnerLock(env.services, turn.taskId);
      const restarted = await restart(env, model, turn.workspaceId, async (services) => {
        await services.workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan();
      });
      try {
        const { aiService, workspaceService, workspaceTurnManager } = restarted;
        const store = (workspaceTurnManager as unknown as { taskHandleStore: TaskHandleStore })
          .taskHandleStore;
        const upsert = store.upsertWorkspaceTurn.bind(store);
        let sent: Awaited<ReturnType<typeof workspaceService.sendMessage>> | undefined;
        // The interrupt has read the turn's history and decided to stop the turn. A send that
        // started now and streamed would be aborted by that decision.
        spyOn(store, "upsertWorkspaceTurn").mockImplementation(async (record) => {
          if (record.handleId === turn.taskId && sent == null) {
            sent = await workspaceService.sendMessage(turn.workspaceId, "Do something else", {
              model: HAIKU_MODEL,
              agentId: "exec",
            });
          }
          return upsert(record);
        });

        await interruptTurn(restarted, ownerId, turn.taskId);

        assert(sent != null, "the user's send ran during the handle write");
        expect({
          sendAccepted: sent.success,
          streaming: aiService.isStreaming(turn.workspaceId),
        }).toEqual({ sendAccepted: false, streaming: false });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a restart after interrupting a turn whose tail is its automatic compaction does not resume it", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const turn = await startFailedTurn(env, ownerId);
      const { historyService } = env.services as unknown as { historyService: HistoryService };
      const history = await historyService.getHistoryFromLatestBoundary(turn.workspaceId);
      const turnMetadata = history.success
        ? history.data.find((row) => row.metadata?.muxMetadata?.type === "workspace-turn-task")
            ?.metadata?.muxMetadata
        : undefined;
      assert(turnMetadata != null, "the turn's prompt is in its history");
      // The turn's stream ran into a mid-stream compaction: its request is the tail that a
      // retry replays, and its follow-up carries the turn.
      const compaction = createMuxMessage("auto-compaction-request", "user", "Summarize", {
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          source: "auto-compaction",
          parsed: {
            followUpContent: {
              text: "Continue",
              model: HAIKU_MODEL,
              agentId: "exec",
              muxMetadata: turnMetadata,
              dispatchOptions: { source: "internal-resume" },
            },
          },
        },
      });
      assert(
        (await historyService.appendToHistory(turn.workspaceId, compaction)).success,
        "the compaction request is the turn's tail"
      );
      await interruptTurn(env.services, ownerId, turn.taskId);

      const restarted = await restart(env, model, turn.workspaceId);
      try {
        expect({
          pending: restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId),
          streaming: restarted.aiService.isStreaming(turn.workspaceId),
        }).toEqual({ pending: false, streaming: false });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a crash after a manual retry of a stopped turn does not resume the turn", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceThenStreamsModel();
      replaceModel(env, model);
      const { aiService, workspaceService } = env.services;
      const turn = await startFailedTurn(env, ownerId);
      await interruptTurn(env.services, ownerId, turn.taskId);

      // The user retries the stopped tail by hand, and the backend exits while it streams.
      const resumed = await workspaceService.resumeStream(turn.workspaceId, {
        model: HAIKU_MODEL,
        agentId: "exec",
      });
      assert(resumed.success && resumed.data.started, "the manual retry starts");
      assert(await waitFor(() => aiService.isStreaming(turn.workspaceId), 20_000), "it streams");

      const restarted = await restart(env, model, turn.workspaceId);
      try {
        expect({
          pending: restarted.workspaceService.hasPendingAutoRetry(turn.workspaceId),
          streaming: restarted.aiService.isStreaming(turn.workspaceId),
        }).toEqual({ pending: false, streaming: false });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("interrupting a turn whose workspace was removed creates no session for it", async () => {
    await withWorkspace(async (env, ownerId) => {
      replaceModel(env, failsOnceModel());
      const { aiService, workspaceService } = env.services;
      const turn = await startFailedTurn(env, ownerId);
      // Removing the workspace leaves its turn's handle running.
      assert(
        (await workspaceService.remove(turn.workspaceId, true)).success,
        "the workspace is removed"
      );
      const listeners = aiService.listenerCount("stream-start");

      await interruptTurn(env.services, ownerId, turn.taskId);

      expect(aiService.listenerCount("stream-start") - listeners).toBe(0);
    });
  }, 90_000);

  test("interrupting a queued workspace turn leaves the running turn's retry armed", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
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

      const pending = { live: workspaceService.hasPendingAutoRetry(targetId) };
      // A restart still resumes the running turn: only the queued handle was stopped.
      const restarted = await restart(env, model, targetId);
      try {
        expect({
          ...pending,
          restarted: restarted.workspaceService.hasPendingAutoRetry(targetId),
        }).toEqual({ live: true, restarted: true });
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);
});
