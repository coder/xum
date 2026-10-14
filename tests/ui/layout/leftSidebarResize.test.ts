/**
 * Integration tests for LeftSidebar drag-resize behavior.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { LEFT_SIDEBAR_COLLAPSED_KEY, LEFT_SIDEBAR_WIDTH_KEY } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("LeftSidebar (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  beforeEach(() => {
    updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, null);
    updatePersistedState(LEFT_SIDEBAR_WIDTH_KEY, null);
  });

  test("drag-resize updates width and persists value", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      // Start expanded.
      updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
      updatePersistedState(LEFT_SIDEBAR_WIDTH_KEY, null);

      const view = renderApp({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const sidebar = await waitFor(
          () => {
            const el = view.container.querySelector('[data-testid="left-sidebar"]');
            if (!el) {
              throw new Error("LeftSidebar not found");
            }
            return el as HTMLElement;
          },
          { timeout: 10_000 }
        );

        const handle = sidebar.querySelector('[data-testid="left-sidebar-resize-handle"]');
        if (!handle) {
          throw new Error("LeftSidebar resize handle not found");
        }

        expect(sidebar.style.width).toBe("288px");

        fireEvent.mouseDown(handle, { clientX: 200 });
        fireEvent.mouseMove(document, { clientX: 300 });
        fireEvent.mouseUp(document);

        // +100px wider from default.
        await waitFor(() => expect(sidebar.style.width).toBe("388px"));
        await waitFor(() => {
          expect(window.localStorage.getItem(LEFT_SIDEBAR_WIDTH_KEY)).toBe("388");
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 60_000);
});
