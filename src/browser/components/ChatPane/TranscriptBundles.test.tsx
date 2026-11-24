import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { DisplayedMessage } from "@/common/types/message";
import { useTranscriptBundles } from "./TranscriptBundles";

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
