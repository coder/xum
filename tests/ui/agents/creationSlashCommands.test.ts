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

import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getDraftScopeId,
  getModelKey,
  getProjectScopeId,
} from "@/common/constants/storage";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

interface CreationView {
  env: ReturnType<typeof getSharedEnv>;
  projectPath: string;
  view: ReturnType<typeof renderApp>;
  cleanupDom: () => void;
  chat: ChatHarness;
}

async function setupCreationView(options?: { beforeRender?: () => void }): Promise<CreationView> {
  const env = getSharedEnv();
  const projectPath = getSharedRepoPath();

  const cleanupDom = setupTestDom();
  options?.beforeRender?.();

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

      const modelKey = getModelKey(getProjectScopeId(projectPath));
      await waitFor(
        () => {
          expect(readPersistedState(modelKey, "")).toBe(expectedModel);
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
    const env = getSharedEnv();
    await env.orpc.config.updateAgentAiDefaults({
      agentAiDefaults: { exec: { autoModelRouting: true } },
    });
    const { projectPath, view, cleanupDom } = await setupCreationView({
      beforeRender: () =>
        updatePersistedState(getExperimentKey(EXPERIMENT_IDS.AUTO_MODEL_ROUTING), true),
    });

    try {
      const projectScopeId = getProjectScopeId(projectPath);
      await waitFor(
        () => {
          expect(readPersistedState(getAutoModelRoutingKey(projectScopeId), false)).toBe(true);
        },
        { timeout: 5_000 }
      );
      expect(readPersistedState(getAutoThinkingLevelKey(projectScopeId), false)).toBe(false);
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.config.updateAgentAiDefaults({ agentAiDefaults: {} });
    }
  }, 30_000);
});
