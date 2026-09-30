import type { ComponentProps } from "react";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RealElapsedTimeDisplayModule from "@/browser/features/Tools/Shared/ElapsedTimeDisplay";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";

const useAdvisorToolLiveOutputMock = mock(
  (
    _workspaceId: string | undefined,
    _toolCallId: string | undefined
  ): WorkspaceStoreModule.AdvisorLiveOutputState | null => null
);

const useAdvisorToolLivePhaseMock = mock(
  (
    _workspaceId: string | undefined,
    _toolCallId: string | undefined
  ): WorkspaceStoreModule.AdvisorLivePhaseState | undefined => undefined
);

const useAdvisorToolLiveReasoningMock = mock(
  (
    _workspaceId: string | undefined,
    _toolCallId: string | undefined
  ): WorkspaceStoreModule.AdvisorLiveReasoningState | null => null
);

/* eslint-disable @typescript-eslint/no-require-imports */
const actualWorkspaceStore =
  require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// Restore the real modules after this suite so the stubs below cannot leak into later files.
restoreModulesAfterSuite([
  ["@/browser/stores/WorkspaceStore", { ...RealWorkspaceStoreModule }],
  ["@/browser/features/Tools/Shared/ElapsedTimeDisplay", { ...RealElapsedTimeDisplayModule }],
]);
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...actualWorkspaceStore,
  useAdvisorToolLiveOutput: useAdvisorToolLiveOutputMock,
  useAdvisorToolLivePhase: useAdvisorToolLivePhaseMock,
  useAdvisorToolLiveReasoning: useAdvisorToolLiveReasoningMock,
}));

void mock.module("@/browser/features/Tools/Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: ({
    startedAt,
    isActive,
  }: {
    startedAt: number | undefined;
    isActive: boolean;
  }) => (
    <span
      data-testid="elapsed-time"
      data-active={String(isActive)}
      data-started-at={startedAt == null ? "missing" : String(startedAt)}
    />
  ),
}));

import { AdvisorToolCall } from "./AdvisorToolCall";

function renderAdvisorToolCall(props: Partial<ComponentProps<typeof AdvisorToolCall>> = {}) {
  return render(
    <TooltipProvider>
      <AdvisorToolCall
        args={{}}
        status="executing"
        workspaceId="workspace-1"
        toolCallId="advisor-call-1"
        startedAt={1_700_000_000_000}
        {...props}
      />
    </TooltipProvider>
  );
}

describe("AdvisorToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;

    useAdvisorToolLiveOutputMock.mockReset();
    useAdvisorToolLivePhaseMock.mockReset();
    useAdvisorToolLiveReasoningMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("auto-expands while executing and shows live phase timing", () => {
    const startedAt = 1_700_000_000_123;

    useAdvisorToolLivePhaseMock.mockReturnValue({
      phase: "waiting_for_response",
      timestamp: startedAt + 250,
    });

    const view = renderAdvisorToolCall({ startedAt });

    expect(useAdvisorToolLivePhaseMock).toHaveBeenCalledWith("workspace-1", "advisor-call-1");
    expect(view.getAllByText("Waiting for response")).toHaveLength(2);

    let timers = view.getAllByTestId("elapsed-time");
    expect(timers).toHaveLength(2);
    for (const timer of timers) {
      expect(timer.dataset.active).toBe("true");
      expect(timer.dataset.startedAt).toBe(String(startedAt));
    }

    fireEvent.click(view.getByText("advisor"));

    expect(view.getAllByText("Waiting for response")).toHaveLength(1);
    timers = view.getAllByTestId("elapsed-time");
    expect(timers).toHaveLength(1);
    expect(timers[0]?.dataset.active).toBe("true");
    expect(timers[0]?.dataset.startedAt).toBe(String(startedAt));
  });

  test("falls back to a generic running state before a live phase arrives", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);

    const view = renderAdvisorToolCall();

    expect(view.getAllByText("Running")).toHaveLength(2);
    const timers = view.getAllByTestId("elapsed-time");
    expect(timers).toHaveLength(2);
    for (const timer of timers) {
      expect(timer.dataset.active).toBe("true");
    }
  });

  test("renders the advisor question when present", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);

    const view = renderAdvisorToolCall({
      args: { question: "  Should we split the refactor into smaller commits?  " },
      status: "completed",
      result: {
        type: "advice",
        advice: "Prefer the smaller diff so reviewers can verify it quickly.",
        advisorModel: "openai:gpt-4.1-mini",
        remainingUses: 1,
      },
    });

    fireEvent.click(view.getByText("advisor"));

    expect(view.getByText("Question")).toBeTruthy();
    expect(view.getByText("Should we split the refactor into smaller commits?")).toBeTruthy();
  });

  test("renders live advisor output while auto-expanded during execution", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue({
      phase: "waiting_for_response",
      timestamp: 1,
    });
    useAdvisorToolLiveOutputMock.mockReturnValue({
      text: "Streamed partial advice",
      timestamp: 2,
    });

    const view = renderAdvisorToolCall({ status: "executing" });

    expect(useAdvisorToolLiveOutputMock).toHaveBeenCalledWith("workspace-1", "advisor-call-1");
    expect(view.getByText("Advice")).toBeTruthy();
    expect(view.getByText("Streamed partial advice")).toBeTruthy();
  });

  test("renders live advisor reasoning separately from live advice", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue({
      phase: "waiting_for_response",
      timestamp: 1,
    });
    useAdvisorToolLiveReasoningMock.mockReturnValue({
      text: "Considering the risky edge case",
      timestamp: 2,
    });
    useAdvisorToolLiveOutputMock.mockReturnValue({
      text: "Prefer the safer path",
      timestamp: 3,
    });

    const view = renderAdvisorToolCall({ status: "executing" });

    expect(useAdvisorToolLiveReasoningMock).toHaveBeenCalledWith("workspace-1", "advisor-call-1");
    expect(view.getByText("Thinking")).toBeTruthy();
    expect(view.getByText("Considering the risky edge case")).toBeTruthy();
    expect(view.getByText("Advice")).toBeTruthy();
    expect(view.getByText("Prefer the safer path")).toBeTruthy();
  });

  test("collapses back to the settled default when execution completes", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue({
      phase: "waiting_for_response",
      timestamp: 1,
    });
    useAdvisorToolLiveOutputMock.mockReturnValue({
      text: "Streamed partial advice",
      timestamp: 2,
    });

    const view = renderAdvisorToolCall({ status: "executing" });

    expect(view.getByText("Streamed partial advice")).toBeTruthy();

    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);
    useAdvisorToolLiveOutputMock.mockReturnValue(null);

    view.rerender(
      <TooltipProvider>
        <AdvisorToolCall
          args={{}}
          status="completed"
          workspaceId="workspace-1"
          toolCallId="advisor-call-1"
          startedAt={1_700_000_000_000}
          result={{
            type: "advice",
            advice: "Final persisted advice",
            advisorModel: "openai:gpt-4.1-mini",
            remainingUses: 1,
          }}
        />
      </TooltipProvider>
    );

    expect(view.queryByText("Final persisted advice")).toBeNull();

    fireEvent.click(view.getByText("advisor"));

    expect(view.getByText("Final persisted advice")).toBeTruthy();
  });

  test("does not auto-expand executing rows that already have terminal results", () => {
    const cases: Array<{
      name: string;
      result: unknown;
      textAfterExpand: string;
      verifyExpandedDetails?: boolean;
    }> = [
      {
        name: "limit",
        result: {
          type: "limit_reached",
          advisorModel: "openai:gpt-4.1-mini",
          message: "Unique advisor limit reached message",
        },
        textAfterExpand: "Unique advisor limit reached message",
      },
      {
        name: "error",
        result: {
          type: "error",
          message: "Unique advisor failure message",
        },
        textAfterExpand: "Unique advisor failure message",
      },
      {
        name: "unrecognized",
        result: {
          type: "unexpected",
          message: "unexpected raw payload",
        },
        textAfterExpand: "Unrecognized advisor tool output shape",
        // Expanding unrecognized output renders JsonHighlight, which needs ThemeProvider;
        // this case only needs to prove terminal-result rows stay collapsed by default.
        verifyExpandedDetails: false,
      },
    ];

    for (const testCase of cases) {
      const view = renderAdvisorToolCall({
        status: "executing",
        result: testCase.result,
        toolCallId: `advisor-call-${testCase.name}`,
      });

      expect(view.queryByText(testCase.textAfterExpand)).toBeNull();

      if (testCase.verifyExpandedDetails !== false) {
        fireEvent.click(view.getByText("advisor"));

        expect(view.getByText(testCase.textAfterExpand)).toBeTruthy();
      }
      view.unmount();
    }
  });

  test("completed advice supersedes live advisor output", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);
    useAdvisorToolLiveOutputMock.mockReturnValue({
      text: "Older streamed partial advice",
      timestamp: 2,
    });

    const view = renderAdvisorToolCall({
      status: "completed",
      result: {
        type: "advice",
        advice: "Final persisted advice",
        advisorModel: "openai:gpt-4.1-mini",
        remainingUses: 1,
      },
    });

    fireEvent.click(view.getByText("advisor"));

    expect(view.getByText("Final persisted advice")).toBeTruthy();
    expect(view.queryByText("Older streamed partial advice")).toBeNull();
  });

  test("continues rendering completed advice results", () => {
    useAdvisorToolLivePhaseMock.mockReturnValue(undefined);

    const view = renderAdvisorToolCall({
      status: "completed",
      result: {
        type: "advice",
        advice: "Prefer the smaller diff so reviewers can verify it quickly.",
        advisorModel: "openai:gpt-4.1-mini",
        remainingUses: 1,
      },
    });

    fireEvent.click(view.getByText("advisor"));

    expect(
      view.getByText("Prefer the smaller diff so reviewers can verify it quickly.")
    ).toBeTruthy();
    expect(view.queryByTestId("elapsed-time")).toBeNull();
  });
});
