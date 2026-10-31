import { describe, expect, spyOn, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
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

function answeringModel(onStream: () => void): MockLanguageModelV3 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV3({
    doStream: () => {
      onStream();
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "a" },
            { type: "text-delta", id: "a", delta: "done" },
            { type: "text-end", id: "a" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      });
    },
  });
}

describe("direct create: a user Stop on the child during its first send", () => {
  test("refuses the brief although the Stop returned before the brief reached the session", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    try {
      await setupProviders(env, { anthropic: { apiKey: "mock-model-key" } });
      const parent = await createWorkspace(env, repoPath, generateBranchName("first-send-stop"));
      if (!parent.success) throw new Error(parent.error);
      const parentId = parent.metadata.id;
      await env.services.initStateManager.waitForInit(parentId);

      let providerRequests = 0;
      const factory = (
        env.services.aiService as unknown as { providerModelFactory: ProviderModelFactory }
      ).providerModelFactory;
      spyOn(factory, "resolveAndCreateModel").mockImplementation(() =>
        Promise.resolve(
          Ok({
            model: answeringModel(() => providerRequests++),
            effectiveModelString: HAIKU_MODEL,
            canonicalModelString: HAIKU_MODEL,
            canonicalProviderName: "anthropic",
            canonicalModelId: HAIKU_MODEL.slice(HAIKU_MODEL.indexOf(":") + 1),
            wireProviderName: "anthropic",
          } satisfies ResolveAndCreateModelResult)
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

      const created = env.services.taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Survey the repository",
        title: "Stopped child",
      });
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
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});
