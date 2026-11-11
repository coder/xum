import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { AgentPluginUpdateReview } from "@/common/orpc/schemas/agentPlugins";
import { subscribeAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type {
  AgentPluginListItem,
  AgentPluginUpdateCheck,
} from "@/common/orpc/schemas/agentPlugins";
import {
  UpdateAllButton,
  UpdateAllStatus,
  useUpdateAll,
  useUpdateReviewQueue,
} from "./PluginsUpdateAll";

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

test("settling the open review opens the next one, and the queue ends empty", () => {
  const { result } = renderHook(() => useUpdateReviewQueue([review("a"), review("b")]));

  expect(result.current.open?.name).toBe("a");
  act(() => result.current.settle(result.current.open));
  expect(result.current.open?.name).toBe("b");
  act(() => result.current.settle(result.current.open));
  expect(result.current.open).toBeNull();
});

test("settling removes that review wherever it is, and nothing for a review that is not queued", () => {
  const queued = [review("a"), review("b"), review("c")];
  const { result } = renderHook(() => useUpdateReviewQueue(queued));

  act(() => result.current.settle(queued[1]));
  expect(result.current.waiting).toEqual([queued[0], queued[2]]);

  act(() => result.current.settle({ ...queued[0] }));
  act(() => result.current.settle(undefined));
  expect(result.current.waiting).toEqual([queued[0], queued[2]]);
});

test("showing reviews replaces the open one and the queue behind it, and the old reviews no longer settle anything", () => {
  const first = review("a");
  const { result } = renderHook(() => useUpdateReviewQueue([first, review("b")]));
  const shown = [review("c"), review("d")];

  act(() => result.current.show(shown));
  expect(result.current.open?.name).toBe("c");
  act(() => result.current.settle(first));
  expect(result.current.waiting).toEqual(shown);
});

test("clearing drops the open review and the queue behind it", () => {
  const { result } = renderHook(() => useUpdateReviewQueue([review("a"), review("b")]));

  act(() => result.current.clear());
  expect(result.current.open).toBeNull();
  expect(result.current.waiting).toEqual([]);
});

test("dropping the open review opens the next one, and dropping a queued one leaves the open one", () => {
  const { result } = renderHook(() =>
    useUpdateReviewQueue([review("a"), review("b"), review("c")])
  );

  act(() => result.current.drop("b"));
  expect(result.current.open?.name).toBe("a");
  expect(result.current.waiting.map((waiting) => waiting.name)).toEqual(["a", "c"]);

  act(() => result.current.drop("a"));
  expect(result.current.open?.name).toBe("c");

  act(() => result.current.drop("unknown"));
  expect(result.current.open?.name).toBe("c");
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

const item = (name: string, managed = true): AgentPluginListItem => ({
  name,
  managed,
  present: true,
  location: `~/.mux/plugins/${name}`,
  source: {
    type: "git",
    url: `https://example.invalid/${name}.git`,
    ref: "main",
    refType: "branch",
  },
  lockedSha: "a".repeat(40),
  skillCount: 1,
  mcpServerCount: 0,
});

const check = (name: string, status: AgentPluginUpdateCheck["status"]): AgentPluginUpdateCheck => ({
  name,
  status,
});

type UpdateAllDeps = Parameters<typeof useUpdateAll>[0];

/** Plugins preview as capability-neutral unless `reviews` lists them. */
function updateAllDeps(config: {
  checks: AgentPluginUpdateCheck[];
  reviews?: AgentPluginUpdateReview[];
  failing?: string[];
  /** Updates wait for this before they answer. */
  holdUpdates?: Promise<void>;
  overrides?: Partial<UpdateAllDeps>;
}) {
  const api = createMockORPCClient({});
  const previewUpdate = mock((input: { name: string }) => {
    const found = config.reviews?.find((candidate) => candidate.name === input.name);
    return Promise.resolve({
      success: true,
      data: found ?? { ...review(input.name), changes: [] },
    });
  });
  const update = mock(async (input: { name: string }) => {
    await config.holdUpdates;
    return config.failing?.includes(input.name)
      ? { success: false, error: "swap failed" }
      : { success: true };
  });
  api.agentPlugins.previewUpdate =
    previewUpdate as unknown as typeof api.agentPlugins.previewUpdate;
  api.agentPlugins.update = update as unknown as typeof api.agentPlugins.update;
  const deps: UpdateAllDeps = {
    api,
    busyPlugin: null,
    setBusyPlugin: mock(() => undefined),
    items: config.checks.map((entry) => item(entry.name)),
    updateChecks: new Map(config.checks.map((entry) => [entry.name, entry])),
    waitingReviews: [],
    onStart: mock(() => undefined),
    onReviews: mock(() => undefined),
    refresh: mock(() => Promise.resolve()),
    checkForUpdates: mock(() => Promise.resolve()),
    ...config.overrides,
  };
  return { deps, previewUpdate, update };
}

test("the count leaves out plugins that are up to date, moved a tag, failed their check or are unmanaged", () => {
  const { deps } = updateAllDeps({
    checks: [
      check("alpha", "update-available"),
      check("beta", "tag-moved"),
      check("gamma", "error"),
      check("delta", "up-to-date"),
      check("echo", "update-available"),
    ],
    overrides: {
      items: [item("alpha"), item("beta"), item("gamma"), item("delta"), item("echo", false)],
    },
  });

  const { result } = renderHook(() => useUpdateAll(deps));

  expect(result.current.count).toBe(1);
});

test("a run tells the host it started before it updates anything", async () => {
  const { deps, update } = updateAllDeps({ checks: [check("alpha", "update-available")] });
  const hook = renderHook(() => useUpdateAll(deps));

  await act(() => hook.result.current.run());

  expect(deps.onStart).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
});

test("a run reports that it is running only while it is in flight", async () => {
  const release = Promise.withResolvers<void>();
  const { deps } = updateAllDeps({
    checks: [check("alpha", "update-available")],
    holdUpdates: release.promise,
  });
  const hook = renderHook(() => useUpdateAll(deps));
  expect(hook.result.current.running).toBe(false);

  let run: Promise<void> = Promise.resolve();
  act(() => {
    run = hook.result.current.run();
  });
  expect(hook.result.current.running).toBe(true);

  release.resolve();
  await act(() => run);
  expect(hook.result.current.running).toBe(false);
});

test.each([
  ["a plugin is busy", { busyPlugin: "beta" }],
  ["there is no api", { api: null }],
])("a run does nothing while %s", async (_label, overrides) => {
  const { deps, previewUpdate } = updateAllDeps({
    checks: [check("alpha", "update-available")],
    overrides,
  });
  const hook = renderHook(() => useUpdateAll(deps));

  await act(() => hook.result.current.run());

  expect(deps.onStart).not.toHaveBeenCalled();
  expect(previewUpdate).not.toHaveBeenCalled();
});

test("a run tells mounted composers about the plugins it applied, and stays quiet when it applied none", async () => {
  const published = mock(() => undefined);
  const unsubscribe = subscribeAgentPluginsMutated(published);
  try {
    const applied = updateAllDeps({ checks: [check("alpha", "update-available")] });
    const hook = renderHook(() => useUpdateAll(applied.deps));
    await act(() => hook.result.current.run());
    expect(published).toHaveBeenCalledTimes(1);

    const nothingApplied = updateAllDeps({
      checks: [check("alpha", "update-available"), check("beta", "update-available")],
      reviews: [review("alpha")],
      failing: ["beta"],
    });
    const quietHook = renderHook(() => useUpdateAll(nothingApplied.deps));
    await act(() => quietHook.result.current.run());
    expect(published).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

test("the status keeps a run's failures after its reviews settle and names only the reviews that wait", async () => {
  const waiting = [review("alpha"), review("beta")];
  const { deps } = updateAllDeps({
    checks: [
      check("alpha", "update-available"),
      check("beta", "update-available"),
      check("gamma", "update-available"),
    ],
    reviews: waiting,
    failing: ["gamma"],
  });
  const onReviews = mock((_reviews: readonly AgentPluginUpdateReview[]) => undefined);
  const hook = renderHook((props: UpdateAllDeps) => useUpdateAll(props), {
    initialProps: { ...deps, onReviews },
  });
  await act(() => hook.result.current.run());
  const shown = onReviews.mock.calls[0][0];

  hook.rerender({ ...deps, onReviews, waitingReviews: shown });
  expect(hook.result.current.status?.message).toContain("alpha");
  expect(hook.result.current.status?.message).toContain("beta");

  hook.rerender({ ...deps, onReviews, waitingReviews: shown.slice(1) });
  expect(hook.result.current.status?.message).not.toContain("alpha");
  expect(hook.result.current.status?.message).toContain("beta");
  expect(hook.result.current.status?.message).toContain("swap failed");

  hook.rerender({ ...deps, onReviews, waitingReviews: [] });
  expect(hook.result.current.status?.message).toContain("swap failed");

  act(() => hook.result.current.dismissStatus());
  expect(hook.result.current.status).toBeNull();
});
