import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import { useTranscriptRowDerivations, useUserMessageNavigation } from "./transcriptRowDerivations";

const NO_MESSAGES: DisplayedMessage[] = [];

function userRow(n: number): DisplayedMessage {
  return {
    type: "user",
    id: `u${n}`,
    historyId: `h${n}`,
    content: `prompt ${n}`,
    historySequence: n,
  };
}

function assistantRow(n: number, content: string): DisplayedMessage {
  return {
    type: "assistant",
    id: `a${n}`,
    historyId: `ha${n}`,
    content,
    historySequence: n,
    isStreaming: false,
    isPartial: false,
    isCompacted: false,
    isIdleCompacted: false,
  };
}

describe("useTranscriptRowDerivations", () => {
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

  // Forked workspaces copy transcripts, so group keys (message IDs) repeat across workspaces.
  // The first render of another workspace must not show the previous one's expanded groups.
  test("does not carry expanded bash_output groups into another workspace's first render", () => {
    const expandedPerRender: Array<{ workspaceId: string; expanded: boolean }> = [];
    const { result, rerender } = renderHook(
      (props: { workspaceId: string }) => {
        const derivations = useTranscriptRowDerivations({
          workspaceId: props.workspaceId,
          messages: NO_MESSAGES,
        });
        expandedPerRender.push({
          workspaceId: props.workspaceId,
          expanded: derivations.expandedBashGroups.has("shared-group"),
        });
        return derivations;
      },
      { initialProps: { workspaceId: "ws-a" } }
    );

    act(() => result.current.toggleBashOutputGroup("shared-group"));
    expect(result.current.expandedBashGroups.has("shared-group")).toBe(true);

    rerender({ workspaceId: "ws-b" });
    expect(expandedPerRender.filter((r) => r.workspaceId === "ws-b" && r.expanded)).toEqual([]);

    // Expanding in the new workspace still works.
    act(() => result.current.expandBashGroup("shared-group"));
    expect(result.current.expandedBashGroups.has("shared-group")).toBe(true);
  });

  // Rows are memoized on prop identity (#4961 F20): a stream delta or a page of older rows must
  // not hand unchanged user rows a new navigation object, or every mounted prompt re-renders.
  describe("useUserMessageNavigation", () => {
    const onNavigate = () => undefined;
    const u2 = userRow(2);
    const u4 = userRow(4);
    const u6 = userRow(6);

    test("keeps navigation objects across a stream delta that touches no user row", () => {
      const { result, rerender } = renderHook(
        (props: { messages: DisplayedMessage[] }) =>
          useUserMessageNavigation({ messages: props.messages, onNavigateToMessage: onNavigate }),
        { initialProps: { messages: [u2, u4, u6, assistantRow(7, "partial")] } }
      );
      const before = result.current;

      rerender({ messages: [u2, u4, u6, assistantRow(7, "partial reply")] });

      expect(result.current?.get("h2")).toBe(before?.get("h2"));
      expect(result.current?.get("h4")).toBe(before?.get("h4"));
      expect(result.current?.get("h6")).toBe(before?.get("h6"));
    });

    test("replaces only the navigation whose neighbor changed when older rows load", () => {
      const { result, rerender } = renderHook(
        (props: { messages: DisplayedMessage[] }) =>
          useUserMessageNavigation({ messages: props.messages, onNavigateToMessage: onNavigate }),
        { initialProps: { messages: [u4, u6] } }
      );
      const before = result.current;

      rerender({ messages: [u2, u4, u6] });

      expect(result.current?.get("h6")).toBe(before?.get("h6"));
      expect(result.current?.get("h4")).not.toBe(before?.get("h4"));
      expect(result.current?.get("h4")).toMatchObject({
        prevUserMessageId: "h2",
        nextUserMessageId: "h6",
      });
      expect(result.current?.get("h2")).toMatchObject({ nextUserMessageId: "h4" });
    });
  });
});
