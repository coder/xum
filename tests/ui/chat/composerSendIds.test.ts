/**
 * Idempotent composer sends (formal/composer-drafts/ComposerSends.tla, FixRenderer; D2, D4, D5):
 * every send carries a renderer-minted id, its text stays in the durable draft (retained under a
 * pending-send entry) until the backend answers for the id, and only that answer removes it
 * (accepted) or shows it again (not accepted). The backend is real; WorkspaceService.sendMessage
 * is wrapped only to hold or fail one reply. A second DraftStore plays a reloaded renderer (or a
 * second window) on the same backend.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { fireEvent, waitFor } from "@testing-library/react";
import * as fs from "fs/promises";
import * as path from "path";

import { createTestApiClient } from "@/browser/testUtils";
import { DraftStore, getDraftStore } from "@/browser/stores/DraftStore";
import type { DraftScope } from "@/common/orpc/schemas/drafts";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const WAIT = { timeout: 30_000 };

type SendMessage = AppHarness["env"]["services"]["workspaceService"]["sendMessage"];

/** Hold the FIRST sendMessage call until `release()`; later calls (a retry) pass through. */
function holdFirstSend(
  app: AppHarness,
  reply: (realSend: SendMessage, args: Parameters<SendMessage>) => ReturnType<SendMessage>
) {
  const workspaceService = app.env.services.workspaceService;
  const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first: ReturnType<SendMessage> | undefined;
  const spy = jest
    .spyOn(workspaceService, "sendMessage")
    .mockImplementation((...args: Parameters<SendMessage>) => {
      if (first !== undefined) return realSend(...args);
      first = (async () => {
        await gate;
        return await reply(realSend, args);
      })();
      return first;
    });
  return {
    spy,
    release: () => release(),
    settle: async () => {
      release();
      await Promise.allSettled([first]);
    },
  };
}

const scopeOf = (app: AppHarness): Extract<DraftScope, { kind: "workspace" }> => ({
  kind: "workspace",
  workspaceId: app.workspaceId,
});

/** The draft file's legacy text: what an older build reads as the whole draft. */
async function legacyDraftText(app: AppHarness): Promise<string | null> {
  const file = path.join(app.env.config.sessionsDir, app.workspaceId, "draft.json");
  try {
    return (JSON.parse(await fs.readFile(file, "utf-8")) as { text: string }).text;
  } catch {
    return null;
  }
}

/** Persisted user rows whose text is `text`. */
async function userRows(app: AppHarness, text: string): Promise<number> {
  const history = await app.env.services
    .toORPCContext()
    .historyService.getHistoryFromLatestBoundary(app.workspaceId);
  if (!history.success) throw new Error(String(history.error));
  return history.data.filter(
    (message) =>
      message.role === "user" &&
      message.parts.some((part) => part.type === "text" && part.text === text)
  ).length;
}

const pendingIds = async (app: AppHarness) =>
  ((await app.env.services.draftService.get(scopeOf(app))).pendingSends ?? []).map(
    ({ sendId }) => sendId
  );

const reloaded: DraftStore[] = [];
/** Another renderer on the same backend (a reload or a second window). */
async function otherRenderer(app: AppHarness): Promise<DraftStore> {
  const store = new DraftStore();
  reloaded.push(store);
  store.setClient(createTestApiClient(app.env.orpc));
  await store.whenReady();
  return store;
}

describe("idempotent composer sends", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });
  afterEach(() => {
    for (const store of reloaded.splice(0)) store.setClient(null);
  });

  test("a send accepted before an Err reply is not put back (D2)", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-accepted-err" });
    const held = holdFirstSend(app, async (realSend, args) => {
      await realSend(...args);
      return { success: false, error: { type: "unknown", raw: "reply failed after accept" } };
    });
    try {
      await app.chat.send("accepted message");
      held.release();
      await app.chat.expectTranscriptContains("Mock response: accepted message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      await held.settle();
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      expect(await app.chat.getInputValue()).toBe("");
      expect(await userRows(app, "accepted message")).toBe(1);
      // Accepted: no failure is reported for it.
      expect(app.view.container.textContent ?? "").not.toContain("reply failed after accept");
    } finally {
      await held.settle();
      held.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  test("a reload before the send reached the backend shows its text again, once (D4)", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-reload-unsent" });
    const held = holdFirstSend(app, (realSend, args) => realSend(...args));
    try {
      const scope = scopeOf(app);
      await app.chat.send("first message");
      await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(1), WAIT);
      await getDraftStore().flush(scope);
      expect(await legacyDraftText(app)).toBe("first message");

      // The reloaded renderer asks the receiver, which never saw the id: not accepted.
      const renderer = await otherRenderer(app);
      await waitFor(() => expect(renderer.getText(scope)).toBe("first message"), WAIT);
      expect(await pendingIds(app)).toEqual([]);

      // The late request is refused (its id was answered "not accepted"): no row, no copy.
      held.release();
      await held.settle();
      expect(await userRows(app, "first message")).toBe(0);
      await app.chat.expectInputValue("first message", WAIT.timeout);
    } finally {
      await held.settle();
      held.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  test("a reload after the backend accepted removes the retained text (D4)", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-reload-accepted" });
    let releaseReply: () => void = () => undefined;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const held = holdFirstSend(app, async (realSend, args) => {
      const result = await realSend(...args);
      // The reply never arrives before the reload.
      await replyGate;
      return result;
    });
    try {
      const scope = scopeOf(app);
      held.release();
      await app.chat.send("accepted message");
      await app.chat.expectTranscriptContains("Mock response: accepted message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      expect(await pendingIds(app)).toHaveLength(1);

      const renderer = await otherRenderer(app);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      expect(renderer.getText(scope)).toBe("");
      expect(await legacyDraftText(app)).toBeNull();
      expect(await userRows(app, "accepted message")).toBe(1);
    } finally {
      releaseReply();
      await held.settle();
      held.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  test("an edit row carries its send id, so a failed edit reply can be looked up", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-edit-row" });
    try {
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains("Mock response: first message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      const history = await app.env.services
        .toORPCContext()
        .historyService.getHistoryFromLatestBoundary(app.workspaceId);
      if (!history.success) throw new Error(String(history.error));
      const target = history.data.find((message) => message.role === "user");
      expect(target).toBeDefined();
      const sendId = "edit-send-id-1";
      const result = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "edited message",
        options: {
          model: "openai:gpt-5.2",
          agentId: "exec",
          editMessageId: target!.id,
          unfencedEdit: true,
          sendId,
        },
      });
      expect(result.success).toBe(true);
      await app.chat.expectTranscriptContains("Mock response: edited message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      const status = await app.env.orpc.workspace.getSendStatus({
        workspaceId: app.workspaceId,
        sendIds: [sendId],
      });
      expect(status.success && status.data.statuses).toEqual([{ sendId, status: "accepted" }]);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("a restart after the row was written but before removal removes it on load (D5)", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-restart" });
    const draftService = app.env.services.draftService;
    // The process dies between the row and the draft removal: no answer is applied.
    const blocked = jest
      .spyOn(draftService, "applySendStatuses")
      .mockImplementation(() => Promise.resolve());
    try {
      const scope = scopeOf(app);
      await app.chat.send("accepted message");
      await app.chat.expectTranscriptContains("Mock response: accepted message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      const [sendId] = await pendingIds(app);
      expect(sendId).toBeDefined();
      // The entry names the receiver that died.
      await draftService.setSendReceiver({ scope, sendId, receiverId: "receiver-before-restart" });
      blocked.mockRestore();

      const renderer = await otherRenderer(app);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      expect(renderer.getText(scope)).toBe("");
      expect(await userRows(app, "accepted message")).toBe(1);
    } finally {
      blocked.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  test("one send id retried from another window is appended once", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-two-windows" });
    const held = holdFirstSend(app, (realSend, args) => realSend(...args));
    try {
      const scope = scopeOf(app);
      await app.chat.send("first message");
      await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(1), WAIT);
      const [sendId] = await pendingIds(app);
      // As if written through another backend: the other window cannot learn its fate
      // ("unknown"), so it moves the entry to its receiver and re-sends the same id.
      await app.env.services.draftService.setSendReceiver({
        scope,
        sendId,
        receiverId: "another-backend",
      });
      await otherRenderer(app);
      await waitFor(() => expect(held.spy).toHaveBeenCalledTimes(2), WAIT);
      await app.chat.expectTranscriptContains("Mock response: first message", WAIT.timeout);
      await app.chat.expectStreamComplete();

      // The first request arrives late: its id is on a row, so it adds nothing.
      held.release();
      await held.settle();
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      expect(await userRows(app, "first message")).toBe(1);
      expect(await app.chat.getInputValue()).toBe("");
    } finally {
      await held.settle();
      held.spy.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  test("a queued send keeps its text durable until its row, with the composer usable", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-queued" });
    try {
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      await app.chat.send("queued follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), WAIT);
      await app.chat.expectInputValue("", WAIT.timeout);
      // Pending (queued): retained, not unresolved, so the composer is not stuck sending.
      expect(await legacyDraftText(app)).toBe("queued follow-up");
      await waitFor(
        () => expect(getDraftStore().getView(scopeOf(app)).unresolvedSendCount).toBe(0),
        WAIT
      );

      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await app.chat.expectTranscriptContains("Mock response: queued follow-up", WAIT.timeout);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      expect(await legacyDraftText(app)).toBeNull();
      expect(await app.chat.getInputValue()).toBe("");
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("Stop returning a late copy of an accepted send does not bring its text back", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-late-copy" });
    const sends = jest.spyOn(app.env.services.workspaceService, "sendMessage");
    try {
      await app.chat.send("accepted message");
      await app.chat.expectTranscriptContains("Mock response: accepted message", WAIT.timeout);
      await app.chat.expectStreamComplete();
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      const [, message, sent] = sends.mock.calls[0];
      sends.mockRestore();

      // A late copy of the same send (same id and payload) reaches a busy session and queues.
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      expect(sent.sendId).toBeDefined();
      const late = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message,
        options: sent,
      });
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), WAIT);

      // Stop returns it; the composer asks the backend first: accepted, so nothing comes back.
      expect(
        (await app.env.orpc.workspace.interruptStream({ workspaceId: app.workspaceId })).success
      ).toBe(true);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await late;
      await waitFor(() => expect(session.getHeldInputs()).toEqual([]), WAIT);
      expect(await app.chat.getInputValue()).toBe("");
      expect(await userRows(app, "accepted message")).toBe(1);
    } finally {
      sends.mockRestore();
      await app.dispose();
    }
  }, 120_000);

  test("Stop returning a queued send shows it once, from the draft", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-stop-restore" });
    try {
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      await app.chat.send("queued follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), WAIT);
      await app.chat.expectInputValue("", WAIT.timeout);

      expect(
        (await app.env.orpc.workspace.interruptStream({ workspaceId: app.workspaceId })).success
      ).toBe(true);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await app.chat.expectInputValue("queued follow-up", WAIT.timeout);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      // Settled: the restored input is in the composer once, and nowhere else.
      await waitFor(() => expect(session.getHeldInputs()).toEqual([]), WAIT);
      expect(await app.chat.getInputValue()).toBe("queued follow-up");
      expect(await userRows(app, "queued follow-up")).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("a lost reply of a send the backend queued is not reported as failed", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-lost-queued-reply" });
    const workspaceService = app.env.services.workspaceService;
    const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
    try {
      const session = workspaceService.getOrCreateSession(app.workspaceId);
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      // The backend queues the send, then its reply is lost.
      jest
        .spyOn(workspaceService, "sendMessage")
        .mockImplementationOnce(async (...args: Parameters<SendMessage>) => {
          await realSend(...args);
          throw new Error("reply lost after queue");
        });
      await app.chat.send("queued follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), WAIT);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await app.chat.expectTranscriptContains("Mock response: queued follow-up", WAIT.timeout);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      expect(await app.chat.getInputValue()).toBe("");
      expect(await userRows(app, "queued follow-up")).toBe(1);
      expect(app.view.container.textContent ?? "").not.toContain("reply lost after queue");
    } finally {
      jest.restoreAllMocks();
      await app.dispose();
    }
  }, 120_000);

  test("an Ok reply of a send cleared from the queue before its lookup shows its text again", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-ok-then-cleared" });
    const workspaceService = app.env.services.workspaceService;
    const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
    try {
      const session = workspaceService.getOrCreateSession(app.workspaceId);
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      // Queued (Ok reply), but another window clears the queue before this one looks it up.
      jest
        .spyOn(workspaceService, "sendMessage")
        .mockImplementationOnce(async (...args: Parameters<SendMessage>) => {
          const result = await realSend(...args);
          await app.env.orpc.workspace.clearQueue({ workspaceId: app.workspaceId });
          return result;
        });
      await app.chat.send("cleared follow-up");
      await app.chat.expectInputValue("cleared follow-up", WAIT.timeout);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await app.chat.expectStreamComplete();
      expect(await app.chat.getInputValue()).toBe("cleared follow-up");
      expect(await userRows(app, "cleared follow-up")).toBe(0);
    } finally {
      jest.restoreAllMocks();
      await app.dispose();
    }
  }, 120_000);

  test("editing a queued message that joins a retained and a foreign send shows each once", async () => {
    const app = await createAppHarness({ branchPrefix: "send-ids-mixed-queue-edit" });
    try {
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      await app.chat.send("composer part");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), WAIT);
      // A send without a client id (another client): the backend mints its id, the draft does
      // not retain it, and it joins the same queued message.
      const foreign = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "foreign part",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      expect(foreign.success).toBe(true);
      // The queued message's Edit (transcript rows have icon-only Edit buttons with a label).
      const edit = await waitFor(() => {
        const button = app.view
          .getAllByRole("button", { name: "Edit" })
          .find((candidate) => !candidate.hasAttribute("aria-label"));
        expect(app.view.container.textContent ?? "").toContain("foreign part");
        if (!button) throw new Error("queued message Edit not shown yet");
        return button;
      }, WAIT);
      fireEvent.click(edit);
      await waitFor(async () => {
        const value = await app.chat.getInputValue();
        expect(value.split("composer part").length - 1).toBe(1);
        expect(value.split("foreign part").length - 1).toBe(1);
      }, WAIT);
      await waitFor(async () => expect(await pendingIds(app)).toEqual([]), WAIT);
      const value = await app.chat.getInputValue();
      expect(value.split("composer part").length - 1).toBe(1);
      expect(value.split("foreign part").length - 1).toBe(1);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
