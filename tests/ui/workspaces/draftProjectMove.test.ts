/**
 * The creation header's project selector moves the draft being edited to the chosen project,
 * sub-project or Scratch, instead of opening the destination's own draft.
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
} from "../../ipc/sendMessageTestHelpers";
import { createTempGitRepo, trustProject } from "../../ipc/helpers";

import {
  cleanupView,
  clearWorkspaceDrafts,
  getWorkspaceDraftIds,
  openProjectCreationView,
  setupTestDom,
} from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";
import { defaultCreationDraftScope, getDraftStore } from "@/browser/stores/DraftStore";
import { setAutoRoutingPick } from "@/browser/utils/aiSelectionIntent";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import { getAutoRouting, getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";
import { readScopeAgentId } from "@/browser/utils/scopedAiDefaults";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import {
  getPendingScopeId,
  getProjectScopeId,
  getWorkspaceNameStateKey,
} from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const WAIT = { timeout: 10_000 };
const ATTACHMENT = {
  kind: "provider" as const,
  id: "file-moved",
  url: "data:text/plain;base64,bW92ZWQ=",
  mediaType: "text/plain",
  filename: "moved.txt",
};

function creationScope(projectPath: string, draftId: string) {
  return { kind: "creation" as const, projectPath, draftId };
}

function textareaValue(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value;
}

function projectSelectorLabel(container: HTMLElement): string | undefined {
  return container.querySelector('[data-testid="project-selector"]')?.textContent?.trim();
}

/** Radix Select content portals into document.body. */
async function pickOption(
  trigger: HTMLElement,
  label: string,
  match: (text: string) => boolean = (text) => text === label
): Promise<void> {
  fireEvent.click(trigger);
  const option = await waitFor(() => {
    const candidate = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (element) => match(element.textContent?.trim() ?? "")
    );
    if (!candidate) throw new Error(`Option '${label}' not found`);
    return candidate;
  }, WAIT);
  fireEvent.click(option);
}

async function moveDraftTo(container: HTMLElement, label: string): Promise<void> {
  const trigger = await waitFor(() => {
    const element = container.querySelector<HTMLElement>('[data-testid="project-selector"]');
    if (!element) throw new Error("Project selector not found");
    return element;
  }, WAIT);
  await pickOption(trigger, label);
  await waitFor(() => expect(projectSelectorLabel(container)).toBe(label), WAIT);
}

async function waitForDraftIds(projectPath: string, expected: string[]): Promise<void> {
  await waitFor(() => expect(getWorkspaceDraftIds(projectPath)).toEqual(expected), WAIT);
}

async function onlyDraftId(projectPath: string): Promise<string> {
  return await waitFor(() => {
    const ids = getWorkspaceDraftIds(projectPath);
    if (ids.length !== 1) throw new Error(`Expected 1 draft in ${projectPath}, got ${ids.length}`);
    return ids[0];
  }, WAIT);
}

describeIntegration("Creation project selector moves the draft", () => {
  let projectBDir = "";
  let projectB = "";

  beforeAll(async () => {
    await createSharedRepo();
    projectBDir = await createTempGitRepo();
    // Added on the backend: addProjectViaUI takes the first row it has not seen for the new one,
    // which races with any other project appearing.
    const created = await getSharedEnv().orpc.projects.create({ projectPath: projectBDir });
    if (!created.success) throw new Error(`Failed to add project B: ${created.error}`);
    projectB = created.data.normalizedPath;
    await trustProject(getSharedEnv(), projectB);
  });

  afterAll(async () => {
    await fs.rm(projectBDir, { recursive: true, force: true });
    await cleanupSharedRepo();
  });

  async function openTwoProjects(): Promise<{
    view: RenderedApp;
    cleanupDom: () => void;
    a: string;
    b: string;
  }> {
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: getSharedEnv().orpc });
    await view.waitForReady();
    // The shared repo is registered by createSharedRepo (trusting it adds it).
    const a = getSharedRepoPath();
    const b = projectB;
    await waitFor(() => {
      for (const projectPath of [a, b]) {
        if (!view.container.querySelector(`[data-project-path="${projectPath}"]`)) {
          throw new Error(`Project row ${projectPath} not found`);
        }
      }
    }, WAIT);
    for (const projectPath of [a, b, SCRATCH_PROJECT_CONFIG_KEY]) {
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(projectPath);
      await getDraftStore().deleteDraft(defaultCreationDraftScope(projectPath));
    }
    return { view, cleanupDom, a, b };
  }

  test("a listed draft moves to another project with its content and settings", async () => {
    const { view, cleanupDom, a, b } = await openTwoProjects();
    const { container } = view;
    try {
      await openProjectCreationView(view, a);
      const sourceDraftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, sourceDraftId), "move me");
      getDraftStore().setAttachments(creationScope(a, sourceDraftId), [ATTACHMENT]);
      await waitFor(() => expect(textareaValue(container)).toBe("move me"), WAIT);
      // Focusing the name input turns auto-naming off, as for a user.
      const nameInput = container.querySelector<HTMLInputElement>("#workspace-name")!;
      fireEvent.focus(nameInput);
      fireEvent.change(nameInput, { target: { value: "moved-name" } });
      await waitFor(() => expect(nameInput.value).toBe("moved-name"), WAIT);

      fireEvent.click(container.querySelector<HTMLElement>('[aria-label="Select agent"]')!);
      fireEvent.click(
        await waitFor(() => {
          const row = container.querySelector<HTMLElement>('[data-agent-id="plan"]');
          if (!row) throw new Error("Plan agent row not found");
          return row;
        }, WAIT)
      );
      await waitFor(() => expect(readScopeAgentId(getProjectScopeId(a))).toBe("plan"), WAIT);
      // The model selector's creation path; an explicit pick leaves model Auto.
      setWorkspaceModelWithOrigin(getProjectScopeId(a), KNOWN_MODELS.HAIKU.id, "user");
      // The destination's own Auto pick must not survive the move.
      setAutoRoutingPick(getProjectScopeId(b), "plan", "model", true);
      await pickOption(
        container.querySelector<HTMLElement>(
          '[data-component="RuntimeTypeGroup"] button[aria-label="Workspace type"]'
        )!,
        "Local",
        // Runtime options also show a description.
        (text) => text.startsWith("Local")
      );

      await moveDraftTo(container, path.basename(b));

      const movedDraftId = await onlyDraftId(b);
      await waitFor(() => {
        expect(textareaValue(container)).toBe("move me");
        expect(container.querySelector<HTMLInputElement>("#workspace-name")?.value).toBe(
          "moved-name"
        );
        expect(
          container.querySelector(
            '[data-component="RuntimeTypeGroup"] button[aria-label="Workspace type"]'
          )?.textContent
        ).toContain("Local");
      }, WAIT);
      expect(readScopeAgentId(getProjectScopeId(b))).toBe("plan");
      expect(getWorkspaceAiSelection(getProjectScopeId(b)).model).toBe(KNOWN_MODELS.HAIKU.id);
      expect(getAutoRouting(getProjectScopeId(b), "model")).toBe(false);
      // The source is deleted once the destination is saved, so a reload shows it in B only.
      await waitForDraftIds(a, []);
      const saved = await getSharedEnv().services.draftService.get(creationScope(b, movedDraftId));
      expect(saved.text).toBe("move me");
      expect(saved.attachments.map(({ id }) => id)).toEqual([ATTACHMENT.id]);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("the bare project page's default draft moves and leaves that page empty", async () => {
    const { view, cleanupDom, a, b } = await openTwoProjects();
    const { container } = view;
    // Holds workspace name generation, so the source composer's request settles after the move.
    const workspaceService = getSharedEnv().services.workspaceService;
    const realCandidates = workspaceService.getWorkspaceNamingCandidates.bind(workspaceService);
    let releaseNaming!: () => void;
    const namingReleased = new Promise<void>((resolve) => {
      releaseNaming = resolve;
    });
    const namingCalls: Promise<unknown>[] = [];
    const namingSpy = jest
      .spyOn(workspaceService, "getWorkspaceNamingCandidates")
      .mockImplementation((...args) => {
        const call = namingReleased.then(() => realCandidates(...args));
        namingCalls.push(call.catch(() => undefined));
        return call;
      });
    try {
      // The project row opens a non-empty default draft (the bare project page).
      getDraftStore().setText(defaultCreationDraftScope(a), "default text");
      await getDraftStore().flush(defaultCreationDraftScope(a));
      await openProjectCreationView(view, a);
      await waitFor(() => expect(textareaValue(container)).toBe("default text"), WAIT);
      await waitFor(() => expect(namingSpy).toHaveBeenCalled(), WAIT);

      await moveDraftTo(container, path.basename(b));

      await onlyDraftId(b);
      await waitFor(() => expect(textareaValue(container)).toBe("default text"), WAIT);
      releaseNaming();
      await Promise.all(namingCalls);
      await waitFor(
        () => expect(getDraftStore().getView(defaultCreationDraftScope(a)).text).toBe(""),
        WAIT
      );
      expect(getWorkspaceDraftIds(a)).toEqual([]);
      // No workspace name is left behind either: it would keep A's bare page non-empty.
      expect(readPersistedState(getWorkspaceNameStateKey(getPendingScopeId(a)), null)).toBeNull();
    } finally {
      releaseNaming();
      namingSpy.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("a draft moved to Scratch and back keeps its text and attachments", async () => {
    const { view, cleanupDom, a } = await openTwoProjects();
    const { container } = view;
    try {
      await openProjectCreationView(view, a);
      const sourceDraftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, sourceDraftId), "round trip");
      getDraftStore().setAttachments(creationScope(a, sourceDraftId), [ATTACHMENT]);
      await waitFor(() => expect(textareaValue(container)).toBe("round trip"), WAIT);

      await moveDraftTo(container, SCRATCH_PROJECT_NAME);
      const scratchDraftId = await onlyDraftId(SCRATCH_PROJECT_CONFIG_KEY);
      await waitFor(() => expect(textareaValue(container)).toBe("round trip"), WAIT);
      await waitForDraftIds(a, []);

      await moveDraftTo(container, path.basename(a));
      const backDraftId = await onlyDraftId(a);
      await waitFor(() => expect(textareaValue(container)).toBe("round trip"), WAIT);
      await waitForDraftIds(SCRATCH_PROJECT_CONFIG_KEY, []);
      expect(backDraftId).not.toBe(scratchDraftId);
      expect(
        getDraftStore()
          .getView(creationScope(a, backDraftId))
          .attachments.map(({ id }) => id)
      ).toEqual([ATTACHMENT.id]);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("switching a listed draft to a sub-project and back keeps the same draft", async () => {
    const subProjectDir = path.join(getSharedRepoPath(), "packages", "sub");
    await fs.mkdir(subProjectDir, { recursive: true });
    const { view, cleanupDom, a } = await openTwoProjects();
    const { container } = view;
    try {
      const created = await getSharedEnv().orpc.projects.create({ projectPath: subProjectDir });
      if (!created.success) throw new Error(`Failed to add the sub-project: ${created.error}`);
      const subProject = created.data.normalizedPath;
      await openProjectCreationView(view, a);
      const draftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, draftId), "same draft");
      await waitFor(() => expect(textareaValue(container)).toBe("same draft"), WAIT);

      await moveDraftTo(container, `${path.basename(a)} / sub`);
      await waitFor(
        () =>
          expect(getDraftStore().getCreationDraftsByProject()[a]).toEqual([
            expect.objectContaining({ draftId, subProjectPath: subProject }),
          ]),
        WAIT
      );
      expect(textareaValue(container)).toBe("same draft");

      await moveDraftTo(container, path.basename(a));
      await waitFor(
        () =>
          expect(getDraftStore().getCreationDraftsByProject()[a]).toEqual([
            expect.objectContaining({ draftId, subProjectPath: null }),
          ]),
        WAIT
      );
      expect(textareaValue(container)).toBe("same draft");
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);
});
