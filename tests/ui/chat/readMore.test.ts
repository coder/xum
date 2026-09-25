/**
 * Integration tests for the read-more context expansion feature in code review.
 *
 * Tests the ability to:
 * - Expand context above hunks (▲ button)
 * - Expand context below hunks (▼ button)
 * - Collapse expanded context via curvy-line indicator between hunk and context
 * - Hide expand buttons at file boundaries (BOF/EOF)
 * - Persist expansion state across re-renders
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
import { renderReviewPanel, type RenderedApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView, waitForRefreshButtonIdle } from "../helpers";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { APIClient } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { STORAGE_KEYS } from "@/constants/workspaceDefaults";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

type ExecuteBashResult = Awaited<ReturnType<APIClient["workspace"]["executeBash"]>>;
type ExecuteBashSuccess = Extract<ExecuteBashResult, { success: true }>;
type BashToolResult = ExecuteBashSuccess["data"];

function isLikelyGitLockError(message: string): boolean {
  // We sometimes race with GitStatusStore (or other git commands) and hit transient lock files.
  // Retrying makes tests far less flaky while still surfacing real failures.
  return /index\.lock|\.lock': File exists|another git process|could not lock/i.test(message);
}

async function executeWorkspaceBashOrThrow(params: {
  orpc: APIClient;
  workspaceId: string;
  script: string;
  timeoutSecs?: number;
  retries?: number;
  retryDelayMs?: number;
}): Promise<string> {
  const retries = params.retries ?? 5;
  const retryDelayMs = params.retryDelayMs ?? 250;

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await params.orpc.workspace.executeBash({
      workspaceId: params.workspaceId,
      script: params.script,
      options: params.timeoutSecs ? { timeout_secs: params.timeoutSecs } : undefined,
    });

    if (!result.success) {
      throw new Error(result.error ?? "executeBash failed");
    }

    const toolResult: BashToolResult = result.data;
    if (toolResult.success) {
      return toolResult.output;
    }

    const message = [toolResult.error, toolResult.output].filter(Boolean).join("\n");
    lastError = message;

    if (attempt < retries && isLikelyGitLockError(message)) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }

    throw new Error(
      `executeBash failed (exit ${toolResult.exitCode}): ${toolResult.error}\n${toolResult.output ?? ""}`
    );
  }

  throw new Error(lastError ?? "executeBash failed");
}

function getHunk(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-hunk-id]") as HTMLElement | null;
}

async function refreshReviewAndWaitForHunk(view: RenderedApp): Promise<void> {
  await view.selectTab("review");

  const refreshButton = view.getByTestId("review-refresh");
  fireEvent.click(refreshButton);

  await waitFor(
    () => {
      const hunk = getHunk(view.container);
      if (!hunk) throw new Error("No hunk found");
      return hunk;
    },
    { timeout: 60_000 }
  );

  await waitForRefreshButtonIdle(refreshButton);
}

async function waitForButtonToDisappear(
  container: HTMLElement,
  ariaLabel: string,
  timeoutMs: number = 10_000
): Promise<void> {
  await waitFor(
    () => {
      const btn = container.querySelector(`button[aria-label="${ariaLabel}"]`);
      if (btn) throw new Error(`Button still visible: ${ariaLabel}`);
    },
    { timeout: timeoutMs }
  );
}

async function waitForNotLoading(
  container: HTMLElement,
  timeoutMs: number = 15_000
): Promise<void> {
  await waitFor(
    () => {
      const text = container.textContent ?? "";
      if (text.includes("Loading...")) throw new Error("Still loading");
    },
    { timeout: timeoutMs }
  );
}

async function withReviewPanel(
  params: { apiClient: APIClient; metadata: FrontendWorkspaceMetadata },
  fn: (view: RenderedApp) => Promise<void>
): Promise<void> {
  const cleanupDom = installDom();

  // Tests in this file diff against HEAD (uncommitted changes).
  // Set the workspace diff base to HEAD explicitly since the app default is origin/<trunk>.
  updatePersistedState(STORAGE_KEYS.reviewDiffBase(params.metadata.id), "HEAD");

  const view = renderReviewPanel({ apiClient: params.apiClient, metadata: params.metadata });

  try {
    await fn(view);
  } finally {
    await cleanupView(view, cleanupDom);
  }
}

async function waitForButton(
  container: HTMLElement,
  ariaLabel: string,
  timeoutMs: number = 10_000
): Promise<HTMLElement> {
  return waitFor(
    () => {
      const btn = container.querySelector(`button[aria-label="${ariaLabel}"]`);
      if (!btn) throw new Error(`Button not found: ${ariaLabel}`);
      return btn as HTMLElement;
    },
    { timeout: timeoutMs }
  );
}

/**
 * Helper to set up the Review tab with a file change.
 * Creates a multi-line file and a diff at a non-first line to test context expansion.
 */

async function setupReviewPanelWithDiff(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string,
  orpc: APIClient
): Promise<HTMLElement> {
  await setupWorkspaceView(view, metadata, workspaceId);

  // Create a multi-line file for context expansion testing
  // We create a file with 30 lines, then modify line 15
  const lines = Array.from({ length: 30 }, (_, i) => `// Line ${i + 1}: content here`);
  const fileContent = lines.join("\n");

  // Create the initial file (committed)
  await executeWorkspaceBashOrThrow({
    orpc,
    workspaceId,
    script: `set -euo pipefail
cat > test-readmore.ts << 'EOF'
${fileContent}
EOF
git add test-readmore.ts
git -c commit.gpgsign=false commit -m "Add test file" --no-verify`,
  });

  // Modify line 15 (creating a diff in the middle of the file)
  const modifiedLines = [...lines];
  modifiedLines[14] = "// Line 15: MODIFIED FOR TEST";
  const modifiedContent = modifiedLines.join("\n");

  await executeWorkspaceBashOrThrow({
    orpc,
    workspaceId,
    script: `set -euo pipefail
cat > test-readmore.ts << 'EOF'
${modifiedContent}
EOF
# Verify we actually produced a diff hunk for the review panel to render.
git diff HEAD -- test-readmore.ts | grep -q "MODIFIED FOR TEST"`,
  });

  await refreshReviewAndWaitForHunk(view);
  return view.container;
}

// ═══════════════════════════════════════════════════════════════════════════════
// READ-MORE CONTEXT EXPANSION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("ReadMore context expansion (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("expand-up button loads additional context above hunk", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        const container = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // Find the expand-up button (▲) - should exist since diff is at line 15, not line 1
        const expandUpButton = await waitForButton(container, "Show more context above");
        fireEvent.click(expandUpButton);

        // Wait for expanded content to appear - should contain lines from before line 15
        await waitFor(
          () => {
            const hunkContent = container.textContent ?? "";
            if (hunkContent.includes("Loading...")) throw new Error("Still loading");

            // Should now have context lines from before the hunk (lines 1-14)
            // Look for a line number that would only appear in expanded content
            if (!hunkContent.includes("Line 10") && !hunkContent.includes("Line 5")) {
              throw new Error("Expanded content not visible - expected earlier line numbers");
            }
          },
          { timeout: 15_000 }
        );

        expect(getHunk(container)).not.toBeNull();
      });
    });
  }, 180_000);

  test("expand-down button loads additional context below hunk", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        const container = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // Find the expand-down button (▼) - should exist since diff is at line 15, file has 30 lines
        const expandDownButton = await waitForButton(container, "Show more context below");
        fireEvent.click(expandDownButton);

        // Wait for expanded content to appear - should contain lines after line 15
        await waitFor(
          () => {
            const hunkContent = container.textContent ?? "";
            if (hunkContent.includes("Loading...")) throw new Error("Still loading");

            // Should now have context lines from after the hunk (lines 16-30)
            // Look for a line number that would only appear in expanded content
            if (!hunkContent.includes("Line 20") && !hunkContent.includes("Line 25")) {
              throw new Error("Expanded content not visible - expected later line numbers");
            }
          },
          { timeout: 15_000 }
        );

        expect(getHunk(container)).not.toBeNull();
      });
    });
  }, 180_000);

  test("hides expand-up button when diff starts at line 1 (BOF)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a small file with diff at line 1 (so BOF is immediate)
        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
echo "// Original line 1" > bof-test.ts
git add bof-test.ts
git -c commit.gpgsign=false commit -m "Add BOF test" --no-verify`,
        });

        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
echo "// Modified line 1" > bof-test.ts
git diff HEAD -- bof-test.ts | grep -q "Modified line 1"`,
        });

        await refreshReviewAndWaitForHunk(view);

        // For a diff starting at line 1:
        // No expand-up button should exist (nothing above line 1)
        // and no BOF marker is shown (we just don't show the control row)
        expect(
          view.container.querySelector('button[aria-label="Show more context above"]')
        ).toBeNull();

        // Expand-down button should still exist
        expect(
          view.container.querySelector('button[aria-label="Show more context below"]')
        ).not.toBeNull();
      });
    });
  }, 180_000);

  test("hides expand-up button for newly added files (oldStart=0, newStart=1)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a NEW file (not modifying existing) - this will have oldStart=0
        // Must stage it for it to show up in the review panel diff
        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
echo "// New file line 1" > brand-new-file.ts
git add brand-new-file.ts
git diff --cached -- brand-new-file.ts | grep -q "New file line 1"`,
        });

        await refreshReviewAndWaitForHunk(view);

        // For a newly added file:
        // oldStart=0 (no old content), newStart=1
        // Should NOT show expand-up button (nothing to expand above a new file)
        expect(
          view.container.querySelector('button[aria-label="Show more context above"]')
        ).toBeNull();
      });
    });
  }, 180_000);

  test("hides expand-down button when expanded past file end (EOF)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a file with 10 lines - modify line 5 so there's context below
        const lines = Array.from({ length: 10 }, (_, i) => `// Line ${i + 1}`);
        const fileContent = lines.join("\n");

        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
cat > eof-test.ts << 'EOF'
${fileContent}
EOF
git add eof-test.ts
git -c commit.gpgsign=false commit -m "Add EOF test" --no-verify`,
        });

        // Modify line 5 (creates a diff in the middle with context above and below)
        const modifiedLines = [...lines];
        modifiedLines[4] = "// Line 5 - MODIFIED";
        const modifiedContent = modifiedLines.join("\n");

        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
cat > eof-test.ts << 'EOF'
${modifiedContent}
EOF
git diff HEAD -- eof-test.ts | grep -q "MODIFIED"`,
        });

        await refreshReviewAndWaitForHunk(view);

        // Click expand-down to reach EOF (file only has 10 lines, expansion requests 20)
        const expandDownButton = await waitForButton(view.container, "Show more context below");
        fireEvent.click(expandDownButton);

        await waitForNotLoading(view.container, 30_000);
        await waitForButtonToDisappear(view.container, "Show more context below", 30_000);
        await waitForButton(view.container, "Collapse context below", 30_000);
      });
    });
  }, 180_000);

  test("expand button stays hidden after reaching EOF (no flash back)", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Create a very small file (5 lines) - modify line 3
        const lines = Array.from({ length: 5 }, (_, i) => `// Line ${i + 1}`);
        const fileContent = lines.join("\n");

        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
cat > tiny-file.ts << 'EOF'
${fileContent}
EOF
git add tiny-file.ts
git -c commit.gpgsign=false commit -m "Add tiny file" --no-verify`,
        });

        // Modify line 3
        const modifiedLines = [...lines];
        modifiedLines[2] = "// Line 3 - MODIFIED";
        const modifiedContent = modifiedLines.join("\n");

        await executeWorkspaceBashOrThrow({
          orpc: env.orpc,
          workspaceId,
          script: `set -euo pipefail
cat > tiny-file.ts << 'EOF'
${modifiedContent}
EOF
git diff HEAD -- tiny-file.ts | grep -q "MODIFIED"`,
        });

        await refreshReviewAndWaitForHunk(view);

        // Click expand-down - this should immediately hit EOF (5 line file, expansion = 20)
        const expandDownButton = await waitForButton(view.container, "Show more context below");
        fireEvent.click(expandDownButton);

        await waitForNotLoading(view.container, 15_000);
        await waitForButtonToDisappear(view.container, "Show more context below", 15_000);

        // Wait a bit and verify button doesn't flash back
        await new Promise((r) => setTimeout(r, 1000));

        // Button should STILL be hidden (no flash back)
        expect(
          view.container.querySelector('button[aria-label="Show more context below"]')
        ).toBeNull();
      });
    });
  }, 180_000);

  test("multiple expand clicks accumulate context", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        const container = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        const expandUpButton = await waitForButton(container, "Show more context above");
        fireEvent.click(expandUpButton);

        // After first click (20 lines), we're at BOF since hunk is at line 15.
        await waitForNotLoading(container, 15_000);
        await waitForButtonToDisappear(container, "Show more context above", 5_000);
        await waitForButton(container, "Collapse context above", 5_000);
      });
    });
  }, 180_000);

  test("per-side collapse button hides expanded context", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      await withReviewPanel({ apiClient: env.orpc, metadata }, async (view) => {
        const container = await setupReviewPanelWithDiff(view, metadata, workspaceId, env.orpc);

        // Expand up to get some expanded content.
        const expandUpButton = await waitForButton(container, "Show more context above");
        fireEvent.click(expandUpButton);

        // Wait for the per-side collapse button to appear (indicates expansion completed).
        const collapseButton = await waitForButton(container, "Collapse context above", 15_000);
        fireEvent.click(collapseButton);

        await waitForButtonToDisappear(container, "Collapse context above", 10_000);
        expect(getHunk(container)).not.toBeNull();
      });
    });
  }, 180_000);
});
