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
import { act, fireEvent, waitFor, within } from "@testing-library/react";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { DraftStore, getDraftStore } from "@/browser/stores/DraftStore";
import { WorkspaceStore, workspaceStore } from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import { getAutoCompactionThresholdKey } from "@/common/constants/storage";
import type { DraftScope } from "@/common/orpc/schemas/drafts";
import type { ReviewNoteData } from "@/common/types/review";
import { EDIT_HISTORY_CHANGED_MESSAGE } from "@/constants/transcriptBarrier";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { Err } from "@/common/types/result";
import { detectDefaultTrunkBranch } from "@/node/git";
import { generateBranchName } from "../../ipc/helpers";
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

/** The composer's normal (not edit) textarea. */
function messageTextarea(app: AppHarness): HTMLTextAreaElement {
  const textarea = app.view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]'
  );
  if (!textarea) throw new Error("Message textarea not found");
  return textarea;
}

/** An edit that ended unsettled: its text follows the unsent draft, which keeps its file. */
async function expectEditKeptAsDraft(app: AppHarness, scope: DraftScope) {
  await waitFor(() => {
    const value = messageTextarea(app).value;
    expect(value.startsWith("unsent draft")).toBe(true);
    expect(value.trimEnd().endsWith("edited message")).toBe(true);
  }, LOAD_TOLERANT_WAIT);
  expect(getDraftStore().getText(scope)).toBe(messageTextarea(app).value);
  expect(
    getDraftStore()
      .getView(scope)
      .attachments.map(({ id }) => id)
  ).toEqual(["file-unsent"]);
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

/** Another renderer on the same backend: a reload of this window, or a second window. */
async function otherRenderer(app: AppHarness): Promise<DraftStore> {
  const store = new DraftStore();
  store.setClient(createTestApiClient(app.env.orpc));
  await store.whenReady();
  return store;
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

  // The edit text lives in this window's memory only: the shared draft keeps the unsent draft,
  // so a reload (#5672) and a second window (#5571) both see the unsent draft, never the edit.
  test("a reload during an edit keeps the unsent draft (#5672)", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-reload-keeps-draft" });
    let reloaded: DraftStore | null = null;
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      // Typing in the edit writes only the memory buffer, never the persisted draft store.
      const setText = jest.spyOn(getDraftStore(), "setText");
      const setAttachments = jest.spyOn(getDraftStore(), "setAttachments");
      typeIntoEdit(textarea, "edited before reload");
      await waitFor(() => expect(textarea.value).toBe("edited before reload"));
      expect(setText).not.toHaveBeenCalled();
      expect(setAttachments).not.toHaveBeenCalled();
      setText.mockRestore();
      setAttachments.mockRestore();
      await getDraftStore().flush(scope);
      expect((await app.env.services.draftService.get(scope)).text).toBe("unsent draft");
      reloaded = await otherRenderer(app);
      expect(reloaded.getText(scope)).toBe("unsent draft");
      const saved = await app.env.services.draftService.get(scope);
      expect(saved.attachments.map(({ id }) => id)).toEqual(["file-unsent"]);
    } finally {
      reloaded?.setClient(null);
      await app.dispose();
    }
  }, 120_000);

  // A workspace switch remounts the composer while ChatPane keeps the edit open: the edit's
  // typed text and attachment changes must survive it, in memory only (#5808). An edit cannot
  // add attachments, so its attachment change is removing one of the message's files.
  test("an open edit keeps its typed text and attachments across a workspace switch", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-survives-switch" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const fileInput = await waitFor(() => {
        const element = app.view.container.querySelector<HTMLInputElement>(
          '[data-component="ChatInputSection"] input[type="file"]'
        );
        if (!element) throw new Error("File input not found");
        return element;
      }, LOAD_TOLERANT_WAIT);
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(["# kept"], "edit-kept.md", { type: "text/markdown" }),
            new File(["# removed"], "edit-removed.md", { type: "text/markdown" }),
          ],
        },
      });
      await waitFor(() => {
        expect(composerText(app)).toContain("edit-kept.md");
        expect(composerText(app)).toContain("edit-removed.md");
      }, LOAD_TOLERANT_WAIT);
      const textarea = await startEditWithUnsentDraft(app, scope);
      await waitFor(() => expect(composerText(app)).toContain("edit-removed.md"), LOAD_TOLERANT_WAIT);
      typeIntoEdit(textarea, "edited before switch");
      await waitFor(() => expect(textarea.value).toBe("edited before switch"));
      const removeButton = [
        ...app.view.container.querySelectorAll<HTMLButtonElement>(
          '[data-component="ChatInputSection"] button[aria-label="Remove attachment"]'
        ),
      ].find((button) => button.parentElement?.textContent?.includes("edit-removed.md"));
      if (!removeButton) throw new Error("Remove button of edit-removed.md not found");
      fireEvent.click(removeButton);
      await waitFor(
        () => expect(composerText(app)).not.toContain("edit-removed.md"),
        LOAD_TOLERANT_WAIT
      );

      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("edit-survives-switch-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      workspaceStore.addWorkspace(created.metadata);
      await showWorkspace(app, created.metadata.id, created.metadata.name);
      await showWorkspace(app, app.workspaceId, app.metadata.name);

      await waitFor(
        () => expect(editTextarea(app)?.value).toBe("edited before switch"),
        LOAD_TOLERANT_WAIT
      );
      expect(composerText(app)).toContain("edit-kept.md");
      expect(composerText(app)).not.toContain("edit-removed.md");
      // The unsent draft never took the edit's text or files, in memory or on the backend.
      expect(getDraftStore().getText(scope)).toBe("unsent draft");
      expect(
        getDraftStore()
          .getView(scope)
          .attachments.map(({ id }) => id)
      ).toEqual(["file-unsent"]);
      await getDraftStore().flush(scope);
      const saved = await app.env.services.draftService.get(scope);
      expect(saved.text).toBe("unsent draft");
      expect(saved.attachments.map(({ id }) => id)).toEqual(["file-unsent"]);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("an edit in one window does not reach another window's composer (#5571)", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-other-window" });
    const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
    const secondWindow = await otherRenderer(app);
    try {
      await startEditWithUnsentDraft(app, scope);
      await getDraftStore().flush(scope);
      // The second window saw the unsent draft arrive; the edit text never follows it.
      await waitFor(() => expect(secondWindow.getText(scope)).toBe("unsent draft"));
      await getDraftStore().flush(scope);
      expect(secondWindow.getText(scope)).toBe("unsent draft");
    } finally {
      secondWindow.setClient(null);
      await app.dispose();
    }
  }, 120_000);

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

  // The edit can end without the composer settling it: ChatPane drops the edit when its row
  // leaves the transcript, or when a history-changed refresh finds no target. The edit's text
  // and attachments then stay as a normal draft after the unsent draft, and typing goes there.
  test("an edit whose row is deleted stays as a normal draft, after the unsent draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-row-deleted-typing" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const textarea = await startEditWithUnsentDraft(app, scope);
      typeIntoEdit(textarea, "edited message");
      await waitFor(() => expect(textarea.value).toBe("edited message"));
      const cleared = await app.env.services.workspaceService.truncateHistory(app.workspaceId);
      expect(cleared.success).toBe(true);
      await waitFor(() => expect(editTextarea(app)).toBeNull(), LOAD_TOLERANT_WAIT);
      await expectEditKeptAsDraft(app, scope);

      const composer = messageTextarea(app);
      // Through the textarea, as a user types: the store shortcut would bypass the composer.
      fireEvent.change(composer, { target: { value: "typed after the edit ended" } });
      await app.chat.expectInputValue("typed after the edit ended", LOAD_TOLERANT_WAIT.timeout);
      expect(getDraftStore().getText(scope)).toBe("typed after the edit ended");
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("an edit whose target a history-changed refresh cannot find stays as a normal draft", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-target-gone-keeps-text" });
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
      await expectEditKeptAsDraft(app, scope);
      refreshSpy.mockRestore();
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

  test("no new edit starts while an edit send is pending; the unsent draft is back once it is accepted", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-refused-while-pending" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);
      // Hold the edit's reply, and its stream at start: the composer is usable meanwhile.
      const replies = holdSendReplies(app);
      await sendEdit(app, "[mock:wait-start] edited message", "first message");

      // The edit text never replaced the unsent draft: once the edited row is replaced, the
      // composer shows the draft again, before the edit's reply.
      await app.chat.expectInputValue("unsent draft", LOAD_TOLERANT_WAIT.timeout);
      // A second edit (the row's Edit action) and a third (ArrowUp in an emptied composer).
      await expectEditRefused(app, "edited message");
      await app.chat.typeWithoutSending("");
      await act(async () => {
        fireEvent.keyDown(composerHolding(app, ""), { key: "ArrowUp" });
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(editTextarea(app)).toBeNull();
      await app.chat.typeWithoutSending("unsent draft\n\ntyped meanwhile");

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

  test("a follow-up sent while an edit is pending gets nothing merged in when the edit completes", async () => {
    const app = await createAppHarness({ branchPrefix: "edit-followup-keeps-draft" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      await startEditWithUnsentDraft(app, scope);
      // Hold the edit's reply, and its stream at start: the composer is usable meanwhile.
      const replies = holdSendReplies(app);
      await sendEdit(app, "[mock:wait-start] edited message", "first message");

      // The unsent draft is back once the edit is accepted; the user replaces it.
      await app.chat.expectInputValue("unsent draft", LOAD_TOLERANT_WAIT.timeout);
      const save = await holdNextSendBeforeClear(app);
      await app.chat.typeWithoutSending("follow-up");
      pressEnterInComposer(app, "follow-up");

      // The edit completes while the follow-up waits: nothing is restored into the composer.
      replies.release();
      // Edits work again once the edit send settled.
      await waitFor(
        () => expect(rowEditButton(app, "edited message")?.disabled).toBe(false),
        LOAD_TOLERANT_WAIT
      );
      expect(getDraftStore().getText(scope)).toBe("follow-up");

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
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
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
      await sendEdit(app, "[mock:wait-start] edited message", "first message");
      // The pre-edit text never left the draft: it shows once the edit is accepted.
      await app.chat.expectInputValue(restoredText, LOAD_TOLERANT_WAIT.timeout);

      // While the edit's stream starts, a queued message without notes goes back into the
      // composer: its note list is empty, and that is what the follow-up send captures.
      await app.chat.send("second follow-up");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
      await editQueuedMessage(app);
      await app.chat.expectInputValue("second follow-up", LOAD_TOLERANT_WAIT.timeout);
      const save = await holdNextSendBeforeClear(app);
      pressEnterInComposer(app, "second follow-up");

      // The edit completes while the follow-up waits: its note comes back. (Its text never
      // left the draft; sending the follow-up above replaced it.)
      replies.release();
      await waitFor(
        () => expect(reviewPanelNotes(app).join("\n")).toContain("pre-edit note"),
        LOAD_TOLERANT_WAIT
      );
      expect(getDraftStore().getText(scope)).toBe("second follow-up");

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
