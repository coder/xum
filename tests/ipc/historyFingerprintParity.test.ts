/**
 * Parity gate for the edit precondition: the client's evidence — built over rows it received
 * through the real oRPC boundary, both replayed history and live-streamed turns assembled by
 * the aggregator — must be accepted by the backend's verification over the persisted rows.
 * Any class of parts that does not round-trip identically must be normalized in the shared
 * primitive; this test is what proves the normalization is sufficient.
 */
import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "./setup";
import { createStreamCollector } from "./streamCollector";
import { createTempGitRepo, generateBranchName, trustProject } from "./helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { isCaughtUpMessage, isMuxMessage } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import type { HistoryService } from "@/node/services/historyService";
import { buildHistoryEditPrecondition } from "@/common/utils/history/editTruncation";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/** ServiceContainer keeps the history service private; the parity gate needs the real one. */
function historyServiceOf(env: Awaited<ReturnType<typeof createTestEnvironment>>): HistoryService {
  return (env.services as unknown as { historyService: HistoryService }).historyService;
}

function committedRows(aggregator: StreamingMessageAggregator): MuxMessage[] {
  const active = aggregator.getActiveStreamMessageId();
  return aggregator
    .getAllMessages()
    .filter((row) => row.id !== active && row.metadata?.partial !== true);
}

async function replayIntoFreshAggregator(
  env: Awaited<ReturnType<typeof createTestEnvironment>>,
  workspaceId: string
): Promise<StreamingMessageAggregator> {
  const controller = new AbortController();
  const iterator = await env.orpc.workspace.onChat(
    { workspaceId, mode: { type: "full" } },
    { signal: controller.signal }
  );
  const rows: MuxMessage[] = [];
  try {
    for await (const event of iterator) {
      if (isMuxMessage(event)) rows.push(event);
      if (isCaughtUpMessage(event)) break;
    }
  } finally {
    controller.abort();
  }
  const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
  aggregator.loadHistoricalMessages(rows, false, { mode: "replace" });
  return aggregator;
}

describe("history edit precondition parity over real IPC", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("replayed and live-assembled rows produce evidence the backend accepts", async () => {
    const env = await createTestEnvironment();
    env.services.aiService.enableMockMode();
    const repoPath = await createTempGitRepo();
    let workspaceId: string | undefined;
    try {
      await trustProject(env, repoPath);
      const created = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName: generateBranchName("fingerprint-parity"),
        trunkBranch: await detectDefaultTrunkBranch(repoPath),
      });
      if (!created.success) throw new Error(created.error);
      workspaceId = created.metadata.id;

      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      await collector.waitForSubscription(10_000);

      // Live turns covering text, tool calls, reasoning and an image attachment on the user row.
      const prompts: {
        text: string;
        fileParts?: { url: string; mediaType: string; filename?: string }[];
      }[] = [
        { text: "Plain text turn" },
        { text: "[mock:tool:file-read] what's in readme.md?" },
        { text: "[mock:reasoning:quicksort] explain quicksort algorithm step by step" },
        {
          text: "Turn with an image",
          fileParts: [
            { url: "data:image/png;base64,AAAA", mediaType: "image/png", filename: "a.png" },
          ],
        },
      ];
      for (const [index, prompt] of prompts.entries()) {
        const result = await env.orpc.workspace.sendMessage({
          workspaceId,
          message: prompt.text,
          options: {
            model: WORKSPACE_DEFAULTS.model,
            agentId: WORKSPACE_DEFAULTS.agentId,
            ...(prompt.fileParts ? { fileParts: prompt.fileParts } : {}),
          },
        });
        expect(result.success).toBe(true);
        await collector.waitForEventN("stream-end", index + 1, 30_000);
      }
      await collector.waitForStop().catch(() => undefined);

      // The live client view: every event applied in order, as WorkspaceStore does.
      const live = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
      for (const event of collector.getEvents()) {
        if (isMuxMessage(event)) {
          live.loadHistoricalMessages([event], false, { mode: "append" });
        } else {
          applyWorkspaceChatEventToAggregator(live, event, { allowSideEffects: false });
        }
      }
      const persisted = await historyServiceOf(env).getHistoryFromLatestBoundary(workspaceId);
      if (!persisted.success) throw new Error(persisted.error);
      const firstUser = persisted.data.find((row) => row.role === "user");
      if (!firstUser) throw new Error("expected a persisted user row");
      expect(committedRows(live).map((row) => row.id)).toEqual(persisted.data.map((row) => row.id));

      // Replayed view: a fresh full replay through oRPC.
      const replayed = await replayIntoFreshAggregator(env, workspaceId);
      const replayedEvidence = buildHistoryEditPrecondition(committedRows(replayed), firstUser.id);
      const liveEvidence = buildHistoryEditPrecondition(committedRows(live), firstUser.id);
      if (!replayedEvidence || !liveEvidence)
        throw new Error("expected evidence for the first turn");
      // Both client views must agree with each other and with the backend's verification.
      expect(liveEvidence).toEqual(replayedEvidence);
      const verified = await historyServiceOf(env).truncateAfterMessage(
        workspaceId,
        replayedEvidence.rangeStartMessageId,
        { precondition: replayedEvidence }
      );
      expect(verified.success).toBe(true);
    } finally {
      if (workspaceId) {
        await env.orpc.workspace
          .remove({ workspaceId, options: { force: true } })
          .catch(() => undefined);
      }
      await cleanupTestEnvironment(env);
    }
  }, 120_000);
});
