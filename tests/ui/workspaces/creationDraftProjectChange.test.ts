/**
 * Picking another project in a creation composer keeps the same draft: its id, editor, text,
 * attachment bytes, manual name and AI choices. Choices tied to the old project reset, and no
 * project's defaults are written.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../../ipc/sendMessageTestHelpers";
import { cleanupTempGitRepo, createTempGitRepo } from "../../ipc/helpers";

import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  getWorkspaceDraftIds,
  openProjectCreationView,
  setupTestDom,
} from "../helpers";

import { getUserPreferences } from "@/browser/stores/AppConfigStore";
import { getCreationDraftStore } from "@/browser/stores/CreationDraftStore";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const IMAGE = {
  kind: "provider" as const,
  id: "image-1",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
  filename: "a.png",
};

function messageTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (!textarea) throw new Error("Message textarea not found");
  return textarea;
}

async function pickProject(container: HTMLElement, label: string): Promise<void> {
  const trigger = container.querySelector<HTMLElement>('[data-testid="project-selector"]');
  if (!trigger) throw new Error("Project selector not found");
  fireEvent.click(trigger);
  const option = await waitFor(() => {
    const candidate = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => element.textContent?.trim() === label
    );
    if (!candidate) throw new Error(`Project option '${label}' not found`);
    return candidate;
  });
  fireEvent.click(option);
  await waitForScope(container, label);
}

async function waitForScope(container: HTMLElement, label: string): Promise<void> {
  await waitFor(() => {
    const current = container.querySelector('[data-testid="project-selector"]');
    if (current?.textContent?.trim() !== label) throw new Error(`Not on '${label}'`);
  });
}

describeIntegration("Creation draft project change", () => {
  let projectB = "";

  beforeAll(async () => {
    await createSharedRepo();
    projectB = await createTempGitRepo();
  });

  afterAll(async () => {
    await cleanupTempGitRepo(projectB);
    await cleanupSharedRepo();
  });

  test("A -> B -> Scratch keeps one draft and resets project-tied choices", async () => {
    const env = getSharedEnv();
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: env.orpc });
    try {
      const pathA = await addProjectViaUI(view, getSharedRepoPath());
      const pathB = await addProjectViaUI(view, projectB);
      const labelB = pathB.split("/").pop() ?? pathB;
      // Adding a project opens it: let that land before opening A.
      await waitForScope(view.container, labelB);
      await openProjectCreationView(view, pathA);
      await waitForScope(view.container, pathA.split("/").pop() ?? pathA);
      const store = getCreationDraftStore();
      const editor = messageTextarea(view.container);
      fireEvent.change(editor, { target: { value: "keep this text" } });
      // The composer's draft is the one holding what was typed.
      const draftId = await waitFor(() => {
        const id = getWorkspaceDraftIds(pathA).find(
          (candidate) => store.getView(candidate).draft?.text === "keep this text"
        );
        if (!id) throw new Error("Typed draft not listed yet");
        return id;
      });
      const draft = store.getView(draftId).draft;
      if (!draft) throw new Error("Draft not loaded");
      store.update(draftId, {
        attachments: [IMAGE],
        manualName: "my-branch",
        ai: { ...draft.ai, model: "anthropic:claude-sonnet-4-5" },
      });
      store.updateExecution(draftId, {
        agent: { id: "repo-only", scope: "project" },
        runtime: { mode: "ssh", host: "project-a-host" },
        trunkBranch: "main",
      });
      const preferences = JSON.stringify(getUserPreferences());

      await pickProject(view.container, labelB);
      await store.flush(draftId);

      // The editor did not remount (its key is the draft id, not the project).
      expect(editor.isConnected).toBe(true);
      expect(store.getView(draftId).draft).toMatchObject({
        projectPath: pathB,
        text: "keep this text",
        attachments: [IMAGE],
        manualName: "my-branch",
        ai: { model: "anthropic:claude-sonnet-4-5" },
        execution: { projectPath: pathB, agent: null, runtime: null, trunkBranch: null },
      });
      expect(getWorkspaceDraftIds(pathA)).not.toContain(draftId);
      expect(getWorkspaceDraftIds(pathB)).toContain(draftId);
      expect(JSON.stringify(getUserPreferences())).toBe(preferences);
      // The confirmed save holds the new project (a reload opens the draft there).
      expect((await env.services.draftService.creation.get(draftId))?.projectPath).toBe(pathB);

      store.updateExecution(draftId, { agent: { id: "plan", scope: "built-in" } });
      await pickProject(view.container, SCRATCH_PROJECT_NAME);
      await store.flush(draftId);
      expect(store.getView(draftId).draft).toMatchObject({
        projectPath: SCRATCH_PROJECT_CONFIG_KEY,
        text: "keep this text",
        attachments: [IMAGE],
        execution: { agent: { id: "plan", scope: "built-in" }, runtime: null },
      });
      await waitFor(() => expect(messageTextarea(view.container).value).toBe("keep this text"));
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  // The composer seeds a draft's AI from its agent's defaults once; a move (and the agent reset and
  // list reload it brings) keeps what the draft holds, and only a user's agent pick applies them.
  test("a project change keeps the draft's model over its agent's defaults", async () => {
    const env = getSharedEnv();
    await env.orpc.config.updateAgentAiDefaults({
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5" },
        plan: { modelString: "anthropic:claude-opus-4-1" },
      },
    });
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: env.orpc });
    try {
      const pathA = await addProjectViaUI(view, getSharedRepoPath());
      const labelB = (await addProjectViaUI(view, projectB)).split("/").pop() ?? projectB;
      await openProjectCreationView(view, pathA);
      await waitForScope(view.container, pathA.split("/").pop() ?? pathA);
      const store = getCreationDraftStore();
      fireEvent.change(messageTextarea(view.container), { target: { value: "keep my model" } });
      const draftId = await waitFor(() => {
        const id = getWorkspaceDraftIds(pathA).find(
          (candidate) => store.getView(candidate).draft?.text === "keep my model"
        );
        if (!id) throw new Error("Typed draft not listed yet");
        return id;
      });
      const model = () => store.getView(draftId).draft?.ai.model;
      await waitFor(() => expect(model()).toBe("openai:gpt-5"));
      const draft = store.getView(draftId).draft;
      if (!draft) throw new Error("Draft not loaded");
      store.update(draftId, { ai: { ...draft.ai, model: "anthropic:claude-sonnet-4-5" } });

      await pickProject(view.container, labelB);
      // Let B's agent list load (the sync waits for it).
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(model()).toBe("anthropic:claude-sonnet-4-5");

      store.updateExecution(draftId, { agent: { id: "plan", scope: "built-in" } });
      await waitFor(() => expect(model()).toBe("anthropic:claude-opus-4-1"));
    } finally {
      await env.orpc.config.updateAgentAiDefaults({ agentAiDefaults: {} });
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
