/**
 * #6033: a creation composer must not send before the project's branch list has loaded. Until it
 * loads the trunk branch is empty, and the backend refuses every runtime except local with
 * "Trunk branch is required for worktree and SSH runtimes".
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

import { renderApp } from "../renderReviewPanel";
import {
  addProjectViaUI,
  cleanupView,
  openProjectCreationView,
  setupTestDom,
  waitForLatestDraftId,
} from "../helpers";
import { ChatHarness } from "../harness";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getAgentsInitNudgeKey, getDraftScopeId } from "@/common/constants/storage";
import type { DraftScope } from "@/common/orpc/schemas/drafts";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const TRUNK_REQUIRED = "Trunk branch is required";

function sendButton(container: HTMLElement): HTMLButtonElement {
  const textareas = container.querySelectorAll<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]'
  );
  const section = textareas[textareas.length - 1]?.closest('[data-component="ChatInputSection"]');
  const button = section?.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
  if (!button) throw new Error("Send button not found");
  return button;
}

async function selectRuntime(container: HTMLElement, label: string): Promise<void> {
  const trigger = container.querySelector<HTMLElement>(
    '[data-component="RuntimeTypeGroup"] button[aria-label="Workspace type"]'
  );
  if (!trigger) throw new Error("Workspace type trigger not found");
  fireEvent.click(trigger);
  const option = await waitFor(
    () => {
      const candidate = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (element) => element.textContent?.includes(label)
      );
      if (!candidate) throw new Error(`Runtime option '${label}' not found`);
      return candidate;
    },
    { timeout: 5_000 }
  );
  fireEvent.click(option);
}

/** Holds every listBranches call until release() so the creation view stays "branches loading". */
function holdBranchList(env: ReturnType<typeof getSharedEnv>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realListBranches = env.services.projectService.listBranches.bind(
    env.services.projectService
  );
  const spy = jest
    .spyOn(env.services.projectService, "listBranches")
    .mockImplementation(async (projectPath: string) => {
      await released;
      return realListBranches(projectPath);
    });
  return { spy, release };
}

/**
 * The app's API client, with projects.runtimeAvailability held until release(). The router calls
 * a module function for it, so the renderer's client is the seam (the backend has no service).
 */
function holdRuntimeAvailability(orpc: ReturnType<typeof getSharedEnv>["orpc"]) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const projects = new Proxy(orpc.projects, {
    get(target, key, receiver) {
      if (key !== "runtimeAvailability") return Reflect.get(target, key, receiver) as unknown;
      return async (...args: Parameters<typeof target.runtimeAvailability>) => {
        await released;
        return target.runtimeAvailability(...args);
      };
    },
  });
  const client = new Proxy(orpc, {
    get(target, key, receiver) {
      return key === "projects" ? projects : (Reflect.get(target, key, receiver) as unknown);
    },
  });
  return { client, release };
}

async function openCreationViewWithHeldBranches(options?: {
  showAgentsInitBanner?: boolean;
  apiClient?: ReturnType<typeof getSharedEnv>["orpc"];
}) {
  const env = getSharedEnv();
  const cleanupDom = setupTestDom();
  const view = renderApp({ apiClient: options?.apiClient ?? env.orpc });
  const projectPath = await addProjectViaUI(view, getSharedRepoPath());
  if (options?.showAgentsInitBanner) updatePersistedState(getAgentsInitNudgeKey(projectPath), true);
  // Held before the creation view mounts: its first listBranches call is the one that matters.
  const held = holdBranchList(env);
  await openProjectCreationView(view, projectPath);
  await waitFor(() => expect(held.spy).toHaveBeenCalled(), { timeout: 10_000 });
  const draftId = await waitForLatestDraftId(projectPath);
  const scope: DraftScope = { kind: "creation", projectPath, draftId };
  const chat = new ChatHarness(view.container, getDraftScopeId(projectPath, draftId), scope);
  const create = jest.spyOn(env.services.workspaceService, "create");
  return { env, view, cleanupDom, chat, held, create };
}

describeIntegration("creation composer while the branch list loads (#6033)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("a worktree workspace cannot be sent until the branches load, then it uses the loaded trunk", async () => {
    const { view, cleanupDom, chat, held, create } = await openCreationViewWithHeldBranches();
    try {
      await chat.typeWithoutSending("hello before branches load");

      // Send is refused while the branch list is pending: the button is disabled and Enter
      // creates nothing, so the backend never sees an empty trunk.
      await waitFor(() => expect(sendButton(view.container).disabled).toBe(true));
      const textarea = view.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]'
      )!;
      fireEvent.keyDown(textarea, { key: "Enter" });
      fireEvent.click(sendButton(view.container));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(create).not.toHaveBeenCalled();
      expect(view.container.textContent ?? "").not.toContain(TRUNK_REQUIRED);

      held.release();
      await waitFor(() => expect(sendButton(view.container).disabled).toBe(false), {
        timeout: 10_000,
      });
      fireEvent.click(sendButton(view.container));
      await waitFor(() => expect(create).toHaveBeenCalled(), { timeout: 30_000 });
      const trunkBranch = create.mock.calls[0]?.[2];
      expect(typeof trunkBranch === "string" && trunkBranch.length > 0).toBe(true);
      expect(view.container.textContent ?? "").not.toContain(TRUNK_REQUIRED);
    } finally {
      held.release();
      held.spy.mockRestore();
      create.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  // The ProjectPage "Run /init" banner sends through the composer's imperative send(), once.
  test("Run /init clicked while the branches load sends /init once they load", async () => {
    const { view, cleanupDom, held, create } = await openCreationViewWithHeldBranches({
      showAgentsInitBanner: true,
    });
    try {
      const runInit = await waitFor(
        () => {
          const button = view.container.querySelector<HTMLButtonElement>(
            '[data-testid="agents-init-run"]'
          );
          if (!button) throw new Error("Run /init banner not shown");
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(runInit);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(create).not.toHaveBeenCalled();
      expect(view.container.textContent ?? "").not.toContain(TRUNK_REQUIRED);

      held.release();
      await waitFor(() => expect(create).toHaveBeenCalled(), { timeout: 30_000 });
      const trunkBranch = create.mock.calls[0]?.[2];
      expect(typeof trunkBranch === "string" && trunkBranch.length > 0).toBe(true);
    } finally {
      held.release();
      held.spy.mockRestore();
      create.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("Run /init then an edit while the branches load sends nothing until the user presses Send", async () => {
    const { view, cleanupDom, chat, held, create } = await openCreationViewWithHeldBranches({
      showAgentsInitBanner: true,
    });
    try {
      const runInit = await waitFor(
        () => {
          const button = view.container.querySelector<HTMLButtonElement>(
            '[data-testid="agents-init-run"]'
          );
          if (!button) throw new Error("Run /init banner not shown");
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(runInit);
      await chat.expectInputValue("/init");
      await chat.typeWithoutSending("a prompt the user has not sent yet");

      held.release();
      await waitFor(() => expect(sendButton(view.container).disabled).toBe(false), {
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(create).not.toHaveBeenCalled();
      await chat.expectInputValue("a prompt the user has not sent yet");
    } finally {
      held.release();
      held.spy.mockRestore();
      create.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  // Runtime availability probes Docker, Podman and the devcontainer CLI with multi-second
  // timeouts. Send waits for the branch list only, not for that probe.
  test("a worktree workspace can be sent once the branches load, while the runtime probe is still pending", async () => {
    const availability = holdRuntimeAvailability(getSharedEnv().orpc);
    const { view, cleanupDom, chat, held, create } = await openCreationViewWithHeldBranches({
      apiClient: availability.client,
    });
    try {
      await chat.typeWithoutSending("hello before the runtime probe finishes");
      await waitFor(() => expect(sendButton(view.container).disabled).toBe(true));

      held.release();
      await waitFor(() => expect(sendButton(view.container).disabled).toBe(false), {
        timeout: 10_000,
      });
      fireEvent.click(sendButton(view.container));
      await waitFor(() => expect(create).toHaveBeenCalled(), { timeout: 30_000 });
      const trunkBranch = create.mock.calls[0]?.[2];
      expect(typeof trunkBranch === "string" && trunkBranch.length > 0).toBe(true);
    } finally {
      availability.release();
      held.release();
      held.spy.mockRestore();
      create.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);

  test("a local workspace can be sent while the branches are still loading", async () => {
    const { view, cleanupDom, chat, held, create } = await openCreationViewWithHeldBranches();
    try {
      await selectRuntime(view.container, "Local");
      await chat.typeWithoutSending("hello on the local runtime");
      await waitFor(() => expect(sendButton(view.container).disabled).toBe(false), {
        timeout: 10_000,
      });
      fireEvent.click(sendButton(view.container));
      await waitFor(() => expect(create).toHaveBeenCalled(), { timeout: 30_000 });
      expect(held.spy.mock.results.length).toBeGreaterThan(0);
    } finally {
      held.release();
      held.spy.mockRestore();
      create.mockRestore();
      await cleanupView(view, cleanupDom);
    }
  }, 90_000);
});
