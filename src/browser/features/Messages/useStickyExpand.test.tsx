import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type React from "react";
import { installDom } from "../../../../tests/ui/dom";

import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

import { MessageListProvider } from "./MessageListContext";
import { ToolNameProvider } from "./ToolNameContext";
import { useStickyExpand, type AutoExpandPrefs } from "./useStickyExpand";

// Tool blocks key their preference by tool name, resolved from ToolNameContext, so
// "tools" tests run under a provider. Defaults to "bash" for single-tool cases.
function makeWrapper(workspaceId: string | null, toolName: string | null = "bash") {
  return function Wrapper(props: { children: React.ReactNode }) {
    const withToolName =
      toolName == null ? (
        props.children
      ) : (
        <ToolNameProvider toolName={toolName}>{props.children}</ToolNameProvider>
      );
    if (workspaceId == null) {
      return <>{withToolName}</>;
    }
    return (
      <MessageListProvider value={{ workspaceId, latestMessageId: null }}>
        {withToolName}
      </MessageListProvider>
    );
  };
}

function readPrefs(workspaceId: string): AutoExpandPrefs {
  return readPersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey(workspaceId), {});
}

describe("useStickyExpand", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("seeds from the fallback when no preference is stored", () => {
    const collapsed = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(collapsed.result.current.expanded).toBe(false);

    const expanded = renderHook(() => useStickyExpand("thinking", true), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(expanded.result.current.expanded).toBe(true);
  });

  test("a stored preference wins over the fallback at mount", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { tools: { bash: true } });
    const overridden = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(overridden.result.current.expanded).toBe(true);

    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), {
      tools: { bash: true },
      thinking: false,
    });
    const collapsed = renderHook(() => useStickyExpand("thinking", true), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(collapsed.result.current.expanded).toBe(false);
  });

  test("a toggle writes only its own kind to the workspace preference", () => {
    const { result } = renderHook(() => useStickyExpand("thinking", false), {
      wrapper: makeWrapper("ws-1"),
    });

    act(() => result.current.toggleExpanded());

    expect(result.current.expanded).toBe(true);
    // Only the toggled kind is persisted; the sibling kind is untouched.
    expect(readPrefs("ws-1")).toEqual({ thinking: true });
  });

  test("a preference change never mutates an already-mounted block, but new blocks inherit it", () => {
    // Mount block A with the quiet (collapsed) fallback.
    const blockA = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(blockA.result.current.expanded).toBe(false);

    // Simulate another block (or a sibling component) flipping the workspace
    // preference to expanded. The present block must NOT react — no layout flash.
    act(() => {
      updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), {
        tools: { bash: true },
      });
    });
    expect(blockA.result.current.expanded).toBe(false);

    // A freshly mounted block inherits the new preference.
    const blockB = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(blockB.result.current.expanded).toBe(true);
  });

  test("preferences are scoped per workspace", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), { tools: { bash: true } });

    const otherWorkspace = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-2"),
    });
    expect(otherWorkspace.result.current.expanded).toBe(false);
    expect(readPrefs("ws-2")).toEqual({});
  });

  test("preferences are scoped per tool name", () => {
    // A choice made on one tool must not leak to a different tool.
    const bash = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1", "bash"),
    });
    act(() => bash.result.current.toggleExpanded());
    expect(readPrefs("ws-1")).toEqual({ tools: { bash: true } });

    // A different tool still falls back to its own default and is unaffected.
    const fileRead = renderHook(() => useStickyExpand("tools", false), {
      wrapper: makeWrapper("ws-1", "file_read"),
    });
    expect(fileRead.result.current.expanded).toBe(false);

    act(() => fileRead.result.current.toggleExpanded());
    // Each tool name persists independently in the same workspace record.
    expect(readPrefs("ws-1")).toEqual({ tools: { bash: true, file_read: true } });
  });

  test("honors a legacy boolean tools preference as the per-tool fallback", () => {
    // A prior build stored `tools` as a single shared boolean. Upgrading users must
    // not silently lose that choice; it applies to every tool until the next toggle.
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), {
      tools: false,
    } as unknown as AutoExpandPrefs);

    const view = renderHook(() => useStickyExpand("tools", true), {
      wrapper: makeWrapper("ws-1", "bash"),
    });
    // Fallback would be expanded (true), but the legacy collapsed preference wins.
    expect(view.result.current.expanded).toBe(false);

    // The next toggle migrates the key to the per-tool record shape.
    act(() => view.result.current.toggleExpanded());
    expect(readPrefs("ws-1")).toEqual({ tools: { bash: true } });
  });

  test("opens on a late forceExpanded trigger and never auto-collapses it (latched)", () => {
    // Mirrors a task / task_await row whose error or failed-sub-task signal only
    // becomes known after mount (Codex P2). Seeding once would miss it.
    const { result, rerender } = renderHook(
      ({ force }: { force: boolean }) => useStickyExpand("tools", false, { forceExpanded: force }),
      { wrapper: makeWrapper("ws-1"), initialProps: { force: false } }
    );
    expect(result.current.expanded).toBe(false);

    // Error arrives → row opens.
    rerender({ force: true });
    expect(result.current.expanded).toBe(true);

    // Trigger clears → row stays open (no collapse tear) and nothing is persisted.
    rerender({ force: false });
    expect(result.current.expanded).toBe(true);
    expect(readPrefs("ws-1")).toEqual({});
  });

  test("a user collapse still wins over an active forceExpanded signal", () => {
    const { result } = renderHook(() => useStickyExpand("tools", false, { forceExpanded: true }), {
      wrapper: makeWrapper("ws-1"),
    });
    expect(result.current.expanded).toBe(true);

    act(() => result.current.setExpanded(false));

    expect(result.current.expanded).toBe(false);
    expect(readPrefs("ws-1")).toEqual({ tools: { bash: false } });
  });

  test("forceExpanded overrides a collapsed stored preference and does not persist", () => {
    updatePersistedState<AutoExpandPrefs>(getAutoExpandPrefsKey("ws-1"), {
      tools: { bash: false },
    });

    const { result } = renderHook(() => useStickyExpand("tools", false, { forceExpanded: true }), {
      wrapper: makeWrapper("ws-1"),
    });

    expect(result.current.expanded).toBe(true);
    // Seeding from forceExpanded must not rewrite the stored preference.
    expect(readPrefs("ws-1")).toEqual({ tools: { bash: false } });
  });

  test("degrades to local-only state with no persistence outside a workspace context", () => {
    const { result } = renderHook(() => useStickyExpand("tools", false));
    expect(result.current.expanded).toBe(false);

    act(() => result.current.toggleExpanded());

    expect(result.current.expanded).toBe(true);
    // No workspaceId → nothing is written to storage.
    expect(globalThis.localStorage.length).toBe(0);
  });
});
