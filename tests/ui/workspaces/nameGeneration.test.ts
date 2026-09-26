/**
 * UI smoke test for workspace name generation.
 *
 * Verifies that typing a message in creation mode triggers name generation
 * and displays the result in the UI. This test uses a real LLM.
 *
 * Robust testing of the model selection fallback logic is in:
 * - src/node/services/modelSelectionFallback.test.ts (unit tests with mocks)
 * - tests/ipc/nameGeneration.test.ts (backend API with real LLM)
 */

import "../dom";
import { act, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getDraftScopeId, getInputKey } from "@/common/constants/storage";

import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  openProjectCreationView,
  setupTestDom,
  waitForLatestDraftId,
} from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Name generation UI flow", () => {
  beforeAll(async () => {
    await createSharedRepo();
  }, 30_000);

  afterAll(async () => {
    await cleanupSharedRepo();
  }, 30_000);

  test("shows generated name when typing message in creation mode", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();

      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      await openProjectCreationView(view, normalizedProjectPath);

      // Set input text via persisted state (happy-dom fireEvent.change can be flaky)
      // This mimics how ChatHarness.send() works
      const draftId = await waitForLatestDraftId(normalizedProjectPath);
      const inputKey = getInputKey(getDraftScopeId(normalizedProjectPath, draftId));
      act(() => {
        updatePersistedState(inputKey, "Fix the sidebar layout bug on mobile devices");
      });

      // Wait for the workspace name input to show a generated name
      // Name format: lowercase letters/numbers/hyphens with 4-char suffix (e.g., "sidebar-a1b2")
      await waitFor(
        () => {
          const input = view.container.querySelector("#workspace-name")!;
          if (!input) throw new Error("Workspace name input not found");

          const name = input.value;
          // Check if name matches expected format: word(s)-xxxx where xxxx is the suffix
          if (!name || !/^[a-z0-9-]+-[a-z0-9]{4}$/.test(name)) {
            throw new Error(`Name not generated yet or invalid format: "${name}"`);
          }
        },
        { timeout: 30_000 } // LLM call can take time
      );

      // Verify the generated name is valid
      const nameInput = view.container.querySelector("#workspace-name")!;
      const generatedName = nameInput.value;
      expect(generatedName).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
      expect(generatedName.length).toBeLessThanOrEqual(30);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
