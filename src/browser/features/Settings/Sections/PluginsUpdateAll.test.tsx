import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { AgentPluginUpdateReview } from "@/common/orpc/schemas/agentPlugins";
import { UpdateAllButton, UpdateAllStatus, useUpdateReviewQueue } from "./PluginsUpdateAll";

let cleanupDom: (() => void) | null = null;
beforeEach(() => {
  cleanupDom = installDom();
});
afterEach(() => {
  cleanup();
  cleanupDom?.();
});

const review = (name: string): AgentPluginUpdateReview => ({
  name,
  fromSha: "a".repeat(40),
  toSha: "b".repeat(40),
  changes: [{ summary: `adds skill '${name}'` }],
  warnings: [],
});

test("the review queue opens its reviews in order and ends empty", () => {
  const { result } = renderHook(() => useUpdateReviewQueue([review("a"), review("b")]));

  expect(result.current.open?.name).toBe("a");
  act(() => result.current.next());
  expect(result.current.open?.name).toBe("b");
  act(() => result.current.next());
  expect(result.current.open).toBeNull();
  act(() => result.current.next());
  expect(result.current.open).toBeNull();
});

test("showing reviews replaces the open one and the queue behind it", () => {
  const { result } = renderHook(() => useUpdateReviewQueue([review("a"), review("b")]));

  act(() => result.current.show([review("c")]));
  expect(result.current.open?.name).toBe("c");
  act(() => result.current.next());
  expect(result.current.open).toBeNull();
});

test("clearing drops the open review and the queue behind it", () => {
  const { result } = renderHook(() => useUpdateReviewQueue([review("a"), review("b")]));

  act(() => result.current.clear());
  expect(result.current.open).toBeNull();
  act(() => result.current.next());
  expect(result.current.open).toBeNull();
});

test("the button renders only while a plugin has an update waiting, and clicks run it", () => {
  const onClick = mock(() => undefined);
  const view = render(
    <UpdateAllButton count={0} running={false} disabled={false} onClick={onClick} />
  );
  expect(view.queryByRole("button")).toBeNull();

  view.rerender(<UpdateAllButton count={3} running={false} disabled={false} onClick={onClick} />);
  expect(view.getByRole("button").textContent).toContain("3");
  fireEvent.click(view.getByRole("button"));
  expect(onClick).toHaveBeenCalledTimes(1);

  view.rerender(<UpdateAllButton count={3} running={true} disabled={true} onClick={onClick} />);
  expect((view.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});

test("the status shows its message for either tone and nothing without one", () => {
  const view = render(<UpdateAllStatus status={null} />);
  expect(view.queryByRole("status")).toBeNull();

  view.rerender(<UpdateAllStatus status={{ tone: "success", message: "Updated alpha" }} />);
  expect(view.getByRole("status").textContent).toContain("Updated alpha");

  view.rerender(<UpdateAllStatus status={{ tone: "error", message: "Update failed — beta" }} />);
  expect(view.getByRole("status").textContent).toContain("Update failed — beta");
});
