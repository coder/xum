/**
 * #5934: the queued card's Edit used to work while another message was being edited. It cleared
 * the queue and put the queued message into the open edit (the typed change was gone), and a
 * Cancel then restored only the pre-edit draft: the queued message and its note were lost.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, fireEvent, waitFor, within } from "@testing-library/react";

import { getDraftStore } from "@/browser/stores/DraftStore";
import type { ReviewNoteData } from "@/common/types/review";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const WAIT = { timeout: 30_000 };

const review = (note: string): ReviewNoteData => ({
  filePath: "src/file.ts",
  lineRange: "1",
  selectedCode: "call()",
  userNote: note,
});
const editTextarea = (app: AppHarness) =>
  app.view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit message"]');
const composerSection = (app: AppHarness) => {
  const section = app.view.container.querySelector<HTMLElement>(
    '[data-component="ChatInputSection"]'
  );
  if (!section) throw new Error("Composer not found");
  return section;
};
const queuedEditButton = (app: AppHarness) =>
  [
    ...app.view.container.querySelectorAll<HTMLButtonElement>(
      '[data-component="QueuedMessageActions"] button'
    ),
  ].find((element) => element.textContent?.includes("Edit"));
const rowEditButton = (app: AppHarness, rowText: string) =>
  [
    ...app.view.container.querySelectorAll<HTMLButtonElement>(
      '[data-message-block] button[aria-label="Edit"]'
    ),
  ].find((element) => element.closest("[data-message-block]")?.textContent?.includes(rowText));
/** Notes still attached in the workspace's backend review store. */
const attachedStoreNotes = async (app: AppHarness) =>
  Object.values(
    (await app.env.services.reviewStateService.getSnapshot(app.workspaceId)).sections.reviews ?? {}
  )
    .filter((entry) => entry.status === "attached")
    .map((entry) => entry.data.userNote);

describe("the queued card's Edit during an open edit (#5934)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("leaves the message queued and the open edit as typed; Cancel keeps both", async () => {
    const app = await createAppHarness({ branchPrefix: "queued-edit-during-edit" });
    const scope = { kind: "workspace" as const, workspaceId: app.workspaceId };
    const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
    let holding: Promise<unknown> | undefined;
    try {
      await app.chat.send("first message");
      await app.chat.expectTranscriptContains("Mock response: first message", WAIT.timeout);
      await app.chat.expectStreamComplete();

      // Q waits in the queue behind a busy workspace, with one review note.
      holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      await waitFor(() => expect(session.isBusy()).toBe(true), WAIT);
      await app.env.orpc.workspace.reviewState.update({
        workspaceId: app.workspaceId,
        delta: {
          reviews: {
            set: {
              "review-q": {
                id: "review-q",
                data: review("queued note"),
                status: "attached",
                createdAt: Date.now(),
              },
            },
          },
        },
      });
      await waitFor(() => expect(composerSection(app).textContent).toContain("queued note"), WAIT);
      await app.chat.send("queued Q");
      await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), WAIT);
      await app.chat.expectInputValue("", WAIT.timeout);
      // The queued send checked its note off: the note now lives only in the queued message.
      await waitFor(async () => expect(await attachedStoreNotes(app)).toEqual([]), WAIT);

      // An unsent draft, then an open edit of the sent message with a typed change.
      await app.chat.typeWithoutSending("unsent draft");
      const rowEdit = await waitFor(() => {
        const button = rowEditButton(app, "first message");
        if (!button || button.disabled) throw new Error("Row Edit not available");
        return button;
      }, WAIT);
      fireEvent.click(rowEdit);
      await waitFor(() => expect(editTextarea(app)?.value).toBe("first message"), WAIT);
      act(() => getDraftStore().setText(scope, "edited message"));
      await waitFor(() => expect(editTextarea(app)?.value).toBe("edited message"), WAIT);

      // The queued card's Edit while the edit is open changes nothing.
      const queuedEdit = await waitFor(() => {
        const button = queuedEditButton(app);
        if (!button) throw new Error("Queued Edit not found");
        return button;
      }, WAIT);
      // It shows as blocked while the edit is open.
      expect(queuedEdit.getAttribute("aria-disabled")).toBe("true");
      // Counted at the backend: the blocked click must never reach clearQueue. The allowed Edit at
      // the end reaches it exactly once, so a late clear from this click shows as a second call.
      const clearQueue = jest.spyOn(app.env.services.workspaceService, "clearQueue");
      fireEvent.click(queuedEdit);
      expect(session.hasQueuedMessages()).toBe(true);
      expect(editTextarea(app)?.value).toBe("edited message");

      // Cancel brings the unsent draft back; Q and its note are still queued.
      fireEvent.click(within(composerSection(app)).getByRole("button", { name: "Cancel" }));
      await app.chat.expectInputValue("unsent draft", WAIT.timeout);
      expect(session.hasQueuedMessages()).toBe(true);
      const queued = app.view.container.querySelector('[data-component="QueuedMessageActions"]')
        ?.parentElement?.textContent;
      expect(queued).toContain("queued Q");
      expect(queued).toContain("queued note");
      // The queued note is the queued message's, not an attached composer note.
      expect(await attachedStoreNotes(app)).toEqual([]);

      // After the edit ends, the queued card's Edit works again.
      await waitFor(
        () => expect(queuedEditButton(app)?.hasAttribute("aria-disabled")).toBe(false),
        WAIT
      );
      expect(clearQueue).not.toHaveBeenCalled();
      fireEvent.click(queuedEditButton(app)!);
      await waitFor(() => expect(getDraftStore().getText(scope)).toContain("queued Q"), WAIT);
      expect(clearQueue).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(composerSection(app).textContent).toContain("queued note"), WAIT);
      expect(session.hasQueuedMessages()).toBe(false);
    } finally {
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await holding;
      await app.dispose();
    }
  }, 180_000);
});
