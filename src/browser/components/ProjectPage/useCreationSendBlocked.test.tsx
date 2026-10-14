import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import { useCreationSendBlocked } from "./useCreationSendBlocked";

let cleanupDom: (() => void) | null = null;

describe("useCreationSendBlocked", () => {
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("starts blocked, and follows the composer's report", () => {
    const hook = renderHook(({ scope }) => useCreationSendBlocked(scope), {
      initialProps: { scope: "/repo-a:__pending__" },
    });
    expect(hook.result.current[0]).toBe(true);
    act(() => hook.result.current[1](false));
    expect(hook.result.current[0]).toBe(false);
  });

  // ProjectPage is reused across projects and drafts: the new scope's composer has not reported
  // yet, so its first render must not inherit the previous scope's "can send" (#6038).
  test("is blocked again on the first render of a new creation scope", () => {
    const renders: boolean[] = [];
    const hook = renderHook(
      ({ scope }) => {
        const state = useCreationSendBlocked(scope);
        renders.push(state[0]);
        return state;
      },
      { initialProps: { scope: "/repo-a:__pending__" } }
    );
    act(() => hook.result.current[1](false));
    renders.length = 0;
    hook.rerender({ scope: "/repo-b:__pending__" });
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every((blocked) => blocked)).toBe(true);
  });
});
