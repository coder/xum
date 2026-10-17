// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { DevToolsRunSummary } from "@/common/types/devtools";
import type { AvailableWorkflow, WorkflowRunRecord } from "@/common/types/workflow";
import { useDevToolsSubscription } from "./DevToolsTab/useDevToolsSubscription";
import { useWorkflowRunLiveSnapshot, useWorkflowRuns } from "./Workflows/useWorkflowRuns";
import { WorkflowsTab } from "./Workflows/WorkflowsTab";

/*
 * Live feeds (a snapshot, then deltas) keep what they show across a dropped connection: the new
 * client's snapshot replaces it when it arrives. Another workspace still clears it.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The ids each feed's next snapshot carries; a test swaps them (or holds them) before a connect. */
let devToolsSnapshot: () => Promise<string[]>;
let workflowSnapshot: () => Promise<string[]>;
let scriptNames: () => Promise<string[]>;

/** A stream that sends one snapshot, then stays open until the connection drops. */
function snapshotStream<T>(snapshot: Promise<T>) {
  return Promise.resolve(
    (async function* () {
      yield await snapshot;
      await new Promise(() => undefined);
    })()
  );
}

function devToolsRun(id: string): DevToolsRunSummary {
  return { id } as unknown as DevToolsRunSummary;
}

function workflowRun(id: string): WorkflowRunRecord {
  return { id, updatedAt: "2026-01-01T00:00:00.000Z" } as unknown as WorkflowRunRecord;
}

function script(name: string): AvailableWorkflow {
  const workflow: AvailableWorkflow = {
    descriptor: { name, description: `${name} script`, scope: "project", executable: true },
    scriptPath: `skill://${name}/workflow.js`,
    args: [],
  };
  return workflow;
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    devtools: {
      subscribe: () =>
        snapshotStream(
          devToolsSnapshot().then((ids) => ({ type: "snapshot", runs: ids.map(devToolsRun) }))
        ),
    },
    workflows: {
      subscribe: () =>
        snapshotStream(
          workflowSnapshot().then((ids) => ({ type: "snapshot", runs: ids.map(workflowRun) }))
        ),
      listScripts: () => scriptNames().then((names) => names.map(script)),
    },
  } as unknown as TestApiOverrides<APIClient>;
}

let harness: ConnectionHarness;

function Wrapper(props: { children: ReactNode }) {
  const Connection = harness.Wrapper;
  return <Connection>{props.children}</Connection>;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function drop() {
  await harness.drop();
  await flush();
}

async function reconnect() {
  harness.reconnect();
  await flush();
}

function ids(runs: Array<{ id: string }>): string[] {
  return runs.map((run) => run.id);
}

describe.each([...GAP_MODES])("live feeds across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    harness = createConnectionHarness(mode, serverOverrides);
    devToolsSnapshot = () => Promise.resolve(["run-a"]);
    workflowSnapshot = () => Promise.resolve(["run-a"]);
    scriptNames = () => Promise.resolve(["deploy"]);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the DevTools feed keeps the shown runs until the new snapshot", async () => {
    const view = renderHook(() => useDevToolsSubscription("ws-1"), { wrapper: Wrapper });
    await waitFor(() => expect(ids(view.result.current.runs)).toEqual(["run-a"]));

    await drop();
    expect(ids(view.result.current.runs)).toEqual(["run-a"]);

    const next = deferred<string[]>();
    devToolsSnapshot = () => next.promise;
    await reconnect();
    expect(ids(view.result.current.runs)).toEqual(["run-a"]);

    next.resolve(["run-b"]);
    await waitFor(() => expect(ids(view.result.current.runs)).toEqual(["run-b"]));
  });

  test("the workflow feed keeps the shown runs until the new snapshot", async () => {
    const view = renderHook(() => useWorkflowRuns("ws-1"), { wrapper: Wrapper });
    await waitFor(() => expect(ids(view.result.current.runs)).toEqual(["run-a"]));

    await drop();
    expect(ids(view.result.current.runs)).toEqual(["run-a"]);

    const next = deferred<string[]>();
    workflowSnapshot = () => next.promise;
    await reconnect();
    expect(ids(view.result.current.runs)).toEqual(["run-a"]);
    expect(view.result.current.loading).toBe(false);

    next.resolve(["run-b"]);
    await waitFor(() => expect(ids(view.result.current.runs)).toEqual(["run-b"]));
  });

  // A lost connection ends the stream without an error (the next client subscribes again). A
  // server cancel on a live socket also arrives as an AbortError, but no new client follows: it
  // must be reported, not leave the kept runs looking current.
  test("the workflow feed reports a server cancel before the snapshot, not a lost connection", async () => {
    const view = renderHook(
      () => ({
        feed: useWorkflowRuns("ws-1"),
        live: useWorkflowRunLiveSnapshot({ workspaceId: "ws-1", runId: "run-a", enabled: true }),
      }),
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(ids(view.result.current.feed.runs)).toEqual(["run-a"]));

    await drop();
    expect(view.result.current.feed.error).toBeNull();
    expect(view.result.current.live.failed).toBe(false);

    workflowSnapshot = () =>
      Promise.reject(new DOMException("cancelled by the server", "AbortError"));
    await reconnect();
    await waitFor(() => expect(view.result.current.feed.error).toBe("cancelled by the server"));
    expect(view.result.current.live.failed).toBe(true);
  });

  test("the Workflows tab keeps its empty state and script list while it reloads", async () => {
    workflowSnapshot = () => Promise.resolve([]);
    const view = render(<WorkflowsTab workspaceId="ws-1" />, { wrapper: Wrapper });
    await view.findByText("deploy");

    await drop();
    expect(view.queryByText("deploy")).not.toBeNull();

    const nextRuns = deferred<string[]>();
    const nextScripts = deferred<string[]>();
    workflowSnapshot = () => nextRuns.promise;
    scriptNames = () => nextScripts.promise;
    await reconnect();
    expect(view.queryByText("deploy")).not.toBeNull();
    expect(view.queryByText("Loading workflow runs…")).toBeNull();

    nextRuns.resolve([]);
    nextScripts.resolve(["release"]);
    await view.findByText("release");
    expect(view.queryByText("deploy")).toBeNull();
  });
});

describe.each([...GAP_MODES])("the Workflows tab opened while reconnecting (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(async () => {
    cleanupDom = installDom();
    harness = createConnectionHarness(mode, serverOverrides);
    scriptNames = () => Promise.resolve(["deploy"]);
    // The tab opens during the gap: no snapshot has landed yet.
    await harness.drop();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows its loading state, not the empty state, until the first snapshot lands", async () => {
    workflowSnapshot = () => Promise.resolve([]);
    const view = render(<WorkflowsTab workspaceId="ws-1" />, { wrapper: Wrapper });
    await flush();

    const next = deferred<string[]>();
    workflowSnapshot = () => next.promise;
    await reconnect();
    expect(view.queryByText("Loading workflow runs…")).not.toBeNull();
    expect(view.queryByText("deploy")).toBeNull();

    next.resolve([]);
    await view.findByText("deploy");
    expect(view.queryByText("Loading workflow runs…")).toBeNull();
  });
});

describe("live feeds of another workspace", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    harness = createConnectionHarness("kept-gap", serverOverrides);
    devToolsSnapshot = () => Promise.resolve(["run-a"]);
    workflowSnapshot = () => Promise.resolve(["run-a"]);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("another workspace clears the shown runs while its own snapshot loads", async () => {
    const devTools = renderHook(
      (props: { workspaceId: string }) => useDevToolsSubscription(props.workspaceId),
      {
        wrapper: Wrapper,
        initialProps: { workspaceId: "ws-1" },
      }
    );
    const workflows = renderHook(
      (props: { workspaceId: string }) => useWorkflowRuns(props.workspaceId),
      {
        wrapper: Wrapper,
        initialProps: { workspaceId: "ws-1" },
      }
    );
    await waitFor(() => expect(ids(devTools.result.current.runs)).toEqual(["run-a"]));
    await waitFor(() => expect(ids(workflows.result.current.runs)).toEqual(["run-a"]));

    devToolsSnapshot = () => new Promise(() => undefined);
    workflowSnapshot = () => new Promise(() => undefined);
    devTools.rerender({ workspaceId: "ws-2" });
    workflows.rerender({ workspaceId: "ws-2" });
    await flush();
    expect(ids(devTools.result.current.runs)).toEqual([]);
    expect(ids(workflows.result.current.runs)).toEqual([]);
    expect(workflows.result.current.loading).toBe(true);
  });
});
