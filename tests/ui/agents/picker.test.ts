/**
 * Integration tests for agent picker (AgentModePicker) component.
 *
 * Tests cover:
 * - Built-in agents appear in dropdown
 * - Custom project agents appear alongside built-ins
 * - Selecting an agent updates the trigger
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
  withSharedWorkspace,
} from "../../ipc/sendMessageTestHelpers";

import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  openProjectCreationView,
  setupTestDom,
  setupWorkspaceView,
} from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Open the agent picker dropdown by clicking the trigger button.
 * Waits until at least one agent row is visible.
 */
async function openAgentPicker(container: HTMLElement): Promise<void> {
  const trigger = await waitFor(
    () => {
      const btn = container.querySelector('[aria-label="Select agent"]')!;
      if (!btn) throw new Error("Agent picker trigger not found");
      return btn;
    },
    { timeout: 5_000 }
  );
  fireEvent.click(trigger);

  // Wait for dropdown to appear with agent rows
  await waitFor(
    () => {
      const rows = container.querySelectorAll("[data-agent-id]");
      if (rows.length === 0) throw new Error("No agents loaded yet");
    },
    { timeout: 10_000 }
  );
}

/**
 * Get all agent names visible in the dropdown.
 */
function getVisibleAgentNames(container: HTMLElement): string[] {
  // Use data-agent-id to find agent rows, then extract names
  const rows = container.querySelectorAll("[data-agent-id]");
  return Array.from(rows).map((row) => {
    const nameSpan = row.querySelector('[data-testid="agent-name"]');
    return nameSpan?.textContent ?? "";
  });
}

/**
 * Get the agent ID by name from the dropdown.
 */
function getAgentIdByName(container: HTMLElement, name: string): string | null {
  const rows = container.querySelectorAll("[data-agent-id]");
  for (const row of Array.from(rows)) {
    const nameSpan = row.querySelector('[data-testid="agent-name"]');
    if (nameSpan?.textContent === name) {
      return row.getAttribute("data-agent-id");
    }
  }
  return null;
}

/**
 * Create a custom agent definition file in the workspace.
 */
async function createAgentFile(
  workspacePath: string,
  agentId: string,
  content: string
): Promise<void> {
  const agentsDir = path.join(workspacePath, ".mux", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, `${agentId}.md`), content);
}

/**
 * Remove a custom agent definition file from the workspace.
 */
async function removeAgentFile(workspacePath: string, agentId: string): Promise<void> {
  const filePath = path.join(workspacePath, ".mux", "agents", `${agentId}.md`);
  try {
    await fs.unlink(filePath);
  } catch {
    // File might not exist
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("Agent Picker (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("built-in agents appear in dropdown", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = setupTestDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        const agentNames = getVisibleAgentNames(view.container);

        // Built-in agents should be present
        expect(agentNames).toContain("Exec");
        expect(agentNames).toContain("Plan");

        // Check IDs match
        expect(getAgentIdByName(view.container, "Exec")).toBe("exec");
        expect(getAgentIdByName(view.container, "Plan")).toBe("plan");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("custom workspace agents appear alongside built-ins", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // With workspaceId provided, agents are discovered from workspace worktree path.
      // This allows iterating on agent definitions per-workspace.
      const workspacePath = metadata.namedWorkspacePath;

      // Create a custom agent in the workspace worktree
      const customAgentContent = `---
name: Code Review
description: Review code changes for quality and best practices.
base: exec
ui:
  color: "#ff6b6b"
tools:
  remove:
    - file_edit_.*
---

You are a code review agent. Review code for quality, readability, and best practices.
`;
      await createAgentFile(workspacePath, "code-review", customAgentContent);

      const cleanupDom = setupTestDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        const agentNames = getVisibleAgentNames(view.container);

        // Both built-in and custom agents should appear
        expect(agentNames).toContain("Exec");
        expect(agentNames).toContain("Plan");
        expect(agentNames).toContain("Code Review");

        // Custom agent should have correct ID
        expect(getAgentIdByName(view.container, "Code Review")).toBe("code-review");
      } finally {
        // Cleanup custom agent
        await removeAgentFile(workspacePath, "code-review");
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("selecting an agent updates the picker trigger", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = setupTestDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Get agent name from trigger
        const getTriggerText = () => {
          const trigger = view.container.querySelector('[aria-label="Select agent"]');
          return trigger?.textContent?.replace(/[⌘⌃⇧\d]/g, "").trim() ?? "";
        };

        await openAgentPicker(view.container);

        // Click on Plan agent row
        const planRow = view.container.querySelector('[data-agent-id="plan"]')!;
        expect(planRow).toBeTruthy();
        fireEvent.click(planRow);

        // Wait for dropdown to close
        await waitFor(
          () => {
            const rows = view.container.querySelectorAll("[data-agent-id]");
            if (rows.length > 0) throw new Error("Dropdown still open");
          },
          { timeout: 2_000 }
        );

        // Trigger should now show "Plan"
        await waitFor(
          () => {
            const text = getTriggerText();
            if (!text.includes("Plan")) {
              throw new Error(`Expected "Plan" in trigger, got "${text}"`);
            }
          },
          { timeout: 2_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("agent picker shows agents on project page (no workspace)", async () => {
    // This test reproduces a bug where the agent picker shows "No matching agents"
    // on the new workspace creation page, even though exec agent is selected.
    // The bug occurs because ModeProvider doesn't load agents when there's no workspaceId.
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();

      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      await openProjectCreationView(view, normalizedProjectPath);

      // Open agent picker
      await openAgentPicker(view.container);

      // Should show agents, not empty
      const agentNames = getVisibleAgentNames(view.container);
      expect(agentNames.length).toBeGreaterThan(0);
      expect(agentNames).toContain("Exec");
      expect(agentNames).toContain("Plan");
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
