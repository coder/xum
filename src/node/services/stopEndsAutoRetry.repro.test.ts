import { describe, expect, spyOn, test } from "bun:test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { Ok } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { createConfigStores } from "@/node/config";
import { AUTO_RETRY_PREFERENCE_FILE, AgentSession } from "@/node/services/agentSession";
import { hasStartupAbandonMarker } from "@/node/services/agentSession.testHarness";
import { ServiceContainer } from "@/node/services/serviceContainer";
import { nodeSessionFiles } from "@/node/services/sessionFiles/nodeSessionFiles";
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

  test("a turn interrupt reaches a session that is still in its startup recovery", async () => {
    await withWorkspace(async (env, workspaceId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const retries = watchRetries(env);
      const sent = await env.services.workspaceService.sendMessage(
        workspaceId,
        "Survey the repository",
        { model: HAIKU_MODEL, agentId: "exec" }
      );
      assert(sent.success, "the turn is accepted");
      await assertBackoffPending(env, retries, workspaceId);

      // The backend exits with the turn in its backoff, so startup recovery resumes it in a
      // session that is not registered yet. What interruptWorkspaceTurn does to its target lands
      // while that recovery runs.
      const restarted = await restart(env, model, workspaceId, async (services) => {
        services.workspaceService.abandonAutoRetry(workspaceId, "task_stopped");
        await services.workspaceService.recordStopForStartupRecovery(workspaceId);
      });
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a Stop during startup recovery's first await keeps it from arming a retry", async () => {
    await withWorkspace(async (env, workspaceId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const retries = watchRetries(env);
      const sent = await env.services.workspaceService.sendMessage(
        workspaceId,
        "Survey the repository",
        { model: HAIKU_MODEL, agentId: "exec" }
      );
      assert(sent.success, "the turn is accepted");
      await assertBackoffPending(env, retries, workspaceId);

      // A turn interrupt's abandon lands while startup recovery awaits its first read (the
      // cancellation record), and its startup record has not been written yet.
      const restarted = await restart(env, model, workspaceId, (services, session) => {
        const host = session as unknown as { compactionRecoveryBlocked: () => Promise<boolean> };
        const blocked = host.compactionRecoveryBlocked.bind(session);
        let stopped = false;
        spyOn(host, "compactionRecoveryBlocked").mockImplementation(async () => {
          const result = await blocked();
          if (!stopped) {
            stopped = true;
            services.workspaceService.abandonAutoRetry(workspaceId, "task_stopped");
          }
          return result;
        });
        return Promise.resolve();
      });
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a turn interrupt's startup record ends a retry that startup recovery armed after its abandon", async () => {
    await withWorkspace(async (env, workspaceId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const retries = watchRetries(env);
      const sent = await env.services.workspaceService.sendMessage(
        workspaceId,
        "Survey the repository",
        { model: HAIKU_MODEL, agentId: "exec" }
      );
      assert(sent.success, "the turn is accepted");
      await assertBackoffPending(env, retries, workspaceId);

      // The interrupt's abandon lands before startup recovery captures anything, and its record
      // only after that recovery armed the interrupted tail again.
      const restarted = await restart(env, model, workspaceId, (services) => {
        services.workspaceService.abandonAutoRetry(workspaceId, "task_stopped");
        return Promise.resolve();
      });
      try {
        assert(
          restarted.workspaceService.hasPendingAutoRetry(workspaceId),
          "startup recovery armed a retry after the abandon"
        );
        await restarted.workspaceService.recordStopForStartupRecovery(workspaceId);
        expect(restarted.workspaceService.hasPendingAutoRetry(workspaceId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("a turn interrupt writes its startup record again after a failed write", async () => {
    await withWorkspace(async (env, ownerId) => {
      const model = failsOnceModel();
      replaceModel(env, model);
      const { workspaceTurnManager } = env.services;
      const retries = watchRetries(env);
      const turn = await workspaceTurnManager.createWorkspaceTurn({
        ownerWorkspaceId: ownerId,
        prompt: "Survey the repository",
        title: "Stopped turn",
        workspace: { mode: "new" },
      });
      if (!turn.success) throw new Error(turn.error);
      const targetId = turn.data.workspaceId;
      await assertBackoffPending(env, retries, targetId);

      // The real stack's HistoryService writes the session files through nodeSessionFiles.
      const files = nodeSessionFiles.promises;
      const writeFile = files.writeFile.bind(files);
      let failedWrites = 0;
      const write = spyOn(files, "writeFile").mockImplementation((file, ...rest) => {
        if (
          failedWrites === 0 &&
          typeof file === "string" &&
          file.endsWith(AUTO_RETRY_PREFERENCE_FILE)
        ) {
          failedWrites += 1;
          return Promise.reject(new Error("ENOSPC: no space left on device"));
        }
        return writeFile(file, ...rest);
      });
      try {
        const interrupted = await workspaceTurnManager.interruptWorkspaceTurn(
          ownerId,
          turn.data.taskId
        );
        assert(interrupted.success, "the turn interrupt succeeds");
      } finally {
        write.mockRestore();
      }
      assert(failedWrites === 1, "the first write of the startup record failed");

      const restarted = await restart(env, model, targetId);
      try {
        expect(restarted.workspaceService.hasPendingAutoRetry(targetId)).toBe(false);
      } finally {
        await restarted.dispose();
        await restarted.shutdown();
      }
    });
  }, 90_000);

  test("interrupting a queued workspace turn leaves the running turn's retry armed", async () => {
    await withWorkspace(async (env, ownerId) => {
      replaceModel(env, failsOnceModel());
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

      expect({
        pending: workspaceService.hasPendingAutoRetry(targetId),
        // A restart must still resume the running turn: the queued interrupt records no Stop.
        startupRecord: await hasStartupAbandonMarker(env.config.sessionsDir, targetId),
      }).toEqual({ pending: true, startupRecord: false });
    });
  }, 90_000);
});
