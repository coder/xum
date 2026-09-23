import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, fireEvent, waitFor } from "@testing-library/react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceStoreRaw,
  workspaceStore,
  type InputRestore,
} from "@/browser/stores/WorkspaceStore";
import { getInputAttachmentsKey, getInputKey, getReviewsKey } from "@/common/constants/storage";
import { prepareUserMessageForSend } from "@/common/types/message";
import { formatReviewForModel, type ReviewNoteData } from "@/common/types/review";
import { detectDefaultTrunkBranch } from "@/node/git";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { HistoryService } from "@/node/services/historyService";
import type { TurnAdmissionToken } from "@/node/services/taskWorkspaceSeam";
import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const draftAttachment = {
  kind: "staged" as const,
  id: "s1",
  filename: "notes.md",
  mediaType: "text/markdown",
  sizeBytes: 8,
  stagedPath: ".mux/user-attachments/uuid/notes.md",
};
const queuedFilePart = {
  url: "data:text/plain;base64,cXVldWVk",
  mediaType: "text/plain",
  filename: "queued-file.txt",
};

/** What TaskService's dequeue gate decides for a queued send whose task already reported. */
const refusingAdmission: TurnAdmissionToken = {
  admissionStale: () => false,
  onEnqueued: () => undefined,
  onAdmitted: () => undefined,
  onDisposed: () => undefined,
  resolveDispatch: () => ({ refuse: "the task already reported" }),
};
const RESTORED_AUTHORED_TEXT = "first authored\n\nsecond authored";
const composerReview = (note: string): ReviewNoteData => ({
  filePath: "src/file.ts",
  lineRange: "1",
  selectedCode: "call()",
  userNote: note,
});
const composerAttachmentNames = (app: AppHarness) =>
  readPersistedState<Array<{ filename?: string }>>(getInputAttachmentsKey(app.workspaceId), []).map(
    (attachment) => attachment.filename
  );
const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1;
/**
 * Bound for waits on work behind a composer send or a restore (the send's async preflight, the
 * in-process IPC hop, the backend queue, the re-render). waitFor's 1 s default passed isolated
 * but not when these app suites share the host with others (a combined jest run timed out
 * waiting for the second send to reach the queue).
 */
const LOAD_TOLERANT_WAIT = { timeout: 30_000 };

/**
 * The real composer path: while a held turn keeps the workspace busy, the user sends two rich
 * messages (text + file + review) from the composer, so both queue. Their dispatch is refused (the
 * sub-agent reported first), which hands both back to the composer once the held turn ends.
 */
async function queueTwoRefusedComposerMessages(app: AppHarness): Promise<ReviewNoteData[]> {
  const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
  // Held outside the composer: a composer send stays in flight until its stream starts, which
  // would keep the composer's review panel hidden.
  const holding = app.env.orpc.workspace.sendMessage({
    workspaceId: app.workspaceId,
    message: "[mock:wait-start] hold the workspace busy",
    options: { model: "openai:gpt-5.2", agentId: "exec" },
  });
  await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
  // Stand-in for TaskService's admission token on a sub-agent workspace's manual sends.
  const queueMessage = session.queueMessage.bind(session);
  const queueSpy = jest
    .spyOn(session, "queueMessage")
    .mockImplementation((message, options, internal) =>
      queueMessage(message, options, { ...internal, turnAdmission: refusingAdmission })
    );
  const reviews = [composerReview("first note"), composerReview("second note")];
  try {
    for (const [index, name] of ["first", "second"].entries()) {
      act(() => {
        updatePersistedState(getReviewsKey(app.workspaceId), {
          workspaceId: app.workspaceId,
          reviews: {
            [`review-${name}`]: {
              id: `review-${name}`,
              data: reviews[index],
              status: "attached",
              createdAt: Date.now(),
            },
          },
          lastUpdated: Date.now(),
        });
        updatePersistedState(getInputAttachmentsKey(app.workspaceId), [
          {
            kind: "provider",
            id: `file-${name}`,
            url: queuedFilePart.url,
            mediaType: queuedFilePart.mediaType,
            filename: `${name}.txt`,
          },
        ]);
      });
      await waitFor(() => {
        expect(app.view.container.textContent).toContain(`${name} note`);
        expect(app.view.container.textContent).toContain(`${name}.txt`);
      }, LOAD_TOLERANT_WAIT);
      await app.chat.send(`${name} authored`);
      await waitFor(() => expect(queueSpy).toHaveBeenCalledTimes(index + 1), LOAD_TOLERANT_WAIT);
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
    }
  } finally {
    queueSpy.mockRestore();
  }
  expect(session.hasQueuedMessages()).toBe(true);
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
  expect((await holding).success).toBe(true);
  return reviews;
}

/** The newest persisted user row (the provider-facing text) once it contains `needle`. */
async function waitForLastUserRow(
  app: AppHarness,
  needle: string
): Promise<{ text: string; reviews: unknown }> {
  return waitFor(
    async () => {
      const history = await new HistoryService(app.env.config).getHistoryFromLatestBoundary(
        app.workspaceId
      );
      if (!history.success) throw new Error("history not readable yet");
      const row = history.data.filter((message) => message.role === "user").at(-1);
      const text = (row?.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      if (!text.includes(needle)) throw new Error("the retried message is not persisted yet");
      const muxMetadata = row?.metadata?.muxMetadata;
      return {
        text,
        reviews: muxMetadata != null && "reviews" in muxMetadata ? muxMetadata.reviews : undefined,
      };
    },
    { timeout: 30_000 }
  );
}

/**
 * Show a workspace the way the sidebar does (the store then moves its single onChat
 * subscription there) and wait until its composer is the mounted one.
 */
async function showWorkspace(harness: AppHarness, workspaceId: string, name: string) {
  const row = await waitFor(
    () => {
      const el = harness.view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el || el.getAttribute("aria-disabled") === "true") {
        throw new Error("Workspace row not selectable yet");
      }
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(row);
  workspaceStore.setActiveWorkspaceId(workspaceId);
  await waitFor(() => {
    expect(document.title.startsWith(name)).toBe(true);
    expect(harness.view.container.querySelector('[data-testid="message-window"]')).not.toBe(null);
  });
}

/**
 * A queued message refused at dispatch (its sub-agent completed its report first) is handed back
 * through `restore-to-input` with `mode: "append"`: the composer keeps what the user typed since
 * and the unsent text is appended after it, so it is visible and recoverable without overwriting
 * the draft. The default (replace) restore — a user Stop — is unchanged.
 */
describe("Unsent queued message restored to the composer", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("append mode preserves the current draft and adds the unsent text after it", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-append" });
    try {
      await app.chat.typeWithoutSending("draft typed after queueing");
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued follow-up that was not sent",
        mode: "append",
      });
      await app.chat.expectInputValue(
        "draft typed after queueing\n\nqueued follow-up that was not sent"
      );
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("append mode keeps the draft's own attachment and adds the refused message's file part after it", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-attach" });
    try {
      await app.chat.typeWithoutSending("draft with a file");
      act(() => {
        updatePersistedState(getInputAttachmentsKey(app.workspaceId), [draftAttachment]);
      });
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("notes.md");
      }, LOAD_TOLERANT_WAIT);
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued text with a file",
        fileParts: [queuedFilePart],
        mode: "append",
      });
      await app.chat.expectInputValue(
        "draft with a file\n\nqueued text with a file",
        LOAD_TOLERANT_WAIT.timeout
      );
      // Both attachments are in the composer, draft first: the user's draft data is not replaced.
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("queued-file.txt");
      }, LOAD_TOLERANT_WAIT);
      expect(app.view.container.textContent).toContain("notes.md");
      const persisted = readPersistedState<Array<{ kind: string; filename?: string }>>(
        getInputAttachmentsKey(app.workspaceId),
        []
      );
      expect(persisted.map((attachment) => [attachment.kind, attachment.filename])).toEqual([
        ["staged", "notes.md"],
        ["provider", "queued-file.txt"],
      ]);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("a text-only refusal appended to a draft with an attachment keeps that attachment", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-textonly" });
    try {
      await app.chat.typeWithoutSending("draft with a file");
      act(() => {
        updatePersistedState(getInputAttachmentsKey(app.workspaceId), [draftAttachment]);
      });
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("notes.md");
      }, LOAD_TOLERANT_WAIT);
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued text only",
        mode: "append",
      });
      await app.chat.expectInputValue(
        "draft with a file\n\nqueued text only",
        LOAD_TOLERANT_WAIT.timeout
      );
      expect(app.view.container.textContent).toContain("notes.md");
      expect(
        readPersistedState<Array<{ id: string }>>(getInputAttachmentsKey(app.workspaceId), []).map(
          (attachment) => attachment.id
        )
      ).toEqual(["s1"]);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("append mode adds the refused message's review notes to the ones already attached instead of replacing them", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-reviews" });
    const review = (note: string) => ({
      filePath: "src/file.ts",
      lineRange: "1",
      selectedCode: "call()",
      userNote: note,
    });
    try {
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "first refused",
        reviews: [review("first note")],
        mode: "append",
      });
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("first note");
      }, LOAD_TOLERANT_WAIT);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "second refused",
        reviews: [review("second note")],
        mode: "append",
      });
      await app.chat.expectInputValue(
        "first refused\n\nsecond refused",
        LOAD_TOLERANT_WAIT.timeout
      );
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("second note");
      }, LOAD_TOLERANT_WAIT);
      expect(app.view.container.textContent).toContain("first note");
      expect(app.view.container.textContent).toContain("2 reviews attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("two refusals restored in the same drain both land: their text, attachments and reviews compose", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-same-drain" });
    const review = (note: string) => ({
      filePath: "src/file.ts",
      lineRange: "1",
      selectedCode: "call()",
      userNote: note,
    });
    try {
      await app.chat.typeWithoutSending("draft");
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      // One drain refuses two token-sealed entries back to back: both restores reach the composer
      // before React re-renders, so neither may read the other's render-time snapshot.
      for (const name of ["first", "second"]) {
        workspaceService.emitChatEvent(app.workspaceId, {
          type: "restore-to-input",
          workspaceId: app.workspaceId,
          text: `${name} refused`,
          fileParts: [{ ...queuedFilePart, filename: `${name}.txt` }],
          reviews: [review(`${name} note`)],
          mode: "append",
        });
      }
      await app.chat.expectInputValue(
        "draft\n\nfirst refused\n\nsecond refused",
        LOAD_TOLERANT_WAIT.timeout
      );
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("2 reviews attached");
      }, LOAD_TOLERANT_WAIT);
      expect(app.view.container.textContent).toContain("first note");
      expect(app.view.container.textContent).toContain("second note");
      const persisted = readPersistedState<Array<{ id: string; filename?: string }>>(
        getInputAttachmentsKey(app.workspaceId),
        []
      );
      expect(persisted.map((attachment) => attachment.filename)).toEqual([
        "first.txt",
        "second.txt",
      ]);
      // Each restoration's attachments keep their own ids (removing one must not remove both).
      expect(new Set(persisted.map((attachment) => attachment.id)).size).toBe(2);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("a refusal that lands while another workspace is shown is restored exactly once when its composer is shown again", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-away" });
    let otherWorkspaceId: string | undefined;
    const draftOf = (workspaceId: string) => readPersistedState(getInputKey(workspaceId), "");
    const attachmentNames = (workspaceId: string) =>
      readPersistedState<Array<{ filename?: string }>>(getInputAttachmentsKey(workspaceId), []).map(
        (attachment) => attachment.filename
      );
    try {
      await app.chat.typeWithoutSending("draft kept");
      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("unsent-away-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      otherWorkspaceId = created.metadata.id;
      const otherName = created.metadata.name;
      workspaceStore.addWorkspace(created.metadata);
      await showWorkspace(app, otherWorkspaceId, otherName);

      // While the other workspace is shown, the first workspace's dequeue gate refuses its two
      // queued manual messages in one drain (their task attempt completed): the real refusal path
      // hands both back.
      const { finalText, metadata } = prepareUserMessageForSend({
        text: "queued follow-up",
        reviews: [
          { filePath: "src/file.ts", lineRange: "1", selectedCode: "call()", userNote: "a note" },
        ],
      });
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      const handedBack: Array<Extract<WorkspaceChatMessage, { type: "restore-to-input" }>> = [];
      const stopCapturing = session.onChatEvent(({ message }) => {
        if ("type" in message && message.type === "restore-to-input") handedBack.push(message);
      });
      const queueOptions = { model: "openai:gpt-5.2", agentId: "exec" };
      session.queueMessage(
        finalText,
        {
          ...queueOptions,
          fileParts: [queuedFilePart],
          ...(metadata ? { muxMetadata: metadata } : {}),
          // As the composer sends it (prepareMessagePayload): the text before review formatting.
          authoredText: "queued follow-up",
        },
        { acceptanceOrigin: "manual", turnAdmission: refusingAdmission }
      );
      session.queueMessage(
        "second follow-up",
        { ...queueOptions, fileParts: [{ ...queuedFilePart, filename: "second.txt" }] },
        { acceptanceOrigin: "manual", turnAdmission: refusingAdmission }
      );
      session.drainQueuedMessagesIfIdle();
      stopCapturing();
      expect(session.hasQueuedMessages()).toBe(false);
      expect(handedBack).toHaveLength(2);
      // The authored text comes back; the review formatted into the sent text comes back as a review.
      const restoredDraft = "draft kept\n\nqueued follow-up\n\nsecond follow-up";
      // Nothing can reach the first workspace's composer while it is not shown.
      expect(draftOf(app.workspaceId)).toBe("draft kept");

      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await waitFor(() => {
        expect(draftOf(app.workspaceId)).toBe(restoredDraft);
      });
      expect(attachmentNames(app.workspaceId)).toEqual(["queued-file.txt", "second.txt"]);
      // Both restorations are applied together on mount; their attachments keep distinct ids.
      expect(
        new Set(
          readPersistedState<Array<{ id: string }>>(
            getInputAttachmentsKey(app.workspaceId),
            []
          ).map((attachment) => attachment.id)
        ).size
      ).toBe(2);
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("a note");
      });
      // The renderer acknowledged both: the backend no longer re-sends them on a replay.
      await waitFor(async () => {
        const replayed: unknown[] = [];
        await session.replayHistory(({ message }) => {
          if ("type" in message && message.type === "restore-to-input") replayed.push(message);
        });
        expect(replayed).toEqual([]);
      });

      // A re-delivery of an applied restoration (a replay racing its acknowledgement) is dropped;
      // the unretained marker restore after it proves the event was processed in order.
      app.env.services.workspaceService.emitChatEvent(app.workspaceId, handedBack[0]);
      app.env.services.workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "marker",
        mode: "append",
      });
      await waitFor(() => {
        expect(draftOf(app.workspaceId)).toBe(`${restoredDraft}\n\nmarker`);
      });

      // Leaving and coming back replays the workspace again: nothing is re-applied.
      await showWorkspace(app, otherWorkspaceId, otherName);
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await app.chat.expectInputValue(`${restoredDraft}\n\nmarker`);
      expect(attachmentNames(app.workspaceId)).toEqual(["queued-file.txt", "second.txt"]);
    } finally {
      if (otherWorkspaceId != null) {
        await app.env.orpc.workspace
          .remove({ workspaceId: otherWorkspaceId, options: { force: true } })
          .catch(() => undefined);
      }
      await app.dispose();
    }
  }, 90_000);

  test("a refused composer message restores its authored text and reviews once, and the retry sends each review once", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-authored" });
    try {
      const reviews = await queueTwoRefusedComposerMessages(app);
      // The authored text comes back, never the provider-facing text with the review blocks
      // formatted into it: the reviews come back as review chips instead.
      await app.chat.expectInputValue(RESTORED_AUTHORED_TEXT, LOAD_TOLERANT_WAIT.timeout);
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("2 reviews attached");
      }, LOAD_TOLERANT_WAIT);
      expect(composerAttachmentNames(app)).toEqual(["first.txt", "second.txt"]);

      // Retry: the composer sends the restored draft as one new message.
      await app.chat.send(RESTORED_AUTHORED_TEXT);
      const sent = await waitForLastUserRow(app, "second authored");
      expect(countOccurrences(sent.text, "first authored")).toBe(1);
      expect(countOccurrences(sent.text, "second authored")).toBe(1);
      for (const review of reviews) {
        expect(countOccurrences(sent.text, formatReviewForModel(review))).toBe(1);
      }
      expect(sent.reviews).toEqual(reviews);
      await app.chat.expectStreamComplete();
      // The sent draft does not come back.
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      expect(app.view.container.textContent).not.toContain("reviews attached");
    } finally {
      await app.dispose();
    }
  }, 90_000);

  test("restored reviews survive switching away and back; the retry sends only the kept, edited review, once", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-remount" });
    let otherWorkspaceId: string | undefined;
    const composerText = () => app.view.container.textContent ?? "";
    // The composer's own review block holding `note` (transcript review blocks have no actions).
    const composerReviewBlock = (note: string) => {
      const block = Array.from(app.view.container.querySelectorAll('[aria-label="Delete review"]'))
        .map((button) => button.closest('[class*="group/review"]'))
        .find((candidate) => candidate?.textContent?.includes(note));
      if (!(block instanceof HTMLElement)) throw new Error(`no composer review for ${note}`);
      return block;
    };
    try {
      const [, secondReview] = await queueTwoRefusedComposerMessages(app);
      await app.chat.expectInputValue(RESTORED_AUTHORED_TEXT, LOAD_TOLERANT_WAIT.timeout);
      await waitFor(
        () => expect(composerText()).toContain("2 reviews attached"),
        LOAD_TOLERANT_WAIT
      );
      // Applied and acknowledged: the backend no longer holds a copy to re-send.
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      await waitFor(async () => {
        const replayed: unknown[] = [];
        await session.replayHistory(({ message }) => {
          if ("type" in message && message.type === "restore-to-input") replayed.push(message);
        });
        expect(replayed).toEqual([]);
      }, LOAD_TOLERANT_WAIT);

      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("unsent-remount-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      otherWorkspaceId = created.metadata.id;
      workspaceStore.addWorkspace(created.metadata);
      const switchAwayAndBack = async () => {
        await showWorkspace(app, created.metadata.id, created.metadata.name);
        await showWorkspace(app, app.workspaceId, app.metadata.name);
      };

      // The composer remounts: the whole restoration is still there.
      await switchAwayAndBack();
      await app.chat.expectInputValue(RESTORED_AUTHORED_TEXT, LOAD_TOLERANT_WAIT.timeout);
      await waitFor(
        () => expect(composerText()).toContain("2 reviews attached"),
        LOAD_TOLERANT_WAIT
      );
      expect(composerAttachmentNames(app)).toEqual(["first.txt", "second.txt"]);

      // The user discards one review and edits the other; both choices survive a remount.
      fireEvent.click(
        composerReviewBlock("first note").querySelector('[aria-label="Delete review"]')!
      );
      await waitFor(
        () => expect(composerText()).toContain("1 review attached"),
        LOAD_TOLERANT_WAIT
      );
      fireEvent.click(
        composerReviewBlock("second note").querySelector('[aria-label="Edit comment"]')!
      );
      const noteEditor = await waitFor(() => {
        const textarea = composerReviewBlock("second note").querySelector("textarea");
        if (!textarea) throw new Error("note editor not open yet");
        return textarea;
      }, LOAD_TOLERANT_WAIT);
      fireEvent.change(noteEditor, { target: { value: "second note, edited" } });
      fireEvent.keyDown(noteEditor, { key: "Enter", ctrlKey: true });
      await waitFor(
        () => expect(composerReviewBlock("second note, edited")).toBeTruthy(),
        LOAD_TOLERANT_WAIT
      );
      await switchAwayAndBack();
      await waitFor(
        () => expect(composerText()).toContain("1 review attached"),
        LOAD_TOLERANT_WAIT
      );
      expect(composerReviewBlock("second note, edited")).toBeTruthy();
      expect(composerText()).not.toContain("first note");

      await app.chat.send(RESTORED_AUTHORED_TEXT);
      const sent = await waitForLastUserRow(app, "second authored");
      const editedReview = { ...secondReview, userNote: "second note, edited" };
      expect(countOccurrences(sent.text, formatReviewForModel(editedReview))).toBe(1);
      expect(sent.text).not.toContain("first note");
      expect(countOccurrences(sent.text, "first authored")).toBe(1);
      expect(countOccurrences(sent.text, "second authored")).toBe(1);
      expect(sent.reviews).toEqual([editedReview]);
      await app.chat.expectStreamComplete();

      // Neither the sent draft nor the discarded review comes back after another remount.
      await switchAwayAndBack();
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      expect(composerText()).not.toContain("review attached");
      expect(composerText()).not.toContain("reviews attached");
      expect(composerAttachmentNames(app)).toEqual([]);
    } finally {
      if (otherWorkspaceId != null) {
        await app.env.orpc.workspace
          .remove({ workspaceId: otherWorkspaceId, options: { force: true } })
          .catch(() => undefined);
      }
      await app.dispose();
    }
  }, 120_000);

  test("a restoration applied in the same update that switches workspaces keeps its text, attachment and review", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-same-batch" });
    let otherWorkspaceId: string | undefined;
    try {
      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("unsent-same-batch-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      otherWorkspaceId = created.metadata.id;
      workspaceStore.addWorkspace(created.metadata);
      const otherRow = await waitFor(() => {
        const el = app.view.container.querySelector(`[data-workspace-id="${otherWorkspaceId}"]`);
        if (!el || el.getAttribute("aria-disabled") === "true") throw new Error("not selectable");
        return el as HTMLElement;
      }, LOAD_TOLERANT_WAIT);
      // The composer applies the restoration (and the store acknowledges it) in the same React
      // batch that unmounts it: every part must already be stored when the ack goes out.
      act(() => {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- plain singleton accessor, no React state.
        (
          useWorkspaceStoreRaw() as unknown as {
            receiveInputRestore: (restore: InputRestore) => void;
          }
        ).receiveInputRestore({
          type: "restore-to-input",
          workspaceId: app.workspaceId,
          text: "same-batch text",
          fileParts: [{ ...queuedFilePart, filename: "same-batch.txt" }],
          reviews: [composerReview("same-batch note")],
          mode: "append",
          restoreId: "same-batch-restore",
        });
        fireEvent.click(otherRow);
        workspaceStore.setActiveWorkspaceId(created.metadata.id);
      });
      await waitFor(
        () => expect(document.title.startsWith(created.metadata.name)).toBe(true),
        LOAD_TOLERANT_WAIT
      );
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await app.chat.expectInputValue("same-batch text", LOAD_TOLERANT_WAIT.timeout);
      expect(composerAttachmentNames(app)).toEqual(["same-batch.txt"]);
      await waitFor(
        () => expect(app.view.container.textContent).toContain("same-batch note"),
        LOAD_TOLERANT_WAIT
      );
    } finally {
      if (otherWorkspaceId != null) {
        await app.env.orpc.workspace
          .remove({ workspaceId: otherWorkspaceId, options: { force: true } })
          .catch(() => undefined);
      }
      await app.dispose();
    }
  }, 90_000);

  test("the default restore (a Stop's queued input) still replaces the draft", async () => {
    const app = await createAppHarness({ branchPrefix: "unsent-replace" });
    try {
      await app.chat.typeWithoutSending("draft to be replaced");
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued input restored by stop",
      });
      await app.chat.expectInputValue("queued input restored by stop");
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
