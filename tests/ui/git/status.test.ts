import "../dom";
import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedRepoPath,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";
import { addFakeOrigin } from "../../ipc/helpers";

import { installDom } from "../dom";
import { renderReviewPanel } from "../renderReviewPanel";
import {
  cleanupView,
  getGitStatusFromElement,
  setupWorkspaceView,
  waitForAheadStatus,
  waitForBranchStatus,
  waitForIdleGitStatus,
  waitForGitStatusElement,
  waitForDirtyStatus,
  waitForCleanStatus,
} from "../helpers";
import { invalidateGitStatus } from "@/browser/stores/GitStatusStore";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/**
 * Trigger git status refresh directly via store invalidation.
 * Window focus events don't work reliably in happy-dom, so we bypass
 * the RefreshController and call invalidateGitStatus() directly.
 */
function triggerGitStatusRefresh(workspaceId: string): void {
  invalidateGitStatus(workspaceId);
}

describeIntegration("GitStatus (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
    // Add fake origin for ahead/behind status tests
    await addFakeOrigin(getSharedRepoPath());
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("initial git status shows clean state for fresh workspace", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Initial subscription triggers immediate fetch
        const statusElement = await waitForGitStatusElement(view.container, workspaceId, 30_000);
        const status = getGitStatusFromElement(statusElement);

        expect(status).not.toBeNull();
        expect(status?.dirty).toBe(false);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status updates on window focus after file change", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await waitForCleanStatus(view.container, workspaceId, 30_000);

        // Modify file (simulates external change or terminal command)
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "TEST_MARKER" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;

        // Trigger git status refresh (simulates user returning to app)
        triggerGitStatusRefresh(workspaceId);

        const dirtyStatus = await waitForDirtyStatus(view.container, workspaceId, 30_000);
        expect(dirtyStatus.dirty).toBe(true);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status shows clean after committing", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "COMMIT_MARKER" >> README.md && git add README.md && git commit -m "test commit"`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;

        triggerGitStatusRefresh(workspaceId);

        const status = await waitForCleanStatus(view.container, workspaceId, 30_000);
        expect(status.dirty).toBe(false);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status reflects ahead count", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Wait for stable baseline (ahead === 0, clean) AND idle store (no in-flight fetch).
        // This ensures we don't race with a background fetch completing mid-commit.
        await waitForIdleGitStatus(
          workspaceId,
          (s) => s.ahead === 0 && !s.dirty,
          "ahead === 0, clean, idle",
          10_000
        );

        // Make 2 commits to get ahead of remote
        for (let i = 0; i < 2; i++) {
          const bashRes = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `echo "commit-${i}" >> README.md && git add README.md && git commit -m "test commit ${i}"`,
          });
          expect(bashRes.success).toBe(true);
          if (!bashRes.success) return;
          // The RPC succeeds even when the script fails: check the commit itself, so a failed
          // commit reports its own error instead of a wrong ahead count 30 s later (#7626).
          expect(bashRes.data.success ? "" : bashRes.data.error).toBe("");
        }

        // Directly invalidate git status instead of simulating window focus.
        // This bypasses RefreshController rate-limiting and jsdom event quirks.
        invalidateGitStatus(workspaceId);
        await waitForAheadStatus(view.container, workspaceId, 2, 30_000);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status includes current branch name", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const statusElement = await waitForGitStatusElement(view.container, workspaceId, 30_000);
        const status = getGitStatusFromElement(statusElement);

        expect(status).not.toBeNull();
        // Workspace branch should be a non-empty string (the worktree's branch name)
        expect(typeof status?.branch).toBe("string");
        expect(status?.branch?.length).toBeGreaterThan(0);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status detects branch change after external checkout", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Wait for initial status to stabilize
        const statusElement = await waitForGitStatusElement(view.container, workspaceId, 30_000);
        const initialStatus = getGitStatusFromElement(statusElement);
        expect(initialStatus?.branch).toBeTruthy();
        const originalBranch = initialStatus!.branch!;

        // Create and checkout a new branch (simulates external git operation)
        const newBranch = `test-branch-switch-${Date.now()}`;
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `git checkout -b "${newBranch}" 2>&1`,
          options: { timeout_secs: 10 },
        });
        expect(bashRes.success).toBe(true);

        // Trigger refresh (simulates focus event or file-modify trigger)
        triggerGitStatusRefresh(workspaceId);

        // Wait for git status to reflect the new branch
        await waitForBranchStatus(view.container, workspaceId, newBranch, 30_000);

        // Switch back to original branch to clean up
        await env.orpc.workspace.executeBash({
          workspaceId,
          script: `git checkout "${originalBranch}" && git branch -D "${newBranch}"`,
          options: { timeout_secs: 10 },
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);
});
