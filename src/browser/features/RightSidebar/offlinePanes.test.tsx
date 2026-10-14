// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { BackgroundBashOutputDialog } from "@/browser/components/BackgroundBashOutputDialog/BackgroundBashOutputDialog";
import { ProjectMCPOverview } from "@/browser/components/ProjectMCPOverview/ProjectMCPOverview";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import type { TestApiOverrides } from "@/browser/testUtils";
import type { DevToolsRunSummary } from "@/common/types/devtools";
import type { GoalBoardSnapshot } from "@/common/types/goal";
import type { AvailableWorkflow, WorkflowRunRecord } from "@/common/types/workflow";
import { DevToolsRunCard } from "./DevToolsTab/DevToolsRunCard";
import { DevToolsTab } from "./DevToolsTab/DevToolsTab";
import { projectWorkflowRun } from "./Workflows/projectWorkflowRun";
import { WorkflowRunHeader } from "./Workflows/WorkflowRunHeader";
import { GoalBoardSections } from "./GoalBoardSections";
import { WorkflowsTab } from "./Workflows/WorkflowsTab";

/*
 * Panes keep what they show while Xum reconnects. That must not hide failures:
 * - a server cancel on a live socket (a plain AbortError) is an error like any other, not a lost
 *   connection, since no new client will come to retry it;
 * - a control that needs the server does nothing without one, so it says so or is disabled;
 * - work cut off by the lost connection runs again on the next client.
 */

let answerServers: () => Promise<unknown>;
let answerOutput: () => Promise<unknown>;
let answerRunDetail: () => Promise<unknown>;
let mutations: string[] = [];

/** A server cancel on a live socket: an abort that is not a lost connection. */
function serverCancel(): Promise<never> {
  return Promise.reject(new DOMException("cancelled by the server", "AbortError"));
}

/** Never answers: the read stays in flight until a drop cuts it off. */
function pending(): Promise<unknown> {
  return new Promise(() => undefined);
}

function outputResult(output: string) {
  return {
    success: true as const,
    data: { status: "exited" as const, output, nextOffset: output.length, truncatedStart: false },
  };
}

function mutation(name: string) {
  return () => {
    mutations.push(name);
    return Promise.resolve();
  };
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    mcp: { list: () => answerServers() },
    workspace: {
      backgroundBashes: { getOutput: () => answerOutput() },
      promoteUpcomingGoal: mutation("promote"),
      archiveGoal: mutation("archive"),
      reviveArchivedGoal: mutation("revive"),
      updateUpcomingGoal: mutation("update"),
      goalDefaults: { get: () => Promise.resolve(null) },
    },
    workflows: {
      subscribe: () =>
        Promise.resolve(
          (async function* () {
            yield { type: "snapshot", runs: [] };
            await new Promise(() => undefined);
          })()
        ),
      listScripts: () => Promise.resolve([workflowScript()]),
      start: mutation("start"),
    },
    devtools: {
      getRunDetail: () => answerRunDetail(),
      subscribe: () =>
        Promise.resolve(
          (async function* () {
            yield { type: "snapshot", runs: [devToolsRun()] };
            await new Promise(() => undefined);
          })()
        ),
      clear: mutation("clear"),
    },
    config: { getConfig: () => Promise.resolve({}) },
  } as unknown as TestApiOverrides<APIClient>;
}

function workflowScript(): AvailableWorkflow {
  const script: AvailableWorkflow = {
    descriptor: {
      name: "deploy",
      description: "deploy script",
      scope: "project",
      executable: true,
    },
    scriptPath: "skill://deploy/workflow.js",
    args: [],
  };
  return script;
}

function goalBoard(): GoalBoardSnapshot {
  const goal = (goalId: string, objective: string) =>
    ({
      goalId,
      objective,
      status: "active",
      budgetCents: null,
      costCents: 0,
    }) as unknown as GoalBoardSnapshot["entries"][number]["goal"];
  return {
    entries: [
      { section: "upcoming", goal: goal("11111111-1111-4111-8111-111111111111", "Ship it") },
      { section: "archived", goal: goal("22222222-2222-4222-8222-222222222222", "Old idea") },
    ],
  };
}

function devToolsRun(): DevToolsRunSummary {
  return {
    id: "run-1",
    firstMessage: "hello",
    stepCount: 0,
    totalDurationMs: null,
    modelId: null,
    isInProgress: false,
    hasError: false,
  } as unknown as DevToolsRunSummary;
}

function workflowRun(status: WorkflowRunRecord["status"]): WorkflowRunRecord {
  return {
    id: "wfr_test",
    workspaceId: "ws-1",
    workflow: { name: "deploy", description: "deploy", scope: "project", executable: true },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:test",
    args: {},
    status,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:01.000Z",
    events: [],
    steps: [],
  };
}

let harness: ConnectionHarness;

function Wrapper(props: { children: ReactNode }) {
  const Connection = harness.Wrapper;
  return (
    <Connection>
      <RouterProvider>
        <SettingsProvider>{props.children}</SettingsProvider>
      </RouterProvider>
    </Connection>
  );
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

function noop() {
  return undefined;
}

describe.each([...GAP_MODES])("panes kept across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    harness = createConnectionHarness(mode, serverOverrides);
    mutations = [];
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a server cancel on a live socket shows the MCP load error and ends its spinner", async () => {
    answerServers = serverCancel;
    const view = render(<ProjectMCPOverview projectPath="/projects/cancel" />, {
      wrapper: Wrapper,
    });
    await flush();

    expect(view.queryByText("cancelled by the server")).not.toBeNull();
    expect(view.container.querySelector(".animate-spin")).toBeNull();
  });

  test("a server cancel on a live socket shows the process output error instead of loading", async () => {
    answerOutput = serverCancel;
    const view = render(
      <BackgroundBashOutputDialog open onOpenChange={noop} workspaceId="ws-1" processId="p1" />,
      { wrapper: Wrapper }
    );
    await flush();

    expect(view.queryByText("cancelled by the server")).not.toBeNull();
    expect(view.queryByText("Loading…")).toBeNull();
  });

  test("the Workflows tab disables Run while there is no live client", async () => {
    const view = render(<WorkflowsTab workspaceId="ws-1" />, { wrapper: Wrapper });
    const run = () => view.getByRole("button", { name: /Run/ }) as HTMLButtonElement;
    await view.findByText("deploy");
    expect(run().disabled).toBe(false);

    await drop();
    expect(view.queryByText("deploy")).not.toBeNull();
    expect(run().disabled).toBe(true);

    await reconnect();
    expect(run().disabled).toBe(false);
    fireEvent.click(run());
    await waitFor(() => expect(mutations).toEqual(["start"]));
  });

  // Offline the board stays on screen read-only, as other kept panes do: its actions are server
  // changes, so they are disabled (not "offline" on click). An open editor keeps its text.
  test("goal-board actions are disabled while offline, and return after the reconnect", async () => {
    const view = render(
      <GoalBoardSections workspaceId="ws-1" board={goalBoard()} onMutated={noop} />,
      { wrapper: Wrapper }
    );
    await flush();
    fireEvent.click(view.getByRole("button", { name: /Archived/ }));
    fireEvent.click(view.getByRole("button", { name: "Edit Ship it" }));
    const actions = ["Save", "Revive Old idea", "Queue another goal"];
    // happy-dom does not apply a disabled fieldset to `disabled`: read the fieldset too.
    const enabledActions = () =>
      actions.filter((name) => {
        const button = view.getByRole("button", { name }) as HTMLButtonElement;
        return !button.disabled && button.closest("fieldset")?.disabled !== true;
      });
    expect(enabledActions()).toEqual(actions);

    await drop();
    expect(enabledActions()).toEqual([]);
    expect(view.queryByLabelText("Goal objective")).not.toBeNull();
    expect(view.queryByText(/Not connected/)).toBeNull();

    await reconnect();
    expect(enabledActions()).toEqual(actions);
    expect(mutations).toEqual([]);
  });

  test("a background process opened offline ends its loading state, and loads on the next client", async () => {
    await drop();
    answerOutput = () => Promise.resolve(outputResult("line A"));
    const view = render(
      <BackgroundBashOutputDialog open onOpenChange={noop} workspaceId="ws-1" processId="p1" />,
      { wrapper: Wrapper }
    );
    await flush();
    expect(view.queryByText("Loading…")).toBeNull();

    const next = Promise.withResolvers<unknown>();
    answerOutput = () => next.promise;
    await reconnect();
    expect(view.queryByText("Loading…")).not.toBeNull();
    next.resolve(outputResult("line A"));
    await view.findByText("line A");
  });

  test("an expanded DevTools run whose detail the drop cut off reads it again on the next client", async () => {
    answerRunDetail = pending;
    const view = render(<DevToolsRunCard run={devToolsRun()} workspaceId="ws-1" />, {
      wrapper: Wrapper,
    });
    fireEvent.click(view.getByRole("button", { name: /hello/ }));
    await flush();

    await drop();
    expect(view.queryByText(/Not connected/)).toBeNull();

    answerRunDetail = () => Promise.resolve(null);
    await reconnect();
    await view.findByText("No steps recorded");
    expect(view.queryByText(/Not connected/)).toBeNull();
  });

  test("the run header's actions are disabled while there is no live client", async () => {
    const live = workflowRun("running");
    const interrupted = workflowRun("interrupted");
    const view = render(
      <>
        <WorkflowRunHeader workspaceId="ws-1" run={live} view={projectWorkflowRun(live)} />
        <WorkflowRunHeader
          workspaceId="ws-1"
          run={interrupted}
          view={projectWorkflowRun(interrupted)}
        />
      </>,
      { wrapper: Wrapper }
    );
    const interrupt = () => view.getByRole("button", { name: /Interrupt/ }) as HTMLButtonElement;
    const resume = () => view.getByRole("button", { name: /Resume/ }) as HTMLButtonElement;
    expect(interrupt().disabled).toBe(false);
    expect(resume().disabled).toBe(false);

    await drop();
    expect(interrupt().disabled).toBe(true);
    expect(resume().disabled).toBe(true);

    await reconnect();
    expect(interrupt().disabled).toBe(false);
    expect(resume().disabled).toBe(false);
  });

  test("DevTools Clear is disabled while there is no live client", async () => {
    const view = render(<DevToolsTab workspaceId="ws-1" />, { wrapper: Wrapper });
    const clear = () => view.getByRole("button", { name: "Clear debug logs" }) as HTMLButtonElement;
    await view.findByText("hello");
    expect(clear().disabled).toBe(false);

    await drop();
    expect(view.queryByText("hello")).not.toBeNull();
    expect(clear().disabled).toBe(true);

    await reconnect();
    expect(clear().disabled).toBe(false);
    fireEvent.click(clear());
    await waitFor(() => expect(mutations).toEqual(["clear"]));
  });

  test("a DevTools run expanded while reconnecting waits for its detail instead of showing none", async () => {
    answerRunDetail = () => Promise.resolve(null);
    const view = render(<DevToolsRunCard run={devToolsRun()} workspaceId="ws-1" />, {
      wrapper: Wrapper,
    });
    await drop();
    // In the kept gap the kept client's read fails at once with a lost connection.
    answerRunDetail = pending;
    fireEvent.click(view.getByRole("button", { name: /hello/ }));
    await flush();
    expect(view.queryByText("No steps recorded")).toBeNull();
    expect(view.container.querySelector(".animate-spin")).not.toBeNull();

    answerRunDetail = () => Promise.resolve(null);
    await reconnect();
    await view.findByText("No steps recorded");
  });
});
