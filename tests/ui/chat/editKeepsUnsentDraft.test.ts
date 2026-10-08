/**
 * Editing an older message fills the composer with the message. The edit's text and files live
 * only in the composer's memory: the unsent draft stays in the shared, persisted draft store, so
 * Cancel, a completed edit (#5155), a reload (#5672) and a second window (#5571) all keep it.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, fireEvent, waitFor, within } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { DraftStore, getDraftStore } from "@/browser/stores/DraftStore";
import { getReviewStateStore } from "@/browser/stores/ReviewStateStore";
import {
  WorkspaceStore,
  useWorkspaceStoreRaw,
  workspaceStore,
  type TranscriptRefreshOutcome,
} from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import * as chatCommands from "@/browser/utils/chatCommands";
import * as controlFlow from "@/browser/utils/compilerSafeControlFlow";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import type { DraftScope } from "@/common/orpc/schemas/drafts";
import type { FilePart } from "@/common/orpc/types";
import type { ReviewNoteData } from "@/common/types/review";
import { joinDraftText } from "@/common/utils/composerDraftText";
import {
  EDIT_HISTORY_CHANGED_MESSAGE,
  EDIT_RETRY_REFRESH_LABEL,
} from "@/constants/transcriptBarrier";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { Err } from "@/common/types/result";
import { detectDefaultTrunkBranch } from "@/node/git";
import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { ChatHarness, createAppHarness, type AppHarness } from "../harness";

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
      'textarea[aria-label="Edit message"]'
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

/**
 * Type into the open edit textarea. The edit text lives in the composer's memory, not in the
 * draft store, so it is set through the textarea as a user would.
 */
function typeIntoEdit(textarea: HTMLTextAreaElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
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

      typeIntoEdit(editTextarea, "edited message");
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

      typeIntoEdit(editTextarea, "edited message");
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

      typeIntoEdit(editTextarea, "/compact -t 500");
      await waitFor(() => expect(editTextarea.value).toBe("/compact -t 500"));
      fireEvent.keyDown(editTextarea, { key: "Enter" });

      await waitFor(
        () =>
          expect(
            app.view.container.querySelector('textarea[aria-label="Edit message"]')
          ).toBeNull(),
        LOAD_TOLERANT_WAIT
      );
      await app.chat.expectStreamComplete(60_000);
      await expectUnsentDraftKept(app, scope);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("the Cancel button leaves edit mode and restores the draft, as Escape does", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-cancel-button-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);

      // Touch screens have no Escape key: the editing indicator must offer a visible way out.
      const composer = app.view.container.querySelector<HTMLElement>(
        '[data-component="ChatInputSection"]'
      )!;
      fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));

      await waitFor(
        () =>
          expect(
            app.view.container.querySelector('textarea[aria-label="Edit message"]')
          ).toBeNull(),
        LOAD_TOLERANT_WAIT
      );
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

      typeIntoEdit(editTextarea, "/compact -t 500");
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
  app.view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit message"]');
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
async function sendEdit(app: AppHarness, text: string, replaced: string) {
  const textarea = editTextarea(app)!;
  typeIntoEdit(textarea, text);
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
    ...app.view.container.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message"]'),
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

  // ArrowUp edits only from an empty composer, so this edit starts without an unsent draft (an
  // edit send shows the unsent draft, see "the composer shows the unsent draft ..." below).
  test("no new edit starts while an edit send is pending, by the row's Edit or by ArrowUp", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-refused-while-pending" });
    try {
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains(
        "Mock response: first message",
        LOAD_TOLERANT_WAIT.timeout
      );
      await app.chat.expectStreamComplete();
      await editRow(app, "first message");
      // Hold the edit's reply, and its stream at start: the composer is usable meanwhile.
      const replies = holdSendReplies(app);
      await sendEdit(app, "[mock:wait-start] edited message", "first message");

      // A second edit (the row's Edit action) and a third (ArrowUp in the empty composer).
      await expectEditRefused(app, "edited message");
      await act(async () => {
        fireEvent.keyDown(composerHolding(app, ""), { key: "ArrowUp" });
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(editTextarea(app)).toBeNull();

      replies.release();
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
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
      typeIntoEdit(editTextarea0, "/compact -t 500");
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
      typeIntoEdit(textarea, "edited message");
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
      await sendEdit(app, "edited message", "first message");
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
      await sendEdit(app, "[mock:wait-start] edited message", "first message");
      // While the edit send is in flight the composer shows the unsent draft.
      await app.chat.expectInputValue("unsent draft", LOAD_TOLERANT_WAIT.timeout);

      const save = await holdNextSendBeforeClear(app);
      await app.chat.typeWithoutSending("follow-up");
      pressEnterInComposer(app, "follow-up");

      // The edit completes while the follow-up waits: nothing comes back into the composer.
      replies.release();
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("follow-up"),
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
      await restoreQueuedMessageWithNote(app, scope, "pre-edit note");

      await editRow(app, "first message");
      const replies = holdSendReplies(app);
      await sendEdit(app, "[mock:wait-start] edited message", "first message");

      // While the edit's stream starts, a queued message without notes goes back into the
      // composer: its note list is empty, and that is what the follow-up send captures.
      await app.chat.send("second follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
      await editQueuedMessage(app);
      await app.chat.expectInputValue("second follow-up", LOAD_TOLERANT_WAIT.timeout);
      const save = await holdNextSendBeforeClear(app);
      pressEnterInComposer(app, "second follow-up");

      // The edit completes while the follow-up waits: its note comes back, and no text.
      replies.release();
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("second follow-up"),
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
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
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

describe("Edit refused because history changed (B8)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("the failure alert goes away once the reviewed edit is sent", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-history-changed-alert" });
    try {
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains(
        "Mock response: first message",
        LOAD_TOLERANT_WAIT.timeout
      );
      await app.chat.expectStreamComplete();
      await editRow(app, "first message");

      // The backend refuses the first attempt: the rows the edit would delete changed.
      const workspaceService = app.env.services.workspaceService;
      const sendSpy = jest
        .spyOn(workspaceService, "sendMessage")
        .mockResolvedValueOnce(Err({ type: "history-changed" }));
      typeIntoEdit(editTextarea(app)!, "edited message");
      await waitFor(() => expect(editTextarea(app)?.value).toBe("edited message"));
      fireEvent.keyDown(editTextarea(app)!, { key: "Enter" });
      await waitFor(
        () => expect(composerText(app)).toContain(EDIT_HISTORY_CHANGED_MESSAGE),
        LOAD_TOLERANT_WAIT
      );
      // Send stays blocked until the transcript refresh lands.
      await waitFor(
        () => expect(composerText(app)).not.toContain("refreshing transcript"),
        LOAD_TOLERANT_WAIT
      );

      // The user reviews the transcript and sends again; this time the backend takes it.
      fireEvent.keyDown(editTextarea(app)!, { key: "Enter" });
      await app.chat.expectTranscriptContains("edited message", LOAD_TOLERANT_WAIT.timeout);
      await app.chat.expectStreamComplete();
      // The edited row can replace the old one (closing edit mode) before the send's reply.
      await waitFor(
        () => expect(composerText(app)).not.toContain(EDIT_HISTORY_CHANGED_MESSAGE),
        LOAD_TOLERANT_WAIT
      );
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// The open edit stays out of the shared draft (#5672, #5571). The unsent draft (U) never leaves
// the draft store; the edit's text and files (E) live in the composer that opened the edit.
// ---------------------------------------------------------------------------------------------

const UNSENT_FILE = {
  kind: "provider" as const,
  id: "file-unsent",
  url: "data:text/plain;base64,dW5zZW50",
  mediaType: "text/plain",
  filename: "unsent.txt",
};

/** The composer's normal (not edit) textarea. */
function messageTextarea(app: AppHarness): HTMLTextAreaElement {
  const textarea = app.view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]'
  );
  if (!textarea) throw new Error("Message textarea not found");
  return textarea;
}

/** Another renderer on the same backend: a reload of this window, or a second window. */
async function otherRenderer(app: AppHarness): Promise<DraftStore> {
  const store = new DraftStore();
  store.setClient(createTestApiClient(app.env.orpc));
  await store.whenReady();
  return store;
}

/** Show a workspace the way the sidebar does, and wait until its composer is mounted. */
async function showWorkspace(app: AppHarness, workspaceId: string, name: string) {
  const row = await waitFor(() => {
    const element = app.view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
    if (!element || element.getAttribute("aria-disabled") === "true") {
      throw new Error("Workspace row not selectable yet");
    }
    return element as HTMLElement;
  }, LOAD_TOLERANT_WAIT);
  fireEvent.click(row);
  workspaceStore.setActiveWorkspaceId(workspaceId);
  await waitFor(() => {
    expect(document.title.startsWith(name)).toBe(true);
    expect(app.view.container.querySelector('[data-testid="message-window"]')).not.toBe(null);
  }, LOAD_TOLERANT_WAIT);
}

/** A second workspace of the same project, known to the sidebar. */
async function addOtherWorkspace(app: AppHarness, prefix: string) {
  const created = await app.env.orpc.workspace.create({
    projectPath: app.repoPath,
    branchName: generateBranchName(prefix),
    trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
  });
  if (!created.success) throw new Error(created.error);
  workspaceStore.addWorkspace(created.metadata);
  return created.metadata;
}

/** Show `other`, then the harness workspace again: the composer unmounts and mounts again. */
async function switchAwayAndBack(app: AppHarness, other: { id: string; name: string }) {
  await showWorkspace(app, other.id, other.name);
  await showWorkspace(app, app.workspaceId, app.metadata.name);
}

/**
 * Visit `other` once and send a message there, then show the harness workspace again: with
 * cached rows in both, ChatPane stays mounted across later switches.
 */
async function visitWithMessage(app: AppHarness, other: { id: string; name: string }) {
  await showWorkspace(app, other.id, other.name);
  const otherChat = new ChatHarness(app.view.container, other.id);
  await otherChat.send("other message");
  await otherChat.expectTranscriptContains(
    "Mock response: other message",
    LOAD_TOLERANT_WAIT.timeout
  );
  await otherChat.expectStreamComplete();
  await showWorkspace(app, app.workspaceId, app.metadata.name);
}

/** Stage a file in the composer, so the next sent message (and an edit of it) carries it. */
async function attachComposerFile(app: AppHarness, filename: string) {
  const input = await waitFor(() => {
    const element = app.view.container.querySelector<HTMLInputElement>(
      '[data-component="ChatInputSection"] input[type="file"]'
    );
    if (!element) throw new Error("File input not found");
    return element;
  }, LOAD_TOLERANT_WAIT);
  fireEvent.change(input, {
    target: { files: [new File(["# file"], filename, { type: "text/markdown" })] },
  });
  await waitFor(() => expect(composerText(app)).toContain(filename), LOAD_TOLERANT_WAIT);
}

const attachmentNames = (attachments: { filename?: string; id: string }[]) =>
  attachments.map((attachment) => attachment.filename ?? attachment.id);
const draftFileNames = (scope: DraftScope) =>
  attachmentNames(getDraftStore().getView(scope).attachments);

/** How many times `needle` occurs in `text`. */
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * The draft holds `text` and the files `names`, in this renderer, on screen (when no edit is
 * open) and on the backend.
 */
async function expectDraft(app: AppHarness, scope: DraftScope, text: string, names: string[]) {
  await waitFor(() => expect(getDraftStore().getText(scope)).toBe(text), LOAD_TOLERANT_WAIT);
  expect(draftFileNames(scope)).toEqual(names);
  if (!editTextarea(app)) expect(messageTextarea(app).value).toBe(text);
  await getDraftStore().flush(scope);
  const saved = await app.env.services.draftService.get(scope);
  expect(saved.text).toBe(text);
  expect(attachmentNames(saved.attachments)).toEqual(names);
}

type SendMessage = AppHarness["env"]["services"]["workspaceService"]["sendMessage"];
type SendSpy = jest.SpyInstance<ReturnType<SendMessage>, Parameters<SendMessage>>;

/**
 * Hold edit sends (requests with an `editMessageId`) until released; other sends go through.
 * "accept": the held edit then reaches the backend. "reply-only": the backend takes the edit at
 * once (its row is replaced) and only the reply waits. "history-changed" and "refuse": the held
 * edit is then refused with that error.
 */
function holdEditSends(
  app: AppHarness,
  mode: "accept" | "reply-only" | "history-changed" | "refuse" = "accept"
) {
  const workspaceService = app.env.services.workspaceService;
  const realSend: SendMessage = workspaceService.sendMessage.bind(workspaceService);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy: SendSpy = jest
    .spyOn(workspaceService, "sendMessage")
    .mockImplementation(async (...args: Parameters<SendMessage>) => {
      if (args[2].editMessageId === undefined) return realSend(...args);
      const reply = mode === "reply-only" ? await realSend(...args) : null;
      await gate;
      if (reply) return reply;
      if (mode === "accept") return realSend(...args);
      return mode === "refuse"
        ? Err({ type: "unknown", raw: "edit refused" })
        : Err({ type: "history-changed" });
    });
  return { release, spy };
}

const editRequests = (spy: SendSpy) =>
  spy.mock.calls.filter(([, , options]) => options.editMessageId !== undefined).length;

/** Let pending promise continuations (a late send reply, a refresh outcome) run. */
async function settleAsyncWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}

/** How many notes in the composer's review panel show `note`. */
const notesShowing = (app: AppHarness, note: string) =>
  reviewPanelNotes(app).filter((text) => text.includes(note)).length;

/** Send `text` with one attached note, and wait until its reply is complete. */
async function sendWithNote(app: AppHarness, text: string, id: string, note: string) {
  await attachStoreReview(app, id, note);
  await waitFor(() => expect(composerText(app)).toContain(note), LOAD_TOLERANT_WAIT);
  await app.chat.send(text);
  await app.chat.expectTranscriptContains(text, LOAD_TOLERANT_WAIT.timeout);
  await app.chat.expectTranscriptContains("Mock response", LOAD_TOLERANT_WAIT.timeout);
  await app.chat.expectStreamComplete();
}

/** Type the unsent draft and its file into the composer. */
async function typeUnsentDraft(app: AppHarness, scope: DraftScope) {
  await app.chat.typeWithoutSending("unsent draft");
  getDraftStore().setAttachments(scope, [UNSENT_FILE]);
}

/** Keep the workspace busy (its stream waits at start) and queue `text` behind it. */
async function queueBehindHeldStream(app: AppHarness, text: string, note?: string) {
  const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
  const options = { model: "openai:gpt-5.2", agentId: "exec" } as const;
  if (!session.isBusy()) {
    void app.env.orpc.workspace
      .sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options,
      })
      .catch(() => undefined);
    await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
  }
  await app.env.orpc.workspace.sendMessage({
    workspaceId: app.workspaceId,
    message: text,
    options: note
      ? { ...options, muxMetadata: { type: "normal", reviews: [review(note)] } }
      : options,
  });
  await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
  return session;
}

/** Right-click transcript text that shows `text` and pick "Quote in input". */
async function quoteTranscriptText(app: AppHarness, text: string) {
  const target = await waitFor(() => {
    const element = [...app.view.container.querySelectorAll("[data-message-block] *")]
      .reverse()
      .find(
        (candidate) => candidate.children.length === 0 && candidate.textContent?.includes(text)
      );
    if (!element) throw new Error(`Transcript text "${text}" not found`);
    return element;
  }, LOAD_TOLERANT_WAIT);
  // PositionedMenu anchors its popover with DOMRect, which tests/ui/dom.ts does not install.
  if (typeof DOMRect === "undefined") Object.assign(globalThis, { DOMRect: window.DOMRect });
  fireEvent.contextMenu(target);
  const quote = await waitFor(() => {
    const item = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Quote in input")
    );
    if (!item) throw new Error("Quote in input not found");
    return item;
  }, LOAD_TOLERANT_WAIT);
  fireEvent.click(quote);
}

function dispatchAppend(text: string, extra?: { workspaceId?: string; fileParts?: FilePart[] }) {
  act(() => {
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, { text, mode: "append", ...extra })
    );
  });
}

describe("An open edit never reaches the shared draft (#5672, #5571)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // T1
  test("a reload during an edit keeps the unsent draft and its files (#5672)", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-reload-keeps-draft" });
    let reloaded: DraftStore | null = null;
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      // Typing in the edit writes only the composer's memory, never the persisted draft store.
      const setText = jest.spyOn(getDraftStore(), "setText");
      const setAttachments = jest.spyOn(getDraftStore(), "setAttachments");
      for (const typed of ["e", "ed", "edi", "edit", "edited before reload"]) {
        typeIntoEdit(textarea, typed);
        await waitFor(() => expect(textarea.value).toBe(typed));
      }
      const workspaceCalls = (spy: typeof setText | typeof setAttachments) =>
        spy.mock.calls.filter(([callScope]) => callScope.kind === "workspace").length;
      expect(workspaceCalls(setText)).toBe(0);
      expect(workspaceCalls(setAttachments)).toBe(0);
      setText.mockRestore();
      setAttachments.mockRestore();

      await getDraftStore().flush(scope);
      reloaded = await otherRenderer(app);
      expect(reloaded.getText(scope)).toBe("unsent draft");
      const saved = await app.env.services.draftService.get(scope);
      expect(saved.text).toBe("unsent draft");
      expect(saved.attachments.map(({ id }) => id)).toEqual(["file-unsent"]);
    } finally {
      reloaded?.setClient(null);
      await app.dispose();
    }
  }, 120_000);

  // T2
  test("a second window keeps the unsent draft while the first edits (#5571)", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-other-window" });
    const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
    const secondWindow = await otherRenderer(app);
    try {
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited in window one");
      await waitFor(() => expect(textarea.value).toBe("edited in window one"));
      await getDraftStore().flush(scope);
      expect((await app.env.services.draftService.get(scope)).text).toBe("unsent draft");
      await waitFor(() => expect(secondWindow.getText(scope)).toBe("unsent draft"));

      // The second window changes the draft; the editing window shows it once its edit ends.
      secondWindow.setText(scope, "unsent draft, changed in window two");
      await secondWindow.flush(scope);
      await waitFor(
        () => expect(getDraftStore().getText(scope)).toBe("unsent draft, changed in window two"),
        LOAD_TOLERANT_WAIT
      );
      expect(textarea.value).toBe("edited in window one");
      fireEvent.keyDown(textarea, { key: "Escape" });
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      await expectDraft(app, scope, "unsent draft, changed in window two", ["unsent.txt"]);
    } finally {
      secondWindow.setClient(null);
      await app.dispose();
    }
  }, 120_000);

  // T11: dev builds render under StrictMode, whose extra mount cleanup must move nothing.
  test("under React StrictMode, a refused edit send reopens the edit", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-strict-refused", strictMode: true });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sends = holdEditSends(app, "refuse");
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);
      sends.release();
      await waitFor(() => expect(composerText(app)).toContain("edit refused"), LOAD_TOLERANT_WAIT);
      await waitFor(
        () => expect(editTextarea(app)?.value).toBe("edited message"),
        LOAD_TOLERANT_WAIT
      );
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});

describe("Inserts while an edit is open (D2-B)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // T22 (a)
  test("Quote in input appends to the open edit, and the unsent draft does not change", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-quote-into-edit" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      await quoteTranscriptText(app, "Mock response: first message");
      await waitFor(() => {
        expect(textarea.value.startsWith("edited message\n\n> ")).toBe(true);
        expect(textarea.value).toContain("Mock response: first message");
      }, LOAD_TOLERANT_WAIT);
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
    } finally {
      await app.dispose();
    }
  }, 120_000);
});

describe("An edit that ends without a send keeps its text after the unsent draft", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // T4
  test("a workspace switch during an edit puts the edit text and files after the unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-switch-moves-edit" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const other = await addOtherWorkspace(app, "edit-switch-moves-edit-other");
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));

      await switchAwayAndBack(app, other);
      expect(editTextarea(app)).toBeNull();
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
        "edit-file.md",
      ]);
      // Once: a second round trip moves nothing more.
      await switchAwayAndBack(app, other);
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
        "edit-file.md",
      ]);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T7 (a): the transcript drops the edited row (CP:1378); the edit's notes stay, as on main.
  test("an edit whose row is deleted keeps its text after the unsent draft, and its notes", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-row-deleted-keeps" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await sendWithNote(app, "first message", "review-row", "row note");
      await typeUnsentDraft(app, scope);
      await editRow(app, "first message");
      await waitFor(() => expect(notesShowing(app, "row note")).toBe(1), LOAD_TOLERANT_WAIT);
      typeIntoEdit(editTextarea(app)!, "edited message");
      await waitFor(() => expect(editTextarea(app)?.value).toBe("edited message"));

      const cleared = await app.env.services.workspaceService.truncateHistory(app.workspaceId);
      expect(cleared.success).toBe(true);
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
      ]);
      expect(notesShowing(app, "row note")).toBe(1);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T7 (b)
  test("an edit whose refused send's refresh finds no target keeps its text after the unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-target-gone-keeps" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sendSpy = jest
        .spyOn(app.env.services.workspaceService, "sendMessage")
        .mockResolvedValueOnce(Err({ type: "history-changed" }));
      const refreshSpy = jest
        .spyOn(WorkspaceStore.prototype, "requestTranscriptRefresh")
        .mockResolvedValue({ kind: "target-not-found" });
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(refreshSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
      ]);
      refreshSpy.mockRestore();
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T8
  test("a second Edit keeps the first edit's text and files after the unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-second-edit-keeps" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await app.chat.send("earlier message");
      await app.chat.expectTranscriptContains(
        "Mock response: earlier message",
        LOAD_TOLERANT_WAIT.timeout
      );
      await app.chat.expectStreamComplete();
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));

      await editRow(app, "earlier message");
      expect(composerText(app)).not.toContain("edit-file.md");
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
        "edit-file.md",
      ]);
      fireEvent.keyDown(editTextarea(app)!, { key: "Escape" });
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      expect(messageTextarea(app).value).toBe(joinDraftText("unsent draft", "edited message"));
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T9: the composer is replaced by the read-only notice.
  test("an edit keeps its text and files after the unsent draft when the workspace turns transcript-only", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-transcript-only-keeps" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      app.env.services.workspaceService.emit("metadata", {
        workspaceId: app.workspaceId,
        metadata: { ...app.metadata, transcriptOnly: true },
      });
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      await waitFor(
        () =>
          expect(getDraftStore().getText(scope)).toBe(
            joinDraftText("unsent draft", "edited message")
          ),
        LOAD_TOLERANT_WAIT
      );
      expect(draftFileNames(scope)).toEqual(["unsent.txt", "edit-file.md"]);
      await getDraftStore().flush(scope);
      const saved = await app.env.services.draftService.get(scope);
      expect(saved.text).toBe(joinDraftText("unsent draft", "edited message"));
      expect(attachmentNames(saved.attachments)).toEqual(["unsent.txt", "edit-file.md"]);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T13: the command took its text and files when it started, so the switch moves nothing.
  test("a /compact edit accepted after a switch leaves the unsent draft only, without the edit's files", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-compact-switch-accepted" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const other = await addOtherWorkspace(app, "edit-compact-switch-accepted-other");
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sends = holdEditSends(app);
      typeIntoEdit(textarea, "/compact -t 500");
      await waitFor(() => expect(textarea.value).toBe("/compact -t 500"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);

      await switchAwayAndBack(app, other);
      expect(editTextarea(app)).toBeNull();
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      sends.release();
      await app.chat.expectStreamComplete(60_000);
      await settleAsyncWork();
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T16: the switch ends the edit while its send waits for a settings save, before the take.
  test("a switch while the edit send is still preparing sends nothing and puts the edit after the unsent draft once", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-switch-while-preparing" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const other = await addOtherWorkspace(app, "edit-switch-while-preparing-other");
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sendSpy = jest.spyOn(app.env.services.workspaceService, "sendMessage");
      const save = await holdNextSendBeforeClear(app);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });

      await switchAwayAndBack(app, other);
      save.release();
      await settleAsyncWork();
      expect(editRequests(sendSpy)).toBe(0);
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
      ]);
      await app.chat.expectTranscriptContains("first message", LOAD_TOLERANT_WAIT.timeout);
      save.spy.mockRestore();
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});

// A switch unmounts the composer (ChatPane keys it by workspace) while its edit send or command
// is still in flight. That late completion must not touch the composer shown now.
describe("An edit send that settles after its composer unmounted", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // T6
  test("a history-changed refusal after a switch puts the edit after the unsent draft once and starts no refresh", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-refused-after-switch" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const other = await addOtherWorkspace(app, "edit-refused-after-switch-other");
      await visitWithMessage(app, other);
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sends = holdEditSends(app, "history-changed");
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);
      const refreshSpy = jest.spyOn(WorkspaceStore.prototype, "requestTranscriptRefresh");

      await showWorkspace(app, other.id, other.name);
      await editRow(app, "other message");
      sends.release();
      await settleAsyncWork();
      expect(editTextarea(app)?.value).toBe("other message");
      expect(refreshSpy.mock.calls.filter(([id]) => id === app.workspaceId)).toHaveLength(0);

      fireEvent.keyDown(editTextarea(app)!, { key: "Escape" });
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
        "edit-file.md",
      ]);
      refreshSpy.mockRestore();
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T10: ChatPane stays mounted; one edit slot serves both workspaces. Edit-row note: "row note".
  for (const targetShown of [true, false]) {
    test(`an edit send accepted after a switch (${targetShown ? "target still shown" : "row already replaced"}) leaves an edit in the other workspace open`, async () => {
      const app = await createAppHarness({
        branchPrefix: targetShown ? "edit-accepted-after-switch" : "edit-replaced-before-switch",
      });
      try {
        const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
        const other = await addOtherWorkspace(app, "edit-accepted-after-switch-other");
        await visitWithMessage(app, other);
        await sendWithNote(app, "first message", "review-row", "row note");
        await typeUnsentDraft(app, scope);
        await editRow(app, "first message");
        const sends = holdEditSends(app, targetShown ? "accept" : "reply-only");
        typeIntoEdit(editTextarea(app)!, "edited message");
        await waitFor(() => expect(editTextarea(app)?.value).toBe("edited message"));
        fireEvent.keyDown(editTextarea(app)!, { key: "Enter" });
        await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);
        if (!targetShown) {
          await app.chat.expectTranscriptNotContains("first message", LOAD_TOLERANT_WAIT.timeout);
        }

        // An edit in the other workspace; back here while the send is pending, Edit stays
        // refused (#5226); then the other workspace's edit again. ChatPane stays mounted.
        await showWorkspace(app, other.id, other.name);
        await editRow(app, "other message");
        await showWorkspace(app, app.workspaceId, app.metadata.name);
        await expectEditRefused(app, targetShown ? "first message" : "edited message");
        await showWorkspace(app, other.id, other.name);
        await editRow(app, "other message");
        typeIntoEdit(editTextarea(app)!, "edited other message");
        await waitFor(() => expect(editTextarea(app)?.value).toBe("edited other message"));
        sends.release();
        await Promise.allSettled(sends.spy.mock.results.map((result): unknown => result.value));
        await settleAsyncWork();
        expect(editTextarea(app)?.value).toBe("edited other message");

        fireEvent.keyDown(editTextarea(app)!, { key: "Escape" });
        await showWorkspace(app, app.workspaceId, app.metadata.name);
        await app.chat.expectTranscriptNotContains("first message", LOAD_TOLERANT_WAIT.timeout);
        await app.chat.expectStreamComplete();
        const editedRows = useWorkspaceStoreRaw()
          .getWorkspaceState(app.workspaceId)
          .messages.filter(
            (message) => message.type === "user" && message.content.endsWith("edited message")
          );
        expect(editedRows).toHaveLength(1);
        await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
        expect(notesShowing(app, "row note")).toBe(0);
        sends.spy.mockRestore();
      } finally {
        await app.dispose();
      }
    }, 120_000);
  }

  // T14
  test("a /compact edit that fails after a switch puts its text and files after the unsent draft once", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-compact-switch-failed" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const other = await addOtherWorkspace(app, "edit-compact-switch-failed-other");
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sends = holdEditSends(app, "refuse");
      typeIntoEdit(textarea, "/compact -t 500");
      await waitFor(() => expect(textarea.value).toBe("/compact -t 500"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);

      await switchAwayAndBack(app, other);
      sends.release();
      await settleAsyncWork();
      await expectDraft(app, scope, joinDraftText("unsent draft", "/compact -t 500"), [
        "unsent.txt",
        "edit-file.md",
      ]);
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T19 (a)
  test("a refresh that finds no target after a switch leaves an edit in the other workspace open", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-refresh-after-switch" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const other = await addOtherWorkspace(app, "edit-refresh-after-switch-other");
      await visitWithMessage(app, other);
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sendSpy = jest
        .spyOn(app.env.services.workspaceService, "sendMessage")
        .mockResolvedValueOnce(Err({ type: "history-changed" }));
      let finishRefresh: (outcome: TranscriptRefreshOutcome) => void = () => undefined;
      const refreshOutcome = new Promise<TranscriptRefreshOutcome>((resolve) => {
        finishRefresh = resolve;
      });
      const refreshSpy = jest
        .spyOn(WorkspaceStore.prototype, "requestTranscriptRefresh")
        .mockImplementation(() => refreshOutcome);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(refreshSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);

      await showWorkspace(app, other.id, other.name);
      await editRow(app, "other message");
      finishRefresh({ kind: "target-not-found" });
      await settleAsyncWork();
      expect(editTextarea(app)?.value).toBe("other message");

      fireEvent.keyDown(editTextarea(app)!, { key: "Escape" });
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await expectDraft(app, scope, joinDraftText("unsent draft", "edited message"), [
        "unsent.txt",
      ]);
      refreshSpy.mockRestore();
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});

describe("Edit sends, restores and inserts while the unsent draft waits", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  // T3: the final check's repro on #5801 (R2 c7e7fdbe76 showed the unsent draft twice).
  for (const olderHistory of [false, true]) {
    test(`a queued message restored during an edit send shows once next to the unsent draft (${olderHistory ? "older history" : "short transcript"})`, async () => {
      const app = await createAppHarness({
        branchPrefix: olderHistory ? "edit-restore-queue-long" : "edit-restore-queue-short",
      });
      try {
        const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
        for (const text of olderHistory
          ? ["first message", "second message", "third message"]
          : ["first message"]) {
          await app.chat.send(text);
          await app.chat.expectTranscriptContains(
            `Mock response: ${text}`,
            LOAD_TOLERANT_WAIT.timeout
          );
          await app.chat.expectStreamComplete();
        }
        await typeUnsentDraft(app, scope);
        await queueBehindHeldStream(app, "queued Q");
        await editRow(app, "first message");
        typeIntoEdit(editTextarea(app)!, "edited message");
        await waitFor(() => expect(editTextarea(app)?.value).toBe("edited message"));
        fireEvent.keyDown(editTextarea(app)!, { key: "Enter" });

        // The edit's truncation gives the queued message back to the composer.
        await waitFor(
          () => expect(getDraftStore().getText(scope)).toContain("queued Q"),
          LOAD_TOLERANT_WAIT
        );
        app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
        await app.chat.expectTranscriptContains(
          "Mock response: edited message",
          LOAD_TOLERANT_WAIT.timeout
        );
        await app.chat.expectStreamComplete();
        await settleAsyncWork();
        const text = getDraftStore().getText(scope);
        expect(occurrences(text, "unsent draft")).toBe(1);
        expect(occurrences(text, "queued Q")).toBe(1);
        expect(draftFileNames(scope).filter((name) => name === "unsent.txt")).toHaveLength(1);
      } finally {
        await app.dispose();
      }
    }, 120_000);
  }

  // T5
  test("a refused edit send reopens the edit with its text and file, and the draft stays the unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-refused-reopens" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sends = holdEditSends(app, "refuse");
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);
      sends.release();
      await waitFor(
        () => expect(editTextarea(app)?.value).toBe("edited message"),
        LOAD_TOLERANT_WAIT
      );
      expect(occurrences(composerText(app), "edit-file.md")).toBe(1);
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T12 (D3-A)
  test("while an edit send is pending the composer shows the unsent draft, and typing changes it", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-pending-shows-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);
      const sends = holdEditSends(app, "reply-only");
      await sendEdit(app, "[mock:wait-start] edited message", "first message");
      await app.chat.expectInputValue("unsent draft", LOAD_TOLERANT_WAIT.timeout);
      fireEvent.change(messageTextarea(app), {
        target: { value: "unsent draft, typed meanwhile" },
      });
      await waitFor(() =>
        expect(getDraftStore().getText(scope)).toBe("unsent draft, typed meanwhile")
      );

      sends.release();
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
      await settleAsyncWork();
      await expectDraft(app, scope, "unsent draft, typed meanwhile", ["unsent.txt"]);
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T15: the send waits for a settings save before it takes the text; the user keeps typing.
  for (const accepted of [true, false]) {
    test(`text typed into the edit while its send prepares survives ${accepted ? "an accepted send, after the unsent draft" : "a refused send, after the edit text"}`, async () => {
      const app = await createAppHarness({
        branchPrefix: accepted ? "edit-typed-while-sending-ok" : "edit-typed-while-sending-refused",
      });
      try {
        const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
        const textarea = await startEditWithUnsentDraft(app, scope);
        const sendSpy = accepted
          ? null
          : jest
              .spyOn(app.env.services.workspaceService, "sendMessage")
              .mockResolvedValueOnce(Err({ type: "unknown", raw: "edit refused" }));
        const save = await holdNextSendBeforeClear(app);
        typeIntoEdit(textarea, "edited message");
        await waitFor(() => expect(textarea.value).toBe("edited message"));
        fireEvent.keyDown(textarea, { key: "Enter" });
        typeIntoEdit(textarea, "edited message\n\ntyped while sending");
        await waitFor(() => expect(textarea.value).toBe("edited message\n\ntyped while sending"));
        save.release();

        if (accepted) {
          await app.chat.expectTranscriptContains(
            "Mock response: edited message",
            LOAD_TOLERANT_WAIT.timeout
          );
          await app.chat.expectStreamComplete();
          await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
          await expectDraft(app, scope, joinDraftText("unsent draft", "typed while sending"), [
            "unsent.txt",
          ]);
        } else {
          await waitFor(
            () => expect(composerText(app)).toContain("edit refused"),
            LOAD_TOLERANT_WAIT
          );
          await waitFor(
            () =>
              expect(editTextarea(app)?.value).toBe(
                joinDraftText("edited message", "typed while sending")
              ),
            LOAD_TOLERANT_WAIT
          );
        }
        save.spy.mockRestore();
        sendSpy?.mockRestore();
      } finally {
        await app.dispose();
      }
    }, 120_000);
  }

  // T17 (a)
  test("the queued card's Edit while an edit is visible leaves the message queued and changes nothing", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-queued-card-refused" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      const session = await queueBehindHeldStream(app, "queued Q");
      await editQueuedMessage(app);
      await settleAsyncWork();
      expect(session.hasQueuedMessages()).toBe(true);
      expect(editTextarea(app)?.value).toBe("edited message");
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T17 (b)
  test("the queued card's Edit during an edit send puts the message in front of the shown unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-queued-card-during-send" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      // Held before the backend sees it: the edit's target still shows (section 3, step 11).
      // The busy stream below changes the history, so the backend would refuse the edit anyway.
      const sends = holdEditSends(app, "refuse");
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(editRequests(sends.spy)).toBe(1), LOAD_TOLERANT_WAIT);
      await queueBehindHeldStream(app, "queued Q", "queued note");
      await editQueuedMessage(app);
      await waitFor(
        () =>
          expect(getDraftStore().getText(scope)).toBe(joinDraftText("queued Q", "unsent draft")),
        LOAD_TOLERANT_WAIT
      );
      expect(draftFileNames(scope)).toEqual(["unsent.txt"]);
      // The note joins the attached notes in the review store, not the composer's override.
      await waitFor(() =>
        expect(
          getReviewStateStore()
            .getAttachedReviews(app.workspaceId)
            .filter((attached) => attached.data.userNote === "queued note")
        ).toHaveLength(1)
      );

      // The refused edit opens again with its text, and "Q, U" waits behind it.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
      sends.release();
      await waitFor(
        () => expect(editTextarea(app)?.value).toBe("edited message"),
        LOAD_TOLERANT_WAIT
      );
      await settleAsyncWork();
      await expectDraft(app, scope, joinDraftText("queued Q", "unsent draft"), ["unsent.txt"]);
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T19 (b)
  test("an old Retry refresh starts no refresh after Cancel and reopening the same row", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-old-retry-ignored" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      const sendSpy = jest
        .spyOn(app.env.services.workspaceService, "sendMessage")
        .mockResolvedValueOnce(Err({ type: "history-changed" }));
      const refreshSpy = jest
        .spyOn(WorkspaceStore.prototype, "requestTranscriptRefresh")
        .mockResolvedValue({ kind: "failed", error: "refresh unavailable" });
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(
        () => expect(composerText(app)).toContain("transcript refresh failed"),
        LOAD_TOLERANT_WAIT
      );

      fireEvent.keyDown(editTextarea(app)!, { key: "Escape" });
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      await editRow(app, "first message");
      typeIntoEdit(editTextarea(app)!, "reopened edit");
      await waitFor(() => expect(editTextarea(app)?.value).toBe("reopened edit"));
      const retries = [...document.body.querySelectorAll("button")].filter(
        (button) => button.textContent === EDIT_RETRY_REFRESH_LABEL
      );
      expect(retries.length).toBeGreaterThan(0);
      const refreshCalls = refreshSpy.mock.calls.length;
      for (const retry of retries) fireEvent.click(retry);
      await settleAsyncWork();
      expect(refreshSpy.mock.calls.length).toBe(refreshCalls);
      expect(editTextarea(app)?.value).toBe("reopened edit");
      expect(composerText(app)).not.toContain("history changed");
      refreshSpy.mockRestore();
      sendSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T20: no dispatcher sends files with "append"; the test dispatches it.
  test("an append with a file during an open edit changes neither the edit nor the unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-append-file-dropped" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      dispatchAppend("appended text", {
        fileParts: [
          {
            url: "data:text/plain;base64,YXBwZW5kZWQ=",
            mediaType: "text/plain",
            filename: "appended.txt",
          },
        ],
      });
      await settleAsyncWork();
      expect(textarea.value).toBe("edited message");
      expect(composerText(app)).not.toContain("appended.txt");
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T21: /compact turns a failed request into a "restore"; a rejection escapes only from the
  // command chain itself, so the test makes the command's continuation reject.
  test("an editing /compact whose request rejects puts its text and files back into the edit once", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-compact-rejects" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await attachComposerFile(app, "edit-file.md");
      const textarea = await startEditWithUnsentDraft(app, scope);
      const realProcess = chatCommands.processSlashCommand;
      const commandSpy = jest
        .spyOn(chatCommands, "processSlashCommand")
        .mockImplementation(async (...args: Parameters<typeof realProcess>) => {
          const result = await realProcess(...args);
          return result.kind === "phase"
            ? {
                ...result,
                continue: () => Promise.reject(new Error("compaction request rejected")),
              }
            : result;
        });
      // The rejection still leaves the composer's send unhandled (`void handleSend()`), as on
      // main. Only the restore is under test, so the send's outer wrapper stops it there.
      const realFinally = controlFlow.runWithFinally;
      const rejections: unknown[] = [];
      const finallySpy = jest.spyOn(controlFlow, "runWithFinally").mockImplementation((async (
        body: () => Promise<unknown>,
        cleanup: () => void
      ) => {
        try {
          return await realFinally(body, cleanup);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "compaction request rejected") {
            throw error;
          }
          rejections.push(error);
          return undefined;
        }
      }) as typeof realFinally);
      typeIntoEdit(textarea, "/compact -t 500");
      await waitFor(() => expect(textarea.value).toBe("/compact -t 500"));
      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(commandSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);
      await settleAsyncWork();
      expect(rejections).toHaveLength(1);
      await waitFor(
        () => expect(editTextarea(app)?.value).toBe("/compact -t 500"),
        LOAD_TOLERANT_WAIT
      );
      expect(occurrences(composerText(app), "edit-file.md")).toBe(1);
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      commandSpy.mockRestore();
      finallySpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T22 (b) and (c): CommandPalette.tsx:276 sends no workspace id; McpAppFrame.tsx:278 does.
  for (const fromMcpApp of [false, true]) {
    test(`${fromMcpApp ? "an MCP App message" : "a palette insert"} appends to the open edit, and the unsent draft does not change`, async () => {
      const app = await createAppHarness({
        branchPrefix: fromMcpApp ? "edit-mcp-insert" : "edit-palette-insert",
      });
      try {
        const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
        const textarea = await startEditWithUnsentDraft(app, scope);
        typeIntoEdit(textarea, "edited message");
        await waitFor(() => expect(textarea.value).toBe("edited message"));
        dispatchAppend("inserted text", fromMcpApp ? { workspaceId: app.workspaceId } : undefined);
        await waitFor(() => expect(textarea.value).toBe("edited message\n\ninserted text"));
        await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      } finally {
        await app.dispose();
      }
    }, 120_000);
  }

  // T22 (d)
  test("a quote during an edit send appends to the shown unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-quote-during-send" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      for (const text of ["first message", "second message"]) {
        await app.chat.send(text);
        await app.chat.expectTranscriptContains(
          `Mock response: ${text}`,
          LOAD_TOLERANT_WAIT.timeout
        );
        await app.chat.expectStreamComplete();
      }
      await typeUnsentDraft(app, scope);
      await editRow(app, "second message");
      const sends = holdEditSends(app, "reply-only");
      await sendEdit(app, "[mock:wait-start] edited message", "Mock response: second message");
      await quoteTranscriptText(app, "Mock response: first message");
      await waitFor(() => {
        const text = getDraftStore().getText(scope);
        expect(text.startsWith("unsent draft\n\n> ")).toBe(true);
        expect(text).toContain("Mock response: first message");
      }, LOAD_TOLERANT_WAIT);
      expect(messageTextarea(app).value).toBe(getDraftStore().getText(scope));
      sends.release();
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await app.chat.expectStreamComplete();
      sends.spy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);

  // T23: the file add checks for an edit before its awaits; the edit opens while it stages.
  test("a file add that lands after Edit opens is refused and writes neither the edit nor the draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-late-file-refused" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains(
        "Mock response: first message",
        LOAD_TOLERANT_WAIT.timeout
      );
      await app.chat.expectStreamComplete();
      await typeUnsentDraft(app, scope);
      const workspaceService = app.env.services.workspaceService;
      const realStage = workspaceService.stageAttachment.bind(workspaceService);
      let releaseStage: () => void = () => undefined;
      const stageGate = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      const stageSpy = jest
        .spyOn(workspaceService, "stageAttachment")
        .mockImplementation(async (...args: Parameters<typeof realStage>) => {
          await stageGate;
          return realStage(...args);
        });
      const input = app.view.container.querySelector<HTMLInputElement>(
        '[data-component="ChatInputSection"] input[type="file"]'
      )!;
      fireEvent.change(input, {
        target: { files: [new File(["# late"], "late.md", { type: "text/markdown" })] },
      });
      await waitFor(() => expect(stageSpy).toHaveBeenCalled(), LOAD_TOLERANT_WAIT);
      await editRow(app, "first message");
      releaseStage();
      await waitFor(
        () =>
          expect(composerText(app)).toContain(
            "Attachments cannot be added while editing a message."
          ),
        LOAD_TOLERANT_WAIT
      );
      await settleAsyncWork();
      expect(composerText(app)).not.toContain("late.md");
      expect(editTextarea(app)?.value).toBe("first message");
      await expectDraft(app, scope, "unsent draft", ["unsent.txt"]);
      stageSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
