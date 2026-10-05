import type { UseSmoothStreamingTextOptions } from "@/browser/hooks/useSmoothStreamingText";
import { useSmoothStreamingText as importedUseSmoothStreamingText } from "@/browser/hooks/useSmoothStreamingText";
import { useWorkspaceStreamingStats as importedUseWorkspaceStreamingStats } from "@/browser/stores/WorkspaceStore";
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { MarkdownCore as ImportedMarkdownCore } from "./MarkdownCore";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { STATIC_STREAMING_MOUNT_MAX_CHARS } from "@/constants/streaming";

const actualMarkdownCore = ImportedMarkdownCore;
const actualUseSmoothStreamingText = importedUseSmoothStreamingText;
const actualUseWorkspaceStreamingStats = importedUseWorkspaceStreamingStats;

const mockUseSmoothStreamingText = mock(
  (options: UseSmoothStreamingTextOptions): { visibleText: string; isCaughtUp: boolean } => ({
    visibleText: options.fullText,
    isCaughtUp: !options.isStreaming,
  })
);

const mockUseWorkspaceStreamingStats = mock((_workspaceId: string) => null);

// Renders per content string, to see which chunks of a chunked row re-render.
const markdownCoreRenders = new Map<string, number>();

// Memoized like the real MarkdownCore, so identical props skip the render.
const MarkdownCoreStub = React.memo(function MarkdownCoreStub(props: {
  content: string;
  renderSynchronously?: boolean;
}) {
  markdownCoreRenders.set(props.content, (markdownCoreRenders.get(props.content) ?? 0) + 1);
  return (
    <div data-testid="markdown-core" data-sync={String(props.renderSynchronously === true)}>
      {props.content}
    </div>
  );
});

// Keep module mocks inside test hooks: Bun loads test files before afterAll runs, so
// file-scope mock.module() calls can pollute unrelated files during collection.
async function installTypewriterMarkdownModuleMocks() {
  await mock.module("./MarkdownCore", () => ({
    MarkdownCore: MarkdownCoreStub,
  }));
  await mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
    useSmoothStreamingText: mockUseSmoothStreamingText,
  }));
  await mock.module("@/browser/stores/WorkspaceStore", () => ({
    useWorkspaceStreamingStats: mockUseWorkspaceStreamingStats,
  }));
}

async function restoreTypewriterMarkdownModuleMocks() {
  // Bun 1.3.6's mock.module() has no disposer, and mock.restore() does not undo
  // module mocks. Restore the real exports so these stubs do not leak into later files.
  await mock.module("./MarkdownCore", () => ({
    MarkdownCore: actualMarkdownCore,
  }));
  await mock.module("@/browser/hooks/useSmoothStreamingText", () => ({
    useSmoothStreamingText: actualUseSmoothStreamingText,
  }));
  await mock.module("@/browser/stores/WorkspaceStore", () => ({
    useWorkspaceStreamingStats: actualUseWorkspaceStreamingStats,
  }));
}

describe("TypewriterMarkdown", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  afterAll(async () => {
    await restoreTypewriterMarkdownModuleMocks();
  });

  beforeEach(async () => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    await installTypewriterMarkdownModuleMocks();
    mockUseSmoothStreamingText.mockClear();
    mockUseWorkspaceStreamingStats.mockClear();
  });

  afterEach(async () => {
    cleanup();
    await restoreTypewriterMarkdownModuleMocks();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("passes smoothed visible text to MarkdownCore when streaming", () => {
    mockUseSmoothStreamingText.mockImplementationOnce(() => ({
      visibleText: "Hel",
      isCaughtUp: false,
    }));

    const view = render(
      <TypewriterMarkdown
        content="Hello world"
        isComplete={false}
        streamKey="msg-1"
        streamSource="live"
      />
    );

    expect(view.getByTestId("markdown-core").textContent).toBe("Hel");
    expect(mockUseSmoothStreamingText).toHaveBeenCalledWith({
      fullText: "Hello world",
      isStreaming: true,
      bypassSmoothing: false,
      streamKey: "msg-1",
      liveCharsPerSec: 0,
    });
  });

  // #5555: Streamdown's streaming mode paints nothing until its first transition commits, so a
  // row that mounts mid-stream (chat switch-back, bundle toggle) would flash empty.
  test("a row mounted mid-stream paints synchronously until its text next grows", () => {
    const view = render(
      <TypewriterMarkdown content="Already shown" isComplete={false} streamKey="msg-sync" />
    );
    const core = () => view.getByTestId("markdown-core");
    expect(core().dataset.sync).toBe("true");

    // Unchanged text (e.g. an unrelated parent re-render) keeps the synchronous paint.
    view.rerender(
      <TypewriterMarkdown content="Already shown" isComplete={false} streamKey="msg-sync" />
    );
    expect(core().dataset.sync).toBe("true");

    // New text returns the row to Streamdown's deferred streaming mode.
    view.rerender(
      <TypewriterMarkdown content="Already shown, more" isComplete={false} streamKey="msg-sync" />
    );
    expect(core().dataset.sync).toBe("false");

    // Completed rows render statically through the non-streaming path, never this one.
    view.rerender(
      <TypewriterMarkdown content="Already shown, more" isComplete={true} streamKey="msg-sync" />
    );
    expect(core().dataset.sync).toBe("false");
  });

  test("a row above the cap that mounts mid-stream renders in chunks, also after it completes", () => {
    // One synchronous render of the whole row would block the chat switch for too long (#5647).
    const paragraph = "y".repeat(500);
    const large = Array.from(
      { length: Math.ceil(STATIC_STREAMING_MOUNT_MAX_CHARS / 500) + 1 },
      () => paragraph
    ).join("\n\n");
    // Older chunks mount on later animation frames; none run in this test.
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => undefined;
    try {
      const view = render(
        <TypewriterMarkdown content={large} isComplete={false} streamKey="big" />
      );
      const cores = () => view.getAllByTestId("markdown-core");
      // Only the tail chunk mounts in the first commit, painted synchronously.
      expect(cores()).toHaveLength(1);
      expect(cores()[0].dataset.sync).toBe("true");

      view.rerender(<TypewriterMarkdown content={large} isComplete={true} streamKey="big" />);
      expect(cores().every((core) => core.dataset.sync === "true")).toBe(true);
      view.unmount();

      // A row that mounts complete keeps the single render.
      const done = render(
        <TypewriterMarkdown content={large} isComplete={true} streamKey="done" />
      );
      expect(done.getAllByTestId("markdown-core")).toHaveLength(1);
      expect(done.getByTestId("markdown-core").dataset.sync).toBe("false");
      done.unmount();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    }

    const atCap = "x".repeat(STATIC_STREAMING_MOUNT_MAX_CHARS);
    const capped = render(
      <TypewriterMarkdown content={atCap} isComplete={false} streamKey="cap" />
    );
    expect(capped.getByTestId("markdown-core").dataset.sync).toBe("true");
  });

  test("a chunked row bounds oversized blocks and re-renders whole for references at completion", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ` + "w".repeat(700));
    const hugeFence =
      "```ts\n" + "const x = 1;\n".repeat(STATIC_STREAMING_MOUNT_MAX_CHARS / 12) + "```";
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => undefined;
    try {
      // The tail chunk is one code block above the cap: it cannot be split, so it keeps the
      // deferred render instead of one long synchronous render.
      const withFence = [...paragraphs, hugeFence].join("\n\n");
      const fenceView = render(
        <TypewriterMarkdown content={withFence} isComplete={false} streamKey="fence" />
      );
      const fenceCores = fenceView.getAllByTestId("markdown-core");
      expect(fenceCores).toHaveLength(1);
      expect(fenceCores[0].dataset.sync).toBe("false");
      fenceView.unmount();

      // A reference defined in another chunk needs one render of the whole reply at completion.
      const withReference = [
        "See [the docs][ref].",
        ...paragraphs,
        "[ref]: https://example.com",
      ].join("\n\n");
      const refView = render(
        <TypewriterMarkdown content={withReference} isComplete={false} streamKey="ref" />
      );
      refView.rerender(
        <TypewriterMarkdown content={withReference} isComplete={true} streamKey="ref" />
      );
      expect(refView.getAllByTestId("markdown-core")).toHaveLength(1);
      expect(refView.getByTestId("markdown-core").textContent).toBe(withReference);
      refView.unmount();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    }
  });

  test("a growing chunked row re-renders only its open last chunk", async () => {
    const paragraphs = (count: number) =>
      Array.from({ length: count }, (_, i) => `Paragraph ${i} ` + "z".repeat(400)).join("\n\n");
    const content = paragraphs(Math.ceil(STATIC_STREAMING_MOUNT_MAX_CHARS / 400) + 5);
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) =>
      setTimeout(() => callback(performance.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    try {
      const view = render(
        <TypewriterMarkdown content={content} isComplete={false} streamKey="grow" />
      );
      const chunks = () => view.getAllByTestId("markdown-core").map((core) => core.textContent);
      // Wait until the older chunks have mounted over the frames.
      for (let i = 0; i < 100 && chunks().join("\n\n").length < content.length - 10; i++) {
        await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
      }
      const mounted = chunks();
      expect(mounted.length).toBeGreaterThan(3);

      markdownCoreRenders.clear();
      view.rerender(
        <TypewriterMarkdown
          content={content + "\n\nA new paragraph."}
          isComplete={false}
          streamKey="grow"
        />
      );
      // Sealed chunks keep identical props, so none of them renders again.
      for (const sealed of mounted.slice(0, -1)) {
        expect(markdownCoreRenders.get(sealed ?? "")).toBeUndefined();
      }
      expect(markdownCoreRenders.size).toBeGreaterThan(0);
      view.unmount();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancelRaf;
    }
  });

  test("bypasses smoothing for replay streams", () => {
    render(
      <TypewriterMarkdown
        content="Replayed content"
        isComplete={false}
        streamKey="msg-2"
        streamSource="replay"
      />
    );

    expect(mockUseSmoothStreamingText).toHaveBeenCalledWith(
      expect.objectContaining({ bypassSmoothing: true })
    );
  });

  // Regression: completed historical messages must not subscribe to live
  // streaming stats for their workspace, otherwise every assistant message in a
  // long transcript re-renders on every stream-delta of an active stream and
  // re-introduces the cascade jitter this PR is supposed to eliminate.
  test("completed messages subscribe with empty key (no live-stats updates)", () => {
    render(
      <TypewriterMarkdown
        content="Historical reply"
        isComplete={true}
        streamKey="msg-old"
        streamSource="live"
        workspaceId="ws-active"
      />
    );

    // Hook still runs (rules of hooks), but the key must be the no-op sentinel.
    expect(mockUseWorkspaceStreamingStats).toHaveBeenCalledWith("");
    expect(mockUseWorkspaceStreamingStats).not.toHaveBeenCalledWith("ws-active");
  });

  test("streaming messages subscribe with the real workspace key", () => {
    render(
      <TypewriterMarkdown
        content="Streaming reply"
        isComplete={false}
        streamKey="msg-live"
        streamSource="live"
        workspaceId="ws-active"
      />
    );

    expect(mockUseWorkspaceStreamingStats).toHaveBeenCalledWith("ws-active");
  });
});
