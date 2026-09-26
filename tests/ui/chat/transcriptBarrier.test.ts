/**
 * Transcript mutation barrier (full app, real IPC, mock AI router).
 *
 * A replay whose history read fails must never look synchronized: the cached rows stay as a
 * provisional view, the banner shows, sends/edits/clear are refused with the draft preserved,
 * Stop-style controls stay usable, and the next complete replay re-enables everything.
 * The failure is deterministic: the workspace's chat.jsonl is replaced by a directory before
 * the store resubscribes, and restored afterwards.
 */
import "../dom";

jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { fireEvent, waitFor } from "@testing-library/react";
import * as fs from "fs/promises";
import path from "path";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import {
  TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE,
  TRANSCRIPT_REPLAY_FAILED_BANNER,
} from "@/constants/transcriptBarrier";

function sendButton(container: HTMLElement): HTMLButtonElement {
  const sections = Array.from(container.querySelectorAll('[data-component="ChatInputSection"]'));
  const section = sections.at(-1);
  if (!section) throw new Error("ChatInputSection not found");
  const button = section.querySelector('button[aria-label="Send message"]');
  if (!button) throw new Error("Send button not found");
  return button as HTMLButtonElement;
}

function activeTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textareas = Array.from(
    container.querySelectorAll('textarea[aria-label="Message Claude"]')
  );
  const textarea = textareas.at(-1);
  if (!textarea) throw new Error("Chat textarea not found");
  return textarea;
}

describe("Transcript mutation barrier (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a failed replay keeps cached rows, refuses mutations, retries, and recovers", async () => {
    const app = await createAppHarness({ branchPrefix: "transcript-barrier" });
    const chatFile = path.join(app.env.config.sessionsDir, app.workspaceId, "chat.jsonl");
    let chatBytes: Buffer | null = null;

    try {
      const seed = "Seed row before the outage";
      await app.chat.send(seed);
      await app.chat.expectTranscriptContains(`Mock response: ${seed}`);
      await app.chat.expectStreamComplete();
      // A fresh workspace's first replay had no rows and therefore no since-cursor; one
      // round trip establishes the cursor so the next resubscribe is incremental and the
      // cached rows survive as a provisional view (a full replay would reset them instead).
      workspaceStore.setActiveWorkspaceId(null);
      workspaceStore.setActiveWorkspaceId(app.workspaceId);
      // With a draft and a verified transcript the composer can send.
      const draft = "Draft typed while the transcript is unverified";
      await app.chat.typeWithoutSending(draft);
      await waitFor(() => expect(sendButton(app.view.container).disabled).toBe(false), {
        timeout: 15_000,
      });

      // Break the history file, then force a resubscribe (leave and re-enter the workspace).
      chatBytes = await fs.readFile(chatFile);
      await fs.rm(chatFile);
      await fs.mkdir(chatFile);
      workspaceStore.setActiveWorkspaceId(null);
      workspaceStore.setActiveWorkspaceId(app.workspaceId);

      await waitFor(
        () =>
          expect(app.view.container.textContent ?? "").toContain(TRANSCRIPT_REPLAY_FAILED_BANNER),
        { timeout: 15_000 }
      );
      // Cached rows stay visible as a provisional view.
      expect(app.view.container.textContent ?? "").toContain(`Mock response: ${seed}`);
      // The per-row Edit affordance is gone while the transcript is unverified.
      expect(app.view.container.querySelector('button[aria-label="Edit"]')).toBeNull();

      // The draft survives, but Send is refused and the draft is preserved.
      await app.chat.expectInputValue(draft);
      expect(sendButton(app.view.container).disabled).toBe(true);
      const sendMessage = jest.spyOn(app.env.services.workspaceService, "sendMessage");
      fireEvent.keyDown(activeTextarea(app.view.container), { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(app.view.container.textContent ?? "").toContain(TRANSCRIPT_NOT_CAUGHT_UP_MESSAGE)
      );
      await app.chat.expectInputValue(draft);
      expect(sendMessage).not.toHaveBeenCalled();

      // Typed /clear is a history mutation too: refused the same way, nothing truncated.
      const truncate = jest.spyOn(app.env.services.workspaceService, "truncateHistory");
      await app.chat.typeWithoutSending("/clear");
      fireEvent.keyDown(activeTextarea(app.view.container), { key: "Enter", code: "Enter" });
      await app.chat.expectInputValue("/clear");
      expect(truncate).not.toHaveBeenCalled();
      await app.chat.typeWithoutSending(draft);

      // Restore the file: the retry loop's next attempt completes and re-enables everything.
      await fs.rmdir(chatFile);
      await fs.writeFile(chatFile, chatBytes);
      chatBytes = null;
      await waitFor(
        () =>
          expect(app.view.container.textContent ?? "").not.toContain(
            TRANSCRIPT_REPLAY_FAILED_BANNER
          ),
        { timeout: 30_000 }
      );
      await waitFor(() => expect(sendButton(app.view.container).disabled).toBe(false), {
        timeout: 15_000,
      });
      await waitFor(() =>
        expect(app.view.container.querySelector('button[aria-label="Edit"]')).not.toBeNull()
      );
      await app.chat.expectInputValue(draft);
      expect(app.view.container.textContent ?? "").toContain(`Mock response: ${seed}`);
    } finally {
      if (chatBytes) {
        await fs.rm(chatFile, { recursive: true, force: true });
        await fs.writeFile(chatFile, chatBytes);
      }
      await app.dispose();
    }
  }, 120_000);
});
