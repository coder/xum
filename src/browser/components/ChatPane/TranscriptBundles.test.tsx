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

  test("what the agent wrote stays in view, and the steps between open in place", () => {
    const messages = [say("update"), read("read-1"), read("read-2"), say("reply"), read("read-3")];
    const view = render(<Transcript messages={messages} isTurnActive={false} />);

    expect(shownRows(view.container)).toEqual(["update", "reply"]);
    const [first, second] = view.getAllByTestId("work-bundle");
    expect(first.textContent).toContain("Read 2 files");

    fireEvent.click(first);

    // The opened steps are listed one by one on a rail, between the two texts. Compact density
    // has no second fold inside an opened line.
    expect(shownRows(view.container)).toEqual(["update", "read-1", "read-2", "reply"]);
    expect(view.queryByTestId("operational-bundle")).toBeNull();
    const steps = view.getByTestId("work-bundle-steps");
    expect(shownRows(steps)).toEqual(["read-1", "read-2"]);
    // The other line is its own block and stays closed.
    expect(second.getAttribute("aria-expanded")).toBe("false");
    // The line and its steps share one block, which bounds where the opened line sticks.
    const block = first.closest('[data-testid="work-bundle-block"]');
    expect(block?.contains(steps)).toBe(true);
    expect(block?.contains(second)).toBe(false);

    fireEvent.click(view.getAllByTestId("work-bundle")[0]);
    expect(shownRows(view.container)).toEqual(["update", "reply"]);
  });

  test("a range that starts below a closed line mounts nothing for that stretch", () => {
    const messages = [read("read-1"), read("read-2"), say("reply")];
    function Tail() {
      const bundles = useTranscriptBundles({
        workspaceId: "ws",
        messages,
        transcriptDensity: "hyper",
        isTurnActive: false,
      });
      return (
        <TranscriptBundleRows
          workspaceId="ws"
          messages={messages.slice(1)}
          indexOffset={1}
          bundles={bundles}
          renderMessageAtIndex={(message, _index, options) => (
            <div key={options.key} data-row={message.id} />
          )}
        />
      );
    }
    const view = render(<Tail />);

    expect(shownRows(view.container)).toEqual(["reply"]);
    expect(view.queryByTestId("work-bundle-block")).toBeNull();
  });

  test("a live stretch mounts no step under its closed line, which names the step instead", () => {
    const messages = [say("update"), read("read-1"), read("read-2", "executing")];
    const view = render(<Transcript messages={messages} isTurnActive />);

    expect(shownRows(view.container)).toEqual(["update"]);
    const line = view.getByTestId("work-bundle");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("Reading a file");
  });

  test("a call that waits for approval shows under its closed line", () => {
    const messages = [say("update"), read("read-1"), read("read-2", "executing")];
    const view = render(
      <Transcript messages={messages} isTurnActive approvalToolCallIds={new Set(["read-2"])} />
    );

    expect(shownRows(view.container)).toEqual(["update", "read-2"]);
    expect(view.getByTestId("work-bundle").getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("work-bundle-steps")).toBeNull();
  });

  test("detailed density folds runs of routine calls and has no work lines", () => {
    const messages = [say("update"), read("read-1"), read("read-2"), say("reply")];
    function Detailed() {
      const bundles = useTranscriptBundles({
        workspaceId: "ws",
        messages,
        transcriptDensity: "normal",
        isTurnActive: false,
      });
      return (
        <TranscriptBundleRows
          workspaceId="ws"
          messages={messages}
          indexOffset={0}
          bundles={bundles}
          renderMessageAtIndex={(message, _index, options) => (
            <div key={options.key} data-row={message.id} />
          )}
        />
      );
    }
    const view = render(<Detailed />);

    expect(view.queryByTestId("work-bundle")).toBeNull();
    expect(shownRows(view.container)).toEqual(["update", "reply"]);
    fireEvent.click(view.getByTestId("operational-bundle"));
    expect(shownRows(view.container)).toEqual(["update", "read-1", "read-2", "reply"]);
  });
});
