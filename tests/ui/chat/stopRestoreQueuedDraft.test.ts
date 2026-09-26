/**
 * Stop while a message is queued returns the queued message to the composer (the backend's
 * `restore-to-input`). Issue #4431: that restore replaced whatever the composer held, so a newer
 * draft the user typed while the message waited was lost. The restore now keeps the newer draft:
 * an empty composer gets exactly the queued message (unchanged behavior); an occupied composer
 * gets the queued message first (it was written, and would have been sent, first) followed by the
 * draft, with both sets of attachments and reviews.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, fireEvent, waitFor } from "@testing-library/react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputAttachmentsKey, getReviewsKey } from "@/common/constants/storage";
import { formatReviewForModel, type ReviewNoteData } from "@/common/types/review";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

/** Bound for waits behind a composer send (see heldQueuedMessage.test.ts). */
const LOAD_TOLERANT_WAIT = { timeout: 30_000 };

const review = (note: string): ReviewNoteData => ({
  filePath: "src/file.ts",
  lineRange: "1",
  selectedCode: "call()",
  userNote: note,
});
const providerAttachment = (filename: string) => ({
  kind: "provider" as const,
  id: `file-${filename}`,
  url: "data:text/plain;base64,cXVldWVk",
  mediaType: "text/plain",
  filename,
});

const composerAttachmentNames = (app: AppHarness) =>
  readPersistedState<{ filename?: string }[]>(getInputAttachmentsKey(app.workspaceId), []).map(
    (attachment) => attachment.filename
  );
/** Notes still attached in the workspace's review store (a send checks its notes off). */
const attachedStoreReviewNotes = (app: AppHarness) =>
  Object.values(
    readPersistedState<{ reviews?: Record<string, { status: string; data: ReviewNoteData }> }>(
      getReviewsKey(app.workspaceId),
      {}
    ).reviews ?? {}
  )
    .filter((entry) => entry.status === "attached")
    .map((entry) => entry.data.userNote);
/** Text of the mounted workspace composer (its review panel lives inside it). */
const composerText = (app: AppHarness) =>
  [...app.view.container.querySelectorAll('[data-component="ChatInputSection"]')]
    .map((section) => section.textContent ?? "")
    .join("\n");
const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1;
/** The composer review panel's "Detach from message" button for the note with this text. */
const detachButtonForNote = (app: AppHarness, note: string) => {
  const block = [
    ...app.view.container.querySelectorAll('[data-component="ChatInputSection"] .group\\/review'),
  ].find((element) => element.textContent?.includes(note));
  const button = block?.querySelector<HTMLButtonElement>(
    'button[aria-label="Detach from message"]'
  );
  if (button == null) throw new Error(`No detach button for ${note}`);
  return button;
};

/** Attach one note in the review store, as the review panel does, and wait for the composer. */
async function attachStoreReview(app: AppHarness, id: string, data: ReviewNoteData) {
  act(() => {
    const current = readPersistedState<{ reviews?: Record<string, unknown> }>(
      getReviewsKey(app.workspaceId),
      {}
    );
    updatePersistedState(getReviewsKey(app.workspaceId), {
      workspaceId: app.workspaceId,
      reviews: {
        ...(current.reviews ?? {}),
        [id]: { id, data, status: "attached", createdAt: Date.now() },
      },
      lastUpdated: Date.now(),
    });
  });
  await waitFor(() => expect(composerText(app)).toContain(data.userNote), LOAD_TOLERANT_WAIT);
}

async function setComposerAttachments(app: AppHarness, filenames: string[]) {
  act(() => {
    updatePersistedState(
      getInputAttachmentsKey(app.workspaceId),
      filenames.map((filename) => providerAttachment(filename))
    );
  });
  await waitFor(() => {
    for (const filename of filenames) expect(composerText(app)).toContain(filename);
  }, LOAD_TOLERANT_WAIT);
}

/**
 * Hold the workspace busy, then send a rich message (text + file + review) from the composer so
 * it queues. Returns the held send; the caller releases it after the Stop.
 */
async function queueRichComposerMessage(app: AppHarness) {
  const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
  // Held outside the composer: a composer send stays in flight until its stream starts.
  const holding = app.env.orpc.workspace.sendMessage({
    workspaceId: app.workspaceId,
    message: "[mock:wait-start] hold the workspace busy",
    options: { model: "openai:gpt-5.2", agentId: "exec" },
  });
  await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
  await attachStoreReview(app, "review-queued", review("queued note"));
  await setComposerAttachments(app, ["queued.txt"]);
  await app.chat.send("queued follow-up");
  await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
  await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
  // The queued send checked its note off; the composer holds nothing of it any more.
  await waitFor(() => expect(attachedStoreReviewNotes(app)).toEqual([]), LOAD_TOLERANT_WAIT);
  expect(composerAttachmentNames(app)).toEqual([]);
  return { session, holding };
}

/** The user presses Stop: the queue is cleared and its message is restored to the composer. */
async function stop(app: AppHarness, holding: Promise<unknown>) {
  expect(
    (await app.env.orpc.workspace.interruptStream({ workspaceId: app.workspaceId })).success
  ).toBe(true);
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
  await holding;
}

/** Persisted user rows whose text contains `needle`, with their file-part names. */
async function userRowsContaining(app: AppHarness, needle: string) {
  const history = await app.env.services
    .toORPCContext()
    .historyService.getHistoryFromLatestBoundary(app.workspaceId);
  if (!history.success) return [];
  return history.data
    .filter((message) => message.role === "user")
    .map((message) => ({
      text: message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
      files: message.parts.flatMap((part) => (part.type === "file" ? [part.filename] : [])),
    }))
    .filter((row) => row.text.includes(needle));
}

describe("Stop restores a queued message without losing a newer draft (#4431)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a newer rich draft is kept after the restored message; restored notes stay in sync with the review store and sending sends exactly the surviving notes once", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-restore-merge" });
    try {
      const { session, holding } = await queueRichComposerMessage(app);

      // While the message waits, the user starts a newer draft with its own file and note.
      await attachStoreReview(app, "review-draft", review("draft note"));
      await setComposerAttachments(app, ["draft.txt"]);
      await app.chat.typeWithoutSending("newer draft");

      await stop(app, holding);
      expect(session.hasQueuedMessages()).toBe(false);

      await app.chat.expectInputValue(
        "queued follow-up\n\nnewer draft",
        LOAD_TOLERANT_WAIT.timeout
      );
      expect(composerAttachmentNames(app)).toEqual(["queued.txt", "draft.txt"]);
      // The restored note joins the draft's note in the review store (not a detached copy).
      await waitFor(
        () => expect(attachedStoreReviewNotes(app)).toEqual(["draft note", "queued note"]),
        LOAD_TOLERANT_WAIT
      );
      await waitFor(() => {
        expect(composerText(app)).toContain("queued note");
        expect(composerText(app)).toContain("draft note");
      }, LOAD_TOLERANT_WAIT);

      // Later review actions keep working on every note: a new note attached afterwards shows,
      // an edit made in the review store shows, and detaching one from the composer removes it.
      await attachStoreReview(app, "review-late", review("late note"));
      act(() => {
        const state = readPersistedState<{
          reviews: Record<string, { status: string; data: ReviewNoteData }>;
        }>(getReviewsKey(app.workspaceId), { reviews: {} });
        const [queuedId] = Object.entries(state.reviews).find(
          // The queued send checked its original copy off; edit the restored, attached one.
          ([, entry]) => entry.status === "attached" && entry.data.userNote === "queued note"
        )!;
        updatePersistedState(getReviewsKey(app.workspaceId), {
          ...state,
          reviews: {
            ...state.reviews,
            [queuedId]: {
              ...state.reviews[queuedId],
              data: { ...state.reviews[queuedId].data, userNote: "queued note, edited" },
            },
          },
          lastUpdated: Date.now(),
        });
      });
      await waitFor(
        () => expect(composerText(app)).toContain("queued note, edited"),
        LOAD_TOLERANT_WAIT
      );
      fireEvent.click(detachButtonForNote(app, "draft note"));
      await waitFor(
        () => expect(composerText(app)).not.toContain("draft note"),
        LOAD_TOLERANT_WAIT
      );

      // Sending sends both texts, both files and each surviving note exactly once.
      await app.chat.send("queued follow-up\n\nnewer draft");
      const [sent] = await waitFor(async () => {
        const rows = await userRowsContaining(app, "newer draft");
        expect(rows).toHaveLength(1);
        return rows;
      }, LOAD_TOLERANT_WAIT);
      expect(sent.text).toContain("queued follow-up");
      expect(countOccurrences(sent.text, formatReviewForModel(review("queued note, edited")))).toBe(
        1
      );
      expect(countOccurrences(sent.text, formatReviewForModel(review("late note")))).toBe(1);
      expect(countOccurrences(sent.text, formatReviewForModel(review("draft note")))).toBe(0);
      expect(sent.files).toEqual(["queued.txt", "draft.txt"]);

      // Nothing the send consumed, and nothing the user removed, comes back into the composer.
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      expect(composerAttachmentNames(app)).toEqual([]);
      await waitFor(() => expect(attachedStoreReviewNotes(app)).toEqual([]), LOAD_TOLERANT_WAIT);
      await waitFor(() => {
        for (const note of ["queued note", "late note", "draft note"]) {
          expect(composerText(app)).not.toContain(note);
        }
      }, LOAD_TOLERANT_WAIT);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("a restore during a send in flight leaves that send's notes to it and keeps the restored notes for the next send", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-restore-inflight" });
    try {
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      await attachStoreReview(app, "review-inflight", review("in-flight note"));
      // The composer send stays in flight (its note still attached in the store, hidden) until
      // its stream starts.
      await app.chat.send("[mock:wait-start] in flight");
      await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      expect(attachedStoreReviewNotes(app)).toEqual(["in-flight note"]);

      app.env.services.workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "restored",
        reviews: [review("restored note")],
      });
      await app.chat.expectInputValue("restored", LOAD_TOLERANT_WAIT.timeout);

      // The in-flight send settles and checks off only the note it carried.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      await waitFor(async () => {
        const rows = await userRowsContaining(app, "in flight");
        expect(rows).toHaveLength(1);
        expect(countOccurrences(rows[0].text, formatReviewForModel(review("in-flight note")))).toBe(
          1
        );
        expect(countOccurrences(rows[0].text, formatReviewForModel(review("restored note")))).toBe(
          0
        );
      }, LOAD_TOLERANT_WAIT);
      await app.chat.expectStreamComplete();
      await waitFor(
        () => expect(attachedStoreReviewNotes(app)).toEqual(["restored note"]),
        LOAD_TOLERANT_WAIT
      );
      await waitFor(() => {
        expect(composerText(app)).toContain("restored note");
        expect(composerText(app)).not.toContain("in-flight note");
      }, LOAD_TOLERANT_WAIT);

      // The restored draft then sends its own note once, and not the earlier one.
      await app.chat.send("restored");
      const [sent] = await waitFor(async () => {
        const rows = await userRowsContaining(app, "restored");
        expect(rows).toHaveLength(1);
        return rows;
      }, LOAD_TOLERANT_WAIT);
      expect(countOccurrences(sent.text, formatReviewForModel(review("restored note")))).toBe(1);
      expect(countOccurrences(sent.text, formatReviewForModel(review("in-flight note")))).toBe(0);
      await waitFor(() => expect(attachedStoreReviewNotes(app)).toEqual([]), LOAD_TOLERANT_WAIT);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("an empty composer gets exactly the queued message back", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-restore-empty" });
    try {
      const { holding } = await queueRichComposerMessage(app);

      await stop(app, holding);

      await app.chat.expectInputValue("queued follow-up", LOAD_TOLERANT_WAIT.timeout);
      expect(composerAttachmentNames(app)).toEqual(["queued.txt"]);
      await waitFor(() => expect(composerText(app)).toContain("queued note"), LOAD_TOLERANT_WAIT);
    } finally {
      await app.dispose();
    }
  }, 90_000);

  test("an attachment-only draft keeps its attachment and gets the queued text without a separator", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-restore-attachment" });
    try {
      const { holding } = await queueRichComposerMessage(app);
      await setComposerAttachments(app, ["draft.txt"]);

      await stop(app, holding);

      await app.chat.expectInputValue("queued follow-up", LOAD_TOLERANT_WAIT.timeout);
      expect(composerAttachmentNames(app)).toEqual(["queued.txt", "draft.txt"]);
      await waitFor(() => expect(composerText(app)).toContain("queued note"), LOAD_TOLERANT_WAIT);
    } finally {
      await app.dispose();
    }
  }, 90_000);
});
