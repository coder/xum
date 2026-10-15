/**
 * Integration tests for draft workspace behavior.
 *
 * Tests that clicking "New Workspace" reuses existing empty drafts
 * instead of creating new ones.
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

import {
  addProjectViaUI,
  cleanupView,
  clearWorkspaceDrafts,
  getWorkspaceDraftIds,
  setupTestDom,
} from "../helpers";
import { renderApp } from "../renderReviewPanel";
import {
  defaultCreationDraftScope,
  getDraftStore,
  type DraftStoreScope,
} from "@/browser/stores/DraftStore";
import * as attachmentsHandling from "@/browser/utils/attachmentsHandling";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type {
  DraftAttachment,
  DraftScope,
  WorkspaceNamePersistedState,
} from "@/common/orpc/schemas/drafts";
import { DEFAULT_CREATION_DRAFT_ID } from "@/constants/drafts";

const IMAGE: DraftAttachment = {
  kind: "provider",
  id: "img-promote",
  url: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
};

const NAME_STATE: WorkspaceNamePersistedState = {
  generatedIdentity: null,
  manualName: "promoted-name",
  autoGenerate: false,
  lastGeneratedFor: "",
};

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Wait for a specific number of drafts to exist */
async function waitForDraftCount(projectPath: string, count: number): Promise<string[]> {
  return await waitFor(
    () => {
      const ids = getWorkspaceDraftIds(projectPath);
      if (ids.length !== count) {
        throw new Error(`Expected ${count} drafts, got ${ids.length}`);
      }
      return ids;
    },
    { timeout: 5_000 }
  );
}

function composerText(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value;
}

async function findProjectRow(container: HTMLElement, projectPath: string): Promise<HTMLElement> {
  return await waitFor(
    () => {
      const el = container.querySelector(`[data-project-path="${projectPath}"][aria-controls]`);
      if (!el) throw new Error("Project row not found");
      return el as HTMLElement;
    },
    { timeout: 5_000 }
  );
}

describeIntegration("Draft workspace behavior", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("clicking New Workspace reuses existing empty draft instead of creating another", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      const projectName = path.basename(normalizedProjectPath);

      // Click project row to open creation view (creates first draft)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      // Wait for creation textarea to appear
      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      // Verify first draft was created
      const [firstDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(firstDraftId).toBeTruthy();

      // Click "New Workspace" button - should reuse empty draft, not create new one
      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(`[aria-label="New chat in ${projectName}"]`);
          if (!btn) throw new Error(`New chat button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      // Verify still only 1 draft (reused the empty one)
      await waitFor(
        () => {
          const draftsAfterSecondClick = getWorkspaceDraftIds(normalizedProjectPath);
          expect(draftsAfterSecondClick.length).toBe(1);
          expect(draftsAfterSecondClick[0]).toBe(firstDraftId);
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("draft row is hidden in sidebar when empty", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);

      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      // A draft exists in storage for reuse, but no row appears in the sidebar.
      const [draftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(draftId).toBeTruthy();
      expect(view.container.querySelector("[data-draft-id]")).toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("the project row opens a non-empty default creation draft instead of a new draft", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });
    const createdScopes: DraftStoreScope[] = [];

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      const projectRow = await findProjectRow(view.container, normalizedProjectPath);

      // A listed draft with text, so the project row cannot reuse it.
      fireEvent.click(projectRow);
      const [listedDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      const listedScope: DraftStoreScope = {
        kind: "creation",
        projectPath: normalizedProjectPath,
        draftId: listedDraftId,
      };
      // Text typed on the bare project page (no draft id) lives in the default creation draft.
      const defaultScope = defaultCreationDraftScope(normalizedProjectPath);
      createdScopes.push(listedScope, defaultScope);
      getDraftStore().setText(listedScope, "listed draft text");
      getDraftStore().setText(defaultScope, "default draft text");
      await getDraftStore().flush(defaultScope);

      // Twice: a repeated click must land on the same draft, never add one.
      for (const _click of [1, 2]) {
        fireEvent.click(projectRow);
        // The project row must not hide the default draft behind a fresh empty composer.
        await waitFor(
          () => {
            const textarea = view.container.querySelector("textarea");
            expect(textarea?.value).toBe("default draft text");
          },
          { timeout: 5_000 }
        );
        expect(getWorkspaceDraftIds(normalizedProjectPath)).toEqual([listedDraftId]);
      }
    } finally {
      // Backend drafts outlive the persisted draft list: drop them so later tests start clean.
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("clicking New Chat before typing reuses hidden draft without showing duplicates", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      const projectName = path.basename(normalizedProjectPath);

      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(
            `[data-project-path="${normalizedProjectPath}"][aria-controls]`
          );
          if (!el) throw new Error("Project row not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      const [draftId] = await waitForDraftCount(normalizedProjectPath, 1);
      expect(draftId).toBeTruthy();
      expect(view.container.querySelector("[data-draft-id]")).toBeNull();

      const newChatButton = await waitFor(
        () => {
          const btn = view.container.querySelector(`[aria-label="New chat in ${projectName}"]`);
          if (!btn) throw new Error(`New chat button not found for ${projectName}`);
          return btn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(newChatButton);

      await waitFor(
        () => {
          expect(getWorkspaceDraftIds(normalizedProjectPath)).toEqual([draftId]);
          expect(view.container.querySelector("[data-draft-id]")).toBeNull();
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  test("hidden empty drafts are not counted or numbered (#5677)", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    const cleanupDom = setupTestDom();

    const view = renderApp({ apiClient: env.orpc });
    const createdScopes: DraftStoreScope[] = [];

    try {
      await view.waitForReady();
      const normalizedProjectPath = await addProjectViaUI(view, projectPath);
      // The draft list lives on the backend: clear drafts left by earlier tests.
      await clearWorkspaceDrafts(normalizedProjectPath);
      await clearWorkspaceDrafts(SCRATCH_PROJECT_CONFIG_KEY);
      const projectName = path.basename(normalizedProjectPath);

      // A project draft with text shows as draft 1.
      const projectRow = await findProjectRow(view.container, normalizedProjectPath);
      fireEvent.click(projectRow);
      const expandButton = view.container.querySelector(
        `[aria-label="Expand project ${projectName}"]`
      );
      if (expandButton) fireEvent.click(expandButton);
      const [typedDraftId] = await waitForDraftCount(normalizedProjectPath, 1);
      const typedScope: DraftStoreScope = {
        kind: "creation",
        projectPath: normalizedProjectPath,
        draftId: typedDraftId,
      };
      createdScopes.push(typedScope);
      getDraftStore().setText(typedScope, "typed draft text");
      await waitFor(
        () =>
          expect(view.container.querySelector(`[data-draft-id="${typedDraftId}"]`)).not.toBeNull(),
        { timeout: 5_000 }
      );
      const openLabel = () =>
        view.container
          .querySelector(`[data-draft-id="${typedDraftId}"][aria-label^="Open workspace draft"]`)
          ?.getAttribute("aria-label");
      expect(openLabel()).toBe("Open workspace draft 1");

      // A newer empty draft renders no row, so it must not push the typed draft to number 2.
      const newChatButton = view.container.querySelector<HTMLElement>(
        `[aria-label="New chat in ${projectName}"]`
      );
      if (!newChatButton) throw new Error(`New chat button not found for ${projectName}`);
      fireEvent.click(newChatButton);
      const draftIds = await waitForDraftCount(normalizedProjectPath, 2);
      for (const draftId of draftIds) {
        createdScopes.push({ kind: "creation", projectPath: normalizedProjectPath, draftId });
      }
      await waitFor(() => expect(openLabel()).toBe("Open workspace draft 1"), { timeout: 5_000 });
      expect(view.container.querySelectorAll('[aria-label^="Open workspace draft"]')).toHaveLength(
        1
      );

      // An empty scratch draft is hidden too: no "Chats (1)", and the placeholder stays.
      fireEvent.click(
        (await waitFor(
          () => {
            const btn = view.container.querySelector('[aria-label="New scratch chat"]');
            if (!btn) throw new Error("New scratch chat button not found");
            return btn;
          },
          { timeout: 5_000 }
        )) as HTMLElement
      );
      const [scratchDraftId] = await waitForDraftCount(SCRATCH_PROJECT_CONFIG_KEY, 1);
      createdScopes.push({
        kind: "creation",
        projectPath: SCRATCH_PROJECT_CONFIG_KEY,
        draftId: scratchDraftId,
      });
      await waitFor(
        () => {
          const header = view.container.querySelector(
            '[aria-label="Collapse scratch chats"]'
          )?.parentElement;
          expect(header?.textContent).toBe("Chats");
          expect(view.container.textContent).toContain("Start a scratch chat");
        },
        { timeout: 5_000 }
      );

      // Collapsed, the section mounts no draft rows; typing into the draft must still count it.
      fireEvent.click(
        view.container.querySelector<HTMLElement>('[aria-label="Collapse scratch chats"]')!
      );
      getDraftStore().setText(
        { kind: "creation", projectPath: SCRATCH_PROJECT_CONFIG_KEY, draftId: scratchDraftId },
        "scratch text"
      );
      await waitFor(
        () => {
          const header = view.container.querySelector(
            '[aria-label="Expand scratch chats"]'
          )?.parentElement;
          expect(header?.textContent).toBe("Chats(1)");
        },
        { timeout: 5_000 }
      );
    } finally {
      // Backend drafts outlive the persisted draft list: drop them so later tests start clean.
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);

  /**
   * Opens the app with a project that has a sub-project and a filled default draft, and no listed
   * draft: the sub-project's "new chat" lists a draft without opening the default one, so the
   * default draft is promoted into the first listed draft.
   */
  async function openPromotion(subProjectDir: string) {
    const env = getSharedEnv();
    const cleanupDom = setupTestDom();
    const view = renderApp({ apiClient: env.orpc });
    await view.waitForReady();
    const projectPath = await addProjectViaUI(view, getSharedRepoPath());
    await clearWorkspaceDrafts(projectPath);
    const created = await env.orpc.projects.create({ projectPath: subProjectDir });
    if (!created.success) throw new Error(created.error);
    const subProjectPath = created.data.normalizedPath;
    const expandLabel = `Expand project ${path.basename(projectPath)}`;
    await waitFor(
      () => {
        const expand = view.container.querySelector<HTMLElement>(`[aria-label="${expandLabel}"]`);
        if (expand) fireEvent.click(expand);
        if (!view.container.querySelector('[aria-label="New chat in sub-project"]')) {
          throw new Error("Sub-project section not shown");
        }
      },
      { timeout: 10_000 }
    );
    const newSubProjectChat = await waitFor(
      () => {
        const button = view.container.querySelector<HTMLElement>(
          '[aria-label="New chat in sub-project"]'
        );
        if (!button) throw new Error("Sub-project new chat button not found");
        return button;
      },
      { timeout: 10_000 }
    );
    const defaultScope: DraftScope = {
      kind: "creation",
      projectPath,
      draftId: DEFAULT_CREATION_DRAFT_ID,
    };
    getDraftStore().setText(defaultScope, "typed on the project page");
    getDraftStore().setAttachments(defaultScope, [IMAGE]);
    getDraftStore().setNameState(defaultScope, NAME_STATE);
    await getDraftStore().flush(defaultScope);
    return { env, view, cleanupDom, projectPath, subProjectPath, newSubProjectChat, defaultScope };
  }

  test("promoting the default draft into a listed draft keeps its text, attachments and name", async () => {
    const subProjectDir = path.join(getSharedRepoPath(), `promote-sub-${Date.now()}`);
    await fs.mkdir(subProjectDir, { recursive: true });
    const opened = await openPromotion(subProjectDir);
    const { env, view, cleanupDom, projectPath, subProjectPath, defaultScope } = opened;
    const createdScopes: DraftScope[] = [defaultScope];

    try {
      const updates = jest.spyOn(env.services.draftService, "update");
      const listPuts = jest.spyOn(env.services.draftService, "putListEntry");
      fireEvent.click(opened.newSubProjectChat);
      const [draftId] = await waitForDraftCount(projectPath, 1);
      const listedScope: DraftScope = { kind: "creation", projectPath, draftId };
      createdScopes.push(listedScope);
      await waitFor(
        async () => {
          const moved = await env.orpc.drafts.get({ scope: listedScope });
          expect(moved).toMatchObject({
            text: "typed on the project page",
            attachments: [IMAGE],
            nameState: NAME_STATE,
          });
          const source = await env.orpc.drafts.get({ scope: defaultScope });
          expect(source.text).toBe("");
          expect(source.nameState).toBeUndefined();
          const { entries } = await env.orpc.drafts.getList();
          expect(entries.find((entry) => entry.draftId === draftId)?.subProjectPath).toBe(
            subProjectPath
          );
        },
        { timeout: 10_000 }
      );
      await waitFor(() => expect(composerText(view.container)).toBe("typed on the project page"), {
        timeout: 10_000,
      });
      // One backend step moved the body and listed the row: no write or put of its own.
      const isListed = (scope: DraftScope) =>
        scope.kind === "creation" && scope.draftId === draftId;
      expect(updates.mock.calls.filter(([input]) => isListed(input.scope))).toEqual([]);
      expect(listPuts.mock.calls.filter(([entry]) => entry.draftId === draftId)).toEqual([]);
      updates.mockRestore();
      listPuts.mockRestore();
    } finally {
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await env.orpc.projects.remove({ projectPath: subProjectPath });
      await cleanupView(view, cleanupDom);
      await fs.rm(subProjectDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("the default composer takes no input while its draft is promoted", async () => {
    const subProjectDir = path.join(getSharedRepoPath(), `promote-lock-sub-${Date.now()}`);
    await fs.mkdir(subProjectDir, { recursive: true });
    const opened = await openPromotion(subProjectDir);
    const { env, view, cleanupDom, projectPath, defaultScope } = opened;
    const createdScopes: DraftScope[] = [defaultScope];
    const draftService = env.services.draftService;
    const moveCreation = draftService.moveCreation.bind(draftService);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const moveSpy = jest
      .spyOn(draftService, "moveCreation")
      .mockImplementation(async (...args: Parameters<typeof moveCreation>) => {
        await held;
        return await moveCreation(...args);
      });

    try {
      await waitFor(() => expect(composerText(view.container)).toBe("typed on the project page"), {
        timeout: 10_000,
      });
      fireEvent.click(opened.newSubProjectChat);
      await waitFor(() => expect(moveSpy).toHaveBeenCalled(), { timeout: 10_000 });
      // An edit made now would miss the moved body, and the moved draft would open without it.
      const textarea = await waitFor(
        () => {
          const locked = view.container.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Message"]'
          );
          expect(locked?.disabled).toBe(true);
          expect(view.container.querySelector<HTMLInputElement>("#workspace-name")?.disabled).toBe(
            true
          );
          return locked!;
        },
        { timeout: 10_000 }
      );
      // A dropped file is not read: the read would land in the default draft after the move.
      const reads = jest.spyOn(attachmentsHandling, "processAttachmentFiles");
      fireEvent.drop(textarea, {
        dataTransfer: { files: [new File(["x"], "note.txt", { type: "text/plain" })], types: [] },
      });
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      release();
      const [draftId] = await waitForDraftCount(projectPath, 1);
      const listedScope: DraftScope = { kind: "creation", projectPath, draftId };
      createdScopes.push(listedScope);
      await waitFor(() => expect(composerText(view.container)).toBe("typed on the project page"), {
        timeout: 10_000,
      });
      expect(await env.orpc.drafts.get({ scope: listedScope })).toMatchObject({
        text: "typed on the project page",
        attachments: [IMAGE],
        nameState: NAME_STATE,
      });
      const source = await env.orpc.drafts.get({ scope: defaultScope });
      expect(source.text).toBe("");
      expect(source.nameState).toBeUndefined();
      expect((await env.orpc.drafts.getList()).entries.map((entry) => entry.draftId)).toEqual([
        draftId,
      ]);
    } finally {
      release();
      moveSpy.mockRestore();
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await env.orpc.projects.remove({ projectPath: opened.subProjectPath });
      await cleanupView(view, cleanupDom);
      await fs.rm(subProjectDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("the default composer keeps showing its draft until the promoted draft opens", async () => {
    const subProjectDir = path.join(getSharedRepoPath(), `promote-shown-sub-${Date.now()}`);
    await fs.mkdir(subProjectDir, { recursive: true });
    const opened = await openPromotion(subProjectDir);
    const { env, view, cleanupDom, projectPath, defaultScope } = opened;
    const createdScopes: DraftScope[] = [defaultScope];
    const draftService = env.services.draftService;
    const moveCreation = draftService.moveCreation.bind(draftService);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The backend moves the draft (and pushes the source's deletion and the new row) before its
    // reply, which is held.
    const moveSpy = jest
      .spyOn(draftService, "moveCreation")
      .mockImplementation(async (...args: Parameters<typeof moveCreation>) => {
        const reply = await moveCreation(...args);
        await held;
        return reply;
      });
    const nameInput = () => view.container.querySelector<HTMLInputElement>("#workspace-name");
    // Every task boundary is a chance to paint: the composer must never show an empty draft. A
    // message channel samples between tasks, as a browser paints (timers come too late).
    const shown: (string | undefined)[] = [];
    const sampler = new MessageChannel();
    let polling = true;
    sampler.port1.onmessage = () => {
      shown.push(composerText(view.container));
      if (polling) sampler.port2.postMessage(null);
    };

    try {
      await waitFor(() => expect(composerText(view.container)).toBe("typed on the project page"), {
        timeout: 10_000,
      });
      sampler.port2.postMessage(null);
      fireEvent.click(opened.newSubProjectChat);
      const [draftId] = await waitForDraftCount(projectPath, 1);
      const listedScope: DraftScope = { kind: "creation", projectPath, draftId };
      createdScopes.push(listedScope);
      await waitFor(
        async () => {
          expect(moveSpy).toHaveBeenCalled();
          expect((await env.orpc.drafts.get({ scope: defaultScope })).text).toBe("");
        },
        { timeout: 10_000 }
      );
      // The pushes have arrived; the composer still shows the draft it moves.
      expect(composerText(view.container)).toBe("typed on the project page");
      expect(nameInput()?.value).toBe(NAME_STATE.manualName);
      release();
      await waitFor(
        () => {
          // The default draft shows empty again, so the composer showing the text is the listed one.
          expect(getDraftStore().getView(defaultScope).text).toBe("");
          expect(composerText(view.container)).toBe("typed on the project page");
        },
        { timeout: 10_000 }
      );
      polling = false;
      expect(shown.filter((text) => text !== "typed on the project page")).toEqual([]);
      expect(await env.orpc.drafts.get({ scope: listedScope })).toMatchObject({
        text: "typed on the project page",
        attachments: [IMAGE],
        nameState: NAME_STATE,
      });
      const source = await env.orpc.drafts.get({ scope: defaultScope });
      expect(source.text).toBe("");
      expect(source.nameState).toBeUndefined();
      expect((await env.orpc.drafts.getList()).entries.map((entry) => entry.draftId)).toEqual([
        draftId,
      ]);
    } finally {
      polling = false;
      sampler.port1.close();
      release();
      moveSpy.mockRestore();
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await env.orpc.projects.remove({ projectPath: opened.subProjectPath });
      await cleanupView(view, cleanupDom);
      await fs.rm(subProjectDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a failed promotion opens an empty listed draft and keeps the default draft", async () => {
    const subProjectDir = path.join(getSharedRepoPath(), `promote-fail-sub-${Date.now()}`);
    await fs.mkdir(subProjectDir, { recursive: true });
    const opened = await openPromotion(subProjectDir);
    const { env, view, cleanupDom, projectPath, defaultScope } = opened;
    const createdScopes: DraftScope[] = [defaultScope];
    const moveSpy = jest
      .spyOn(env.services.draftService, "moveCreation")
      .mockRejectedValue(new Error("move failed"));

    try {
      fireEvent.click(opened.newSubProjectChat);
      const [draftId] = await waitForDraftCount(projectPath, 1);
      createdScopes.push({ kind: "creation", projectPath, draftId });
      await waitFor(() => expect(moveSpy).toHaveBeenCalled(), { timeout: 10_000 });
      await waitFor(
        async () => {
          expect((await env.orpc.drafts.getList()).entries.map((entry) => entry.draftId)).toEqual([
            draftId,
          ]);
        },
        { timeout: 10_000 }
      );
      // The composer opened the new, empty draft; the default draft still holds what was typed.
      expect(composerText(view.container)).toBe("");
      expect(getDraftStore().getView(defaultScope).text).toBe("typed on the project page");
      expect(await env.orpc.drafts.get({ scope: defaultScope })).toMatchObject({
        text: "typed on the project page",
        nameState: NAME_STATE,
      });
    } finally {
      moveSpy.mockRestore();
      await Promise.all(createdScopes.map((scope) => getDraftStore().deleteDraft(scope)));
      await env.orpc.projects.remove({ projectPath: opened.subProjectPath });
      await cleanupView(view, cleanupDom);
      await fs.rm(subProjectDir, { recursive: true, force: true });
    }
  }, 60_000);
});
