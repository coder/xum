/**
 * The creation header's project selector moves the draft being edited to the chosen project,
 * sub-project or Scratch, instead of opening the destination's own draft.
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";
import * as fs from "node:fs/promises";
import * as os from "node:os";
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
import { readScopeAgentId, writeScopedAiDefault } from "@/browser/utils/scopedAiDefaults";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import {
  getDraftScopeId,
  getPendingScopeId,
  getProjectScopeId,
  getWorkspaceNameStateKey,
} from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getProjectRouteId } from "@/common/utils/projectRouteId";

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

function projectSelector(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-testid="project-selector"]');
}

function projectSelectorLabel(container: HTMLElement): string | undefined {
  return projectSelector(container)?.textContent?.trim();
}

function runtimeSelector(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-component="RuntimeTypeGroup"] button[aria-label="Workspace type"]'
  );
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
    const element = projectSelector(container);
    if (!element) throw new Error("Project selector not found");
    return element;
  }, WAIT);
  await pickOption(trigger, label);
  await waitFor(() => expect(projectSelectorLabel(container)).toBe(label), WAIT);
}

async function pickAgent(container: HTMLElement, projectPath: string, agentId: string) {
  fireEvent.click(container.querySelector<HTMLElement>('[aria-label="Select agent"]')!);
  fireEvent.click(
    await waitFor(() => {
      const row = container.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`);
      if (!row) throw new Error(`Agent row ${agentId} not found`);
      return row;
    }, WAIT)
  );
  await waitFor(() => expect(readScopeAgentId(getProjectScopeId(projectPath))).toBe(agentId), WAIT);
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

type OrpcClient = ReturnType<typeof getSharedEnv>["orpc"];

/**
 * The app's API client, with nameGeneration.generate held until release(). Holding the client
 * call (not a backend service) lets allAnswered() resolve only after the composer that made a
 * request has handled its answer: its await runs before the test's.
 */
function holdNameGeneration(orpc: OrpcClient) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answered: Promise<unknown>[] = [];
  const nameGeneration = new Proxy(orpc.nameGeneration, {
    get(target, key, receiver) {
      if (key !== "generate") return Reflect.get(target, key, receiver) as unknown;
      return (...args: Parameters<typeof target.generate>) => {
        const call = released.then(() => target.generate(...args));
        answered.push(call);
        return call;
      };
    },
  });
  const client = new Proxy(orpc, {
    get(target, key, receiver) {
      return key === "nameGeneration"
        ? nameGeneration
        : (Reflect.get(target, key, receiver) as unknown);
    },
  });
  return {
    client,
    release,
    calls: () => answered.length,
    allAnswered: () => Promise.allSettled(answered),
  };
}

/**
 * The app's API client, recording agents.list calls so a test can wait until every answer was
 * handled (as in holdNameGeneration, the caller's await runs before the test's). holdNext() holds
 * the next call until release(): a move lists the destination's agents before navigating, so the
 * next call after holdNext() and a move is the move's, not the destination composer's.
 */
function trackAgentLists(orpc: OrpcClient) {
  const calls: Promise<unknown>[] = [];
  let hold: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const agents = new Proxy(orpc.agents, {
    get(target, key, receiver) {
      if (key !== "list") return Reflect.get(target, key, receiver) as unknown;
      return (...args: Parameters<typeof target.list>) => {
        const gate = hold ?? Promise.resolve();
        hold = null;
        const call = gate.then(() => target.list(...args));
        calls.push(call);
        return call;
      };
    },
  });
  const client = new Proxy(orpc, {
    get(target, key, receiver) {
      return key === "agents" ? agents : (Reflect.get(target, key, receiver) as unknown);
    },
  });
  return {
    client,
    holdNext: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
    /** Every call answered and handled (a macrotask runs after the callers' continuations). */
    allHandled: async () => {
      await Promise.allSettled(calls);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/**
 * Picks A's own agent in-both and starts moving A's draft to B, whose agent differs (exec), with
 * the move's agents.list request for B held until agentLists.release().
 */
async function startHeldAgentMove(
  container: HTMLElement,
  agentLists: ReturnType<typeof trackAgentLists>,
  a: string,
  b: string
): Promise<void> {
  writeScopedAiDefault(getProjectScopeId(b), "agentId", "exec");
  await pickAgent(container, a, "in-both");
  agentLists.holdNext();
  await pickOption(projectSelector(container)!, path.basename(b));
  // The selector stays locked while the move waits.
  await waitFor(() => expect(projectSelector(container)?.disabled).toBe(true), WAIT);
}

async function writeAgent(projectPath: string, agentId: string): Promise<string> {
  const file = path.join(projectPath, ".xum", "agents", `${agentId}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\nname: ${agentId}\nbase: exec\n---\n\nA test agent.\n`);
  return file;
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

  async function openTwoProjects(
    apiClient: OrpcClient = getSharedEnv().orpc,
    /** The address bar's route, where the app starts. */
    route?: string
  ): Promise<{
    view: RenderedApp;
    cleanupDom: () => void;
    a: string;
    b: string;
  }> {
    const cleanupDom = setupTestDom();
    if (route != null) window.history.replaceState(null, "", route);
    const view = renderApp({ apiClient });
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

      await pickAgent(container, a, "plan");
      // The model selector's creation path; an explicit pick leaves model Auto.
      setWorkspaceModelWithOrigin(getProjectScopeId(a), KNOWN_MODELS.HAIKU.id, "user");
      // The destination's own Auto pick must not survive the move.
      setAutoRoutingPick(getProjectScopeId(b), "plan", "model", true);
      await pickOption(
        runtimeSelector(container)!,
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
        expect(runtimeSelector(container)?.textContent).toContain("Local");
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
    // The source composer's name request settles after the move.
    const naming = holdNameGeneration(getSharedEnv().orpc);
    const { view, cleanupDom, a, b } = await openTwoProjects(naming.client);
    const { container } = view;
    try {
      // The project row opens a non-empty default draft (the bare project page).
      getDraftStore().setText(defaultCreationDraftScope(a), "default text");
      await getDraftStore().flush(defaultCreationDraftScope(a));
      await openProjectCreationView(view, a);
      await waitFor(() => expect(textareaValue(container)).toBe("default text"), WAIT);
      await waitFor(() => expect(naming.calls()).toBeGreaterThan(0), WAIT);

      await moveDraftTo(container, path.basename(b));

      await onlyDraftId(b);
      await waitFor(() => expect(textareaValue(container)).toBe("default text"), WAIT);
      naming.release();
      await naming.allAnswered();
      await waitFor(
        () => expect(getDraftStore().getView(defaultCreationDraftScope(a)).text).toBe(""),
        WAIT
      );
      expect(getWorkspaceDraftIds(a)).toEqual([]);
      // No workspace name is left behind either: it would keep A's bare page non-empty.
      await waitFor(
        () =>
          expect(
            readPersistedState(getWorkspaceNameStateKey(getPendingScopeId(a)), null)
          ).toBeNull(),
        WAIT
      );
    } finally {
      naming.release();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("an empty listed draft moves with its settings and leaves no row behind", async () => {
    const { view, cleanupDom, a, b } = await openTwoProjects();
    try {
      await openProjectCreationView(view, a);
      await onlyDraftId(a);
      setWorkspaceModelWithOrigin(getProjectScopeId(a), KNOWN_MODELS.HAIKU.id, "user");

      await moveDraftTo(view.container, path.basename(b));

      await onlyDraftId(b);
      // An empty source has nothing to move, but its row must not stay behind.
      await waitForDraftIds(a, []);
      expect(getWorkspaceAiSelection(getProjectScopeId(b)).model).toBe(KNOWN_MODELS.HAIKU.id);
    } finally {
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

  test("the project selector is disabled while a creation send is in flight", async () => {
    // A send first waits for the workspace name, so a held name request keeps it in flight.
    // Never released: the send must not go on to create a workspace.
    const naming = holdNameGeneration(getSharedEnv().orpc);
    const { view, cleanupDom, a } = await openTwoProjects(naming.client);
    const { container } = view;
    try {
      await openProjectCreationView(view, a);
      const draftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, draftId), "send me");
      await waitFor(() => expect(naming.calls()).toBeGreaterThan(0), WAIT);
      expect(projectSelector(container)?.disabled).toBe(false);

      fireEvent.click(container.querySelector<HTMLElement>('button[aria-label="Send message"]')!);

      await waitFor(() => expect(projectSelector(container)?.disabled).toBe(true), WAIT);
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("the project selector is disabled while an attached file is read", async () => {
    const { view, cleanupDom, a } = await openTwoProjects();
    const { container } = view;
    let releaseFile!: () => void;
    const fileRead = new Promise<void>((resolve) => {
      releaseFile = resolve;
    });
    try {
      await openProjectCreationView(view, a);
      const draftId = await onlyDraftId(a);
      // Not a provider type: the creation composer reads its bytes into a pending file.
      const file = new File(["held"], "held.bin", { type: "application/octet-stream" });
      Object.defineProperty(file, "arrayBuffer", {
        value: () => fileRead.then(() => new TextEncoder().encode("held").buffer),
      });
      expect(projectSelector(container)?.disabled).toBe(false);

      fireEvent.change(
        container.querySelector<HTMLInputElement>(
          '[data-component="InputMethodGroup"] input[type="file"]'
        )!,
        { target: { files: [file] } }
      );

      // The read file is added to the draft the composer showed when it was attached.
      await waitFor(() => expect(projectSelector(container)?.disabled).toBe(true), WAIT);
      releaseFile();
      await waitFor(() => {
        expect(projectSelector(container)?.disabled).toBe(false);
        expect(
          getDraftStore()
            .getView(creationScope(a, draftId))
            .attachments.map(({ filename }) => filename)
        ).toEqual(["held.bin"]);
      }, WAIT);
    } finally {
      releaseFile();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("the project selector is disabled while the draft's attachments load", async () => {
    const { view, cleanupDom, a } = await openTwoProjects();
    const { container } = view;
    const draftService = getSharedEnv().services.draftService;
    const realGet = draftService.get.bind(draftService);
    let releasePayloads!: () => void;
    const payloadGate = new Promise<void>((resolve) => {
      releasePayloads = resolve;
    });
    const getSpy = jest.spyOn(draftService, "get").mockImplementation(async (scope) => {
      await payloadGate;
      return realGet(scope);
    });
    try {
      await openProjectCreationView(view, a);
      const draftId = await onlyDraftId(a);
      // Another window attaches a file: this one gets its metadata and then loads its payload.
      await getSharedEnv().orpc.drafts.update({
        scope: creationScope(a, draftId),
        text: "attachments load later",
        attachments: [ATTACHMENT],
      });
      await waitFor(() => {
        expect(getDraftStore().getView(creationScope(a, draftId))).toMatchObject({
          attachmentCount: 1,
          payloadsLoaded: false,
        });
        expect(getSpy).toHaveBeenCalled();
      }, WAIT);

      // A move now would copy the text at once and the attachments only once they load.
      await waitFor(() => expect(projectSelector(container)?.disabled).toBe(true), WAIT);
      releasePayloads();
      await waitFor(() => expect(projectSelector(container)?.disabled).toBe(false), WAIT);
    } finally {
      releasePayloads();
      getSpy.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("a runtime the composer fell back to on its own does not move with the draft", async () => {
    // Not a git repository: the composer switches from the default Worktree to Local.
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-move-plain-"));
    const created = await getSharedEnv().orpc.projects.create({ projectPath: plainDir });
    if (!created.success) throw new Error(`Failed to add the plain project: ${created.error}`);
    const plain = created.data.normalizedPath;
    await trustProject(getSharedEnv(), plain);
    const { view, cleanupDom, b } = await openTwoProjects();
    const { container } = view;
    try {
      await openProjectCreationView(view, plain);
      await waitFor(() => expect(runtimeSelector(container)?.textContent).toContain("Local"), WAIT);

      await moveDraftTo(container, path.basename(b));

      await waitFor(
        () => expect(runtimeSelector(container)?.textContent).toContain("Worktree"),
        WAIT
      );
    } finally {
      await cleanupView(view, cleanupDom);
      await getSharedEnv().orpc.projects.remove({ projectPath: plain });
      await fs.rm(plainDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("a project's own agent moves only to a project that has it", async () => {
    const a = getSharedRepoPath();
    const agentFiles = [
      await writeAgent(a, "in-both"),
      await writeAgent(projectB, "in-both"),
      await writeAgent(a, "only-in-a"),
    ];
    const agentLists = trackAgentLists(getSharedEnv().orpc);
    const { view, cleanupDom, b } = await openTwoProjects(agentLists.client);
    const { container } = view;
    try {
      // B's composer was not opened: the move loads B's agents itself.
      await openProjectCreationView(view, a);
      await pickAgent(container, a, "in-both");
      await moveDraftTo(container, path.basename(b));
      await waitFor(() => expect(readScopeAgentId(getProjectScopeId(b))).toBe("in-both"), WAIT);

      await openProjectCreationView(view, a);
      await pickAgent(container, a, "only-in-a");
      await moveDraftTo(container, path.basename(b));
      await agentLists.allHandled();

      // B keeps its own agent: B's composer would show only-in-a while a send ran exec.
      expect(readScopeAgentId(getProjectScopeId(b))).toBe("in-both");
    } finally {
      await cleanupView(view, cleanupDom);
      await Promise.all(agentFiles.map((file) => fs.rm(file, { force: true })));
    }
  }, 90_000);

  test("the move opens the destination only once its agents loaded", async () => {
    const a = getSharedRepoPath();
    const agentFiles = [await writeAgent(a, "in-both"), await writeAgent(projectB, "in-both")];
    const agentLists = trackAgentLists(getSharedEnv().orpc);
    const { view, cleanupDom, b } = await openTwoProjects(agentLists.client);
    const { container } = view;
    try {
      await openProjectCreationView(view, a);
      await startHeldAgentMove(container, agentLists, a, b);

      // B open before its agents arrived would show its own agent, and a send there would run it.
      expect(projectSelectorLabel(container)).toBe(path.basename(a));
      agentLists.release();
      await waitFor(() => expect(projectSelectorLabel(container)).toBe(path.basename(b)), WAIT);
      expect(readScopeAgentId(getProjectScopeId(b))).toBe("in-both");
    } finally {
      agentLists.release();
      await cleanupView(view, cleanupDom);
      await Promise.all(agentFiles.map((file) => fs.rm(file, { force: true })));
    }
  }, 90_000);

  test("a send while the move waits for the agents keeps the draft in its project", async () => {
    const a = getSharedRepoPath();
    const agentFiles = [await writeAgent(a, "in-both"), await writeAgent(projectB, "in-both")];
    // A send first waits for the workspace name, so a held name request keeps it in flight.
    // Never released: the send must not go on to create a workspace.
    const naming = holdNameGeneration(getSharedEnv().orpc);
    const agentLists = trackAgentLists(naming.client);
    const { view, cleanupDom, b } = await openTwoProjects(agentLists.client);
    const { container } = view;
    try {
      await openProjectCreationView(view, a);
      const draftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, draftId), "send me");
      await waitFor(() => expect(naming.calls()).toBeGreaterThan(0), WAIT);
      await startHeldAgentMove(container, agentLists, a, b);
      expect(runtimeSelector(container)?.hasAttribute("disabled")).toBe(false);

      fireEvent.click(container.querySelector<HTMLElement>('button[aria-label="Send message"]')!);
      // The creation controls lock once the send is in flight.
      await waitFor(
        () => expect(runtimeSelector(container)?.hasAttribute("disabled")).toBe(true),
        WAIT
      );
      agentLists.release();
      await agentLists.allHandled();

      expect(projectSelectorLabel(container)).toBe(path.basename(a));
      expect(getWorkspaceDraftIds(b)).toEqual([]);
    } finally {
      agentLists.release();
      await cleanupView(view, cleanupDom);
      await Promise.all(agentFiles.map((file) => fs.rm(file, { force: true })));
    }
  }, 90_000);

  test("a move that waits for the agents stays put once the user left the draft", async () => {
    const a = getSharedRepoPath();
    const agentFiles = [await writeAgent(a, "in-both"), await writeAgent(projectB, "in-both")];
    const agentLists = trackAgentLists(getSharedEnv().orpc);
    const { view, cleanupDom, b } = await openTwoProjects(agentLists.client);
    const { container } = view;
    try {
      await openProjectCreationView(view, a);
      const draftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, draftId), "left behind");
      await startHeldAgentMove(container, agentLists, a, b);

      // The user opens B's own new draft: the move must not open its copy in place of it.
      await openProjectCreationView(view, b);
      const ownDraftId = await onlyDraftId(b);
      agentLists.release();
      await agentLists.allHandled();

      expect(textareaValue(container)).toBe("");
      expect(getWorkspaceDraftIds(b)).toEqual([ownDraftId]);
      expect(getWorkspaceDraftIds(a)).toEqual([draftId]);
    } finally {
      agentLists.release();
      await cleanupView(view, cleanupDom);
      await Promise.all(agentFiles.map((file) => fs.rm(file, { force: true })));
    }
  }, 90_000);

  test("a move that keeps its source keeps the source's workspace name", async () => {
    const { view, cleanupDom, a, b } = await openTwoProjects();
    const { container } = view;
    const draftService = getSharedEnv().services.draftService;
    const realUpdate = draftService.update.bind(draftService);
    // The destination's save fails, so the move keeps the source draft.
    const updateSpy = jest
      .spyOn(draftService, "update")
      .mockImplementation((input, acceptance) =>
        input.scope.kind === "creation" && input.scope.projectPath === b
          ? Promise.reject(new Error("destination save failed"))
          : realUpdate(input, acceptance)
      );
    const moveSpy = jest.spyOn(getDraftStore(), "moveDraft");
    try {
      await openProjectCreationView(view, a);
      const sourceDraftId = await onlyDraftId(a);
      getDraftStore().setText(creationScope(a, sourceDraftId), "kept");
      const nameInput = container.querySelector<HTMLInputElement>("#workspace-name")!;
      fireEvent.focus(nameInput);
      fireEvent.change(nameInput, { target: { value: "kept-name" } });
      await waitFor(() => expect(nameInput.value).toBe("kept-name"), WAIT);

      await moveDraftTo(container, path.basename(b));

      expect(await moveSpy.mock.results[0]?.value).toBe(false);
      expect(getWorkspaceDraftIds(a)).toEqual([sourceDraftId]);
      expect(
        readPersistedState(getWorkspaceNameStateKey(getDraftScopeId(a, sourceDraftId)), null)
      ).toMatchObject({ manualName: "kept-name" });
    } finally {
      moveSpy.mockRestore();
      updateSpy.mockRestore();
      // Stops the destination's save retries.
      await clearWorkspaceDrafts(b);
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  // The composer edits the project's default draft for a blank or invalid draft id: the move must
  // take that draft, not look for a listed one with the route's id.
  test("a route with a blank draft id moves the project's default draft", async () => {
    const a = getSharedRepoPath();
    const { view, cleanupDom, b } = await openTwoProjects(
      getSharedEnv().orpc,
      `/project?project=${getProjectRouteId(a)}&draft=`
    );
    const { container } = view;
    try {
      const textarea = await waitFor(() => {
        const element = container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]'
        );
        if (!element) throw new Error("Composer not found");
        return element;
      }, WAIT);
      fireEvent.change(textarea, { target: { value: "typed on a blank draft route" } });
      await waitFor(
        () =>
          expect(getDraftStore().getView(defaultCreationDraftScope(a)).text).toBe(
            "typed on a blank draft route"
          ),
        WAIT
      );

      await moveDraftTo(container, path.basename(b));

      const movedId = await onlyDraftId(b);
      await waitFor(
        () =>
          expect(getDraftStore().getView(creationScope(b, movedId)).text).toBe(
            "typed on a blank draft route"
          ),
        WAIT
      );
      await waitFor(
        () => expect(getDraftStore().getView(defaultCreationDraftScope(a)).text).toBe(""),
        WAIT
      );
    } finally {
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);
});
