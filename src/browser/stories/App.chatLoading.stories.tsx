import { wrapAsyncIterator } from "@orpc/shared";
import { expect, userEvent, waitFor, within } from "@storybook/test";
import type { WorkspaceActivitySnapshot, WorkspaceChatMessage } from "@/common/orpc/types";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createMockORPCClient } from "./mocks/orpc";
import { createAssistantMessage } from "./mocks/messages";
import type { ProjectConfig } from "@/common/types/project";
import { createWorkspace, groupWorkspacesByProject, STABLE_TIMESTAMP } from "./mocks/workspaces";
import {
  clearWorkspaceSelection,
  collapseLeftSidebar,
  collapseRightSidebar,
  expandLeftSidebar,
  expandProjects,
  selectWorkspace,
} from "./helpers/uiState";

export default { ...appMeta, title: "App/ChatLoading" };

async function checkPhoneViewport(context: Parameters<NonNullable<AppStory["play"]>>[0]) {
  // Check composed metadata and actual layout, not which spread syntax a story used.
  await expect(context.parameters).toMatchObject({
    pixel: { matrix: { viewports: expect.arrayContaining(["phone"]) } },
  });
  await waitFor(() =>
    expect(
      within(context.canvasElement).getByTestId("chat-loading-phone").getBoundingClientRect().width
    ).toBe(390)
  );
}

async function switchWorkspace(canvasElement: HTMLElement, workspaceId: string) {
  expandLeftSidebar();
  const row = await waitFor(async () => {
    const element = canvasElement.querySelector<HTMLElement>(
      '[data-workspace-id="' + workspaceId + '"][role="button"]'
    );
    await expect(element).not.toBeNull();
    return element!;
  });
  await userEvent.click(row);
  collapseLeftSidebar();
}

async function checkTranscriptLayout(canvasElement: HTMLElement, loading = true) {
  const canvas = within(canvasElement);
  await waitFor(async () => {
    const transcript = canvas.getByRole("log");
    await expect(transcript).toBeVisible();
    await expect(transcript).toHaveAttribute("aria-busy", String(loading));
    await expect(canvas.getByTestId("message-window")).toHaveAttribute(
      "data-loaded",
      String(!loading)
    );
    // Loading feedback must not reserve a gutter after hydration or cover compact tail rows.
    await expect(getComputedStyle(transcript).paddingBottom).toBe("0px");
    const replayStatus = canvas.queryByTestId("transcript-loading-status");
    if (loading && !canvas.queryByTestId("transcript-hydration-placeholder")) {
      await expect(replayStatus).toBeVisible();
      await expect(replayStatus).toHaveAttribute("role", "status");
      const statusRect = replayStatus!.getBoundingClientRect();
      const dockRect = canvas.getByTestId("chat-composer-dock").getBoundingClientRect();
      // Feedback lives inside the existing dock edge, never over the transcript tail.
      await expect(statusRect.top).toBe(dockRect.top);
      await expect(statusRect.height).toBeGreaterThan(0);
      await expect(statusRect.bottom).toBeLessThanOrEqual(dockRect.bottom);
    } else {
      await expect(replayStatus).toBeNull();
    }
    const composer = canvasElement.querySelector(
      '[data-component="ChatInputSurface"], [data-testid="chat-composer-dock"] [role="note"]'
    )!;
    const composerRect = composer.getBoundingClientRect();
    await expect(composerRect.left).toBeGreaterThanOrEqual(
      canvasElement.getBoundingClientRect().left
    );
    await expect(composerRect.right).toBeLessThanOrEqual(
      canvasElement.getBoundingClientRect().right
    );
  });
}

// Catch-up must not change dock height or move already-visible rows, including
// bottom-pinned transcripts whose scroll position follows content size changes.
async function finishReplayWithoutLayoutShift(
  canvasElement: HTMLElement,
  finishReplay: () => void
) {
  const canvas = within(canvasElement);
  const dock = canvas.getByTestId("chat-composer-dock");
  const message = canvas.getByText("Previously loaded response.");
  const scrollport = canvas.getByTestId("message-window");
  const before = {
    dockHeight: dock.getBoundingClientRect().height,
    messageTop: message.getBoundingClientRect().top,
    scrollHeight: scrollport.scrollHeight,
  };
  const tail = canvas.getByText("Compact tail reasoning.");
  await expect(tail).toBeVisible();
  await expect(tail.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    dock.getBoundingClientRect().top
  );
  finishReplay();
  await checkTranscriptLayout(canvasElement, false);
  // Let layout and the native scroll/resize observers process catch-up.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  await expect(dock.getBoundingClientRect().height).toBe(before.dockHeight);
  const replayedMessage = await canvas.findByText("Previously loaded response.");
  await expect(replayedMessage.getBoundingClientRect().top, "cached message position").toBe(
    before.messageTop
  );
  await expect(scrollport.scrollHeight).toBe(before.scrollHeight);
}

type ActivitySubscribe = ReturnType<
  typeof createMockORPCClient
>["workspace"]["activity"]["subscribe"];
interface ActivityEvent {
  type: "activity";
  workspaceId: string;
  activity: WorkspaceActivitySnapshot | null;
}

// Background activity snapshots (the always-on per-workspace subscription) queue through
// `emit` and stay deliverable until the store aborts; client swaps between stories must
// release the previous subscription, so the iterator also ends on abort.
function createActivityFeed(): {
  subscribe: ActivitySubscribe;
  emit: (workspaceId: string, activity: WorkspaceActivitySnapshot) => void;
} {
  const queued: ActivityEvent[] = [];
  let wake: (() => void) | null = null;
  const subscribe: ActivitySubscribe = (_input, options) => {
    async function* iterate() {
      while (!options?.signal?.aborted) {
        const next = queued.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
    }
    return Promise.resolve(wrapAsyncIterator(iterate(), {}));
  };
  return {
    subscribe,
    emit: (workspaceId, activity) => {
      queued.push({ type: "activity", workspaceId, activity });
      wake?.();
    },
  };
}

function createHydrationStory(workspaceId: string): AppStory {
  const workspace = createWorkspace({
    id: workspaceId,
    name: "loading-history",
    projectName: "xum",
  });
  const otherWorkspace = createWorkspace({
    id: workspaceId + "-other",
    name: "caught-up-history",
    projectName: "xum",
  });
  const monitorWorkspace = createWorkspace({
    id: workspaceId + "-monitor",
    name: "waiting-on-monitor",
    projectName: "xum",
  });
  const transcriptWorkspace = createWorkspace({
    id: workspaceId + "-transcript",
    name: "read-only-history",
    projectName: "xum",
    transcriptOnly: true,
  });
  const workspaces = [workspace, otherWorkspace, monitorWorkspace, transcriptWorkspace];
  // Exercise real bottom-pinning, not only a short transcript with spare space.
  const history = createAssistantMessage(
    "history",
    Array.from({ length: 20 }, (_, index) => `Earlier response paragraph ${index + 1}.`).join(
      "\n\n"
    ) + "\n\nPreviously loaded response.",
    { historySequence: 1 }
  );
  // A compact tail must remain clear of the dock without a permanent loading gutter.
  history.parts.push({ type: "reasoning", text: "Compact tail reasoning." });
  let emitChat: (event: WorkspaceChatMessage) => void;
  let emitActivity: ReturnType<typeof createActivityFeed>["emit"];
  let subscriptions = 0;
  let transcriptSubscriptions = 0;
  let emitTranscript: (event: WorkspaceChatMessage) => void;

  function setup() {
    subscriptions = 0;
    transcriptSubscriptions = 0;
    const activityFeed = createActivityFeed();
    emitActivity = activityFeed.emit;
    selectWorkspace(workspace);
    collapseLeftSidebar();
    collapseRightSidebar();
    expandProjects([workspace.projectPath]);
    const client = createMockORPCClient({
      projects: groupWorkspacesByProject(workspaces),
      workspaces,
      workspaceActivitySnapshots: {
        [monitorWorkspace.id]: {
          recency: STABLE_TIMESTAMP,
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          activeBashMonitorCount: 1,
        },
      },
      onChat: (workspaceId, emit) => {
        if (workspaceId === workspace.id) {
          emitChat = emit;
          subscriptions += 1;
        } else if (workspaceId === monitorWorkspace.id) {
          emit(history);
        } else if (workspaceId === transcriptWorkspace.id) {
          emitTranscript = emit;
          transcriptSubscriptions += 1;
          if (transcriptSubscriptions === 1) {
            emit(history);
            emit({
              type: "caught-up",
              historyReplayStatus: "complete",
              hasOlderHistory: false,
              cursor: { history: { messageId: history.id, historySequence: 1 } },
            });
          }
        } else {
          emit(
            createAssistantMessage("other-history", "Another workspace response.", {
              historySequence: 1,
            })
          );
          emit({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false });
        }
      },
    });
    client.workspace.activity.subscribe = activityFeed.subscribe;
    return client;
  }
  const exerciseHydration: AppStory["play"] = async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const exposedStatuses = () =>
      within(canvas.getByTestId("message-window")).queryAllByRole("status");
    await step("First fetch is visible before the transcript and decorations reveal", async () => {
      await checkTranscriptLayout(canvasElement);
      await expect(canvas.getByTestId("transcript-hydration-placeholder")).toBeVisible();
      await expect(exposedStatuses()).toHaveLength(1);
      await expect(exposedStatuses()[0]).toBe(
        canvas.getByTestId("transcript-hydration-placeholder")
      );
      await expect(canvas.getByRole("textbox")).toBeEnabled();
      emitChat({
        type: "stream-lifecycle",
        workspaceId: workspace.id,
        phase: "preparing",
        hadAnyOutput: false,
      });
      // An active turn does not mean history has loaded: the skeleton keeps holding the
      // empty transcript while the barrier stays docked, and the dock shimmer only
      // appears when the skeleton is absent.
      await expect(await canvas.findByRole("button", { name: "Stop streaming" })).toBeVisible();
      await checkTranscriptLayout(canvasElement);
      await expect(canvas.getByTestId("transcript-hydration-placeholder")).toBeVisible();
      await expect(canvas.queryByTestId("transcript-loading-status")).toBeNull();
      emitChat({
        type: "stream-lifecycle",
        workspaceId: workspace.id,
        phase: "idle",
        hadAnyOutput: false,
      });
      await expect(await canvas.findByTestId("transcript-hydration-placeholder")).toBeVisible();
      // Cold open of an existing workspace: replayed init events land before history. A
      // running init card is the transcript (live init bypasses hydration), but once it
      // finishes the lone card must not release the skeleton ahead of the history rows.
      emitChat({
        type: "init-start",
        hookPath: "/project/.xum/init",
        timestamp: STABLE_TIMESTAMP,
        replay: true,
      });
      await expect((await canvas.findAllByText(/Creating workspace/))[0]).toBeVisible();
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      emitChat({ type: "init-end", exitCode: 0, timestamp: STABLE_TIMESTAMP, replay: true });
      await expect(await canvas.findByTestId("transcript-hydration-placeholder")).toBeVisible();
      await expect(canvas.queryByText(/Workspace created/)).toBeNull();
      await expect(canvas.queryByTestId("transcript-loading-status")).toBeNull();
      emitChat(history);
      emitChat({
        type: "caught-up",
        historyReplayStatus: "complete",
        hasOlderHistory: false,
        cursor: { history: { messageId: history.id, historySequence: 1 } },
      });
      await checkTranscriptLayout(canvasElement, false);
      await expect(
        await canvas.findByText("Previously loaded response.", {}, { timeout: 5000 })
      ).toBeVisible();
      await expect(await canvas.findByText(/Workspace created/)).toBeVisible();
      await expect(exposedStatuses()).toHaveLength(0);
    });

    await step(
      "Switching away settles the transcript; revisiting preserves cached rows during replay",
      async () => {
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(
          await canvas.findByText("Another workspace response.", {}, { timeout: 5000 })
        ).toBeVisible();
        await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(2));
        await checkTranscriptLayout(canvasElement);
        await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
        await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
        await expect(exposedStatuses()).toHaveLength(1);
        await expect(exposedStatuses()[0]).toBe(canvas.getByTestId("transcript-loading-status"));
        // Replay stays visible while navigation remains available, including on phones.
        const scrollport = canvas.getByTestId("message-window");
        await expect(scrollport.scrollHeight).toBeGreaterThan(scrollport.clientHeight);
        scrollport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        scrollport.scrollTop = 0;
        scrollport.dispatchEvent(new Event("scroll"));
        const jumpToBottom = await canvas.findByRole("button", { name: /Jump to bottom/ });
        await checkTranscriptLayout(canvasElement);
        await userEvent.click(jumpToBottom);
        await checkTranscriptLayout(canvasElement);
        await finishReplayWithoutLayoutShift(canvasElement, () => {
          emitChat(history);
          emitChat({
            type: "caught-up",
            historyReplayStatus: "complete",
            replay: "since",
            hasOlderHistory: false,
            cursor: { history: { messageId: history.id, historySequence: 1 } },
          });
        });
        // Re-enter catch-up for the competing progress-state checks below.
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(await canvas.findByText("Another workspace response.")).toBeVisible();
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(3));
        await checkTranscriptLayout(canvasElement);
      }
    );

    await step("Active turns retain replay shimmer alongside their controls", async () => {
      emitChat({
        type: "init-start",
        hookPath: "/project/.xum/init",
        timestamp: STABLE_TIMESTAMP,
        replay: true,
      });
      emitChat({
        type: "init-output",
        line: "Preparing workspace",
        step: true,
        isError: false,
        timestamp: STABLE_TIMESTAMP,
        replay: true,
      });
      await expect((await canvas.findAllByText(/Creating workspace/))[0]).toBeVisible();
      await expect(await canvas.findByText("Preparing workspace")).toBeVisible();
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      emitChat({ type: "init-end", exitCode: 0, timestamp: STABLE_TIMESTAMP, replay: true });
      await expect(await canvas.findByText(/Workspace created/)).toBeVisible();
      await checkTranscriptLayout(canvasElement);
      emitChat({
        type: "stream-lifecycle",
        workspaceId: workspace.id,
        phase: "preparing",
        hadAnyOutput: false,
      });
      await expect(await canvas.findByRole("button", { name: "Stop streaming" })).toBeVisible();
      await checkTranscriptLayout(canvasElement);
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      emitChat({
        type: "stream-start",
        workspaceId: workspace.id,
        messageId: "stream",
        model: DEFAULT_MODEL,
        historySequence: 2,
        startTime: STABLE_TIMESTAMP,
      });
      await expect(await canvas.findByText(/streaming\.\.\./)).toBeVisible();
      await checkTranscriptLayout(canvasElement);
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      emitChat(history);
      emitChat({
        type: "caught-up",
        historyReplayStatus: "complete",
        replay: "since",
        hasOlderHistory: false,
        cursor: { history: { messageId: history.id, historySequence: 1 } },
      });
      emitChat({
        type: "stream-delta",
        workspaceId: workspace.id,
        messageId: "stream",
        delta: "Live response.",
        tokens: 3,
        timestamp: STABLE_TIMESTAMP,
      });
      await expect(await canvas.findByText("Live response.")).toBeVisible();
      await expect(canvas.getByRole("log")).toHaveAttribute("aria-busy", "true");
      await expect(canvas.queryByTestId("transcript-loading-status")).toBeNull();
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      emitChat({
        type: "stream-end",
        workspaceId: workspace.id,
        messageId: "stream",
        metadata: { model: DEFAULT_MODEL },
        parts: [{ type: "text", text: "Live response." }],
      });
      emitChat({
        type: "stream-lifecycle",
        workspaceId: workspace.id,
        phase: "idle",
        hadAnyOutput: true,
      });
    });

    await step("A monitor barrier stays docked beside the replay skeleton", async () => {
      await switchWorkspace(canvasElement, monitorWorkspace.id);
      await expect(
        await canvas.findByText(/Waiting on background bash monitor/, {}, { timeout: 5000 })
      ).toBeVisible();
      await checkTranscriptLayout(canvasElement);
      // History rows are buffered until caught-up, so the transcript is still empty here.
      await expect(canvas.getByTestId("transcript-hydration-placeholder")).toBeVisible();
      await expect(canvas.queryByTestId("transcript-loading-status")).toBeNull();
    });

    await step("Read-only cached transcripts stay stable during replay", async () => {
      await switchWorkspace(canvasElement, transcriptWorkspace.id);
      await expect(
        await canvas.findByText("Previously loaded response.", {}, { timeout: 5000 })
      ).toBeVisible();
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      await switchWorkspace(canvasElement, otherWorkspace.id);
      await expect(await canvas.findByText("Another workspace response.")).toBeVisible();
      await switchWorkspace(canvasElement, transcriptWorkspace.id);
      await waitFor(() => expect(transcriptSubscriptions).toBe(2));
      await checkTranscriptLayout(canvasElement);
      await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
      await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      await expect(canvas.queryByRole("textbox")).toBeNull();
      await finishReplayWithoutLayoutShift(canvasElement, () => {
        emitTranscript(history);
        emitTranscript({
          type: "caught-up",
          historyReplayStatus: "complete",
          replay: "since",
          hasOlderHistory: false,
          cursor: { history: { messageId: history.id, historySequence: 1 } },
        });
      });
      await checkTranscriptLayout(canvasElement, false);
      await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
    });

    await step(
      "Switching back to a workspace that streamed in the background shows the skeleton, not cached rows",
      async () => {
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(
          await canvas.findByText("Another workspace response.", {}, { timeout: 5000 })
        ).toBeVisible();
        // A new turn started while this workspace was unsubscribed from onChat: the cached
        // rows are missing that content, so they must not paint and then jump on caught-up.
        emitActivity(workspace.id, {
          recency: STABLE_TIMESTAMP + 1,
          streaming: true,
          streamingGeneration: 2,
          lastModel: DEFAULT_MODEL,
          lastThinkingLevel: null,
        });
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(4));
        await expect(await canvas.findByRole("button", { name: "Stop streaming" })).toBeVisible();
        await checkTranscriptLayout(canvasElement);
        await expect(canvas.getByTestId("transcript-hydration-placeholder")).toBeVisible();
        await expect(canvas.queryByText("Previously loaded response.")).toBeNull();
        await expect(canvas.queryByTestId("transcript-loading-status")).toBeNull();
        emitChat(history);
        emitChat({
          type: "caught-up",
          historyReplayStatus: "complete",
          replay: "since",
          hasOlderHistory: false,
          cursor: { history: { messageId: history.id, historySequence: 1 } },
        });
        await checkTranscriptLayout(canvasElement, false);
        await expect(await canvas.findByText("Previously loaded response.")).toBeVisible();
        await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
        // The background turn is over before the next step leaves this workspace, so its
        // cached rows stay trustworthy there.
        emitActivity(workspace.id, {
          recency: STABLE_TIMESTAMP + 2,
          streaming: false,
          streamingGeneration: 2,
          lastModel: DEFAULT_MODEL,
          lastThinkingLevel: null,
        });
      }
    );

    await step(
      "A later replay remains busy without shifting or clearing previously cached messages",
      async () => {
        await switchWorkspace(canvasElement, otherWorkspace.id);
        await expect(
          await canvas.findByText("Another workspace response.", {}, { timeout: 5000 })
        ).toBeVisible();
        await switchWorkspace(canvasElement, workspace.id);
        await waitFor(() => expect(subscriptions).toBe(5));
        await checkTranscriptLayout(canvasElement);
        await expect(canvas.getByText("Previously loaded response.")).toBeVisible();
        await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
        // Freeze active replay so desktop and phone snapshots cover the shimmer with turn controls.
        emitChat({
          type: "stream-lifecycle",
          workspaceId: workspace.id,
          phase: "preparing",
          hadAnyOutput: false,
        });
        await expect(await canvas.findByRole("button", { name: "Stop streaming" })).toBeVisible();
        await checkTranscriptLayout(canvasElement);
        // Trustworthy cached rows keep painting under an active turn; only the dock shimmer shows.
        await expect(canvas.queryByTestId("transcript-hydration-placeholder")).toBeNull();
      }
    );
  };

  return { render: () => <AppWithMocks setup={setup} />, play: exerciseHydration };
}

export const Replay: AppStory = {
  ...createHydrationStory("ws-loading-desktop"),
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } } },
};

const phoneHydration = createHydrationStory("ws-loading-phone");

export const Phone: AppStory = {
  ...phoneHydration,
  play: async (context) => {
    await checkPhoneViewport(context);
    await phoneHydration.play!(context);
  },
  decorators: [
    (Story) => (
      <div
        data-testid="chat-loading-phone"
        style={{ width: 390, maxWidth: "100%", height: "100vh", overflow: "hidden" }}
      >
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "phone", isRotated: false } },
  parameters: {
    pixel: { matrix: { viewports: ["phone"] } },
    viewport: {
      options: {
        phone: { name: "Phone", styles: { width: "390px", height: "844px" }, type: "mobile" },
      },
    },
  },
};

// Keep the first-load shimmer frozen so Pixel also captures the empty-history state.
export const InitialLoadingPhone: AppStory = {
  ...Phone,
  ...createHydrationStory("ws-loading-initial-phone"),
  globals: { ...Phone.globals, theme: "light" },
  parameters: {
    ...Phone.parameters,
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => {
    await checkPhoneViewport(context);
    await checkTranscriptLayout(context.canvasElement);
    const skeleton = within(context.canvasElement).getByTestId("transcript-hydration-placeholder");
    await expect(skeleton).toBeVisible();
    // A fixed-height phone canvas can autofocus-scroll the initial shimmer out of view.
    await expect(skeleton.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  },
};

// Live controls must not follow the skeleton's arbitrary height, short history, or
// streaming growth. Compare real screen coordinates, including every reveal frame.
function createStreamingHydrationStory(workspaceId: string): AppStory {
  const workspace = createWorkspace({
    id: workspaceId,
    name: "streaming-replay",
    projectName: "xum",
  });
  let emitChat: (event: WorkspaceChatMessage) => void;
  function setup() {
    selectWorkspace(workspace);
    collapseLeftSidebar();
    collapseRightSidebar();
    return createMockORPCClient({
      projects: groupWorkspacesByProject([workspace]),
      workspaces: [workspace],
      onChat: (_workspaceId, emit) => {
        emitChat = emit;
      },
    });
  }
  return {
    render: () => <AppWithMocks setup={setup} />,
    play: async ({ canvasElement, step }) => {
      const canvas = within(canvasElement);
      await waitFor(() => expect(typeof emitChat).toBe("function"));
      await checkTranscriptLayout(canvasElement);
      await expect(canvas.getByTestId("transcript-hydration-placeholder")).toBeVisible();
      emitChat({ type: "stream-lifecycle", workspaceId, phase: "preparing", hadAnyOutput: false });
      const stop = await canvas.findByRole("button", { name: "Stop streaming" });
      const status = await canvas.findByText(/starting\.\.\./);
      const scrollport = canvas.getByTestId("message-window");
      const position = () => ({
        statusLeft: status.getBoundingClientRect().left,
        statusTop: status.getBoundingClientRect().top,
        stopRight: stop.getBoundingClientRect().right,
        stopTop: stop.getBoundingClientRect().top,
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      const before = position();
      const checkPosition = async () => {
        await expect(position()).toEqual(before);
        await expect(stop.getBoundingClientRect().right).toBeLessThanOrEqual(
          scrollport.getBoundingClientRect().right
        );
        await expect(status.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          scrollport.getBoundingClientRect().left
        );
        await expect(stop.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          scrollport.getBoundingClientRect().bottom
        );
      };
      await step("Skeleton and short history share the same live-control position", async () => {
        await checkPosition();
        const frames: Array<ReturnType<typeof position>> = [];
        let frame = 0;
        const sample = () => {
          frames.push(position());
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        try {
          emitChat(createAssistantMessage("history", "Replayed response.", { historySequence: 1 }));
          emitChat({
            type: "stream-start",
            workspaceId,
            messageId: "stream",
            model: DEFAULT_MODEL,
            historySequence: 2,
            startTime: STABLE_TIMESTAMP,
          });
          emitChat({ type: "caught-up", hasOlderHistory: false });
          await expect(await canvas.findByText("Replayed response.")).toBeVisible();
          await waitFor(() => expect(scrollport).toHaveAttribute("data-loaded", "true"));
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
          await checkPosition();
          for (const sample of frames) await expect(sample).toEqual(before);
        } finally {
          cancelAnimationFrame(frame);
        }
      });
      await step("Growing output and scrolling history leave Stop in place", async () => {
        emitChat({
          type: "stream-delta",
          workspaceId,
          messageId: "stream",
          delta: Array.from({ length: 30 }, (_, i) => "Streaming paragraph " + (i + 1) + ".").join(
            "\n\n"
          ),
          tokens: 10000,
          timestamp: STABLE_TIMESTAMP,
        });
        await expect(
          await canvas.findByText(/Streaming paragraph 30\./, {}, { timeout: 10000 })
        ).toBeVisible();
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        await checkPosition();
        scrollport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        scrollport.scrollTop = 0;
        scrollport.dispatchEvent(new Event("scroll"));
        await expect(await canvas.findByRole("button", { name: /Jump to bottom/ })).toBeVisible();
        await checkPosition();
        await userEvent.click(canvas.getByRole("button", { name: /Jump to bottom/ }));
      });
    },
  };
}

export const StreamingHydration: AppStory = {
  ...createStreamingHydrationStory("ws-streaming-hydration"),
  globals: { viewport: { value: "laptop", isRotated: false } },
  parameters: {
    ...Replay.parameters,
    viewport: {
      options: {
        laptop: { name: "Laptop", styles: { width: "1200px", height: "900px" }, type: "desktop" },
      },
    },
  },
};

const phoneStreamingHydration = createStreamingHydrationStory("ws-streaming-hydration-phone");
export const StreamingHydrationPhone: AppStory = {
  ...Phone,
  ...phoneStreamingHydration,
  play: async (context) => {
    await checkPhoneViewport(context);
    await phoneStreamingHydration.play!(context);
  },
};

// Sending the first message shows nothing on the project page beyond a locked composer; the new
// workspace opens with the message and the creation card and keeps both until the backend
// persists them.
function createCreationPendingStory(): AppStory {
  const projectPath = "/home/user/projects/xum";
  const typed = "Add a dark mode toggle";
  const workspaceName = "dark-mode-toggle";
  let releaseName: () => void = () => undefined;
  let releaseCreate: () => void = () => undefined;

  function setup() {
    clearWorkspaceSelection();
    collapseLeftSidebar();
    collapseRightSidebar();
    expandProjects([projectPath]);
    const nameGate = new Promise<void>((resolve) => {
      releaseName = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const client = createMockORPCClient({
      projects: new Map<string, ProjectConfig>([[projectPath, { workspaces: [], trusted: true }]]),
      workspaces: [],
      onChat: (workspaceId, emit) => {
        if (!workspaceId.startsWith("ws-created-")) {
          return;
        }
        // Live init for the just-created workspace; the first message is never persisted here,
        // so the pending row stays in place for the snapshot.
        emit({
          type: "init-start",
          hookPath: projectPath + "/.xum/init",
          timestamp: STABLE_TIMESTAMP,
        });
        emit({
          type: "init-output",
          line: "Preparing checkout",
          step: true,
          isError: false,
          timestamp: STABLE_TIMESTAMP,
        });
        emit({
          type: "init-output",
          line: "Running .xum/init",
          step: true,
          isError: false,
          timestamp: STABLE_TIMESTAMP,
        });
        emit({
          type: "caught-up",
          historyReplayStatus: "complete",
          replay: "full",
          hasOlderHistory: false,
        });
      },
    });
    client.nameGeneration.generate = async () => {
      await nameGate;
      return {
        success: true as const,
        data: { name: workspaceName, title: "Dark mode toggle", modelUsed: "mock" },
      };
    };
    const originalCreate = client.workspace.create;
    client.workspace.create = async (input) => {
      await createGate;
      return originalCreate(input);
    };
    client.workspace.activity.subscribe = createActivityFeed().subscribe;
    return client;
  }

  const play: AppStory["play"] = async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const textarea = () => canvasElement.querySelector<HTMLTextAreaElement>("textarea");

    await step("Open the project creation view", async () => {
      expandLeftSidebar();
      const projectRow = await waitFor(async () => {
        const element = canvasElement.querySelector<HTMLElement>(
          '[data-project-path="' + projectPath + '"][aria-controls]'
        );
        await expect(element).not.toBeNull();
        return element!;
      });
      await userEvent.click(projectRow);
      collapseLeftSidebar();
      await waitFor(async () => {
        await expect(textarea()).not.toBeNull();
        await expect(textarea()).toBeEnabled();
      });
    });

    await step(
      "Sending only locks the composer; the project page shows no transcript",
      async () => {
        await userEvent.click(textarea()!);
        await userEvent.type(textarea()!, typed);
        await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
        await waitFor(async () => {
          await expect(textarea()).toBeDisabled();
        });
        releaseName();
        // Name generation is done and creation is still pending: no rows, no creation card.
        await expect(canvasElement.querySelector('[data-testid="chat-message"]')).toBeNull();
        await expect(canvas.queryByText(/Creating workspace/)).toBeNull();
        await expect(canvas.queryByTestId("message-window")).toBeNull();
      }
    );

    await step(
      "The new workspace opens with the message above the live creation card",
      async () => {
        releaseCreate();
        const messageWindow = await canvas.findByTestId("message-window", {}, { timeout: 5000 });
        await waitFor(async () => {
          const rows = Array.from(messageWindow.querySelectorAll('[data-testid="chat-message"]'));
          await expect(rows.length).toBeGreaterThanOrEqual(2);
          await expect(rows[0].textContent).toContain(typed);
          await expect(rows[1].textContent).toContain("Creating workspace");
        });
        await expect(await canvas.findByText("Running .xum/init")).toBeVisible();
      }
    );
  };

  return { render: () => <AppWithMocks setup={setup} />, play };
}

export const CreationPending: AppStory = {
  ...createCreationPendingStory(),
  parameters: { pixel: { matrix: { viewports: ["laptop"] } } },
};

const creationPendingPhone = createCreationPendingStory();

export const CreationPendingPhone: AppStory = {
  ...creationPendingPhone,
  play: async (context) => {
    await checkPhoneViewport(context);
    await creationPendingPhone.play!(context);
  },
  decorators: [
    (Story) => (
      <div
        data-testid="chat-loading-phone"
        style={{ width: 390, maxWidth: "100%", height: "100vh", overflow: "hidden" }}
      >
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
};
