import { describe, expect, spyOn, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { Ok } from "@/common/types/result";
import type { HistoryService } from "@/node/services/historyService";
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

// The real ServiceContainer (TaskService, WorkspaceService, AgentSession, AIService); only the
// language model is substituted.

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const BRIEF = "Survey the repository and list every TODO";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await sleep(10);
  }
  return true;
}

/** Answers "done" and records each request's prompt; a stream finishes once `finish` resolves. */
function answeringModel(
  onStream: (prompt: string) => void,
  finish: () => Promise<void>
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: (options) => {
      onStream(JSON.stringify(options.prompt));
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "a" });
            controller.enqueue({ type: "text-delta", id: "a", delta: "done" });
            await finish();
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

async function withParent(
  run: (env: TestEnvironment, parentId: string, repoPath: string) => Promise<void>
): Promise<void> {
  const env = await createTestEnvironment();
  const repoPath = await createTempGitRepo();
  try {
    await setupProviders(env, { anthropic: { apiKey: "mock-model-key" } });
    const parent = await createWorkspace(env, repoPath, generateBranchName("first-send"));
    if (!parent.success) throw new Error(parent.error);
    await env.services.initStateManager.waitForInit(parent.metadata.id);
    await run(env, parent.metadata.id, repoPath);
  } finally {
    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(repoPath);
  }
}

/** `beforeModel` runs before each model resolution, after the turn was admitted. */
function useModel(
  env: TestEnvironment,
  model: MockLanguageModelV3,
  beforeModel: () => Promise<void> = () => Promise.resolve()
): void {
  const factory = (
    env.services.aiService as unknown as { providerModelFactory: ProviderModelFactory }
  ).providerModelFactory;
  spyOn(factory, "resolveAndCreateModel").mockImplementation(async () => {
    await beforeModel();
    return Ok({
      model,
      effectiveModelString: HAIKU_MODEL,
      canonicalModelString: HAIKU_MODEL,
      canonicalProviderName: "anthropic",
      canonicalModelId: HAIKU_MODEL.slice(HAIKU_MODEL.indexOf(":") + 1),
      wireProviderName: "anthropic",
    } satisfies ResolveAndCreateModelResult);
  });
}

function historyOf(env: TestEnvironment): HistoryService {
  return (env.services as unknown as { historyService: HistoryService }).historyService;
}

async function historyHasBrief(env: TestEnvironment, workspaceId: string): Promise<boolean> {
  const history = await historyOf(env).getHistoryFromLatestBoundary(workspaceId);
  return history.success && JSON.stringify(history.data).includes(BRIEF);
}

function createChild(env: TestEnvironment, parentId: string) {
  return env.services.taskService.create({
    parentWorkspaceId: parentId,
    kind: "agent",
    agentId: "explore",
    prompt: BRIEF,
    title: "First-send child",
  });
}

describe("direct create on the real stack: the child's first send after the release", () => {
  test("a parent Stop issued while create holds its locks leaves the brief in history for a resume", async () => {
    await withParent(async (env, parentId) => {
      const prompts: string[] = [];
      useModel(
        env,
        answeringModel(
          (prompt) => prompts.push(prompt),
          () => Promise.resolve()
        )
      );
      const taskService = env.services.taskService;
      const svc = taskService as unknown as {
        emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
      };
      const emit = svc.emitWorkspaceMetadata.bind(taskService);
      let childId = "";
      let stopping: Promise<string[]> | undefined;
      // The user stops the parent while the create still runs its locked steps.
      spyOn(svc, "emitWorkspaceMetadata").mockImplementation((id) => {
        if (id !== parentId && stopping == null) {
          childId = id;
          stopping = taskService.terminateAllDescendantAgentTasks(parentId);
        }
        return emit(id);
      });

      await createChild(env, parentId);
      expect(await stopping).toEqual([childId]);
      await waitFor(() => !taskService.isWorkspaceStopInProgress(childId), 5_000);
      const before = prompts.length;
      const resumed = await env.services.workspaceService.sendMessage(childId, "please continue", {
        model: HAIKU_MODEL,
        agentId: "explore",
      });

      expect(resumed.success).toBe(true);
      expect(await waitFor(() => prompts.length > before, 10_000)).toBe(true);
      expect(prompts.at(-1)).toContain(BRIEF);
      expect(prompts.at(-1)).toContain("please continue");
    });
  }, 120_000);

  test("a user Stop on the child while its brief builds the request returns at once and keeps the brief", async () => {
    await withParent(async (env, parentId, repoPath) => {
      let providerRequests = 0;
      const building = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let holding = true;
      useModel(
        env,
        answeringModel(
          () => providerRequests++,
          () => Promise.resolve()
        ),
        async () => {
          if (!holding) return;
          holding = false;
          building.resolve();
          await release.promise;
        }
      );
      const childRow = () =>
        env.config
          .loadConfigOrDefault()
          .projects.get(repoPath)
          ?.workspaces.find((workspace) => workspace.parentWorkspaceId === parentId);

      const created = createChild(env, parentId);
      try {
        await building.promise;
        const childId = childRow()?.id ?? "";
        const stopping = env.services.workspaceService.interruptStream(childId, {
          disableAutoRetry: true,
          retireBashMonitorAttention: true,
        });
        const stopReturned = await Promise.race([
          stopping.then(() => true),
          sleep(5_000).then(() => false),
        ]);
        release.resolve();
        await created;
        await stopping;

        expect(stopReturned).toBe(true);
        expect(providerRequests).toBe(0);
        expect(env.services.aiService.isStreaming(childId)).toBe(false);
        expect(await historyHasBrief(env, childId)).toBe(true);
      } finally {
        release.resolve();
        await created;
      }
    });
  }, 120_000);

  test("parent guidance sent while the first send returns is delivered after the child's stream ends", async () => {
    await withParent(async (env, parentId) => {
      const finishFirstStream = Promise.withResolvers<void>();
      let streams = 0;
      useModel(
        env,
        answeringModel(
          () => streams++,
          // Only the brief's stream waits: later turns (the guidance) finish at once.
          () => (streams === 1 ? finishFirstStream.promise : Promise.resolve())
        )
      );
      const workspaceService = env.services.workspaceService;
      const send = workspaceService.sendMessage.bind(workspaceService);
      const sendReturned = Promise.withResolvers<string>();
      const releaseSend = Promise.withResolvers<void>();
      let holdingSend = true;
      // The brief's send has started its stream; its result reaches TaskService only on release.
      spyOn(workspaceService, "sendMessage").mockImplementation(async (workspaceId, ...rest) => {
        const result = await send(workspaceId, ...rest);
        if (workspaceId !== parentId && holdingSend) {
          holdingSend = false;
          sendReturned.resolve(workspaceId);
          await releaseSend.promise;
        }
        return result;
      });
      const streamEnded = Promise.withResolvers<void>();
      env.services.aiService.on("stream-end", (event: { workspaceId?: string }) => {
        if (event.workspaceId !== parentId) streamEnded.resolve();
      });

      const created = createChild(env, parentId);
      try {
        const childId = await sendReturned.promise;
        const guided = env.services.taskService.sendMessageToDescendantAgentTask(
          parentId,
          childId,
          "Followup guidance.",
          "tool-end"
        );
        // The guidance reaches its wait for the brief's send while the brief's stream is open.
        await new Promise((resolve) => setTimeout(resolve, 50));
        finishFirstStream.resolve();
        await streamEnded.promise;
        releaseSend.resolve();

        expect((await created).success).toBe(true);
        expect(await guided).toMatchObject({ success: true });
      } finally {
        finishFirstStream.resolve();
        releaseSend.resolve();
        await created;
      }
    });
  }, 120_000);
});
