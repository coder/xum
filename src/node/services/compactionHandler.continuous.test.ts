import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { sliceMessagesForProviderFromLatestContextBoundary } from "@/common/utils/messages/compactionBoundary";
import { CompactionHandler } from "./compactionHandler";
import { prepareMessagesForProvider } from "./messagePipeline";
import { createTestHistoryService } from "./testHistoryService";

describe("continuous compaction provider replay", () => {
  let store: Awaited<ReturnType<typeof createTestHistoryService>>;
  const workspaceId = "continuous-wire-tests";

  beforeEach(async () => {
    store = await createTestHistoryService();
  });
  afterEach(async () => {
    await store.cleanup();
  });

  for (const provider of ["anthropic", "openai"]) {
    it(`replays the durable summary, prompt, and sliced tool pairs through the ${provider} pipeline`, async () => {
      const old = createMuxMessage(
        "old-user",
        "user",
        "Old investigation no longer needed verbatim"
      );
      const prompt = createMuxMessage("recent-user", "user", "Verify the fix");
      const answer = createMuxMessage("recent-answer", "assistant", "", {
        stepStartPartIndices: [0, 1, 2],
        usage: { inputTokens: 60_000, outputTokens: 500, totalTokens: 60_500 },
      });
      answer.parts = [
        { type: "text", text: "Earlier work replaced by the summary" },
        {
          type: "dynamic-tool",
          toolCallId: "first-check",
          toolName: "bash",
          state: "output-available",
          input: { script: "bun test", timeout_secs: 10 },
          output: { success: true, output: "Tests passed" },
        },
        {
          type: "dynamic-tool",
          toolCallId: "second-check",
          toolName: "bash",
          state: "output-available",
          input: { script: "git diff --check", timeout_secs: 10 },
          output: { success: true, output: "No whitespace errors" },
        },
      ];
      for (const message of [old, prompt, answer]) {
        expect((await store.historyService.appendToHistory(workspaceId, message)).success).toBe(
          true
        );
      }
      const before = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(before.success, "Expected readable seeded history");
      const emitter = new EventEmitter();
      const emitted: MuxMessage[] = [];
      emitter.on("chat-event", (event: { workspaceId: string; message: MuxMessage }) => {
        expect(event.workspaceId).toBe(workspaceId);
        emitted.push(event.message);
      });
      const handler = new CompactionHandler({
        workspaceId,
        historyService: store.historyService,
        sessionDir: path.join(store.tempDir, "pending"),
        emitter,
      });
      await handler.preparePendingStateFromMessages(before.data);
      const tail = [
        prompt,
        {
          ...answer,
          parts: answer.parts.slice(1),
          metadata: { ...answer.metadata, stepStartPartIndices: [0, 1] },
        },
      ];
      expect(
        await handler.persistContinuousCompaction({
          shouldPersist: () => true,
          messages: before.data,
          text: "The bug is fixed; verification is in progress.",
          model: `${provider}:test-model`,
          tail,
          systemMessageTokens: 200,
          attachmentTokens: 50,
        })
      ).toBe(true);
      const after = await store.historyService.getHistoryFromLatestBoundary(workspaceId);
      assert(after.success, "Expected durable boundary and tail");
      expect(after.data).toHaveLength(3);
      expect(emitted.map((row) => row.id)).toEqual(after.data.map((row) => row.id));
      expect(after.data.slice(1).every((row) => row.metadata?.uiVisible === true)).toBe(true);
      expect(after.data[2].metadata?.usage).toBeUndefined();
      expect(after.data[2].metadata?.contextUsage).toBeUndefined();
      const wire = await prepareMessagesForProvider({
        messagesWithSentinel: sliceMessagesForProviderFromLatestContextBoundary(after.data),
        effectiveAgentId: "exec",
        toolNamesForSentinel: [],
        providerForMessages: provider,
        effectiveThinkingLevel: "off",
        modelString: `${provider}:test-model`,
        workspaceId,
      });
      const text = wire.flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      );
      expect(text).toContain("The bug is fixed; verification is in progress.");
      expect(text).toContain("Verify the fix");
      expect(text).not.toContain("Old investigation no longer needed verbatim");
      expect(text).not.toContain("Earlier work replaced by the summary");
      const calls = wire.flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "tool-call")
          : []
      );
      const results = wire.flatMap((message) =>
        message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : []
      );
      expect(calls.map((part) => part.toolCallId)).toEqual(["first-check", "second-check"]);
      expect(results.map((part) => part.toolCallId)).toEqual(calls.map((part) => part.toolCallId));
      expect(calls.map((part) => part.input)).toEqual(
        answer.parts.slice(1).map((part) => (part.type === "dynamic-tool" ? part.input : undefined))
      );
      expect(results.map((part) => part.output)).toEqual([
        { type: "json", value: { success: true, output: "Tests passed" } },
        { type: "json", value: { success: true, output: "No whitespace errors" } },
      ]);
    });
  }
});
