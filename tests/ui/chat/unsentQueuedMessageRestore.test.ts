import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { act, waitFor } from "@testing-library/react";

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputAttachmentsKey } from "@/common/constants/storage";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

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
      });
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued text with a file",
        fileParts: [queuedFilePart],
        mode: "append",
      });
      await app.chat.expectInputValue("draft with a file\n\nqueued text with a file");
      // Both attachments are in the composer, draft first: the user's draft data is not replaced.
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("queued-file.txt");
      });
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
      });
      const workspaceService = app.env.services.workspaceService;
      workspaceService.getOrCreateSession(app.workspaceId);
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "queued text only",
        mode: "append",
      });
      await app.chat.expectInputValue("draft with a file\n\nqueued text only");
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
      });
      workspaceService.emitChatEvent(app.workspaceId, {
        type: "restore-to-input",
        workspaceId: app.workspaceId,
        text: "second refused",
        reviews: [review("second note")],
        mode: "append",
      });
      await app.chat.expectInputValue("first refused\n\nsecond refused");
      await waitFor(() => {
        expect(app.view.container.textContent).toContain("second note");
      });
      expect(app.view.container.textContent).toContain("first note");
      expect(app.view.container.textContent).toContain("2 reviews attached");
    } finally {
      await app.dispose();
    }
  }, 60_000);

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
