/**
 * #5411 item 2: a sub-agent's goal turns run on its task-pinned model, so the RightSidebar budget
 * editor must not refuse a child goal's budget because the composer's model is unpriced. The
 * backend prices the budget on the task model (and refuses it there when that is unpriced).
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

import {
  cleanupTestEnvironment,
  createTestEnvironment,
  preloadTestModules,
  type TestEnvironment,
} from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";

import { detectDefaultTrunkBranch } from "@/node/git";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  getModelKey,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import { UNPRICED_CURRENT_MODEL_GOAL_MESSAGE } from "@/common/utils/goals/budgetPricing";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";

// Not in any pricing table: the composer-model pre-check would refuse a budget on it.
const UNPRICED_COMPOSER_MODEL = "openai:unpriced-composer-model";
const PRICED_TASK_MODEL = "openai:gpt-4o-mini";

describe("RightSidebar child goal budget (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test.each([
    ["a sub-agent's goal budget skips the composer-model pre-check", true],
    ["a top-level goal budget keeps the composer-model pre-check", false],
  ] as const)(
    "%s",
    async (_name, isChild) => {
      const env: TestEnvironment = await createTestEnvironment();
      const repoPath = await createTempGitRepo();
      let view: RenderedApp | undefined;
      let cleanupDom: (() => void) | undefined;
      const workspaceIds: string[] = [];
      try {
        await trustProject(env, repoPath);
        const trunkBranch = await detectDefaultTrunkBranch(repoPath);
        const create = async (prefix: string): Promise<FrontendWorkspaceMetadata> => {
          const result = await env.orpc.workspace.create({
            projectPath: repoPath,
            branchName: generateBranchName(prefix),
            trunkBranch,
          });
          if (!result.success) throw new Error(`create failed: ${result.error}`);
          workspaceIds.push(result.metadata.id);
          return result.metadata;
        };
        const parent = await create("goal-budget-parent");
        let target = await create("goal-budget-target");

        // Created while top-level (users cannot create a child's goal), then paused.
        const created = await env.orpc.workspace.setGoal({
          workspaceId: target.id,
          objective: "Finish the child work",
          budgetCents: null,
        });
        expect(created.success).toBe(true);
        const paused = await env.orpc.workspace.setGoal({
          workspaceId: target.id,
          status: "paused",
        });
        expect(paused.success).toBe(true);
        if (isChild) {
          target = {
            ...target,
            parentWorkspaceId: parent.id,
            // Running: inactive sub-agents are hidden from the sidebar.
            taskStatus: "running",
          };
          await env.config.addWorkspace(repoPath, {
            ...target,
            agentType: "exec",
            taskModelString: PRICED_TASK_MODEL,
          });
        }

        cleanupDom = installDom();
        updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, "goal");
        updatePersistedState(getRightSidebarLayoutKey(target.id), null);
        updatePersistedState(getModelKey(target.id), UNPRICED_COMPOSER_MODEL);
        view = renderApp({ apiClient: env.orpc, metadata: target });
        await setupWorkspaceView(view, target, target.id);
        const rendered = view;

        const opener = await waitFor(
          () => {
            const goalTab = rendered.container.querySelector<HTMLElement>(
              '[role="tab"][aria-controls*="goal"]'
            );
            if (!goalTab) throw new Error("Goal tab not found");
            fireEvent.click(goalTab);
            const button = rendered.container.querySelector<HTMLElement>(
              '[aria-label="Edit goal budget"]'
            );
            if (!button) throw new Error("Budget editor not found");
            return button;
          },
          { timeout: 10_000 }
        );
        fireEvent.click(opener);
        const input = await waitFor(() => {
          const element = rendered.container.querySelector<HTMLInputElement>(
            '[aria-label="Goal budget amount"]'
          );
          if (!element) throw new Error("Budget input not found");
          return element;
        });
        fireEvent.input(input, { target: { value: "$7.50" } });
        const save = Array.from(rendered.container.querySelectorAll("button")).find(
          (button) => button.textContent === "Save budget"
        );
        if (!save) throw new Error("Save budget button not found");
        fireEvent.click(save);

        if (isChild) {
          await waitFor(
            async () => {
              const { goal } = await env.orpc.workspace.getGoal({ workspaceId: target.id });
              expect(goal?.budgetCents).toBe(750);
            },
            { timeout: 10_000 }
          );
          expect(rendered.container.textContent).not.toContain(UNPRICED_CURRENT_MODEL_GOAL_MESSAGE);
        } else {
          await waitFor(() => {
            expect(rendered.container.textContent).toContain(UNPRICED_CURRENT_MODEL_GOAL_MESSAGE);
          });
          const { goal } = await env.orpc.workspace.getGoal({ workspaceId: target.id });
          expect(goal?.budgetCents).toBeNull();
        }
      } finally {
        if (view && cleanupDom) await cleanupView(view, cleanupDom);
        else cleanupDom?.();
        for (const workspaceId of workspaceIds.reverse()) {
          try {
            await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
          } catch {
            // Best-effort cleanup.
          }
        }
        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      }
    },
    60_000
  );
});
