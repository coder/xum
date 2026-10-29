import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { fireEvent, waitFor } from "@testing-library/react";

import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { detectDefaultTrunkBranch } from "@/node/git";
import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

const LOAD_TOLERANT_WAIT = { timeout: 30_000 };
const DUPLICATE_KEY_WARNING = "Encountered two children with the same key";

const queuedBanners = (app: AppHarness) =>
  app.view.container.querySelectorAll('[data-component="QueuedMessageBanner"]');
const dockDecorationStacks = (app: AppHarness) =>
  app.view.container.querySelectorAll(
    '[data-testid="chat-composer-dock"] [data-component="ChatInputDecorationStack"]'
  );

/** Show a workspace the way the sidebar does and wait until its chat is the mounted one. */
async function showWorkspace(harness: AppHarness, workspaceId: string, name: string) {
  const row = await waitFor(
    () => {
      const el = harness.view.container.querySelector<HTMLElement>(
        `[data-workspace-id="${workspaceId}"]`
      );
      if (!el || el.getAttribute("aria-disabled") === "true") {
        throw new Error("Workspace row not selectable yet");
      }
      return el;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(row);
  workspaceStore.setActiveWorkspaceId(workspaceId);
  await waitFor(() => {
    expect(document.title.startsWith(name)).toBe(true);
    expect(harness.view.container.querySelector('[data-testid="message-window"]')).not.toBe(null);
  });
}

describe("Composer decorations across workspace switches", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("a workspace's queued message stays in its own composer dock after switching away and back", async () => {
    const app = await createAppHarness({ branchPrefix: "switch-decorations" });
    let otherWorkspaceId: string | undefined;
    const consoleErrorSpy = jest.spyOn(console, "error");
    try {
      // Hold a turn so the next composer send queues behind it.
      const holding = app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: "[mock:wait-start] hold the workspace busy",
        options: { model: "openai:gpt-5.2", agentId: "exec" },
      });
      const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
      await waitFor(() => expect(session.isBusy()).toBe(true), LOAD_TOLERANT_WAIT);
      await app.chat.send("queued follow-up");
      await waitFor(() => expect(queuedBanners(app)).toHaveLength(1), LOAD_TOLERANT_WAIT);

      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("switch-decorations-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      otherWorkspaceId = created.metadata.id;
      const otherName = created.metadata.name;
      workspaceStore.addWorkspace(created.metadata);

      // A -> B -> A -> B: the second switch to B is where the previous dock content leaked.
      await showWorkspace(app, otherWorkspaceId, otherName);
      await waitFor(() => expect(queuedBanners(app)).toHaveLength(0), LOAD_TOLERANT_WAIT);
      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await waitFor(() => expect(queuedBanners(app)).toHaveLength(1), LOAD_TOLERANT_WAIT);
      await showWorkspace(app, otherWorkspaceId, otherName);
      await waitFor(() => expect(queuedBanners(app)).toHaveLength(0), LOAD_TOLERANT_WAIT);
      expect(dockDecorationStacks(app)).toHaveLength(1);

      // Keep the warning and the duplicated key only; the component stack runs to thousands of lines.
      const duplicateKeyErrors = consoleErrorSpy.mock.calls
        .filter((args) =>
          args.some((arg) => typeof arg === "string" && arg.includes(DUPLICATE_KEY_WARNING))
        )
        .map((args) => args.slice(0, 2));
      expect(duplicateKeyErrors).toEqual([]);

      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
      expect((await holding).success).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
      if (otherWorkspaceId != null) {
        await app.env.orpc.workspace
          .remove({ workspaceId: otherWorkspaceId, options: { force: true } })
          .catch((error: unknown) => console.warn("Removing the second workspace failed", error));
      }
      await app.dispose();
    }
  }, 90_000);
});
