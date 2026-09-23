import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, fireEvent, waitFor } from "@testing-library/react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import { getInputAttachmentsKey, getInputKey, getReviewsKey } from "@/common/constants/storage";
import { prepareUserMessageForSend } from "@/common/types/message";
import { formatReviewForModel, type ReviewNoteData } from "@/common/types/review";
import { Err } from "@/common/types/result";
import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import type { TurnAdmissionToken } from "@/node/services/taskWorkspaceSeam";
import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const NOT_SENT_LABEL = "Not sent — the task reported before this ran";
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
/** Notes still attached in the workspace's review store (a send checks its notes off). */
const attachedStoreReviewNotes = (app: AppHarness) =>
  Object.values(
    readPersistedState<{ reviews?: Record<string, { status: string; data: ReviewNoteData }> }>(
      getReviewsKey(app.workspaceId),
      {}
    ).reviews ?? {}
  )
    .filter((review) => review.status === "attached")
    .map((review) => review.data.userNote);
/**
 * Bound for waits on work behind a composer send (the send's async preflight, the in-process IPC
 * hop, the backend queue, the re-render). waitFor's 1 s default passed isolated but not when
 * these app suites share the host with others.
 */
const LOAD_TOLERANT_WAIT = { timeout: 30_000 };

const heldBanners = (app: AppHarness) =>
  [...app.view.container.querySelectorAll('[data-component="HeldInputBanner"]')] as HTMLElement[];
const heldButtons = (app: AppHarness, label: "Send" | "Discard") =>
  [
    ...app.view.container.querySelectorAll(`button[aria-label="${label} unsent message"]`),
  ] as HTMLButtonElement[];

/**
 * The real composer path: while a held turn keeps the workspace busy, the user sends two rich
 * messages (text + file + review) from the composer, so both queue. Their dispatch is refused (the
 * sub-agent reported first) once the busy turn ends, so the backend keeps both as held input.
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

/** Persisted user rows whose provider-facing text contains `needle`. */
async function userRowsContaining(app: AppHarness, needle: string): Promise<string[]> {
  const history = await new HistoryService(app.env.config).getHistoryFromLatestBoundary(
    app.workspaceId
  );
  if (!history.success) return [];
  return history.data
    .filter((message) => message.role === "user")
    .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
    .filter((text) => text.includes(needle));
}

/**
 * A manual queued message refused at dispatch (its sub-agent completed its report first) stays
 * with the backend session as held input: shown as a "Not sent" banner next to the queued
 * message, never pushed into the composer, re-sent or discarded only by an explicit action.
 */
describe("Held (refused) queued messages", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a refusal that lands while another workspace is shown is held: it shows after switching back and after a reload's replay, the draft is untouched, a failed Send keeps it, Discard removes it", async () => {
    const app = await createAppHarness({ branchPrefix: "held-away" });
    let otherWorkspaceId: string | undefined;
    const draftOf = (workspaceId: string) => readPersistedState(getInputKey(workspaceId), "");
    try {
      await app.chat.typeWithoutSending("draft kept");
      act(() => {
        updatePersistedState(getInputAttachmentsKey(app.workspaceId), [draftAttachment]);
      });
      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("held-away-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      otherWorkspaceId = created.metadata.id;
      const otherName = created.metadata.name;
      workspaceStore.addWorkspace(created.metadata);
      await showWorkspace(app, otherWorkspaceId, otherName);

      // While the other workspace is shown, the first workspace's dequeue gate refuses its two
      // queued manual messages in one drain (their task attempt completed).
      const { finalText, metadata } = prepareUserMessageForSend({
        text: "queued follow-up",
        reviews: [composerReview("a note")],
      });
      const workspaceService = app.env.services.workspaceService;
      const session = workspaceService.getOrCreateSession(app.workspaceId);
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
      expect(session.hasQueuedMessages()).toBe(false);
      expect(session.getHeldInputs().map((held) => held.send.displayText)).toEqual([
        "queued follow-up",
        "second follow-up",
      ]);

      // Switching back shows both, in order, with their counts; the composer is not involved.
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(2), LOAD_TOLERANT_WAIT);
      const bannerTexts = () => heldBanners(app).map((banner) => banner.textContent ?? "");
      expect(bannerTexts()[0]).toContain(NOT_SENT_LABEL);
      expect(bannerTexts()[0]).toContain("queued follow-up");
      expect(bannerTexts()[0]).toContain("1 attachment · 1 review");
      expect(bannerTexts()[1]).toContain("second follow-up");
      expect(bannerTexts()[1]).toContain("1 attachment");
      expect(bannerTexts()[1]).not.toContain("review");
      expect(draftOf(app.workspaceId)).toBe("draft kept");
      expect(composerAttachmentNames(app)).toEqual(["notes.md"]);

      // A reload loses every renderer copy; the backend's replay alone brings the list back.
      (
        useWorkspaceStoreRaw() as unknown as {
          chatTransientState: Map<string, { heldInputs: unknown[] }>;
        }
      ).chatTransientState.get(app.workspaceId)!.heldInputs = [];
      await showWorkspace(app, otherWorkspaceId, otherName);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(0), LOAD_TOLERANT_WAIT);
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(2), LOAD_TOLERANT_WAIT);
      expect(bannerTexts()[0]).toContain("queued follow-up");

      // A Send the backend does not accept keeps the held input and shows why.
      const sendSpy = jest
        .spyOn(workspaceService, "sendMessage")
        .mockResolvedValueOnce(Err({ type: "unknown", raw: "provider unavailable" }));
      fireEvent.click(heldButtons(app, "Send")[1]);
      await waitFor(() => {
        expect(heldBanners(app)[1].querySelector('[role="alert"]')?.textContent).toContain(
          "provider unavailable"
        );
      }, LOAD_TOLERANT_WAIT);
      sendSpy.mockRestore();
      expect(heldBanners(app)).toHaveLength(2);
      expect(session.getHeldInputs()).toHaveLength(2);

      // Discard removes exactly that one.
      fireEvent.click(heldButtons(app, "Discard")[1]);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(1), LOAD_TOLERANT_WAIT);
      expect(bannerTexts()[0]).toContain("queued follow-up");
      expect(session.getHeldInputs().map((held) => held.send.displayText)).toEqual([
        "queued follow-up",
      ]);
      expect(draftOf(app.workspaceId)).toBe("draft kept");
      expect(composerAttachmentNames(app)).toEqual(["notes.md"]);
    } finally {
      if (otherWorkspaceId != null) {
        await app.env.orpc.workspace
          .remove({ workspaceId: otherWorkspaceId, options: { force: true } })
          .catch(() => undefined);
      }
      await app.dispose();
    }
  }, 90_000);

  test("refused composer messages are held, not restored; Send re-sends one exactly once with each review once, and a double click sends it once", async () => {
    const app = await createAppHarness({ branchPrefix: "held-send" });
    try {
      const reviews = await queueTwoRefusedComposerMessages(app);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(2), LOAD_TOLERANT_WAIT);
      // The composer stays as the sends left it: empty, no attachments, no reviews attached.
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      expect(composerAttachmentNames(app)).toEqual([]);
      await waitFor(() => expect(attachedStoreReviewNotes(app)).toEqual([]), LOAD_TOLERANT_WAIT);
      expect(heldBanners(app)[0].textContent).toContain("first authored");
      expect(heldBanners(app)[0].textContent).toContain("1 attachment · 1 review");

      fireEvent.click(heldButtons(app, "Send")[0]);
      const [sent] = await waitFor(async () => {
        const rows = await userRowsContaining(app, "first authored");
        if (rows.length === 0) throw new Error("the held message is not persisted yet");
        return rows;
      }, LOAD_TOLERANT_WAIT);
      expect(countOccurrences(sent, "first authored")).toBe(1);
      expect(countOccurrences(sent, formatReviewForModel(reviews[0]))).toBe(1);
      expect(countOccurrences(sent, formatReviewForModel(reviews[1]))).toBe(0);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(1), LOAD_TOLERANT_WAIT);
      await app.chat.expectStreamComplete();

      // A double click on the remaining Send sends it once.
      const [sendSecond] = heldButtons(app, "Send");
      fireEvent.click(sendSecond);
      fireEvent.click(sendSecond);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(0), LOAD_TOLERANT_WAIT);
      await app.chat.expectStreamComplete();
      const secondRows = await userRowsContaining(app, "second authored");
      expect(secondRows).toHaveLength(1);
      expect(countOccurrences(secondRows[0], formatReviewForModel(reviews[1]))).toBe(1);
      expect(await userRowsContaining(app, "first authored")).toHaveLength(1);
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
    } finally {
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
