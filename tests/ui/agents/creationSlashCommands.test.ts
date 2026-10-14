/**
 * Integration tests for slash commands in workspace creation mode.
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

import { getUserPreferences } from "@/browser/stores/AppConfigStore";
import { resetAiSelectionIntentForTests } from "@/browser/utils/aiSelectionIntent";
import { getAutoRouting } from "@/browser/utils/workspaceAiSettingsSync";
import { getDraftScopeId, getProjectScopeId } from "@/common/constants/storage";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

interface CreationView {
  env: ReturnType<typeof getSharedEnv>;
  projectPath: string;
  view: ReturnType<typeof renderApp>;
  cleanupDom: () => void;
  chat: ChatHarness;
}

async function setupCreationView(): Promise<CreationView> {
  const env = getSharedEnv();
  const projectPath = getSharedRepoPath();

  const cleanupDom = setupTestDom();

  const view = renderApp({ apiClient: env.orpc });

  const normalizedProjectPath = await addProjectViaUI(view, projectPath);
  await openProjectCreationView(view, normalizedProjectPath);

  const draftId = await waitForLatestDraftId(normalizedProjectPath);

  const chat = new ChatHarness(view.container, getDraftScopeId(normalizedProjectPath, draftId), {
    kind: "creation",
    projectPath: normalizedProjectPath,
    draftId,
  });

  return {
    env,
    projectPath: normalizedProjectPath,
    view,
    cleanupDom,
    chat,
  };
}

describeIntegration("Creation slash commands", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("/model updates project-scoped model in creation mode", async () => {
    const { projectPath, view, cleanupDom, chat } = await setupCreationView();

    try {
      const alias = "sonnet";
      const expectedModel = MODEL_ABBREVIATIONS[alias];
      if (!expectedModel) {
        throw new Error(`Missing model abbreviation for ${alias}`);
      }

      await chat.send(`/model ${alias}`);

      await waitFor(
        () => {
          expect(view.container.textContent ?? "").toContain(`Model changed to ${expectedModel}`);
        },
        { timeout: 5_000 }
      );

      await waitFor(
        () => {
          expect(getUserPreferences().ai?.projectDefaults?.[projectPath]?.model).toBe(
            expectedModel
          );
        },
        { timeout: 5_000 }
      );

      await chat.expectInputValue("");
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("workspace-only commands show a toast and keep input", async () => {
    const { view, cleanupDom, chat } = await setupCreationView();

    try {
      const command = "/compact";
      await chat.send(command);

      await waitFor(
        () => {
          expect(view.container.textContent ?? "").toContain(
            "Command not available during workspace creation"
          );
        },
        { timeout: 5_000 }
      );

      await chat.expectInputValue(command);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("a configured Auto default turns Auto on in the creation composer", async () => {
    // The /model test above left an unsent concrete pick for this shared project.
    resetAiSelectionIntentForTests();
    const env = getSharedEnv();
    await env.orpc.config.updateAgentAiDefaults({
      agentAiDefaults: { exec: { autoModelRouting: true } },
    });
    await env.orpc.experiments.set({
      experimentId: EXPERIMENT_IDS.AUTO_MODEL_ROUTING,
      enabled: true,
    });
    const { projectPath, view, cleanupDom } = await setupCreationView();

    try {
      const projectScopeId = getProjectScopeId(projectPath);
      await waitFor(
        () => {
          expect(getAutoRouting(projectScopeId, "model")).toBe(true);
        },
        { timeout: 5_000 }
      );
      expect(getAutoRouting(projectScopeId, "thinkingLevel")).toBe(false);
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.config.updateAgentAiDefaults({ agentAiDefaults: {} });
      await env.orpc.experiments.set({
        experimentId: EXPERIMENT_IDS.AUTO_MODEL_ROUTING,
        enabled: null,
      });
    }
  }, 30_000);
});
