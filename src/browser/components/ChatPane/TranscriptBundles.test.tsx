import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import { TranscriptBundleRows, useTranscriptBundles } from "./TranscriptBundles";

const NO_MESSAGES: DisplayedMessage[] = [];

describe("useTranscriptBundles", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  // Forked workspaces copy transcripts, so bundle keys (derived from message IDs) repeat across
  // workspaces. No render of another workspace may show the previous one's expansion choices.
  test("does not carry bundle expansion overrides into another workspace's renders", () => {
    const rendersWithOverride: string[] = [];
    const { result, rerender } = renderHook(
      (props: { workspaceId: string }) => {
        const bundles = useTranscriptBundles({
          workspaceId: props.workspaceId,
          messages: NO_MESSAGES,
          transcriptDensity: "hyper",
          isTurnActive: false,
        });
        if (
          bundles.workBundleExpansionOverrides.has("shared-bundle") ||
          bundles.operationalBundleExpansionOverrides.has("shared-bundle")
        ) {
          rendersWithOverride.push(props.workspaceId);
        }
        return bundles;
      },
      { initialProps: { workspaceId: "ws-a" } }
    );

    act(() => {
      result.current.setWorkBundleExpanded("shared-bundle", true);
      result.current.setOperationalBundleExpanded("shared-bundle", true);
    });
    expect(result.current.workBundleExpansionOverrides.get("shared-bundle")).toBe(true);
    expect(result.current.operationalBundleExpansionOverrides.get("shared-bundle")).toBe(true);

    rendersWithOverride.length = 0;
    rerender({ workspaceId: "ws-b" });
    expect(rendersWithOverride).toEqual([]);

    // Choices are per visit: returning without touching anything in the other workspace starts
    // empty too, instead of restoring the earlier visit's choices.
    rerender({ workspaceId: "ws-a" });
    expect(rendersWithOverride).toEqual([]);
    rerender({ workspaceId: "ws-b" });

    // Setting a choice in the new workspace stores it for that workspace only.
    act(() => result.current.setOperationalBundleExpanded("shared-bundle", false));
    expect(result.current.operationalBundleExpansionOverrides.get("shared-bundle")).toBe(false);
    expect(result.current.workBundleExpansionOverrides.has("shared-bundle")).toBe(false);

    // Returning after a choice in the other workspace starts empty again as well.
    rendersWithOverride.length = 0;
    rerender({ workspaceId: "ws-a" });
    expect(rendersWithOverride).toEqual([]);
  });
});

// The rows a host mounts for a turn at compact density, with the real projection behind them.
describe("TranscriptBundleRows", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    const domWindow = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.window = domWindow;
    globalThis.document = domWindow.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  const HISTORY_ID = "history-turn";

  function read(id: string, status: "completed" | "executing" = "completed"): DisplayedMessage {
    return {
      type: "tool",
      id,
      historyId: HISTORY_ID,
      toolCallId: id,
      toolName: "file_read",
      args: {},
      status,
      isPartial: false,
      historySequence: 1,
    };
  }

  function say(id: string): DisplayedMessage {
    return {
      type: "assistant",
      id,
      historyId: HISTORY_ID,
      content: id,
      historySequence: 1,
      isStreaming: false,
      isPartial: false,
      isCompacted: false,
      isIdleCompacted: false,
    };
  }

  function Transcript(props: {
    messages: DisplayedMessage[];
    isTurnActive: boolean;
    approvalToolCallIds?: ReadonlySet<string>;
  }) {
    const bundles = useTranscriptBundles({
      workspaceId: "ws",
      messages: props.messages,
      transcriptDensity: "hyper",
      isTurnActive: props.isTurnActive,
      approvalToolCallIds: props.approvalToolCallIds,
    });
    return (
      <TranscriptBundleRows
        workspaceId="ws"
        messages={props.messages}
        indexOffset={0}
        bundles={bundles}
        renderMessageAtIndex={(message, _index, options) => (
          <div key={options.key} data-row={message.id} />
        )}
      />
    );
  }

  function shownRows(container: HTMLElement): string[] {
    return [...container.querySelectorAll("[data-row]")].map(
      (row) => row.getAttribute("data-row") ?? ""
    );
  }

  test("a finished turn is one work line and the reply until the line is opened", () => {
    const messages = [say("narration"), read("read-1"), read("read-2"), say("reply")];
    const view = render(<Transcript messages={messages} isTurnActive={false} />);

    expect(shownRows(view.container)).toEqual(["reply"]);
    expect(view.queryByTestId("operational-bundle")).toBeNull();

    fireEvent.click(view.getByTestId("work-bundle"));

    // Opened, the turn reads as detailed density does: narration, the folded run, the reply.
    expect(shownRows(view.container)).toEqual(["narration", "reply"]);
    expect(view.getByTestId("operational-bundle").textContent).toContain("Read 2 files");
    // The steps hang off one rail, and the reply stands outside it.
    const steps = view.getByTestId("work-bundle-steps");
    expect(shownRows(steps)).toEqual(["narration"]);
    expect(steps.contains(view.getByTestId("operational-bundle"))).toBe(true);
  });

  test("a live turn mounts no step under its closed line, which names the step instead", () => {
    const messages = [say("narration"), read("read-1"), read("read-2", "executing")];
    const view = render(<Transcript messages={messages} isTurnActive />);

    expect(shownRows(view.container)).toEqual(["narration"]);
    expect(view.queryByTestId("operational-bundle")).toBeNull();
    const line = view.getByTestId("work-bundle");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("Reading a file");
  });

  test("a call that waits for approval shows on its own, without the run it belongs to", () => {
    const messages = [say("narration"), read("read-1"), read("read-2", "executing")];
    const view = render(
      <Transcript messages={messages} isTurnActive approvalToolCallIds={new Set(["read-2"])} />
    );

    expect(shownRows(view.container)).toEqual(["narration", "read-2"]);
    expect(view.queryByTestId("operational-bundle")).toBeNull();
    expect(view.getByTestId("work-bundle").getAttribute("aria-expanded")).toBe("false");
  });
});
