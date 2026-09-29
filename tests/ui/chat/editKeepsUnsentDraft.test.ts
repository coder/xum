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

import { getDraftStore } from "@/browser/stores/DraftStore";
import type { DraftScope } from "@/common/orpc/schemas/drafts";
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
