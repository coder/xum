import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import type { MuxMessage } from "@/common/types/message";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

async function collectFullHistory(
  workspaceId: string,
  app: Awaited<ReturnType<typeof createAppHarness>>
) {
  const replay = await app.env.orpc.workspace.getFullReplay({ workspaceId });
  return replay.filter(
    (message): message is Extract<(typeof replay)[number], { type: "message" }> => {
      return message.type === "message";
    }
  );
}

function getMessageText(messages: { parts: MuxMessage["parts"] }[]): string {
  return messages
    .flatMap((message) =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
    )
    .join("\n");
}

describe("Fork from assistant response (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("forks from the selected assistant response instead of the latest turn", async () => {
    const app = await createAppHarness({ branchPrefix: "fork-response" });
    let forkedWorkspaceId: string | null = null;

    try {
      const firstPrompt = "First branch point";
      const secondPrompt = "Second branch point";
      const firstResponse = `Mock response: ${firstPrompt}`;
      const secondResponse = `Mock response: ${secondPrompt}`;

      await app.chat.send(firstPrompt);
      await app.chat.expectTranscriptContains(firstResponse);
      await app.chat.expectStreamComplete();

      await app.chat.send(secondPrompt);
      await app.chat.expectTranscriptContains(secondResponse);
      await app.chat.expectStreamComplete();

      const forkButton = await waitFor(
        () => {
          const messageNode = Array.from(
            app.view.container.querySelectorAll('[data-testid="chat-message"]')
          ).find((node) => node.textContent?.includes(firstResponse));
          if (!messageNode) {
            throw new Error("Selected assistant response not found");
          }

          const button = messageNode.querySelector('button[aria-label="Fork"]');
          if (!button) {
            throw new Error("Fork button not found for selected response");
          }
          if (button.hasAttribute("disabled")) {
            throw new Error("Fork button is disabled for selected response");
          }

          return button as HTMLElement;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(forkButton);

      await waitFor(
        () => {
          const path = window.location.pathname;
          if (!path.startsWith("/workspace/")) {
            throw new Error(`Unexpected path after fork: ${path}`);
          }

          const currentId = decodeURIComponent(path.slice("/workspace/".length));
          if (currentId === app.workspaceId) {
            throw new Error("Still on source workspace after response fork");
          }

          forkedWorkspaceId = currentId;
        },
        { timeout: 10_000 }
      );

      if (!forkedWorkspaceId) {
        throw new Error("Missing forked workspace ID after response fork");
      }

      const forkedHistory = await collectFullHistory(forkedWorkspaceId, app);
      const forkedText = getMessageText(forkedHistory);

      expect(forkedText).toContain(firstPrompt);
      expect(forkedText).toContain(firstResponse);
      expect(forkedText).not.toContain(secondPrompt);
      expect(forkedText).not.toContain(secondResponse);

      await app.chat.expectTranscriptContains(firstResponse);
      const transcriptText =
        app.view.container.querySelector('[data-testid="message-window"]')?.textContent ?? "";
      expect(transcriptText).not.toContain(secondResponse);
    } finally {
      if (forkedWorkspaceId) {
        await app.env.orpc.workspace
          .remove({ workspaceId: forkedWorkspaceId, options: { force: true } })
          .catch(() => {});
      }

      await app.dispose();
    }
  }, 60_000);
});
