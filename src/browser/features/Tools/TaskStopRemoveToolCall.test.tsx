import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type {
  TaskRemoveToolArgs,
  TaskRemoveToolSuccessResult,
  TaskStopToolArgs,
  TaskStopToolSuccessResult,
} from "@/common/types/tools";

import { GenericToolCall } from "./GenericToolCall";
import { getToolComponent } from "./Shared/getToolComponent";

function renderTool(toolName: string, args: object, props: Record<string, unknown>) {
  const Component = getToolComponent(toolName, args, props.result);
  // Invalid args silently fall back to the generic card; fail loudly instead.
  expect(Component).not.toBe(GenericToolCall);
  return render(
    <TooltipProvider>
      <Component args={args} {...props} />
    </TooltipProvider>
  );
}

type View = ReturnType<typeof renderTool>;

function badgeTexts(element: ParentNode): Array<string | null> {
  return Array.from(element.querySelectorAll('[data-component="TaskStatusBadge"]')).map(
    (badge) => badge.textContent
  );
}

// TaskId renders the ID as a button placed directly inside its result row.
function rowOf(view: View, taskId: string): HTMLElement {
  const row = view.getByRole("button", { name: taskId }).parentElement;
  if (!row) throw new Error(`No row for ${taskId}`);
  return row;
}

let originalWindow: typeof globalThis.window;
let originalDocument: typeof globalThis.document;

beforeEach(() => {
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
  globalThis.document = globalThis.window.document;
});

afterEach(() => {
  cleanup();
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

describe("TaskStopToolCall and TaskRemoveToolCall", () => {
  const args = { task_ids: ["task-a", "task-b"] } satisfies TaskStopToolArgs & TaskRemoveToolArgs;

  test.each([
    ["task_stop", "2 to stop"],
    ["task_remove", "2 to remove"],
  ])("%s lists the requested task IDs without statuses before results arrive", (tool, summary) => {
    const view = renderTool(tool, args, { status: "executing" });
    expect(view.getByText(summary)).toBeTruthy();
    fireEvent.click(view.getByText(tool));

    expect(rowOf(view, "task-a")).toBeTruthy();
    expect(rowOf(view, "task-b")).toBeTruthy();
    expect(badgeTexts(view.container)).toEqual([]);
  });

  const stopped = { status: "stopped", taskId: "task-a" } as const;
  const inactive = { status: "already_inactive", taskId: "task-b" } as const;
  const removed = { status: "removed", taskId: "task-a" } as const;
  test.each<[string, string, TaskStopToolSuccessResult | TaskRemoveToolSuccessResult]>([
    ["task_stop", "1 stopped", { results: [stopped] }],
    ["task_stop", "1 stopped, 1 already inactive", { results: [stopped, inactive] }],
    ["task_stop", "0 stopped, 1 already inactive", { results: [inactive] }],
    ["task_stop", "2 to stop", { results: [{ status: "not_found", taskId: "task-a" }] }],
    ["task_remove", "1 removed", { results: [removed, { status: "active", taskId: "task-b" }] }],
    ["task_remove", "2 to remove", { results: [{ status: "active", taskId: "task-a" }] }],
  ])("%s header reads %p", (tool, summary, result) => {
    const view = renderTool(tool, args, { result, status: "completed" });
    expect(view.getByText(summary)).toBeTruthy();
  });

  test("task_stop rows pair each task with its status, note and error", () => {
    const view = renderTool("task_stop", args, {
      status: "completed",
      result: {
        results: [
          { status: "stopped", taskId: "task-a", note: "Stopped mid-turn." },
          { status: "error", taskId: "task-b", error: "Permission denied." },
        ],
      } satisfies TaskStopToolSuccessResult,
    });
    // The card starts collapsed.
    expect(view.queryByRole("button", { name: "task-a" })).toBeNull();

    fireEvent.click(view.getByText("task_stop"));

    const rowA = rowOf(view, "task-a");
    expect(badgeTexts(rowA)).toEqual(["stopped"]);
    expect(rowA.textContent).toContain("Stopped mid-turn.");
    expect(rowA.textContent).not.toContain("Permission denied.");
    const rowB = rowOf(view, "task-b");
    expect(badgeTexts(rowB)).toEqual(["error"]);
    expect(rowB.textContent).toContain("Permission denied.");
  });

  test("task_remove rows show each task's status, error and removed paths", () => {
    const paths = ["/worktrees/task-a", "/sessions/task-a"];
    const view = renderTool("task_remove", args, {
      status: "completed",
      result: {
        results: [
          { status: "removed", taskId: "task-a", paths },
          { status: "error", taskId: "task-b", error: "Uncommitted changes." },
        ],
      } satisfies TaskRemoveToolSuccessResult,
    });
    fireEvent.click(view.getByText("task_remove"));

    const rowA = rowOf(view, "task-a");
    expect(badgeTexts(rowA)).toEqual(["removed"]);
    expect(rowA.textContent).toContain(paths.join(""));
    const rowB = rowOf(view, "task-b");
    expect(badgeTexts(rowB)).toEqual(["error"]);
    expect(rowB.textContent).toContain("Uncommitted changes.");
    expect(rowB.textContent).not.toContain(paths[0]);
  });
});
