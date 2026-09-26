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

import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { HistoryService } from "@/node/services/historyService";
import { getDraftScopeId, getModelKey, getProjectScopeId } from "@/common/constants/storage";
import { KNOWN_MODELS, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";

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

  const chat = new ChatHarness(view.container, getDraftScopeId(normalizedProjectPath, draftId));

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

  test("/<model> one-shot sends the first message with that model only", async () => {
    getSharedEnv().services.aiService.enableMockMode();
    const { env, projectPath, view, cleanupDom, chat } = await setupCreationView();
    const modelKey = getModelKey(getProjectScopeId(projectPath));
    const projectModelBefore = readPersistedState(modelKey, "");
    let workspaceId: string | undefined;

    try {
      await chat.send("/haiku hello from creation");

      const created = await waitFor(
        async () => {
          const workspaces = await env.orpc.workspace.list({ archived: false });
          const workspace = workspaces.find((candidate) => candidate.projectPath === projectPath);
          if (!workspace) throw new Error("Created workspace not found yet");
          return workspace;
        },
        { timeout: 20_000 }
      );
      const createdWorkspaceId = created.id;
      workspaceId = createdWorkspaceId;
      // The workspace is named from the request, not the /haiku modifier.
      expect(created.name).not.toContain("haiku");

      // The command prefix is stripped from the sent text and the one-shot model is used...
      await waitFor(
        () => {
          expect(view.container.textContent ?? "").toContain("Mock response: hello from creation");
        },
        { timeout: 20_000 }
      );
      expect(env.services.aiService.mockAiStreamPlayer?.debugGetLastModel(createdWorkspaceId)).toBe(
        KNOWN_MODELS.HAIKU.id
      );
      // ...without changing the project's model preference.
      expect(readPersistedState(modelKey, "")).toBe(projectModelBefore);
      // The durable user row carries the one-shot model for the starting indicator.
      const history = await new HistoryService(env.config).getHistoryFromLatestBoundary(
        createdWorkspaceId
      );
      const userRow = (history.success ? history.data : []).find((m) => m.role === "user");
      expect(userRow?.metadata?.muxMetadata?.requestedModel).toBe(KNOWN_MODELS.HAIKU.id);
    } finally {
      if (workspaceId) {
        await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
      }
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

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
});
