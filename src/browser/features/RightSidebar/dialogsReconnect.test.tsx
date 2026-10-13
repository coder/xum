// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { BackgroundBashOutputDialog } from "@/browser/components/BackgroundBashOutputDialog/BackgroundBashOutputDialog";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { SubagentTranscriptDialog } from "@/browser/features/Tools/SubagentTranscriptDialog";
import type { TestApiOverrides } from "@/browser/testUtils";
import { PlanFileDialog } from "./PlanFileDialog";

/*
 * A dialog that shows loaded content keeps it across a dropped connection: the new client
 * reloads it in the background and replaces it only when the read lands. Opening another
 * workspace, task or process still clears it.
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

/** What each server procedure answers; a test swaps them before a reconnect. */
let answerPlan: () => Promise<unknown>;
let answerTranscript: () => Promise<unknown>;
let answerOutput: () => Promise<unknown>;

function planResult(content: string) {
  return { success: true as const, data: { content, path: "/plans/plan.md" } };
}

function transcriptResult(thinkingLevel: "low" | "high") {
  return { messages: [], thinkingLevel };
}

function outputResult(output: string) {
  return {
    success: true as const,
    data: { status: "exited" as const, output, nextOffset: output.length, truncatedStart: false },
  };
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    workspace: {
      getPlanContent: () => answerPlan(),
      getSubagentTranscript: () => answerTranscript(),
      backgroundBashes: { getOutput: () => answerOutput() },
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

/** Drop the connection and wait until the dialog settled on it. */
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

describe.each([...GAP_MODES])("dialogs across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    harness = createConnectionHarness(mode, serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the plan dialog keeps the shown plan until the new client's read lands", async () => {
    answerPlan = () => Promise.resolve(planResult("Plan A"));
    const view = render(<PlanFileDialog open onOpenChange={noop} workspaceId="ws-1" />, {
      wrapper: Wrapper,
    });
    await view.findByText("Plan A");

    await drop();
    expect(view.queryByText("Plan A")).not.toBeNull();
    expect(view.queryByText("API unavailable")).toBeNull();

    // The new client's read is still in flight, and is then cut off by a second drop.
    const pending = deferred<unknown>();
    answerPlan = () => pending.promise;
    await reconnect();
    expect(view.queryByText("Plan A")).not.toBeNull();
    expect(view.queryByText("Loading plan…")).toBeNull();
    await drop();
    expect(view.queryByText("Plan A")).not.toBeNull();
    expect(view.queryByTestId("plan-file-dialog-error")).toBeNull();

    const next = deferred<unknown>();
    answerPlan = () => next.promise;
    await reconnect();
    expect(view.queryByText("Plan A")).not.toBeNull();
    next.resolve(planResult("Plan B"));
    await view.findByText("Plan B");
    expect(view.queryByText("Plan A")).toBeNull();
  });

  test("the transcript dialog keeps the shown transcript until the new client's read lands", async () => {
    answerTranscript = () => Promise.resolve(transcriptResult("high"));
    const view = render(<SubagentTranscriptDialog open onOpenChange={noop} taskId="task-1" />, {
      wrapper: Wrapper,
    });
    await view.findByText("thinking: high");
    expect(view.queryByText("Transcript is empty")).not.toBeNull();

    // Offline may show an error box, but above the transcript, which stays.
    await drop();
    expect(view.queryByText("thinking: high")).not.toBeNull();
    expect(view.queryByText("Transcript is empty")).not.toBeNull();

    const pending = deferred<unknown>();
    answerTranscript = () => pending.promise;
    await reconnect();
    expect(view.queryByText("thinking: high")).not.toBeNull();
    expect(view.queryByText("Transcript is empty")).not.toBeNull();
    await drop();
    expect(view.queryByText("Transcript is empty")).not.toBeNull();
    expect(view.queryByText(/WebSocket|connection/i)).toBeNull();

    const next = deferred<unknown>();
    answerTranscript = () => next.promise;
    await reconnect();
    next.resolve(transcriptResult("low"));
    await view.findByText("thinking: low");
  });

  test("the background process dialog keeps the shown output until the new client's read lands", async () => {
    answerOutput = () => Promise.resolve(outputResult("line A"));
    const view = render(
      <BackgroundBashOutputDialog open onOpenChange={noop} workspaceId="ws-1" processId="p1" />,
      { wrapper: Wrapper }
    );
    await view.findByText("line A");

    await drop();
    expect(view.queryByText("line A")).not.toBeNull();

    const pending = deferred<unknown>();
    answerOutput = () => pending.promise;
    await reconnect();
    expect(view.queryByText("line A")).not.toBeNull();
    expect(view.queryByText("Loading…")).toBeNull();
    await drop();
    expect(view.queryByText("line A")).not.toBeNull();
    expect(view.queryByText(/WebSocket|connection/i)).toBeNull();

    // The new read is a fresh tail: it replaces the kept output instead of appending to it.
    const next = deferred<unknown>();
    answerOutput = () => next.promise;
    await reconnect();
    next.resolve(outputResult("line B"));
    await view.findByText("line B");
    expect(view.queryByText(/line A/)).toBeNull();
  });
});

describe("dialogs opened on other data", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    harness = createConnectionHarness("kept-gap", serverOverrides);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("another workspace clears the shown plan while its own plan loads", async () => {
    answerPlan = () => Promise.resolve(planResult("Plan A"));
    const view = render(<PlanFileDialog open onOpenChange={noop} workspaceId="ws-1" />, {
      wrapper: Wrapper,
    });
    await view.findByText("Plan A");

    const pending = deferred<unknown>();
    answerPlan = () => pending.promise;
    view.rerender(<PlanFileDialog open onOpenChange={noop} workspaceId="ws-2" />);
    await waitFor(() => expect(view.queryByText("Loading plan…")).not.toBeNull());
    expect(view.queryByText("Plan A")).toBeNull();
  });

  test("another process clears the shown output while its own output loads", async () => {
    answerOutput = () => Promise.resolve(outputResult("line A"));
    const view = render(
      <BackgroundBashOutputDialog open onOpenChange={noop} workspaceId="ws-1" processId="p1" />,
      { wrapper: Wrapper }
    );
    await view.findByText("line A");

    const pending = deferred<unknown>();
    answerOutput = () => pending.promise;
    view.rerender(
      <BackgroundBashOutputDialog open onOpenChange={noop} workspaceId="ws-1" processId="p2" />
    );
    await waitFor(() => expect(view.queryByText("Loading…")).not.toBeNull());
    expect(view.queryByText("line A")).toBeNull();
  });
});
