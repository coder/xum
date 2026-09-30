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
import { act, fireEvent, waitFor } from "@testing-library/react";

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
  await app.chat.expectTranscriptContains(
    "Mock response: first message",
    LOAD_TOLERANT_WAIT.timeout
  );
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
    const button = rowEditButton(app, "first message");
    if (!button) throw new Error("Edit button not found");
    return button;
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

async function attachStoreReview(app: AppHarness, id: string, note: string) {
  await app.env.orpc.workspace.reviewState.update({
    workspaceId: app.workspaceId,
    delta: {
      reviews: {
        set: { [id]: { id, data: review(note), status: "attached", createdAt: Date.now() } },
      },
    },
  });
}

/** Click a visible button found by `find`, waiting for it to render. */
async function clickWhenShown(find: () => Element | undefined, what: string) {
  const button = await waitFor(() => {
    const element = find();
    if (!element) throw new Error(`${what} not found`);
    return element as HTMLElement;
  }, LOAD_TOLERANT_WAIT);
  fireEvent.click(button);
}

/** The queued message's Edit action moves it (text and notes) back into the composer. */
const editQueuedMessage = (app: AppHarness) =>
  clickWhenShown(
    () =>
      [
        ...app.view.container.querySelectorAll('[data-component="QueuedMessageActions"] button'),
      ].find((element) => element.textContent?.includes("Edit")),
    "Queued message Edit button"
  );

/** The Edit action of the transcript row that shows `rowText`. */
const rowEditButton = (app: AppHarness, rowText: string) =>
  [
    ...app.view.container.querySelectorAll<HTMLButtonElement>(
      '[data-message-block] button[aria-label="Edit"]'
    ),
  ].find((element) => element.closest("[data-message-block]")?.textContent?.includes(rowText));

async function editRow(app: AppHarness, rowText: string) {
  await clickWhenShown(() => rowEditButton(app, rowText), `Edit button of "${rowText}"`);
  await waitFor(() => expect(editTextarea(app)?.value).toBe(rowText), LOAD_TOLERANT_WAIT);
}

/**
 * Try to edit a row while an edit send is pending: its Edit action is disabled and a click
 * does not open edit mode.
 */
async function expectEditRefused(app: AppHarness, rowText: string) {
  const button = await waitFor(() => {
    const element = rowEditButton(app, rowText);
    if (!element) throw new Error(`Edit button of "${rowText}" not found`);
    return element;
  }, LOAD_TOLERANT_WAIT);
  const editValueBefore = editTextarea(app)?.value;
  await act(async () => {
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(editTextarea(app)?.value).toBe(editValueBefore);
  expect(button.disabled).toBe(true);
}

/**
 * Put a queued message with a note back into the composer, so it has its own note list (the
 * review override). Returns the restored composer text.
 */
async function restoreQueuedMessageWithNote(app: AppHarness, scope: DraftScope, note: string) {
  const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
  const holding = app.env.orpc.workspace.sendMessage({
    workspaceId: app.workspaceId,
    message: "[mock:wait-start] hold the workspace busy",
    options: { model: "openai:gpt-5.2", agentId: "exec" },
  });
  await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
  await attachStoreReview(app, "review-queued", note);
  await waitFor(() => expect(composerText(app)).toContain(note), LOAD_TOLERANT_WAIT);
  await app.chat.send("queued follow-up");
  await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
  await editQueuedMessage(app);
  await waitFor(
    () => expect(getDraftStore().getText(scope)).toContain("queued follow-up"),
    LOAD_TOLERANT_WAIT
  );
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
  await holding;
  await app.chat.expectStreamComplete();
  return getDraftStore().getText(scope);
}

/**
 * Hold the next send between capturing its composer input and clearing it: it waits for a
 * pending settings save first. Only that save is held; later config writes go through.
 */
async function holdNextSendBeforeClear(app: AppHarness) {
  const realSave = app.env.config.saveUserConfig.bind(app.env.config);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = jest
    .spyOn(app.env.config, "saveUserConfig")
    .mockImplementationOnce(async (...args: Parameters<typeof realSave>) => {
      await gate;
      return realSave(...args);
    });
  updatePersistedState(getAutoCompactionThresholdKey(WORKSPACE_DEFAULTS.model), 80);
  await waitFor(() => expect(spy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);
  return { release, spy };
}

/** The workspace composer textarea that holds `value`. */
const composerHolding = (app: AppHarness, value: string) =>
  [
    ...app.view.container.querySelectorAll<HTMLTextAreaElement>(
      'textarea[aria-label="Message Claude"]'
    ),
  ].find((textarea) => textarea.value === value && !textarea.disabled)!;

/** Press Enter in the workspace composer that holds `value`. */
function pressEnterInComposer(app: AppHarness, value: string) {
  fireEvent.keyDown(composerHolding(app, value), { key: "Enter" });
}

const sentMessages = (spy: ReturnType<typeof holdSendReplies>["spy"], message: string) =>
  spy.mock.calls.filter(([, sent]) => sent === message).length;

describe("Edit sends racing newer composer input (#5226)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("no new edit starts while an edit send is pending; the unsent draft comes back in order", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-refused-while-pending" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);
      // Hold the edit's reply, and its stream at start: the composer is usable meanwhile.
      const replies = holdSendReplies(app);
      await sendEdit(app, scope, "[mock:wait-start] edited message", "first message");

      // A second edit (the row's Edit action) and a third (ArrowUp in the empty composer).
      await expectEditRefused(app, "edited message");
      await act(async () => {
        fireEvent.keyDown(composerHolding(app, ""), { key: "ArrowUp" });
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(editTextarea(app)).toBeNull();
      await app.chat.typeWithoutSending("typed meanwhile");

      replies.release();
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
      await app.chat.expectInputValue(
        "unsent draft\n\ntyped meanwhile",
        LOAD_TOLERANT_WAIT.timeout
      );
      expect(
        getDraftStore()
          .getView(scope)
          .attachments.map(({ id }) => id)
      ).toEqual(["file-unsent"]);
      // Edits work again once the send settled.
      await waitFor(() => expect(rowEditButton(app, "edited message")?.disabled).toBe(false));
      replies.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("no new edit starts while an editing /compact is pending, and no attachment is lost", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-compact-refuses-edit" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await app.chat.send("earlier message");
      await app.chat.expectTranscriptContains("Mock response: earlier message");
      await app.chat.expectStreamComplete();
      const editTextarea0 = await startEditWithUnsentDraft(app, scope);
      // Hold the compaction request so the command stays pending.
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
      await waitFor(() => expect(editTextarea0.value).toBe("/compact -t 500"));
      fireEvent.keyDown(editTextarea0, { key: "Enter" });
      await waitFor(() => expect(sendSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);

      await expectEditRefused(app, "earlier message");

      releaseSend();
      await app.chat.expectStreamComplete(60_000);
      await expectUnsentDraftKept(app, scope);
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("cancelling an edit while its send waits does not let a reopened edit be closed or cleared", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-cancel-reopen" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      const save = await holdNextSendBeforeClear(app);
      getDraftStore().setText(scope, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });

      // The send waits for the settings save; the user cancels the edit and reopens the row.
      fireEvent.keyDown(textarea, { key: "Escape" });
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("unsent draft"),
        LOAD_TOLERANT_WAIT
      );
      await expectEditRefused(app, "first message");

      save.release();
      await app.chat.expectStreamComplete();
      await expectUnsentDraftKept(app, scope);
      save.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("review notes attached while an edit is pending stay next to the restored notes", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-pending-keeps-notes" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains("Mock response", LOAD_TOLERANT_WAIT.timeout);
      await app.chat.expectStreamComplete();
      const restoredText = await restoreQueuedMessageWithNote(app, scope, "queued note");

      await editRow(app, "first message");
      const replies = holdSendReplies(app);
      await sendEdit(app, scope, "edited message", "first message");
      await app.chat.expectStreamComplete();
      // A note attached while the edit's reply is pending.
      await attachStoreReview(app, "review-late", "late note");
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

      const save = await holdNextSendBeforeClear(app);
      await app.chat.typeWithoutSending("follow-up");
      pressEnterInComposer(app, "follow-up");

      // The edit completes while the follow-up waits: the pre-edit draft comes back.
      replies.release();
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("unsent draft\n\nfollow-up"),
        LOAD_TOLERANT_WAIT
      );

      save.release();
      await waitFor(
        () => expect(sentMessages(replies.spy, "follow-up")).toBe(1),
        LOAD_TOLERANT_WAIT
      );
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectTranscriptContains(
        "Mock response: follow-up",
        LOAD_TOLERANT_WAIT.timeout
      );
      await expectUnsentDraftKept(app, scope);
      replies.spy.mockRestore();
      save.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("notes restored while a follow-up waits survive its send", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-followup-keeps-notes" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains("Mock response", LOAD_TOLERANT_WAIT.timeout);
      await app.chat.expectStreamComplete();
      // The edit's pre-edit draft has its own note list.
      const restoredText = await restoreQueuedMessageWithNote(app, scope, "pre-edit note");

      await editRow(app, "first message");
      const replies = holdSendReplies(app);
      await sendEdit(app, scope, "[mock:wait-start] edited message", "first message");

      // While the edit's stream starts, a queued message without notes goes back into the
      // composer: its note list is empty, and that is what the follow-up send captures.
      await app.chat.send("second follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
      await editQueuedMessage(app);
      await app.chat.expectInputValue("second follow-up", LOAD_TOLERANT_WAIT.timeout);
      const save = await holdNextSendBeforeClear(app);
      pressEnterInComposer(app, "second follow-up");

      // The edit completes while the follow-up waits: its draft and note come back.
      replies.release();
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe(`${restoredText}\n\nsecond follow-up`),
        LOAD_TOLERANT_WAIT
      );

      save.release();
      await waitFor(
        () => expect(sentMessages(replies.spy, "second follow-up")).toBe(2),
        LOAD_TOLERANT_WAIT
      );
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectTranscriptContains(
        "Mock response: second follow-up",
        LOAD_TOLERANT_WAIT.timeout
      );
      await app.chat.expectInputValue(restoredText, LOAD_TOLERANT_WAIT.timeout);
      await waitFor(
        () => expect(reviewPanelNotes(app).join("\n")).toContain("pre-edit note"),
        LOAD_TOLERANT_WAIT
      );
      replies.spy.mockRestore();
      save.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
