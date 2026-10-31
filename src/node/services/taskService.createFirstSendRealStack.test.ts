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

/** Answers "done"; a stream finishes only once `finish` resolves. */
function answeringModel(onStream: () => void, finish: () => Promise<void>): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: () => {
      onStream();
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

function createChild(env: TestEnvironment, parentId: string) {
  return env.services.taskService.create({
    parentWorkspaceId: parentId,
    kind: "agent",
    agentId: "explore",
    prompt: "Survey the repository",
    title: "First-send child",
  });
}

describe("direct create on the real stack: the child's first send after the release", () => {
  test("a user Stop on the child refuses the brief although the Stop returned before the brief reached the session", async () => {
    await withParent(async (env, parentId, repoPath) => {
      let providerRequests = 0;
      useModel(
        env,
        answeringModel(
          () => providerRequests++,
          () => Promise.resolve()
        )
      );
      const history = (env.services as unknown as { historyService: HistoryService })
        .historyService;
      const capture = history.captureCompactionReplacement.bind(history);
      const held = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      // Holds the child's brief at the first await of its send, after its synchronous entry.
      let holding = true;
      spyOn(history, "captureCompactionReplacement").mockImplementation(
        async (workspaceId, options) => {
          if (workspaceId !== parentId && holding) {
            holding = false;
            held.resolve(workspaceId);
            await release.promise;
          }
          return capture(workspaceId, options);
        }
      );

      const created = createChild(env, parentId);
      const childId = await held.promise;
      const stopping = env.services.workspaceService.interruptStream(childId, {
        disableAutoRetry: true,
        retireBashMonitorAttention: true,
      });
      const stopReturned = await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
      release.resolve();
      const result = await created;
      await stopping;

      expect(stopReturned).toBe(true);
      expect(result.success).toBe(false);
      expect(providerRequests).toBe(0);
      const row = env.config
        .loadConfigOrDefault()
        .projects.get(repoPath)
        ?.workspaces.find((workspace) => workspace.id === childId);
      expect(row?.taskStatus).toBe("interrupted");
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
