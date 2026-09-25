import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { APIContext } from "@/browser/contexts/API";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as OriginalWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as OriginalWorkflowToolSharedModule from "@/browser/features/Tools/WorkflowToolShared";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";

import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";

// Restore the real modules once this suite ends: the overlay below otherwise stays registered
// for every later file in the bun process (ModelsSection.discovery timed out behind it).
// Spread before mocking; the namespace imports are live bindings the mocks would replace.
restoreModulesAfterSuite([
  ["@/browser/stores/WorkspaceStore", { ...OriginalWorkspaceStoreModule }],
  ["@/browser/features/Tools/WorkflowToolShared", { ...OriginalWorkflowToolSharedModule }],
]);

void mock.module("@/browser/features/Tools/WorkflowToolShared", () => ({
  WorkflowJsonBlock: (props: { value: unknown; ariaLabel: string }) => (
    <pre aria-label={props.ariaLabel}>{JSON.stringify(props.value)}</pre>
  ),
}));

let workflowTaskWorkspaces = new Map<string, FrontendWorkspaceMetadata>();
let navigateToWorkspace: (workspaceId: string) => void = () => undefined;
const workspaceStoreSubscribers = new Set<() => void>();

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceStore =
  require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// Spread the real module and overlay (not replace) the raw store, so code this suite does not
// control keeps working against a complete store while the mock is registered.
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useWorkspaceStoreRaw: () =>
    overlayWorkspaceStoreRaw(actualWorkspaceStore.useWorkspaceStoreRaw(), {
      subscribeDerived: (listener: () => void) => {
        workspaceStoreSubscribers.add(listener);
        return () => workspaceStoreSubscribers.delete(listener);
      },
      getWorkspaceMetadata: (workspaceId: string) => workflowTaskWorkspaces.get(workspaceId),
      navigateToWorkspace: (workspaceId: string) => navigateToWorkspace(workspaceId),
    }),
}));

import type { WorkflowRunView } from "./projectWorkflowRun";
import { WorkflowTimeline } from "./WorkflowTimeline";

function createWorkflowTaskWorkspaceMetadata(workspaceId: string): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    name: workspaceId,
    title: workspaceId,
    projectPath: "/repo",
    projectName: "repo",
    namedWorkspacePath: `/repo/${workspaceId}`,
    createdAt: "2026-05-29T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/mux-src" },
  };
}

function syncWorkflowTaskWorkspaces(nextWorkspaces: Map<string, FrontendWorkspaceMetadata>): void {
  workflowTaskWorkspaces = nextWorkspaces;
  for (const subscriber of workspaceStoreSubscribers) {
    subscriber();
  }
}

function normalizeText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function makeCompletedView(): WorkflowRunView {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    id: "wfr_test",
    workflow: {
      name: "test-workflow",
      description: "Test workflow",
      scope: "project",
      executable: true,
    },
    status: "completed",
    argEntries: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    phases: [],
    steps: [],
    result: {
      reportMarkdown: "",
      structuredOutput: {
        outcome: "converged",
        verifierRuns: 1,
        nested: { ignored: true },
      },
    },
    errorMessage: null,
    stats: {
      total: 0,
      done: 0,
      running: 0,
      failed: 0,
      elapsedMs: 0,
    },
  };
}

function makeRunningStepView(taskId: string): WorkflowRunView {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    ...makeCompletedView(),
    status: "running",
    phases: [
      {
        name: "implementation",
        label: "Implementation",
        steps: [
          {
            stepId: "implement",
            taskId,
            taskWorkspaceId: taskId,
            status: "running",
            title: "Implement #160",
            phaseName: "implementation",
            startedAt: timestamp,
          },
        ],
        done: 0,
        total: 1,
        running: true,
        failed: false,
        lifecycle: "running",
        latest: true,
      },
    ],
    steps: [],
    result: null,
    stats: {
      total: 1,
      done: 0,
      running: 1,
      failed: 0,
      elapsedMs: 0,
    },
  };
}

function makeCompletedStepView(taskId: string): WorkflowRunView {
  const startedAt = "2026-06-25T12:00:00.000Z";
  const completedAt = "2026-06-25T12:00:02.000Z";
  return {
    ...makeCompletedView(),
    phases: [
      {
        name: "review",
        label: "Review",
        steps: [
          {
            stepId: "review",
            taskId,
            taskWorkspaceId: taskId,
            status: "completed",
            title: "Review implementation",
            phaseName: "review",
            startedAt,
            completedAt,
            durationMs: 2000,
            result: {
              title: "Review result",
              reportMarkdown: "Completed step report body.",
            },
          },
        ],
        done: 1,
        total: 1,
        running: false,
        failed: false,
        lifecycle: "completed",
        latest: true,
      },
    ],
    steps: [],
    result: null,
    stats: {
      total: 1,
      done: 1,
      running: 0,
      failed: 0,
      elapsedMs: 2000,
    },
  };
}

function makeCompletedEvaluationStepView(evaluation: {
  modelString: string;
  responseModelId: string;
}): WorkflowRunView {
  const startedAt = "2026-06-25T12:00:00.000Z";
  const completedAt = "2026-06-25T12:00:02.000Z";
  return {
    ...makeCompletedView(),
    phases: [
      {
        name: "screen",
        label: "Screen",
        steps: [
          {
            stepId: "screen-issue",
            status: "completed",
            title: "Screen issue",
            phaseName: "screen",
            startedAt,
            completedAt,
            durationMs: 2000,
            evaluation: { ...evaluation, attempt: 1, cached: false },
          },
        ],
        done: 1,
        total: 1,
        running: false,
        failed: false,
        lifecycle: "completed",
        latest: true,
      },
    ],
    steps: [],
    result: null,
    stats: { total: 1, done: 1, running: 0, failed: 0, elapsedMs: 2000 },
  };
}

function makeNestedWorkflowParentView(): WorkflowRunView {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    ...makeCompletedView(),
    status: "running",
    phases: [
      {
        name: "delegate",
        label: "delegate",
        steps: [
          {
            stepId: "implementation-loop",
            status: "running",
            title: "implementation-loop",
            phaseName: "delegate",
            startedAt: timestamp,
            nestedWorkflowRunId: "wfr_child01",
            nestedWorkflowName: "implementation-loop",
            nestedWorkflowStatus: "started",
          },
        ],
        done: 0,
        total: 1,
        running: true,
        failed: false,
        lifecycle: "running",
        latest: true,
      },
    ],
    steps: [],
    result: null,
    stats: {
      total: 1,
      done: 0,
      running: 1,
      failed: 0,
      elapsedMs: 0,
    },
  };
}

function makeChildWorkflowRun(): WorkflowRunRecord {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    id: "wfr_child01",
    workspaceId: "workspace-main",
    workflow: {
      name: "implementation-loop",
      description: "Implement a nested slice",
      scope: "global",
      requestedScriptPath: "skill://implementation-loop/workflow.js",
      canonicalScriptPath: "skill://implementation-loop/workflow.js",
      sourceKind: "skill",
      sourceHash: "sha256:child",
      executable: true,
    },
    source: "export default function workflow() { return null; }",
    sourceHash: "sha256:child",
    args: { target: "coder/mux#3546" },
    parentWorkflow: {
      runId: "wfr_parent01",
      stepId: "implementation-loop",
      inputHash: "hash-child",
      depth: 0,
    },
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [
      { sequence: 1, type: "status", at: timestamp, status: "running" },
      { sequence: 2, type: "phase", at: timestamp, name: "child-phase" },
      {
        sequence: 3,
        type: "task",
        at: timestamp,
        stepId: "child-task",
        taskId: "task_child",
        status: "started",
        title: "Child task",
      },
    ],
    steps: [
      {
        stepId: "child-task",
        inputHash: "child-task-hash",
        status: "started",
        taskId: "task_child",
        startedAt: timestamp,
      },
    ],
  };
}

function renderWithWorkflowApi(ui: ReactElement, client: unknown) {
  return render(
    <APIContext.Provider
      value={{
        status: "connected",
        api: client as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {ui}
    </APIContext.Provider>
  );
}

describe("WorkflowTimeline", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    navigateToWorkspace = () => undefined;
    syncWorkflowTaskWorkspaces(new Map());
    workspaceStoreSubscribers.clear();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("opens an available child task workspace from a workflow step", () => {
    const navigatedTo: string[] = [];
    navigateToWorkspace = (workspaceId) => {
      navigatedTo.push(workspaceId);
    };
    syncWorkflowTaskWorkspaces(
      new Map([["task_live", createWorkflowTaskWorkspaceMetadata("task_live")]])
    );

    const view = render(<WorkflowTimeline view={makeRunningStepView("task_live")} />);

    fireEvent.click(view.getByRole("button", { name: "Implementation 0/1" }));
    fireEvent.click(
      view.getByRole("button", { name: "Open workspace for workflow step Implement #160" })
    );

    expect(navigatedTo).toEqual(["task_live"]);
  });

  test("hides child task workspace action when workspace metadata is missing", () => {
    const view = render(<WorkflowTimeline view={makeRunningStepView("task_deleted")} />);

    fireEvent.click(view.getByRole("button", { name: "Implementation 0/1" }));

    expect(
      view.queryByRole("button", { name: "Open workspace for workflow step Implement #160" })
    ).toBeNull();
  });

  test("hides workspace action when a step only references another task id", () => {
    syncWorkflowTaskWorkspaces(
      new Map([["task_source", createWorkflowTaskWorkspaceMetadata("task_source")]])
    );
    const workflowView = makeRunningStepView("task_source");
    delete workflowView.phases[0].steps[0].taskWorkspaceId;
    const view = render(<WorkflowTimeline view={workflowView} />);

    fireEvent.click(view.getByRole("button", { name: "Implementation 0/1" }));

    expect(
      view.queryByRole("button", { name: "Open workspace for workflow step Implement #160" })
    ).toBeNull();
  });

  test("opens completed step details independently from workspace navigation", () => {
    const navigatedTo: string[] = [];
    navigateToWorkspace = (workspaceId) => {
      navigatedTo.push(workspaceId);
    };
    syncWorkflowTaskWorkspaces(
      new Map([["task_completed", createWorkflowTaskWorkspaceMetadata("task_completed")]])
    );
    const view = render(<WorkflowTimeline view={makeCompletedStepView("task_completed")} />);

    fireEvent.click(view.getByRole("button", { name: "Review 1/1" }));
    expect(view.queryByText("Completed step report body.")).toBeNull();

    fireEvent.click(
      view.getByRole("button", { name: "Open workspace for workflow step Review implementation" })
    );

    expect(navigatedTo).toEqual(["task_completed"]);
    expect(view.queryByText("Completed step report body.")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Review implementation 2s" }));

    expect(view.getByText("Completed step report body.")).toBeDefined();
  });

  test("shows the response model only when it differs from the requested model id", () => {
    // Providers report bare ids (and the service falls back to the requested
    // bare id), while the admitted model string carries the provider prefix.
    const renderExpanded = (responseModelId: string) => {
      const view = render(
        <WorkflowTimeline
          view={makeCompletedEvaluationStepView({ modelString: "openai:gpt-5", responseModelId })}
        />
      );
      fireEvent.click(view.getByRole("button", { name: "Screen 1/1" }));
      fireEvent.click(view.getByRole("button", { name: /^Screen issue/ }));
      return view;
    };

    const same = renderExpanded("gpt-5");
    expect(same.getByText("openai:gpt-5")).toBeDefined();
    expect(same.queryByText(/^↳/)).toBeNull();
    same.unmount();

    const snapshot = renderExpanded("gpt-5-2026-03-01");
    expect(snapshot.getByText("↳ gpt-5-2026-03-01")).toBeDefined();
  });

  test("inlines a nested workflow run under its parent step", async () => {
    const requestedRunIds: string[] = [];
    const client = {
      workflows: {
        getRun: (input: { runId: string }) => {
          requestedRunIds.push(input.runId);
          return Promise.resolve(makeChildWorkflowRun());
        },
      },
    };

    const view = renderWithWorkflowApi(
      <WorkflowTimeline view={makeNestedWorkflowParentView()} workspaceId="workspace-main" />,
      client
    );

    fireEvent.click(view.getByRole("button", { name: "delegate 0/1" }));

    await waitFor(() => {
      expect(view.getByText("child-phase")).toBeDefined();
    });
    expect(requestedRunIds).toContain("wfr_child01");
    expect(view.getByText("running · 0/1 steps · child-phase")).toBeDefined();
  });

  test("keeps completed nested workflow duration out of the generic details card", async () => {
    const client = {
      workflows: {
        getRun: () => Promise.resolve(makeChildWorkflowRun()),
      },
    };
    const completedParentView = makeNestedWorkflowParentView();
    completedParentView.phases[0].done = 1;
    completedParentView.phases[0].running = false;
    completedParentView.phases[0].steps[0].status = "completed";
    completedParentView.phases[0].steps[0].completedAt = "2026-06-25T12:00:02.000Z";
    completedParentView.phases[0].steps[0].durationMs = 2000;
    completedParentView.phases[0].steps[0].nestedWorkflowStatus = "completed";
    completedParentView.phases[0].steps[0].result = {
      reportMarkdown: "Nested parent result should stay hidden.",
      structuredOutput: { nestedResult: true },
    };
    completedParentView.stats.done = 1;
    completedParentView.stats.running = 0;

    const view = renderWithWorkflowApi(
      <WorkflowTimeline view={completedParentView} workspaceId="workspace-main" />,
      client
    );

    fireEvent.click(view.getByRole("button", { name: "delegate 1/1" }));
    fireEvent.click(view.getByRole("button", { name: "implementation-loop 2s nested" }));

    await waitFor(() => {
      expect(view.getByText("Nested workflow implementation-loop")).toBeDefined();
    });
    expect(view.queryByText("Nested parent result should stay hidden.")).toBeNull();

    const durationLabels = Array.from(
      view.container.querySelectorAll("span"),
      normalizeText
    ).filter((text) => text === "2s");
    expect(durationLabels).toHaveLength(1);
  });

  test("uses active child run progress when the parent nested event is terminal", async () => {
    const client = {
      workflows: {
        getRun: () => Promise.resolve(makeChildWorkflowRun()),
      },
    };
    const staleParentView = makeNestedWorkflowParentView();
    staleParentView.phases[0].failed = true;
    staleParentView.phases[0].steps[0].status = "failed";
    staleParentView.phases[0].steps[0].nestedWorkflowStatus = "failed";

    const view = renderWithWorkflowApi(
      <WorkflowTimeline view={staleParentView} workspaceId="workspace-main" />,
      client
    );

    await waitFor(() => {
      expect(view.getByText("running · 0/1 steps · child-phase")).toBeDefined();
    });
  });

  test("auto-opens an active nested workflow when the child event arrives after mount", async () => {
    const client = {
      workflows: {
        getRun: () => Promise.resolve(makeChildWorkflowRun()),
      },
    };
    const initialView = makeNestedWorkflowParentView();
    delete initialView.phases[0].steps[0].nestedWorkflowRunId;
    delete initialView.phases[0].steps[0].nestedWorkflowName;
    delete initialView.phases[0].steps[0].nestedWorkflowStatus;
    const withApi = (timelineView: WorkflowRunView) => (
      <APIContext.Provider
        value={{
          status: "connected",
          api: client as never,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <WorkflowTimeline view={timelineView} workspaceId="workspace-main" />
      </APIContext.Provider>
    );

    const view = render(withApi(initialView));
    fireEvent.click(view.getByRole("button", { name: "delegate 0/1" }));
    expect(view.queryByText("Nested workflow implementation-loop")).toBeNull();

    view.rerender(withApi(makeNestedWorkflowParentView()));

    await waitFor(() => {
      expect(view.getByText("Nested workflow implementation-loop")).toBeDefined();
    });
  });

  test("renders final report stat chips as bold key before value", () => {
    const { container } = render(<WorkflowTimeline view={makeCompletedView()} />);

    const statTexts = Array.from(container.querySelectorAll("span"), normalizeText);
    const boldTexts = Array.from(container.querySelectorAll("b"), normalizeText);

    expect(statTexts).toContain("outcome converged");
    expect(statTexts).toContain("verifierRuns 1");
    expect(statTexts).not.toContain("converged outcome");
    expect(statTexts).not.toContain("1 verifierRuns");
    expect(boldTexts).toEqual(["outcome", "verifierRuns"]);
  });
});
