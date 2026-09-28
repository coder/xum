/**
 * Composer drafts live on the backend, and hydration and change events carry attachment metadata
 * only: the payloads (base64 data URLs) load separately. A send pressed while they are still
 * loading must not go out, or it would send the draft without its attachments and then clear the
 * draft, deleting them.
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

describe("Sending a draft whose attachment payloads are still loading", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("does not send until the payloads arrive, then sends them", async () => {
    const app = await createAppHarness({ branchPrefix: "draft-payload-send" });
    try {
      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const draftService = app.env.services.draftService;
      const realGet = draftService.get.bind(draftService);
      let releasePayloads: () => void = () => undefined;
      const payloadGate = new Promise<void>((resolve) => {
        releasePayloads = resolve;
      });
      const getSpy = jest.spyOn(draftService, "get").mockImplementation(async (requested) => {
        await payloadGate;
        return realGet(requested);
      });

      // Another client (e.g. a browser tab on the same backend) attaches a file to this draft.
      await app.env.orpc.drafts.update({
        scope,
        attachments: [
          {
            kind: "provider",
            id: "file-late",
            url: "data:text/plain;base64,bGF0ZQ==",
            mediaType: "text/plain",
            filename: "late.txt",
          },
        ],
      });
      await waitFor(() => {
        expect(getDraftStore().getView(scope)).toMatchObject({
          attachmentCount: 1,
          payloadsLoaded: false,
        });
        expect(getSpy).toHaveBeenCalled();
      }, LOAD_TOLERANT_WAIT);

      await app.chat.send("send with the late file");
      // The refusal is synchronous; its notice shows that the send was pressed and handled.
      await waitFor(
        () => expect(app.view.container.textContent).toMatch(/still loading/),
        LOAD_TOLERANT_WAIT
      );
      expect(await userRowsContaining(app, "send with the late file")).toEqual([]);
      expect(getDraftStore().getView(scope).attachmentCount).toBe(1);

      releasePayloads();
      await waitFor(
        () => expect(getDraftStore().getView(scope).payloadsLoaded).toBe(true),
        LOAD_TOLERANT_WAIT
      );
      await app.chat.send("send with the late file");
      await waitFor(
        async () =>
          expect(await userRowsContaining(app, "send with the late file")).toEqual([
            { text: "send with the late file", files: ["late.txt"] },
          ]),
        LOAD_TOLERANT_WAIT
      );
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("editing an older message while they load keeps them in the draft restored on cancel", async () => {
    const app = await createAppHarness({ branchPrefix: "draft-payload-edit" });
    try {
      await app.chat.send("first message");
      await waitFor(
        () => expect(app.view.container.textContent).toContain("Mock response"),
        LOAD_TOLERANT_WAIT
      );
      await app.chat.expectStreamComplete();

      const scope: DraftScope = { kind: "workspace", workspaceId: app.workspaceId };
      const draftService = app.env.services.draftService;
      const realGet = draftService.get.bind(draftService);
      let releasePayloads: () => void = () => undefined;
      const payloadGate = new Promise<void>((resolve) => {
        releasePayloads = resolve;
      });
      const getSpy = jest.spyOn(draftService, "get").mockImplementation(async (requested) => {
        await payloadGate;
        return realGet(requested);
      });
      await app.env.orpc.drafts.update({
        scope,
        attachments: [
          {
            kind: "provider",
            id: "file-late",
            url: "data:text/plain;base64,bGF0ZQ==",
            mediaType: "text/plain",
            filename: "late.txt",
          },
        ],
      });
      await waitFor(() => {
        expect(getDraftStore().getView(scope)).toMatchObject({ payloadsLoaded: false });
        expect(getSpy).toHaveBeenCalled();
      }, LOAD_TOLERANT_WAIT);

      const editButton = await waitFor(() => {
        const button = app.view.container.querySelector('button[aria-label="Edit"]');
        if (!button) throw new Error("Edit button not found");
        return button as HTMLElement;
      }, LOAD_TOLERANT_WAIT);
      fireEvent.click(editButton);
      releasePayloads();
      const editTextarea = await waitFor(() => {
        const textarea = app.view.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Edit your last message"]'
        );
        if (!textarea) throw new Error("Edit textarea not found");
        expect(textarea.value).toBe("first message");
        return textarea;
      }, LOAD_TOLERANT_WAIT);

      fireEvent.keyDown(editTextarea, { key: "Escape" });
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      await getDraftStore().flush(scope);
      expect((await realGet(scope)).attachments.map(({ id }) => id)).toEqual(["file-late"]);
      getSpy.mockRestore();
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
