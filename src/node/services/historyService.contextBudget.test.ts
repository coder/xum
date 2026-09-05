import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "./testHistoryService";
import { prepareProviderRequestMessages } from "./turnContextAssembler";

const workspaceId = "budget-rejection";

describe("HistoryService context-budget request rejection", () => {
  let h: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    h = await createTestHistoryService();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  test("rejects all owned prelude kinds but preserves unrelated history and stale references", async () => {
    const prior = createMuxMessage("prior", "user", "Prior request");
    const shared = createMuxMessage("shared", "user", "Previously accepted skill", {
      synthetic: true,
      agentSkillSnapshot: { skillName: "shared", scope: "project", sha256: "shared" },
    });
    const file = createMuxMessage("file", "user", "File expansion", {
      synthetic: true,
      fileAtMentionSnapshot: ["@file.txt"],
    });
    const skill = createMuxMessage("skill", "user", "Skill expansion", {
      synthetic: true,
      agentSkillSnapshot: { skillName: "test", scope: "project", sha256: "test" },
    });
    const mcp = createMuxMessage("mcp", "user", "MCP expansion", {
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "server",
        promptName: "prompt",
        commandKey: "prompt",
        invokingMessageId: "trigger",
      },
    });
    const peer = createMuxMessage("peer", "assistant", "Peer payload", { synthetic: true });
    const future = createMuxMessage("future", "assistant", "Later payload", { synthetic: true });
    const trigger = createMuxMessage("trigger", "user", "Rejected request", {
      requestPreludeMessageIds: [
        file.id,
        skill.id,
        mcp.id,
        peer.id,
        prior.id,
        future.id,
        "missing",
      ],
    });
    const rows = [prior, shared, file, skill, mcp, peer, trigger, future];
    expect((await h.historyService.appendManyToHistory(workspaceId, rows)).success).toBe(true);
    // Use persisted ownership, not a stale caller copy's references.
    const result = await h.historyService.rejectContextBudgetRequest(workspaceId, {
      ...trigger,
      metadata: { ...trigger.metadata, requestPreludeMessageIds: [shared.id] },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.data.map((row) => row.id)).toEqual([
      file.id,
      skill.id,
      mcp.id,
      peer.id,
      trigger.id,
    ]);
    const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!persisted.success) throw new Error(persisted.error);
    expect(persisted.data.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(persisted.data.map((row) => row.parts)).toEqual(rows.map((row) => row.parts));
    expect(
      prepareProviderRequestMessages(persisted.data, "openai", "off").providerRequestMessages.map(
        (row) => row.id
      )
    ).toEqual([prior.id, shared.id, future.id]);
  });

  test("a stale trigger identity leaves the entire request unchanged", async () => {
    const payload = createMuxMessage("payload", "assistant", "Payload", { synthetic: true });
    const trigger = createMuxMessage("trigger", "user", "Request", {
      requestPreludeMessageIds: [payload.id],
    });
    expect(
      (await h.historyService.appendManyToHistory(workspaceId, [payload, trigger])).success
    ).toBe(true);
    const result = await h.historyService.rejectContextBudgetRequest(workspaceId, {
      ...trigger,
      id: "removed",
    });
    expect(result.success).toBe(false);
    const persisted = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!persisted.success) throw new Error(persisted.error);
    expect(persisted.data.every((row) => !row.metadata?.contextBudgetRejected)).toBe(true);
  });
});
