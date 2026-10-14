import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import { useTranscriptRowDerivations } from "./transcriptRowDerivations";

const NO_MESSAGES: DisplayedMessage[] = [];

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
});
