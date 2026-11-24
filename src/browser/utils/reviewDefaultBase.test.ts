import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

import { useProjectReviewBase, useWorkspaceDiffBase } from "./reviewDefaultBase";

const projectPath = "/repo";

function loadPreferences(defaultBaseByProject?: Record<string, string>): void {
  act(() => {
    getAppConfigStore().updateOptimistically({
      userPreferences: defaultBaseByProject ? { review: { defaultBaseByProject } } : {},
    });
  });
}

describe("reviewDefaultBase", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    getAppConfigStore().clearCachedState();
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().clearCachedState();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("the project default is unknown until the first snapshot, then null when unset", () => {
    const { result } = renderHook(() => useProjectReviewBase(projectPath));
    expect(result.current).toBeUndefined();

    loadPreferences();
    expect(result.current).toBeNull();
  });

  test("a workspace without its own base follows a project default that loads after mount", () => {
    const { result } = renderHook(() => useWorkspaceDiffBase("ws-1", projectPath));
    expect(result.current[0]).toBe(WORKSPACE_DEFAULTS.reviewBase);

    loadPreferences({ [projectPath]: "origin/develop" });
    expect(result.current[0]).toBe("origin/develop");

    act(() => result.current[1]("HEAD~1"));
    expect(result.current[0]).toBe("HEAD~1");
  });
});
