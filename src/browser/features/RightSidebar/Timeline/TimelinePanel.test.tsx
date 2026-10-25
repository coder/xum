import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { APIContext } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { WorkspaceTimelineSnapshot } from "@/browser/stores/WorkspaceStore";
import { getTimelineFilterKey } from "@/common/constants/storage";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";
import { formatDuration } from "@/common/utils/formatDuration";

import { installDom } from "../../../../../tests/ui/dom";
import { TimelinePanelView, type TimelineWorkspaceStore } from "./TimelinePanel";

// Bun unit tests for the panel view. tests/ui/rightSidebar/timeline.test.ts drives the same panel
// under Jest, but Jest's coverage collects only .ts files, so these cover the feed shaping,
// row rendering and panel states where the CRAP report can see them.

const WORKSPACE_ID = "timeline-unit-workspace";
const BASE_TIMESTAMP = Date.UTC(2026, 6, 27, 12, 0, 0);

function makeEvent(
  id: string,
  kind: string,
  seq: number,
  overrides: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    v: 1,
    id,
    kind,
    seq,
    ts: BASE_TIMESTAMP + seq * 1000,
    source: { system: "chat" },
    ...overrides,
  };
}

function renderPanel(events: TimelineEvent[], snapshot: Partial<WorkspaceTimelineSnapshot> = {}) {
  const workspaceStore = {
    getWorkspaceState: () => ({ messages: [], muxMessages: [], hasOlderHistory: false }),
    loadOlderHistory: mock((_workspaceId: string) => Promise.resolve("loaded" as const)),
    loadOlderTimeline: mock((_workspaceId: string) => Promise.resolve()),
    retryTimeline: mock((_workspaceId: string) => undefined),
  } satisfies TimelineWorkspaceStore;
  const timeline: WorkspaceTimelineSnapshot = {
    events,
    nextCursor: null,
    hasOlder: false,
    initialized: true,
    loadingOlder: false,
    loadError: null,
    loadErrorKind: null,
    ...snapshot,
  };
  // The preview card of a selected anchored row needs an API context; with no client it skips the
  // preview fetch and still offers the reveal action.
  const view = render(
    <APIContext.Provider
      value={{
        api: null,
        status: "error",
        error: "API unavailable",
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      <TimelinePanelView
        workspaceId={WORKSPACE_ID}
        timeline={timeline}
        workspaceStore={workspaceStore}
      />
    </APIContext.Provider>
  );
  const row = (id: string) =>
    view.container.querySelector<HTMLElement>(`[data-timeline-event-id="${id}"]`);
  const rowIds = () =>
    Array.from(view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")).map(
      (element) => element.dataset.timelineEventId
    );
  const collapsed = () =>
    Array.from(view.container.querySelectorAll<HTMLElement>("[data-timeline-collapsed-kind]"));
  return { ...view, workspaceStore, row, rowIds, collapsed };
}

describe("TimelinePanelView", () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  describe("panel states", () => {
    test("shows a loading state until the timeline initializes", () => {
      const view = renderPanel([], { initialized: false });
      expect(view.getByText("Loading timeline…")).toBeTruthy();
      expect(view.queryByText("No timeline events yet")).toBeNull();
    });

    test("tells an empty timeline apart from a failed first load, and retries the failed one", () => {
      const empty = renderPanel([]);
      expect(empty.getByText("No timeline events yet")).toBeTruthy();
      cleanup();

      const failed = renderPanel([], {
        loadError: "subscription closed",
        loadErrorKind: "subscription",
      });
      expect(failed.getByText("Timeline unavailable")).toBeTruthy();
      expect(failed.getByText("subscription closed")).toBeTruthy();
      fireEvent.click(failed.getByRole("button", { name: "Retry" }));
      expect(failed.workspaceStore.retryTimeline.mock.calls).toEqual([[WORKSPACE_ID]]);
    });

    test("offers a reconnect only for a dead subscription when rows are on screen", () => {
      const events = [makeEvent("prompt", "turn.user", 1)];
      const dead = renderPanel(events, {
        loadError: "stream ended",
        loadErrorKind: "subscription",
      });
      expect(dead.getByText("stream ended")).toBeTruthy();
      fireEvent.click(dead.getByRole("button", { name: "Reconnect" }));
      expect(dead.workspaceStore.retryTimeline.mock.calls).toEqual([[WORKSPACE_ID]]);
      cleanup();

      const page = renderPanel(events, { loadError: "page failed", loadErrorKind: "pagination" });
      expect(page.getByText("page failed")).toBeTruthy();
      expect(page.queryByRole("button", { name: "Reconnect" })).toBeNull();
    });

    test("pages older events on request and marks the start of the timeline", () => {
      const events = [makeEvent("prompt", "turn.user", 1)];
      const older = renderPanel(events, { hasOlder: true });
      fireEvent.click(older.getByRole("button", { name: "Load older" }));
      expect(older.workspaceStore.loadOlderTimeline.mock.calls).toEqual([[WORKSPACE_ID]]);
      cleanup();

      const loading = renderPanel(events, { hasOlder: true, loadingOlder: true });
      const button = loading.getByRole("button", { name: "Loading older…" });
      expect((button as HTMLButtonElement).disabled).toBe(true);
      cleanup();

      const start = renderPanel(events);
      expect(start.getByText("Beginning of timeline")).toBeTruthy();
      expect(start.queryByRole("button", { name: "Load older" })).toBeNull();
    });
  });

  describe("filters and selection", () => {
    const events = [
      makeEvent("failed-turn", "turn.failed", 3, {
        status: "failed",
        data: { reason: "Provider returned 529" },
      }),
      makeEvent("goal", "goal.set", 2),
      makeEvent("prompt", "turn.user", 1),
    ];

    test("narrows the feed to the chosen category and keeps pagination reachable", () => {
      const view = renderPanel(events, { hasOlder: true });
      expect(view.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(view.getByRole("button", { name: "Errors" }));
      expect(view.getByRole("button", { name: "Errors" }).getAttribute("aria-pressed")).toBe(
        "true"
      );
      expect(view.rowIds()).toEqual(["failed-turn"]);

      fireEvent.click(view.getByRole("button", { name: "Subagents" }));
      expect(view.rowIds()).toEqual([]);
      expect(view.getByText("No events match this filter.")).toBeTruthy();
      expect(view.getByRole("button", { name: "Load older" })).toBeTruthy();
    });

    test("falls back to every event when the stored filter is not a known category", () => {
      updatePersistedState(getTimelineFilterKey(WORKSPACE_ID), "retired-category");
      const view = renderPanel(events);
      expect(view.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
      expect(view.rowIds()).toEqual(["failed-turn", "goal", "prompt"]);
    });

    test("selects a row on click and clears the selection with Escape", () => {
      const view = renderPanel(events);
      fireEvent.click(view.row("goal")!);
      expect(view.row("goal")!.getAttribute("aria-pressed")).toBe("true");
      expect(view.row("prompt")!.getAttribute("aria-pressed")).toBe("false");

      fireEvent.keyDown(view.row("goal")!, { key: "Escape" });
      expect(view.row("goal")!.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("rows", () => {
    test("joins the title, model and mode, reason and duration into the row detail", () => {
      const view = renderPanel([
        makeEvent("full", "turn.interrupted", 3, {
          status: "interrupted",
          data: {
            title: "Fix flaky test",
            digest: "hidden",
            model: "sonnet",
            mode: "exec",
            reason: "user stop",
            durationMs: 1500,
          },
        }),
        makeEvent("digest-only", "turn.user", 2, {
          data: { digest: "Run the suite", mode: "plan" },
        }),
        makeEvent("bare", "goal.set", 1, { data: {} }),
      ]);
      expect(view.row("full")!.textContent).toContain(
        `Fix flaky test · sonnet · exec · user stop · ${formatDuration(1500, "precise")}`
      );
      expect(view.row("full")!.textContent).not.toContain("hidden");
      expect(view.row("digest-only")!.textContent).toContain("Run the suite · plan");
      // With nothing to show, the row is only its kind label and time.
      const bare = view.row("bare")!;
      expect(bare.textContent).toBe(`Goal set${bare.querySelector("time")!.textContent}`);
    });

    test("titles agent events by their description and badges them by category", () => {
      const view = renderPanel([
        makeEvent("picked-up", "agent.event", 2, {
          source: { system: "agent" },
          data: { description: "Picked up review comment", category: "picked_up" },
        }),
        makeEvent("uncategorized", "agent.event", 1, {
          source: { system: "agent" },
          data: { description: "Noted a decision" },
        }),
      ]);
      expect(view.row("picked-up")!.textContent).toStartWith("Picked up review commentpicked up");
      expect(view.row("uncategorized")!.textContent).toStartWith("Noted a decisionAgent");
    });

    test("renders turn ends and context boundaries as rules, selectable only with an anchor", () => {
      const view = renderPanel([
        makeEvent("turn-done", "turn.completed", 4, {
          data: { model: "sonnet", durationMs: 2000 },
        }),
        makeEvent("turn-plain", "turn.completed", 3),
        makeEvent("compacted", "compaction.completed", 2, {
          epoch: 3,
          anchor: { messageId: "summary" },
        }),
        makeEvent("reset", "context.reset", 1),
      ]);
      const separators = view.getAllByRole("separator").map((element) => element.textContent);
      expect(separators).toHaveLength(3);
      expect(separators[0]).toStartWith(`sonnet · ${formatDuration(2000, "precise")}`);
      expect(separators[1]).toStartWith("Turn completed");
      expect(separators[2]).toBe("Context boundary · Context reset");

      // An anchored boundary may point into archived history, so it stays selectable.
      const compacted = view.row("compacted")!;
      expect(compacted.tagName).toBe("BUTTON");
      expect(compacted.textContent).toBe("Epoch 3 · Compaction completed");
      fireEvent.click(compacted);
      expect(compacted.getAttribute("aria-pressed")).toBe("true");
      expect(view.getByTestId("timeline-reveal")).toBeTruthy();
    });
  });

  describe("collapsed runs", () => {
    test("collapses three or more consecutive same-kind rows and expands them on click", () => {
      const view = renderPanel([
        makeEvent("settings-3", "settings.changed", 5),
        makeEvent("settings-2", "settings.changed", 4),
        makeEvent("settings-1", "settings.changed", 3),
        makeEvent("goal-2", "goal.set", 2),
        makeEvent("goal-1", "goal.set", 1),
      ]);
      expect(view.rowIds()).toEqual(["goal-2", "goal-1"]);
      const [run] = view.collapsed();
      expect(run.dataset.timelineCollapsedCount).toBe("3");
      expect(run.textContent).toBe("3 Settings changed events");

      fireEvent.click(run);
      expect(view.rowIds()).toEqual(["settings-3", "settings-2", "settings-1", "goal-2", "goal-1"]);
      expect(view.collapsed()[0].getAttribute("aria-expanded")).toBe("true");
    });

    test("groups machinery across kinds and absorbed turn rules, labeled by the most frequent kind", () => {
      const view = renderPanel([
        makeEvent("prompt", "turn.user", 8),
        makeEvent("beat-3", "heartbeat.dispatched", 7),
        makeEvent("beat-2", "heartbeat.dispatched", 6),
        makeEvent("turn-end", "turn.completed", 5),
        makeEvent("goal-push", "goal.continuation_dispatched", 4),
        makeEvent("reset", "context.reset", 3),
        makeEvent("beat-1", "heartbeat.dispatched", 2),
        makeEvent("turn-end-1", "turn.completed", 1),
      ]);
      const [run] = view.collapsed();
      expect(view.collapsed()).toHaveLength(1);
      // The group opens with the goal continuation, but heartbeats outnumber it.
      expect(run.dataset.timelineCollapsedKind).toBe("heartbeat.dispatched");
      // The absorbed turn rule is decoration: only the three machinery events count.
      expect(run.dataset.timelineCollapsedCount).toBe("3");
      expect(run.textContent).toBe("3 automatic events");
      // A deliberate context reset breaks the group, and a lone machinery event stays a plain row.
      expect(view.rowIds()).toEqual(["prompt", "beat-1"]);

      fireEvent.click(run);
      expect(view.rowIds()).toEqual(["prompt", "beat-3", "beat-2", "goal-push", "beat-1"]);
      // The expanded group shows its absorbed turn rule again, between its machinery rows.
      const ruleLabels = view
        .getAllByRole("separator")
        .map((element) => element.querySelector("span")?.textContent);
      expect(ruleLabels).toEqual([
        "Turn completed",
        "Context boundary · Context reset",
        "Turn completed",
      ]);
    });

    test("drops an aborted retry next to its interruption, but keeps it under the Errors filter", () => {
      const events = [
        makeEvent("interrupted", "turn.interrupted", 2, { status: "interrupted" }),
        makeEvent("retry", "retry.abandoned", 1, { data: { reason: "aborted" } }),
      ];
      const view = renderPanel(events);
      expect(view.rowIds()).toEqual(["interrupted"]);

      fireEvent.click(view.getByRole("button", { name: "Errors" }));
      expect(view.rowIds()).toEqual(["retry"]);
    });
  });

  describe("sub-agent rows", () => {
    test("drops a started row once a newer row for that task lands", () => {
      const view = renderPanel([
        makeEvent("report-a", "task.reported", 3, {
          data: { title: "Auditor finished" },
          anchor: { taskId: "task-a", messageId: "report-msg" },
        }),
        makeEvent("start-a", "task.created", 2, {
          anchor: { taskId: "task-a", toolCallId: "call-a" },
        }),
        makeEvent("start-b", "task.created", 1, {
          anchor: { taskId: "task-b", toolCallId: "call-b" },
        }),
      ]);
      expect(view.rowIds()).toEqual(["report-a", "start-b"]);
    });

    test("drops only updates whose title and digest repeat a newer row of the same task", () => {
      const view = renderPanel([
        makeEvent("report", "task.reported", 5, {
          data: { title: "Subagent (explore) report", digest: "No must-fix issues" },
          anchor: { taskId: "task-a" },
        }),
        // Untitled and fallback-titled rows share one key when their digests match.
        makeEvent("repeat", "task.progress", 4, {
          data: { digest: "No must-fix issues" },
          anchor: { taskId: "task-a" },
        }),
        makeEvent("distinct", "task.progress", 3, {
          data: { title: "Found a race", digest: "No must-fix issues" },
          anchor: { taskId: "task-a" },
        }),
        makeEvent("other-task", "task.progress", 2, {
          data: { digest: "No must-fix issues" },
          anchor: { taskId: "task-b" },
        }),
        makeEvent("distinct-older", "task.progress", 1, {
          data: { title: "Found a race", digest: "No must-fix issues" },
          anchor: { taskId: "task-a" },
        }),
      ]);
      expect(view.rowIds()).toEqual(["report", "distinct", "other-task"]);
    });

    test("gives a retained row without a transcript anchor the started row's reveal target", () => {
      const view = renderPanel([
        makeEvent("report", "task.reported", 2, {
          data: { title: "Auditor finished" },
          anchor: { taskId: "task-a", childWorkspaceId: "child-a" },
        }),
        makeEvent("start", "task.created", 1, {
          anchor: { taskId: "task-a", toolCallId: "spawn-call", childWorkspaceId: "child-a" },
        }),
      ]);
      expect(view.rowIds()).toEqual(["report"]);
      fireEvent.click(view.row("report")!);
      expect(view.getByTestId("timeline-reveal").textContent).toBe("Reveal in transcript");
    });
  });
});
