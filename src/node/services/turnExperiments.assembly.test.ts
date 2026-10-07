import { describe, expect, spyOn, test } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { Ok } from "@/common/types/result";
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
  createStreamCollector,
  createTempGitRepo,
  createWorkspace,
  generateBranchName,
  sendMessageWithModel,
} from "../../../tests/ipc/helpers";
import { assertStreamSuccess, type StreamCollector } from "../../../tests/ipc/streamCollector";

// Runs under `bun test` (not Jest) for the same reason as mcpIdentity.assembly.test.ts:
// enabling PTC loads prettier through dynamic import().
function answeringModel(): MockLanguageModelV3 {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "done" },
            { type: "text-end", id: "answer" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }),
  });
}

describe("turn experiments", () => {
  test("a send carrying experiments, as an old bundle sends them, gets the server's toolset", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    let workspaceId = "";
    let collector: StreamCollector | undefined;
    try {
      await setupProviders(env, { anthropic: { apiKey: "mock-model-key" } });
      const workspace = await createWorkspace(env, repoPath, generateBranchName("turn-exp"));
      if (!workspace.success) throw new Error(workspace.error);
      workspaceId = workspace.metadata.id;
      const model = answeringModel();
      const factory = (
        env.services.aiService as unknown as { providerModelFactory: ProviderModelFactory }
      ).providerModelFactory;
      spyOn(factory, "resolveAndCreateModel").mockResolvedValue(
        Ok({
          model,
          effectiveModelString: HAIKU_MODEL,
          canonicalModelString: HAIKU_MODEL,
          canonicalProviderName: "anthropic",
          canonicalModelId: HAIKU_MODEL.slice(HAIKU_MODEL.indexOf(":") + 1),
          wireProviderName: "anthropic",
          routedThroughGateway: false,
        } satisfies ResolveAndCreateModelResult)
      );
      collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      await collector.waitForSubscription(5_000);
      const sendWithPtc = async (programmaticToolCalling: boolean) => {
        collector!.clear();
        // Old bundles still send `experiments`; the field is no longer in the schema.
        const oldBundleOptions = {
          thinkingLevel: "off",
          agentId: "exec",
          experiments: { programmaticToolCalling },
        } as const;
        const sent = await sendMessageWithModel(
          env,
          workspaceId,
          "hello",
          HAIKU_MODEL,
          oldBundleOptions
        );
        expect(sent.success).toBe(true);
        expect(await collector!.waitForEvent("stream-end", 60_000)).not.toBeNull();
        assertStreamSuccess(collector!);
        return (model.doStreamCalls.at(-1)?.tools ?? []).map((tool) => tool.name);
      };

      const serverOff = await sendWithPtc(true);
      expect(serverOff).toContain("file_read");
      expect(serverOff).not.toContain("code_execution");

      await env.services.experimentsService.setOverride(
        EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
        true
      );
      const serverOn = await sendWithPtc(false);
      expect(serverOn).toContain("code_execution");
      expect(serverOn).not.toContain("file_read");
    } finally {
      collector?.stop();
      if (workspaceId) {
        await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
      }
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});
