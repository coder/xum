/**
 * #4448: Stop returns a queued message with a one-shot `restore-to-input` event, after the backend
 * has cleared the queue. A composer in edit mode drops that event, and nobody receives it while the
 * workspace's composer is not mounted. The backend therefore keeps the restored message as held
 * input ("Not sent" banner, Send/Discard) until a composer takes the restore and releases it. When
 * the composer is mounted and not editing, Stop behaves exactly as before: the message lands in the
 * composer and no banner ever shows.
 */
import "../dom";
jest.mock("lottie-react", () => ({
  __esModule: true,
  default: () => null,
}));
import { fireEvent, waitFor } from "@testing-library/react";

import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import { getDraftStore } from "@/browser/stores/DraftStore";
import { detectDefaultTrunkBranch } from "@/node/git";
import { generateBranchName } from "../../ipc/helpers";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness, type AppHarness } from "../harness";

/** Bound for waits behind a composer send (see heldQueuedMessage.test.ts). */
const LOAD_TOLERANT_WAIT = { timeout: 30_000 };
const INTERRUPTED_LABEL = "Not sent — interrupted before this ran";

const heldBanners = (app: AppHarness) =>
  [...app.view.container.querySelectorAll('[data-component="HeldInputBanner"]')] as HTMLElement[];
const heldSendButton = (app: AppHarness) =>
  app.view.container.querySelector<HTMLButtonElement>('button[aria-label="Send unsent message"]');

/** Hold the workspace busy, then queue a follow-up from the composer. */
async function queueComposerFollowUp(app: AppHarness, text: string) {
  const session = app.env.services.workspaceService.getOrCreateSession(app.workspaceId);
  // A just-completed turn may still be settling; the hold must start a turn, not queue behind it.
  await waitFor(() => expect(session.isBusy()).toBe(false), LOAD_TOLERANT_WAIT);
  // Held outside the composer: a composer send stays in flight until its stream starts.
  const holding = app.env.orpc.workspace.sendMessage({
    workspaceId: app.workspaceId,
    message: "[mock:wait-start] hold the workspace busy",
    options: { model: "openai:gpt-5.2", agentId: "exec" },
  });
  // After an earlier turn the hold can queue briefly behind its settling; wait until it is the
  // running (gated) turn, so only the follow-up below is queued.
  await waitFor(() => {
    expect(session.isBusy()).toBe(true);
    expect(session.hasQueuedMessages()).toBe(false);
  }, LOAD_TOLERANT_WAIT);
  await app.chat.send(text);
  await waitFor(() => expect(session.hasQueuedMessages()).toBe(true), LOAD_TOLERANT_WAIT);
  await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
  return { session, holding };
}

/** Stop from outside the composer (the Stop button, a keybind, CLI or API all land here). */
async function stop(app: AppHarness, holding: Promise<unknown>) {
  expect(
    (await app.env.orpc.workspace.interruptStream({ workspaceId: app.workspaceId })).success
  ).toBe(true);
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
  await holding;
}

/**
 * Show a workspace the way the sidebar does (the store then moves its single onChat
 * subscription there) and wait until its composer is the mounted one.
 */
async function showWorkspace(harness: AppHarness, workspaceId: string, name: string) {
  const row = await waitFor(
    () => {
      const el = harness.view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el || el.getAttribute("aria-disabled") === "true") {
        throw new Error("Workspace row not selectable yet");
      }
      return el as HTMLElement;
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

async function userRowsContaining(app: AppHarness, needle: string): Promise<string[]> {
  const history = await app.env.services
    .toORPCContext()
    .historyService.getHistoryFromLatestBoundary(app.workspaceId);
  if (!history.success) return [];
  return history.data
    .filter((message) => message.role === "user")
    .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
    .filter((text) => text.includes(needle));
}

describe("Stop keeps a restored queued message the composer cannot take (#4448)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("Stop while editing an older message leaves the edit alone and keeps the queued message as a banner that Send delivers once", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-held-edit" });
    try {
      await app.chat.send("first message");
      // expectStreamComplete alone can pass before the send's stream has even started.
      await waitFor(
        () => expect(app.view.container.textContent).toContain("Mock response"),
        LOAD_TOLERANT_WAIT
      );
      await app.chat.expectStreamComplete();
      const { session, holding } = await queueComposerFollowUp(app, "queued follow-up");

      // Edit the older message (the first Edit button is the oldest user message).
      const editButton = await waitFor(() => {
        const button = app.view.container.querySelector('button[aria-label="Edit"]');
        if (!button) throw new Error("Edit button not found");
        return button as HTMLElement;
      }, LOAD_TOLERANT_WAIT);
      fireEvent.click(editButton);
      const editTextarea = await waitFor(() => {
        const textarea = app.view.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Edit your last message"]'
        );
        if (!textarea) throw new Error("Edit textarea not found");
        return textarea;
      }, LOAD_TOLERANT_WAIT);
      await waitFor(() => expect(editTextarea.value).toBe("first message"));

      await stop(app, holding);

      await waitFor(() => expect(heldBanners(app)).toHaveLength(1), LOAD_TOLERANT_WAIT);
      expect(heldBanners(app)[0].textContent).toContain(INTERRUPTED_LABEL);
      expect(heldBanners(app)[0].textContent).toContain("queued follow-up");
      expect(editTextarea.value).toBe("first message");
      expect(session.getHeldInputs().map((held) => [held.reason, held.send.displayText])).toEqual([
        ["interrupted", "queued follow-up"],
      ]);

      // Leave edit mode, then send the held message: it is delivered exactly once.
      fireEvent.keyDown(editTextarea, { key: "Escape" });
      await app.chat.expectInputValue("", LOAD_TOLERANT_WAIT.timeout);
      const send = heldSendButton(app);
      if (!send) throw new Error("Send button not found");
      fireEvent.click(send);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(0), LOAD_TOLERANT_WAIT);
      await app.chat.expectStreamComplete();
      expect(await userRowsContaining(app, "queued follow-up")).toHaveLength(1);
      expect(session.getHeldInputs()).toHaveLength(0);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("Stop while another workspace is shown keeps the queued message; it shows as a banner on return and the composer is untouched", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-held-away" });
    try {
      const { session, holding } = await queueComposerFollowUp(app, "queued while away");
      const created = await app.env.orpc.workspace.create({
        projectPath: app.repoPath,
        branchName: generateBranchName("stop-held-away-other"),
        trunkBranch: await detectDefaultTrunkBranch(app.repoPath),
      });
      if (!created.success) throw new Error(created.error);
      workspaceStore.addWorkspace(created.metadata);
      await showWorkspace(app, created.metadata.id, created.metadata.name);

      // A Stop that no mounted composer can take (e.g. from the CLI, the API or VS Code).
      await stop(app, holding);
      expect(session.getHeldInputs().map((held) => [held.reason, held.send.displayText])).toEqual([
        ["interrupted", "queued while away"],
      ]);

      await showWorkspace(app, app.workspaceId, app.metadata.name);
      await waitFor(() => expect(heldBanners(app)).toHaveLength(1), LOAD_TOLERANT_WAIT);
      expect(heldBanners(app)[0].textContent).toContain(INTERRUPTED_LABEL);
      expect(heldBanners(app)[0].textContent).toContain("queued while away");
      expect(getDraftStore().getText({ kind: "workspace", workspaceId: app.workspaceId })).toBe("");
      expect(session.getHeldInputs()).toHaveLength(1);
    } finally {
      await app.dispose();
    }
  }, 120_000);

  test("Stop with the composer mounted and not editing restores into the composer as before, never shows a banner, and releases the backend copy", async () => {
    const app = await createAppHarness({ branchPrefix: "stop-held-normal" });
    const store = useWorkspaceStoreRaw();
    let mostVisibleHeldInputs = 0;
    const unsubscribe = store.subscribeKey(app.workspaceId, () => {
      mostVisibleHeldInputs = Math.max(
        mostVisibleHeldInputs,
        store.getWorkspaceState(app.workspaceId).heldInputs.length
      );
    });
    try {
      const { session, holding } = await queueComposerFollowUp(app, "queued follow-up");

      await stop(app, holding);

      await app.chat.expectInputValue("queued follow-up", LOAD_TOLERANT_WAIT.timeout);
      await waitFor(() => expect(session.getHeldInputs()).toHaveLength(0), LOAD_TOLERANT_WAIT);
      expect(heldBanners(app)).toHaveLength(0);
      // Not even for one state update: the composer took it before the held list arrived.
      expect(mostVisibleHeldInputs).toBe(0);
    } finally {
      unsubscribe();
      await app.dispose();
    }
  }, 120_000);
});
