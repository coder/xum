/**
 * Editing an older message snapshots the unsent composer draft and fills the composer with the
 * message. Cancel restores the snapshot; completing the edit must restore it too (#5155), or the
 * draft (text and attachments) is gone, and with backend drafts its draft.json with it.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { fireEvent, waitFor } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import type { DraftScope } from "@/common/orpc/schemas/drafts";
import type { ReviewNoteData } from "@/common/types/review";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const LOAD_TOLERANT_WAIT = { timeout: 30_000 };

async function startEditWithUnsentDraft(app: AppHarness, scope: DraftScope) {
  await app.chat.send("first message");
  await app.chat.expectTranscriptContains("Mock response", LOAD_TOLERANT_WAIT.timeout);
  await app.chat.expectStreamComplete();

  await app.chat.typeWithoutSending("unsent draft");
  getDraftStore().setAttachments(scope, [
    {
      kind: "provider",
      id: "file-unsent",
      url: "data:text/plain;base64,dW5zZW50",
      mediaType: "text/plain",
      filename: "unsent.txt",
    },
  ]);

  const editButton = await waitFor(() => {
    const button = app.view.container.querySelector('button[aria-label="Edit"]');
    if (!button) throw new Error("Edit button not found");
    return button as HTMLElement;
  }, LOAD_TOLERANT_WAIT);
  fireEvent.click(editButton);
  return await waitFor(() => {
    const textarea = app.view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit your last message"]'
    );
    if (!textarea) throw new Error("Edit textarea not found");
    expect(textarea.value).toBe("first message");
    return textarea;
  }, LOAD_TOLERANT_WAIT);
}

async function expectUnsentDraftKept(app: AppHarness, scope: DraftScope) {
  await app.chat.expectInputValue("unsent draft", LOAD_TOLERANT_WAIT.timeout);
  expect(
    getDraftStore()
      .getView(scope)
      .attachments.map(({ id }) => id)
  ).toEqual(["file-unsent"]);
  // The restored draft is what the backend keeps, not an empty or deleted draft.
  await getDraftStore().flush(scope);
  const saved = await app.env.services.draftService.get(scope);
  expect(saved.text).toBe("unsent draft");
  expect(saved.attachments.map(({ id }) => id)).toEqual(["file-unsent"]);
}

describe("Completing an edit of an older message", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("keeps the unsent draft, with its attachments", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const editTextarea = await startEditWithUnsentDraft(app, scope);

      getDraftStore().setText(scope, "edited message");
      await waitFor(() => expect(editTextarea.value).toBe("edited message"));
      fireEvent.keyDown(editTextarea, { key: "Enter" });

      await app.chat.expectTranscriptContains("edited message", LOAD_TOLERANT_WAIT.timeout);
      await app.chat.expectStreamComplete();
      await expectUnsentDraftKept(app, scope);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("keeps the unsent draft when the edited row is replaced before the send returns", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-replaced-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const editTextarea = await startEditWithUnsentDraft(app, scope);

      // The backend emits the replacement row before its reply; hold the reply so the row (and
      // the edit state it clears) lands first.
      const workspaceService = app.env.services.workspaceService;
      const realSend = workspaceService.sendMessage.bind(workspaceService);
      let releaseReply: () => void = () => undefined;
      const replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      const sendSpy = jest
        .spyOn(workspaceService, "sendMessage")
        .mockImplementation(async (...args: Parameters<typeof realSend>) => {
          const result = await realSend(...args);
          await replyGate;
          return result;
        });

      getDraftStore().setText(scope, "edited message");
      await waitFor(() => expect(editTextarea.value).toBe("edited message"));
      fireEvent.keyDown(editTextarea, { key: "Enter" });
      await app.chat.expectTranscriptContains("edited message", LOAD_TOLERANT_WAIT.timeout);
      await app.chat.expectTranscriptNotContains("first message", LOAD_TOLERANT_WAIT.timeout);
      releaseReply();
      await app.chat.expectStreamComplete();
      await expectUnsentDraftKept(app, scope);
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("keeps the unsent draft when the edit is a /compact command", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-compact-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const editTextarea = await startEditWithUnsentDraft(app, scope);

      getDraftStore().setText(scope, "/compact -t 500");
      await waitFor(() => expect(editTextarea.value).toBe("/compact -t 500"));
      fireEvent.keyDown(editTextarea, { key: "Enter" });

      await waitFor(
        () =>
          expect(
            app.view.container.querySelector('textarea[aria-label="Edit your last message"]')
          ).toBeNull(),
        LOAD_TOLERANT_WAIT
      );
      await app.chat.expectStreamComplete(60_000);
      await expectUnsentDraftKept(app, scope);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("restores the draft once when a /compact edit is cancelled before it is accepted", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-compact-cancel-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const editTextarea = await startEditWithUnsentDraft(app, scope);

      // Hold the compaction request so the edit can be cancelled while it is pending.
      const workspaceService = app.env.services.workspaceService;
      const realSend = workspaceService.sendMessage.bind(workspaceService);
      let releaseSend: () => void = () => undefined;
      const sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const sendSpy = jest
        .spyOn(workspaceService, "sendMessage")
        .mockImplementation(async (...args: Parameters<typeof realSend>) => {
          await sendGate;
          return realSend(...args);
        });

      getDraftStore().setText(scope, "/compact -t 500");
      await waitFor(() => expect(editTextarea.value).toBe("/compact -t 500"));
      fireEvent.keyDown(editTextarea, { key: "Enter" });
      await waitFor(() => expect(sendSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);

      // Cancel restores the draft; the late acceptance must not restore it a second time.
      fireEvent.keyDown(editTextarea, { key: "Escape" });
      // The composer stays disabled while the command runs: read the draft itself.
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("unsent draft"),
        LOAD_TOLERANT_WAIT
      );
      releaseSend();
      await app.chat.expectStreamComplete(60_000);
      await expectUnsentDraftKept(app, scope);
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});

/** Hold `workspaceService.sendMessage` replies (the send itself runs) until released. */
function holdSendReplies(app: AppHarness) {
  const workspaceService = app.env.services.workspaceService;
  const realSend = workspaceService.sendMessage.bind(workspaceService);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = jest
    .spyOn(workspaceService, "sendMessage")
    .mockImplementation(async (...args: Parameters<typeof realSend>) => {
      const result = await realSend(...args);
      await gate;
      return result;
    });
  return { release, spy };
}

const editTextarea = (app: AppHarness) =>
  app.view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Edit your last message"]'
  );
const sendButton = (app: AppHarness) =>
  app.view.container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
/** Text of the mounted workspace composer (its review panel lives inside it). */
const composerText = (app: AppHarness) =>
  [...app.view.container.querySelectorAll('[data-component="ChatInputSection"]')]
    .map((section) => section.textContent ?? "")
    .join("\n");
/** Notes shown in the composer's review panel. */
const reviewPanelNotes = (app: AppHarness) =>
  [
    ...app.view.container.querySelectorAll('[data-component="ChatInputSection"] .group\\/review'),
  ].map((element) => element.textContent ?? "");
const review = (note: string): ReviewNoteData => ({
  filePath: "src/file.ts",
  lineRange: "1",
  selectedCode: "call()",
  userNote: note,
});

/** Send an edit of the open edit textarea with `text` and wait until its row replaced the old one. */
async function sendEdit(app: AppHarness, scope: DraftScope, text: string, replaced: string) {
  const textarea = editTextarea(app)!;
  getDraftStore().setText(scope, text);
  await waitFor(() => expect(textarea.value).toBe(text));
  fireEvent.keyDown(textarea, { key: "Enter" });
  await app.chat.expectTranscriptContains(text, LOAD_TOLERANT_WAIT.timeout);
  await app.chat.expectTranscriptNotContains(replaced, LOAD_TOLERANT_WAIT.timeout);
}

describe("Edit sends racing newer composer input (#5226)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a second edit started while the first is pending keeps the first edit's draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-second-edit-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);
      const replies = holdSendReplies(app);
      await sendEdit(app, scope, "edited message", "first message");
      await app.chat.expectStreamComplete();

      // The first edit's reply is still pending: edit its replacement row.
      fireEvent.click(
        await waitFor(() => {
          const button = app.view.container.querySelector('button[aria-label="Edit"]');
          if (!button) throw new Error("Edit button not found");
          return button as HTMLElement;
        }, LOAD_TOLERANT_WAIT)
      );
      await waitFor(() => expect(editTextarea(app)?.value).toBe("edited message"));
      expect(sendButton(app)?.disabled).toBe(true);

      replies.release();
      // The first send settled; the second edit is still open and untouched.
      await waitFor(() => expect(sendButton(app)?.disabled).toBe(false), LOAD_TOLERANT_WAIT);
      expect(editTextarea(app)?.value).toBe("edited message");

      // Cancelling the second edit brings back the draft from before the first one.
      fireEvent.keyDown(editTextarea(app)!, { key: "Escape" });
      await expectUnsentDraftKept(app, scope);
      replies.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("review notes attached while an edit is pending stay next to the restored notes", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-pending-keeps-notes" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains("Mock response", LOAD_TOLERANT_WAIT.timeout);
      await app.chat.expectStreamComplete();

      // A queued message with a note, moved back into the composer by its Edit action, gives the
      // composer its own note list (the review override) before the edit starts.
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
      await app.env.orpc.workspace.reviewState.update({
        workspaceId: app.workspaceId,
        delta: {
          reviews: {
            set: {
              "review-queued": {
                id: "review-queued",
                data: review("queued note"),
                status: "attached",
                createdAt: Date.now(),
              },
            },
          },
        },
      });
      await waitFor(() => expect(composerText(app)).toContain("queued note"), LOAD_TOLERANT_WAIT);
      await app.chat.send("queued follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
      fireEvent.click(
        await waitFor(() => {
          const button = [
            ...app.view.container.querySelectorAll(
              '[data-component="QueuedMessageActions"] button'
            ),
          ].find((element) => element.textContent?.includes("Edit"));
          if (!button) throw new Error("Queued message Edit button not found");
          return button as HTMLElement;
        }, LOAD_TOLERANT_WAIT)
      );
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toContain("queued follow-up"),
        LOAD_TOLERANT_WAIT
      );
      const restoredText = getDraftStore().getText(scope);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await app.chat.expectStreamComplete();

      const firstRowEdit = await waitFor(() => {
        const button = [
          ...app.view.container.querySelectorAll('[data-message-block] button[aria-label="Edit"]'),
        ].find((element) =>
          element.closest("[data-message-block]")?.textContent?.includes("first message")
        );
        if (!button) throw new Error("Edit button of the first message not found");
        return button as HTMLElement;
      }, LOAD_TOLERANT_WAIT);
      fireEvent.click(firstRowEdit);
      await waitFor(
        () => expect(editTextarea(app)?.value).toBe("first message"),
        LOAD_TOLERANT_WAIT
      );

      const replies = holdSendReplies(app);
      await sendEdit(app, scope, "edited message", "first message");
      await app.chat.expectStreamComplete();
      // A note attached while the edit's reply is pending.
      await app.env.orpc.workspace.reviewState.update({
        workspaceId: app.workspaceId,
        delta: {
          reviews: {
            set: {
              "review-late": {
                id: "review-late",
                data: review("late note"),
                status: "attached",
                createdAt: Date.now(),
              },
            },
          },
        },
      });
      replies.release();

      await app.chat.expectInputValue(restoredText, LOAD_TOLERANT_WAIT.timeout);
      // The review panel shows both: the restored note and the one attached meanwhile.
      await waitFor(() => {
        const notes = reviewPanelNotes(app).join("\n");
        expect(notes).toContain("queued note");
        expect(notes).toContain("late note");
      }, LOAD_TOLERANT_WAIT);
      replies.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("a follow-up sent while an edit is pending clears only its own text", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-followup-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);
      // Hold the edit's reply, and its stream at start: the composer is usable meanwhile.
      const replies = holdSendReplies(app);
      await sendEdit(app, scope, "[mock:wait-start] edited message", "first message");

      // Hold the follow-up between capturing its text and clearing it: it waits for a pending
      // settings save first. Only that save is held; later config writes (the edit's stream
      // start) go through.
      const realSave = app.env.config.saveUserConfig.bind(app.env.config);
      let releaseSave: () => void = () => undefined;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      const saveSpy = jest
        .spyOn(app.env.config, "saveUserConfig")
        .mockImplementationOnce(async (...args: Parameters<typeof realSave>) => {
          await saveGate;
          return realSave(...args);
        });
      updatePersistedState(getAutoCompactionThresholdKey(WORKSPACE_DEFAULTS.model), 80);
      await waitFor(() => expect(saveSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);
      await app.chat.typeWithoutSending("follow-up");
      const composer = [
        ...app.view.container.querySelectorAll<HTMLTextAreaElement>(
          'textarea[aria-label="Message Claude"]'
        ),
      ].find((textarea) => textarea.value === "follow-up");
      fireEvent.keyDown(composer!, { key: "Enter" });

      // The edit completes while the follow-up waits: the pre-edit draft comes back.
      replies.release();
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("unsent draft\n\nfollow-up"),
        LOAD_TOLERANT_WAIT
      );

      releaseSave();
      await waitFor(
        () => expect(replies.spy.mock.calls.map(([, message]) => message)).toContain("follow-up"),
        LOAD_TOLERANT_WAIT
      );
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectTranscriptContains(
        "Mock response: follow-up",
        LOAD_TOLERANT_WAIT.timeout
      );
      await expectUnsentDraftKept(app, scope);
      replies.spy.mockRestore();
      saveSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
