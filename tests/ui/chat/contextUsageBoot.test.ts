/**
 * Composer context-usage button while the workspace's history is still loading (#6101).
 *
 * The button's numbers come from replayed chat history. Before caught-up the store has no
 * usage yet, which is "unknown", not "no usage": the button must not show "0" for a
 * workspace that has usage. Once history has loaded, an empty workspace shows its real "0".
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import type { ChatMuxMessage, WorkspaceChatMessage } from "@/common/orpc/types";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";

type Emit = (message: WorkspaceChatMessage) => void;

/** Render one workspace whose history replay is held until the test releases it. */
async function renderWithHeldReplay(id: string, history: ChatMuxMessage[]) {
  const cleanupDom = installDom();
  const metadata = createWorkspace({ id, name: id, projectName: "my-app" });
  const held: Emit[] = [];
  const client = createMockORPCClient({
    projects: groupWorkspacesByProject([metadata]),
    workspaces: [metadata],
    onChat: (workspaceId, emit) => {
      if (workspaceId === metadata.id) {
        held.push(emit);
        return undefined;
      }
      queueMicrotask(() =>
        emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false })
      );
      return undefined;
    },
  });
  const view = renderApp({ apiClient: client, metadata });
  await setupWorkspaceView(view, metadata, metadata.id);

  const contextUsageButton = () =>
    view.container.querySelector<HTMLButtonElement>('button[aria-label^="Context usage"]');
  return {
    view,
    contextUsageButton,
    releaseReplay: () => {
      const emit = held.at(-1);
      if (!emit) throw new Error("The app has not subscribed to the workspace chat yet");
      for (const message of history) emit(message);
      emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false });
    },
    dispose: () => cleanupView(view, cleanupDom),
  };
}

describe("Composer context usage before history loads (#6101)", () => {
  test("a workspace with usage never shows 0 before its history has loaded", async () => {
    const app = await renderWithHeldReplay("ws-usage-boot", [
      createUserMessage("msg-user-1", "Question", { historySequence: 1 }),
      createAssistantMessage("msg-assistant-1", "Answer", {
        historySequence: 2,
        contextUsage: { inputTokens: 40_000, outputTokens: 500 },
      }),
    ]);
    try {
      const button = await waitFor(
        () => {
          const el = app.contextUsageButton();
          if (!el) throw new Error("Context usage button not rendered");
          return el;
        },
        { timeout: 10_000 }
      );
      // History is still held: the usage is unknown, so no number may show.
      expect(button.getAttribute("aria-label")).not.toMatch(/^Context usage: 0\b/);
      expect(button.querySelector("[data-context-usage-percent]")?.textContent ?? "").toBe("");
      // The settings dialog opened now must not show a wrong 0 or a limit warning either.
      fireEvent.click(button);
      const dialog = await waitFor(() => within(document.body).getByRole("dialog"));
      const usageText = within(dialog).getByText("Context Usage").nextElementSibling?.textContent;
      expect(usageText ?? "").not.toMatch(/\d/);
      expect(dialog.textContent ?? "").not.toContain("Unknown model limits");

      app.releaseReplay();
      await waitFor(
        () =>
          expect(app.contextUsageButton()?.getAttribute("aria-label")).toMatch(
            /^Context usage: 40\.5k \/ /
          ),
        { timeout: 10_000 }
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("a workspace with no usage shows its real 0 once its history has loaded", async () => {
    const app = await renderWithHeldReplay("ws-no-usage-boot", []);
    try {
      app.releaseReplay();
      await waitFor(
        () => {
          const button = app.contextUsageButton();
          expect(button?.getAttribute("aria-label")).toBe("Context usage: 0 (unknown limit)");
          expect(button?.querySelector("[data-context-usage-percent]")?.textContent).toBe("0");
        },
        { timeout: 10_000 }
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
