import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { useBackgroundBashStoreRaw } from "@/browser/stores/BackgroundBashStore";
import { createTestApiClient } from "@/browser/testUtils";
import { computeTaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import type { BackgroundProcessInfo } from "@/common/orpc/schemas/api";
import type { DisplayedMessage } from "@/common/types/message";
import type { TaskAwaitToolArgs, TaskAwaitToolSuccessResult } from "@/common/types/tools";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as RealWorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as RealSubagentTranscriptDialogModule from "@/browser/features/Tools/SubagentTranscriptDialog";
import * as RealElapsedTimeDisplayModule from "@/browser/features/Tools/Shared/ElapsedTimeDisplay";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

let workspaceContextMock: {
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  setSelectedWorkspace: (selection: unknown) => void;
} | null = null;

restoreModulesAfterSuite([
  ["@/browser/contexts/WorkspaceContext", { ...RealWorkspaceContextModule }],
  ["@/browser/features/Tools/SubagentTranscriptDialog", { ...RealSubagentTranscriptDialogModule }],
  ["@/browser/features/Tools/Shared/ElapsedTimeDisplay", { ...RealElapsedTimeDisplayModule }],
]);
void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useOptionalWorkspaceContext: () => workspaceContextMock,
  toWorkspaceSelection: (workspace: FrontendWorkspaceMetadata) => workspace,
}));
void mock.module("@/browser/features/Tools/SubagentTranscriptDialog", () => ({
  SubagentTranscriptDialog: () => null,
}));
// Live timers are irrelevant to these rows; a static stub keeps renders deterministic.
void mock.module("@/browser/features/Tools/Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: () => <span data-testid="elapsed-time" />,
}));

import { getToolComponent } from "./Shared/getToolComponent";

const ROOT_WORKSPACE_ID = "root-ws";
const TaskAwaitToolCall = getToolComponent("task_await", { task_ids: [] }, undefined);

function workspace(id: string, overrides: Partial<FrontendWorkspaceMetadata> = {}) {
  return {
    id,
    name: `name-${id}`,
    projectName: "project",
    projectPath: "/project",
    runtimeConfig: { type: "local" },
    namedWorkspacePath: `/project/${id}`,
    ...overrides,
  } satisfies FrontendWorkspaceMetadata;
}

function setWorkspaces(...workspaces: FrontendWorkspaceMetadata[]) {
  const setSelectedWorkspace = mock((_selection: unknown) => undefined);
  workspaceContextMock = {
    workspaceMetadata: new Map(workspaces.map((ws) => [ws.id, ws])),
    setSelectedWorkspace,
  };
  return setSelectedWorkspace;
}

function renderAwait(props: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <MessageListProvider value={{ workspaceId: ROOT_WORKSPACE_ID, latestMessageId: null }}>
        <TaskAwaitToolCall status="completed" {...props} />
      </MessageListProvider>
    </TooltipProvider>
  );
}

function renderCompletedResults(results: TaskAwaitToolSuccessResult["results"], extra = {}) {
  const view = renderAwait({ args: { task_ids: [] }, result: { results }, ...extra });
  // Successful polls render collapsed; failed polls force the details open.
  const toggle = view.container.querySelector('[aria-label$="Show task wait details"]');
  if (!toggle) throw new Error("task_await header not rendered");
  if (!view.container.querySelector('[data-component="TaskAwaitDetails"]')) fireEvent.click(toggle);
  return view;
}

function renderExecuting(taskIds: string[]) {
  const args = { task_ids: taskIds, timeout_secs: null } satisfies TaskAwaitToolArgs;
  const view = renderAwait({ args, status: "executing" });
  fireEvent.click(view.getByLabelText(/Show task wait details$/));
  return view;
}

function badgeTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-component="TaskStatusBadge"]')).map(
    (badge) => badge.textContent ?? ""
  );
}

function child(id: string, parentWorkspaceId: string) {
  return workspace(id, { parentWorkspaceId });
}

function proc(id: string, status: BackgroundProcessInfo["status"]): BackgroundProcessInfo {
  return { id, pid: 1, script: "true", startTime: 1, status };
}

/** Ancestry chain root <- w1 <- ... <- wN. */
function chain(length: number): FrontendWorkspaceMetadata[] {
  return Array.from({ length }, (_, i) =>
    child(`w${i + 1}`, i === 0 ? ROOT_WORKSPACE_ID : `w${i}`)
  );
}

describe("task_await card rows", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    workspaceContextMock = null;
    // Unmount first: clearing the store under a mounted card re-renders it outside act().
    cleanup();
    const bashStore = useBackgroundBashStoreRaw();
    bashStore.setClient(null);
    bashStore.clearCachedState();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("completed row shows its report title, run facts, patch summary and report, not raw output", () => {
    const view = renderCompletedResults([
      {
        status: "completed",
        taskId: "task-1",
        title: "  Pagination report  ",
        reportMarkdown: "Found **three** helpers",
        output: "raw stdout that the report replaces",
        exitCode: 0,
        elapsed_ms: 65_000,
        note: "Report persisted on disk",
        artifacts: { gitFormatPatch: readyPatch("task-1") },
      },
    ]);

    expect(view.getByText("Pagination report")).toBeDefined();
    expect(view.getByRole("button", { name: "task-1" })).toBeDefined();
    expect(view.getByText("exit 0")).toBeDefined();
    expect(view.getByText("took 1m")).toBeDefined();
    expect(view.getByLabelText("View notice")).toBeDefined();
    expect(view.getByText("Patch: ready (1 ready; 2 commits)")).toBeDefined();
    expect(view.getByText("three")).toBeDefined();
    expect(view.queryByText("raw stdout that the report replaces")).toBeNull();
    expect(badgeTexts(view.container)).toEqual(["completed"]);
  });

  test("active row shows live output and uses the workspace title when there is no report title", () => {
    setWorkspaces(workspace("task-2", { title: "Workspace title" }));
    const view = renderCompletedResults([
      { status: "running", taskId: "task-2", output: "step 3 of 5", elapsed_ms: 400 },
    ]);

    expect(view.getByText("Workspace title")).toBeDefined();
    expect(view.getByText("step 3 of 5")).toBeDefined();
    expect(view.getByText("took 400ms")).toBeDefined();
    expect(view.queryByLabelText("View notice")).toBeNull();
    expect(view.queryByText(/^exit /)).toBeNull();
    expect(badgeTexts(view.container)).toEqual(["running"]);
  });

  test("blank report title falls back to the workspace title, and the task ID opens that workspace", () => {
    const target = workspace("child-ws", { name: "Child workspace" });
    const setSelectedWorkspace = setWorkspaces(target);
    const view = renderCompletedResults([
      // wst_ handles are not workspace IDs; the result's workspaceId names the real workspace.
      {
        status: "completed",
        taskId: "wst_turn1",
        title: "   ",
        workspaceId: "child-ws",
        reportMarkdown: "",
      },
    ]);

    expect(view.getByText("Child workspace")).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "wst_turn1" }));
    expect(setSelectedWorkspace).toHaveBeenCalledWith(target);
  });

  test("error row shows the error and forces the card open", () => {
    const view = renderAwait({
      args: { task_ids: ["task-3"] },
      result: {
        results: [
          { status: "error", taskId: "task-3", error: "Sub-agent crashed", elapsed_ms: 2_000 },
        ],
      } satisfies TaskAwaitToolSuccessResult,
    });

    expect(view.getByText("1 task failed")).toBeDefined();
    // No report or workspace title: the task ID itself is the row heading.
    expect(view.getByRole("button", { name: "task-3" })).toBeDefined();
    expect(view.getByText("Sub-agent crashed")).toBeDefined();
    expect(view.getByText("took 2s")).toBeDefined();
    expect(badgeTexts(view.container)).toEqual(["error"]);
  });

  test("hides report and patch summary when the spawn card already shows the report", () => {
    const awaitResult = {
      results: [
        {
          status: "completed",
          taskId: "task-4",
          title: "Spawned report",
          reportMarkdown: "Duplicated report body",
          artifacts: { gitFormatPatch: readyPatch("task-4") },
        },
      ],
    } satisfies TaskAwaitToolSuccessResult;
    const messages: DisplayedMessage[] = [
      toolMessage("task", { prompt: "p", title: "Spawn" }, { status: "queued", taskId: "task-4" }),
      toolMessage("task_await", { task_ids: ["task-4"] }, awaitResult),
    ];

    const view = renderCompletedResults(awaitResult.results, {
      taskReportLinking: computeTaskReportLinking(messages),
    });

    const details = view.container.querySelector<HTMLElement>(
      '[data-component="TaskAwaitDetails"]'
    );
    if (!details) throw new Error("details not expanded");
    expect(within(details).getByText("Spawned report")).toBeDefined();
    expect(within(details).queryByText("Duplicated report body")).toBeNull();
    expect(within(details).queryByText(/^Patch:/)).toBeNull();
  });

  test.each<[string, FrontendWorkspaceMetadata[], string, number | null]>([
    ["direct child", chain(1), "w1", 1],
    ["grandchild", chain(2), "w2", 2],
    ["50 hops (traversal limit)", chain(50), "w50", 50],
    ["51 hops (beyond the limit)", chain(51), "w51", null],
    ["missing ancestor", [workspace("w2", { parentWorkspaceId: "gone" })], "w2", null],
    // The (corrupt) entry keyed by the blank ID proves a blank parent is never followed.
    ["blank parent ID", [child("w1", "  "), child("  ", ROOT_WORKSPACE_ID)], "w1", null],
    ["ancestry cycle", [child("a", "b"), child("b", "a")], "a", null],
    ["the awaiting workspace itself", [workspace(ROOT_WORKSPACE_ID)], ROOT_WORKSPACE_ID, null],
  ])("nesting depth label for %s", (_name, workspaces, leafId, expectedDepth) => {
    setWorkspaces(...workspaces);
    const view = renderExecuting([leafId]);

    // The row resolved the metadata (title shown), so only the depth computation varies.
    expect(view.getByText(`name-${leafId}`)).toBeDefined();
    const depthLabels = view.queryAllByText(/^depth \d+$/).map((el) => el.textContent);
    expect(depthLabels).toEqual(expectedDepth == null ? [] : [`depth ${expectedDepth}`]);
  });

  test("background bash rows map live process status and fall back to waiting", async () => {
    const processes: BackgroundProcessInfo[] = [
      { ...proc("p-run", "running"), displayName: "Dev Server" },
      proc("p-exit", "exited"),
      proc("p-kill", "killed"),
      proc("p-fail", "failed"),
    ];
    // The store asks for the next snapshot only after it has applied this one.
    let markSnapshotApplied!: () => void;
    const snapshotApplied = new Promise<void>((resolve) => (markSnapshotApplied = resolve));
    useBackgroundBashStoreRaw().setClient(
      createTestApiClient({
        workspace: {
          backgroundBashes: {
            subscribe: (_input, options) =>
              Promise.resolve(
                (async function* () {
                  yield { processes, foregroundToolCallIds: [] };
                  markSnapshotApplied();
                  // Stay subscribed until the store aborts, like the live feed.
                  await new Promise((resolve) =>
                    options?.signal?.addEventListener("abort", resolve)
                  );
                })()
              ),
          },
        },
      })
    );

    const ids = ["p-run", "p-exit", "p-kill", "p-fail", "p-gone"];
    const view = renderExecuting(ids.map((id) => `bash:${id}`));

    // The first snapshot arrives asynchronously, so every bash row starts out waiting.
    expect(badgeTexts(view.container)).toEqual(new Array<string>(5).fill("waiting"));
    await act(() => snapshotApplied);
    expect(badgeTexts(view.container).join(" ")).toBe("running completed terminated error waiting");
    // Rows without a display name fall back to the process ID; unknown processes show the task ID.
    expect(view.getByText("p-exit")).toBeDefined();
    expect(view.getByRole("button", { name: "bash:p-gone" })).toBeDefined();
  });
});

function readyPatch(childTaskId: string) {
  return {
    childTaskId,
    parentWorkspaceId: ROOT_WORKSPACE_ID,
    createdAtMs: 1,
    status: "ready" as const,
    projectArtifacts: [],
    readyProjectCount: 1,
    failedProjectCount: 0,
    skippedProjectCount: 0,
    totalCommitCount: 2,
  };
}

function toolMessage(toolName: string, args: unknown, result: unknown): DisplayedMessage {
  return {
    type: "tool",
    id: `msg-${toolName}`,
    historyId: `hist-${toolName}`,
    toolCallId: `call-${toolName}`,
    toolName,
    args,
    result,
    status: "completed",
    isPartial: false,
    historySequence: 1,
  };
}
