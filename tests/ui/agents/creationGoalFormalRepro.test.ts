/**
 * Repro of a composer-draft counterexample found by the TLA+ model in formal/composer-drafts/
 * (ComposerDrafts.tla, config MC_creation; run formal/composer-drafts/check.sh).
 *
 * D3: `/goal <objective>` typed into a creation composer creates the workspace first, then runs the
 * goal command in it (useCreationWorkspace.handleSend). The creation draft is deleted as soon as
 * the workspace exists (`clearPendingDraft`, before the command runs). When the command does not
 * consume its input (handleGoalCommand returns "restore": setGoal refused or threw, or a budget on
 * an unpriced model), creation used to return `{ success: false }` without moving the text
 * anywhere, so the objective the user typed was gone: not in any draft, not a goal, not in the
 * transcript. Creation now hands the typed command to the new workspace's composer draft.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";

import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  openProjectCreationView,
  setupTestDom,
  waitForLatestDraftId,
} from "../helpers";
import { ChatHarness } from "../harness";

import { getDraftStore } from "@/browser/stores/DraftStore";
import { getDraftScopeId } from "@/common/constants/storage";
import type { DraftScope } from "@/common/orpc/schemas/drafts";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const OBJECTIVE = "ship the formal composer model";

async function setupCreationView() {
  const env = getSharedEnv();
  const cleanupDom = setupTestDom();
  const view = renderApp({ apiClient: env.orpc });
  const projectPath = await addProjectViaUI(view, getSharedRepoPath());
  await openProjectCreationView(view, projectPath);
  const draftId = await waitForLatestDraftId(projectPath);
  const scope: DraftScope = { kind: "creation", projectPath, draftId };
  const chat = new ChatHarness(view.container, getDraftScopeId(projectPath, draftId), scope);
  return { env, projectPath, view, cleanupDom, chat, scope };
}

function workspaceIdsOf(env: ReturnType<typeof getSharedEnv>, projectPath: string): string[] {
  const project = env.services.config.loadConfigOrDefault().projects.get(projectPath);
  return (project?.workspaces ?? []).flatMap((workspace) => (workspace.id ? [workspace.id] : []));
}

const NOT_YET = "objective not found yet";

/** Every place the typed objective may legitimately survive: drafts, goals, the visible composer. */
async function whereTheObjectiveLives(
  env: ReturnType<typeof getSharedEnv>,
  projectPath: string,
  scope: DraftScope,
  container: HTMLElement,
  /** Workspaces that existed before this test (an earlier test's leftovers in the shared repo). */
  preexisting: ReadonlySet<string>
): Promise<string[]> {
  const found: string[] = [];
  for (const textarea of container.querySelectorAll("textarea")) {
    if (textarea.value.includes(OBJECTIVE)) found.push("visible composer");
  }
  await getDraftStore().flush(scope);
  if ((await env.services.draftService.get(scope)).text.includes(OBJECTIVE)) {
    found.push("creation draft");
  }
  for (const workspaceId of workspaceIdsOf(env, projectPath)) {
    if (preexisting.has(workspaceId)) continue;
    const workspaceScope: DraftScope = { kind: "workspace", workspaceId };
    await getDraftStore().flush(workspaceScope);
    if ((await env.services.draftService.get(workspaceScope)).text.includes(OBJECTIVE)) {
      found.push(`draft of ${workspaceId}`);
    }
    const goal = await env.services.workspaceGoalService.getGoal(workspaceId);
    if (goal?.objective?.includes(OBJECTIVE)) found.push(`goal of ${workspaceId}`);
  }
  return found;
}

describeIntegration("formal/composer-drafts: /goal in a creation composer", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("a refused /goal keeps the objective the user typed", async () => {
    const { env, projectPath, view, cleanupDom, chat, scope } = await setupCreationView();
    const before = new Set(workspaceIdsOf(env, projectPath));
    const setGoal = jest.spyOn(env.services.workspaceGoalService, "setGoal").mockResolvedValue({
      success: false,
      error: { type: "invalid_transition", message: "formal repro: goal refused" },
    });
    try {
      await chat.send(`/goal ${OBJECTIVE}`);
      await waitFor(() => expect(setGoal).toHaveBeenCalled(), { timeout: 30_000 });
      await waitFor(
        () => {
          const created = workspaceIdsOf(env, projectPath).filter((id) => !before.has(id));
          expect(created).toHaveLength(1);
        },
        { timeout: 30_000 }
      );
      // The refusal settles the creation send after the app already left the creation view.
      await Promise.allSettled(setGoal.mock.results.map((result): unknown => result.value));

      // The creation handler finishes after setGoal settles, with no signal of its own: poll
      // until the objective shows up (a fix) or the wait runs out (D3). Only the "not yet"
      // outcome is swallowed; a failing lookup still fails the repro elsewhere.
      let found: string[] = [];
      await waitFor(
        async () => {
          found = await whereTheObjectiveLives(env, projectPath, scope, view.container, before);
          if (found.length === 0) throw new Error(NOT_YET);
        },
        { timeout: 5_000 }
      ).catch((error: unknown) => {
        // waitFor appends the DOM to the last error's message.
        if (!(error instanceof Error && error.message.startsWith(NOT_YET))) throw error;
      });
      // Target assertion: the refused command's input survives somewhere the user can find it.
      expect(found.length > 0).toBe(true);
    } finally {
      setGoal.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("control: an accepted /goal turns the objective into the new workspace's goal", async () => {
    const { env, projectPath, view, cleanupDom, chat, scope } = await setupCreationView();
    const before = new Set(workspaceIdsOf(env, projectPath));
    try {
      await chat.send(`/goal ${OBJECTIVE}`);
      await waitFor(
        async () => {
          const created = workspaceIdsOf(env, projectPath).filter((id) => !before.has(id));
          expect(created).toHaveLength(1);
          const goal = await env.services.workspaceGoalService.getGoal(created[0]);
          expect(goal?.objective).toBe(OBJECTIVE);
        },
        { timeout: 30_000 }
      );
      // The creation draft is deleted once the command returns, just after the backend set the goal.
      await waitFor(
        async () => {
          const found = await whereTheObjectiveLives(
            env,
            projectPath,
            scope,
            view.container,
            before
          );
          expect(found).toEqual([expect.stringMatching(/^goal of /)]);
        },
        { timeout: 10_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);
});
