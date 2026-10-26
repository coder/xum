import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";
import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { detectDefaultTrunkBranch } from "@/node/git";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";
import {
  cleanupTestEnvironment,
  createTestEnvironment,
  type TestEnvironment,
} from "../../ipc/setup";
import { renderReviewPanel, type RenderedApp } from "../renderReviewPanel";
import { cleanupView, setupTestDom, setupWorkspaceView } from "../helpers";

const execAsync = promisify(exec);
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/**
 * A workspace whose setup lasts until `release()`: its committed init hook waits for a file, so
 * the test decides when setup ends without a timed wait.
 */
async function openWorkspaceInSetup() {
  const repoPath = await createTempGitRepo();
  const releaseFile = path.join(repoPath, "..", `${path.basename(repoPath)}-release`);
  await fs.mkdir(path.join(repoPath, ".xum"), { recursive: true });
  const hook = path.join(repoPath, ".xum", "init");
  await fs.writeFile(hook, `#!/bin/sh\nwhile [ ! -f '${releaseFile}' ]; do sleep 0.05; done\n`);
  await fs.chmod(hook, 0o755);
  await execAsync(`git add -A && git commit -m "Add init hook"`, { cwd: repoPath });

  const env: TestEnvironment = await createTestEnvironment();
  await trustProject(env, repoPath);
  const created = await env.orpc.workspace.create({
    projectPath: repoPath,
    branchName: generateBranchName("review-focus-setup"),
    trunkBranch: await detectDefaultTrunkBranch(repoPath),
  });
  if (!created.success) throw new Error(created.error);
  const metadata: FrontendWorkspaceMetadata = created.metadata;
  const cleanupDom = setupTestDom();
  const view: RenderedApp = renderReviewPanel({ apiClient: env.orpc, metadata });
  await setupWorkspaceView(view, metadata, metadata.id, { waitForSetup: false });
  // The strip holds only opened tabs: Stats, then Review (tabs 1 and 2).
  await view.selectTab("costs");
  await view.selectTab("review");
  await view.findByText("Setting up workspace...", {}, { timeout: 30_000 });
  await view.selectTab("costs");

  return {
    view,
    release: () => fs.writeFile(releaseFile, ""),
    async dispose() {
      await fs.writeFile(releaseFile, "");
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId: metadata.id, options: { force: true } });
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
      await fs.rm(releaseFile, { force: true });
    },
  };
}

function reviewPanel(view: RenderedApp): HTMLElement {
  const panel = view.container.querySelector<HTMLElement>('[data-testid="review-panel"]');
  if (!panel) throw new Error("Review panel not mounted (workspace setup not finished)");
  return panel;
}

// #7449: Ctrl+2 while the Review tab shows the setup placeholder.
describeIntegration("ReviewPanel focus during workspace setup (UI + ORPC)", () => {
  test("a Ctrl+2 during setup focuses the panel once setup ends", async () => {
    const workspace = await openWorkspaceInSetup();
    try {
      fireEvent.keyDown(window, { key: "2", ctrlKey: true });
      await workspace.release();
      await waitFor(
        () => {
          if (!reviewPanel(workspace.view).contains(document.activeElement)) {
            throw new Error("Review panel not focused");
          }
        },
        { timeout: 30_000 }
      );
    } finally {
      await workspace.dispose();
    }
  }, 120_000);

  test("a focus move after the Ctrl+2 cancels it, also when focus then drops to the body", async () => {
    const workspace = await openWorkspaceInSetup();
    try {
      fireEvent.keyDown(window, { key: "2", ctrlKey: true });
      const chatInput = await workspace.view.findByRole("textbox", { name: "Message" });
      chatInput.focus();
      // As when the focused control unmounts: focus is back on the body, where it was at Ctrl+2.
      chatInput.blur();
      await workspace.release();
      await waitFor(() => reviewPanel(workspace.view), { timeout: 30_000 });
      expect(reviewPanel(workspace.view).contains(document.activeElement)).toBe(false);
    } finally {
      await workspace.dispose();
    }
  }, 120_000);
});
