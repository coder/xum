import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { readLatestAssistantReply } from "./latestAssistantReply";

let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
beforeEach(async () => {
  fixture = await createTestHistoryService();
});
afterEach(async () => {
  await fixture.cleanup();
});

async function append(message: MuxMessage) {
  expect((await fixture.historyService.appendToHistory("ws", message)).success).toBe(true);
}

describe("readLatestAssistantReply", () => {
  test("skips machine rows and stops at the manual-reset floor", async () => {
    await append(createMuxMessage("reply", "assistant", "Real reply"));
    await append(
      createMuxMessage("summary", "assistant", "Compacted context", {
        compactionBoundary: true,
        compacted: "idle",
      })
    );
    await append(createMuxMessage("envelope", "assistant", "peer text", { synthetic: true }));
    expect(await readLatestAssistantReply(fixture.historyService, "ws")).toEqual({
      ok: true,
      reply: { text: "Real reply", messageId: "reply" },
    });
    await append(
      createMuxMessage("reset", "assistant", "", { contextBoundaryKind: "reset", synthetic: true })
    );
    expect(await readLatestAssistantReply(fixture.historyService, "ws")).toEqual({
      ok: true,
      reply: null,
    });
  });

  test("legacy `compacted: false` rows are ordinary replies", async () => {
    await append(createMuxMessage("reply", "assistant", "Plain reply", { compacted: false }));
    expect(await readLatestAssistantReply(fixture.historyService, "ws")).toEqual({
      ok: true,
      reply: { text: "Plain reply", messageId: "reply" },
    });
  });

  test("an aborted signal ends the read as a failure, not as no reply", async () => {
    await append(createMuxMessage("reply", "assistant", "Real reply"));
    const controller = new AbortController();
    controller.abort();
    expect(await readLatestAssistantReply(fixture.historyService, "ws", controller.signal)).toEqual(
      { ok: false }
    );
  });

  test("no retained history is no reply; other read failures are failures", async () => {
    expect(await readLatestAssistantReply(fixture.historyService, "missing")).toEqual({
      ok: true,
      reply: null,
    });
    const scan = spyOn(fixture.historyService, "scanHistoryBounded").mockRejectedValueOnce(
      new Error("stale_cursor")
    );
    expect(await readLatestAssistantReply(fixture.historyService, "ws")).toEqual({ ok: false });
    scan.mockRestore();
  });
});
