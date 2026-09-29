/**
 * Integration tests for draft workspace behavior.
 *
 * Tests that clicking "New Workspace" reuses existing empty drafts
 * instead of creating new ones.
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";
import * as path from "node:path";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";

import {
  addProjectViaUI,
  cleanupView,
  clearWorkspaceDrafts,
  getWorkspaceDraftIds,
  setupTestDom,
} from "../helpers";
import { renderApp } from "../renderReviewPanel";
import {
  defaultCreationDraftScope,
  getDraftStore,
  type DraftStoreScope,
} from "@/browser/stores/DraftStore";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Wait for a specific number of drafts to exist */
async function waitForDraftCount(projectPath: string, count: number): Promise<string[]> {
  return await waitFor(
    () => {
      const ids = getWorkspaceDraftIds(projectPath);
      if (ids.length !== count) {
        throw new Error(`Expected ${count} drafts, got ${ids.length}`);
      }
      return ids;
    },
    { timeout: 5_000 }
  );
}

async function findProjectRow(container: HTMLElement, projectPath: string): Promise<HTMLElement> {
  return await waitFor(
    () => {
      const el = container.querySelector(`[data-project-path="${projectPath}"][aria-controls]`);
      if (!el) throw new Error("Project row not found");
      return el as HTMLElement;
    },
    { timeout: 5_000 }
  );
}

describeIntegration("Draft workspace behavior", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking New Workspace reuses existing empty draft instead of creating another", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      const projectName = path.basename(normalizedProjectPath);

      // Click project row to open creation view (creates first draft)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      // Wait for creation textarea to appear
      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      // Verify first draft was created
      const [firstDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(firstDraftId).toBeTruthy();

      // Click "New Workspace" button - should reuse empty draft, not create new one
      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(`[aria-label="New chat in ${projectName}"]`);
          if (!btn) throw new Error(`New chat button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      // Verify still only 1 draft (reused the empty one)
      await waitFor(
        () => {
          const draftsAfterSecondClick = getWorkspaceDraftIds(normalizedProjectPath);
          expect(draftsAfterSecondClick.length).toBe(1);
          expect(draftsAfterSecondClick[0]).toBe(firstDraftId);
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("draft row is hidden in sidebar when empty", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);

      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      // A draft exists in storage for reuse, but no row appears in the sidebar.
      const [draftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(draftId).toBeTruthy();
      expect(view.container.querySelector("[data-draft-id]")).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("the project row opens a non-empty default creation draft instead of a new draft", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });
    const createdScopes: DraftStoreScope[] = [];

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      const projectRow = await findProjectRow(view.container, normalizedProjectPath);

      // A listed draft with text, so the project row cannot reuse it.
      fireEvent.click(projectRow);
      const [listedDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      const listedScope: DraftStoreScope = {
        kind: "creation",
        projectPath: normalizedProjectPath,
        draftId: listedDraftId,
      };
      // Text typed on the bare project page (no draft id) lives in the default creation draft.
      const defaultScope = defaultCreationDraftScope(normalizedProjectPath);
      createdScopes.push(listedScope, defaultScope);
      getDraftStore().setText(listedScope, "listed draft text");
      getDraftStore().setText(defaultScope, "default draft text");
      await getDraftStore().flush(defaultScope);

      // Twice: a repeated click must land on the same draft, never add one.
      for (const _click of [1, 2]) {
        fireEvent.click(projectRow);
        // The project row must not hide the default draft behind a fresh empty composer.
        await waitFor(
          () => {
            const textarea = view.container.querySelector("textarea");
            expect(textarea?.value).toBe("default draft text");
          },
          { timeout: 5_000 }
        );
        expect(getWorkspaceDraftIds(normalizedProjectPath)).toEqual([listedDraftId]);
      }
    } finally {
      // Backend drafts outlive the persisted draft list: drop them so later tests start clean.
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("clicking New Chat before typing reuses hidden draft without showing duplicates", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      const projectName = path.basename(normalizedProjectPath);

      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      const [draftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(draftId).toBeTruthy();
      expect(view.container.querySelector("[data-draft-id]")).toBeNull();

      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(`[aria-label="New chat in ${projectName}"]`);
          if (!btn) throw new Error(`New chat button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      await waitFor(
        () => {
          expect(getWorkspaceDraftIds(normalizedProjectPath)).toEqual([draftId]);
          expect(view.container.querySelector("[data-draft-id]")).toBeNull();
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
