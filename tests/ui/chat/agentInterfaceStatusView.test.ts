import "../dom";

import * as fs from "fs/promises";
import * as path from "path";
import { waitFor } from "@testing-library/react";

// App-level UI tests render the loader shell first, so stub Lottie before importing the
// harness to keep happy-dom from tripping over lottie-web's canvas bootstrap.
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

function query(container: HTMLElement, selector: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(selector);
}

function get(container: HTMLElement, selector: string): HTMLElement {
  const element = query(container, selector);
  if (element == null) throw new Error(`${selector} not found`);
  return element;
}

describe("Agent interface status view in the chat pane", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("Tab reaches the page before the composer and skips the covered transcript; a deleted page in a crowded folder goes", async () => {
    const app = await createAppHarness({
      branchPrefix: "agent-interface-view",
      beforeRenderEnvironment: async (env) => {
        await env.orpc.experiments.set({ experimentId: EXPERIMENT_IDS.ARTIFACTS, enabled: true });
        await env.orpc.experiments.set({
          experimentId: EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE,
          enabled: true,
        });
      },
    });

    try {
      const listing = await app.env.orpc.artifacts.list({ workspaceId: app.workspaceId });
      if (!listing.success || !listing.data.available) throw new Error("No artifacts folder");
      const dir = listing.data.dir;
      await fs.mkdir(dir, { recursive: true });
      // A crowded folder: the page is older than every file the capped listing keeps, before
      // and after it is deleted, so only reads of the page itself tell the pane about it.
      const pagePath = path.join(dir, AGENT_INTERFACE_STATUS_ARTIFACT);
      await fs.writeFile(pagePath, "<p>Status</p>");
      await fs.utimes(pagePath, new Date(1_000_000), new Date(1_000_000));
      for (let i = 0; i < 501; i++) {
        await fs.writeFile(path.join(dir, `note-${i}.txt`), "note");
      }

      const container = app.view.container;
      const statusView = await waitFor(
        () => get(container, '[data-testid="agent-interface-status-view"]'),
        { timeout: 15_000 }
      );
      const frame = await waitFor(() => get(statusView, '[data-testid="artifact-frame"]'), {
        timeout: 15_000,
      });
      const messageWindow = get(container, '[data-testid="message-window"]');
      const composer = get(
        container,
        '[data-testid="chat-composer-dock"] textarea[aria-label="Message"]'
      );

      // Sequential focus follows document order and skips a negative tabIndex.
      expect({
        transcriptTabbable: messageWindow.tabIndex >= 0,
        pageBeforeComposer:
          (frame.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      }).toEqual({ transcriptTabbable: false, pageBeforeComposer: true });

      await fs.rm(pagePath);
      await waitFor(
        () => {
          if (query(container, '[data-testid="agent-interface-status-view"]') != null) {
            throw new Error("The deleted page still shows");
          }
        },
        { timeout: 15_000 }
      );
      // Back on the chat, the transcript scrolls from the keyboard again.
      expect(messageWindow.tabIndex).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 90_000);
});
