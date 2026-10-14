/**
 * Runs the real useDraftWorkspaceSettings source through React Compiler (the production
 * config from vite) and checks what the New Workspace composer relies on: with unchanged
 * inputs, a re-render keeps `selectedRuntime` and `setSelectedRuntime`.
 *
 * Why a separate compile step: Bun and Jest load the hook without React Compiler, so a plain
 * render test cannot see this. Since #5916 the hook derives `selectedRuntime` from the
 * defaults on every render until the user picks one. When the compiler stopped caching that
 * derivation, both values changed on every keystroke and CreationControls re-rendered per
 * character (#5937, nightly "perf: type in the New Workspace composer").
 *
 * The compiled module is evaluated with a require bound to the hook's own path, so it shares
 * React, the stores and the contexts with this test, and no global loader or config changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "@babel/core";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { APIProvider } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import { reactCompilerConfig } from "@/vite/reactCompilerConfig";
import type { useDraftWorkspaceSettings as UseDraftWorkspaceSettings } from "./useDraftWorkspaceSettings";

const HOOK_PATH = path.join(import.meta.dir, "useDraftWorkspaceSettings.ts");
const PROJECT_PATH = "/tmp/project";
// Stable references: only the unrelated prop changes between renders.
const BRANCHES = ["main"];

function loadCompiledHook(): typeof UseDraftWorkspaceSettings {
  const compiled = transformSync(readFileSync(HOOK_PATH, "utf8"), {
    filename: HOOK_PATH,
    babelrc: false,
    configFile: false,
    // Same module output as the repo's Jest Babel config, from declared dependencies only.
    presets: [
      ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
      "@babel/preset-typescript",
    ],
    plugins: [["babel-plugin-react-compiler", reactCompilerConfig]],
  });
  assert(compiled?.code, "React Compiler produced no output for useDraftWorkspaceSettings.ts");

  const moduleExports: Record<string, unknown> = {};
  const compiledModule = { exports: moduleExports };
  // Evaluate the compiled source as a CommonJS module.
  const evaluate = vm.compileFunction(compiled.code, ["require", "module", "exports"], {
    filename: HOOK_PATH,
  });
  Reflect.apply(evaluate, undefined, [createRequire(HOOK_PATH), compiledModule, moduleExports]);

  const hook = compiledModule.exports.useDraftWorkspaceSettings;
  assert(typeof hook === "function", "compiled module must export useDraftWorkspaceSettings");
  return hook as typeof UseDraftWorkspaceSettings;
}

function Wrapper(props: { children: React.ReactNode }) {
  async function* empty() {
    // no-op
  }
  const [client] = React.useState(() =>
    createTestApiClient({
      // A remembered option makes the loaded preferences observable below.
      config: createTestPreferencesConfig({
        workspaceCreation: {
          byProject: { [PROJECT_PATH]: { lastRuntimeConfig: { ssh: { host: "dev@host" } } } },
        },
      }),
      providers: {
        getConfig: () => Promise.resolve({}),
        onConfigChanged: () => Promise.resolve(empty()),
      },
      projects: { list: () => Promise.resolve([]) },
    })
  );
  return (
    <APIProvider client={client}>
      <ProjectProvider>
        <ThinkingProvider projectPath={PROJECT_PATH}>{props.children}</ThinkingProvider>
      </ProjectProvider>
    </APIProvider>
  );
}

describe("useDraftWorkspaceSettings under React Compiler", () => {
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
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({
      userPreferences: undefined,
      defaultModel: undefined,
      defaultRuntime: undefined,
    });
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("keeps the default runtime and its setter across unrelated re-renders", async () => {
    const useCompiledDraftWorkspaceSettings = loadCompiledHook();
    const { result, rerender } = renderHook(
      // `draft` stands in for the composer text: it changes, the hook inputs do not.
      (props: { draft: string }) => {
        void props.draft;
        return useCompiledDraftWorkspaceSettings(PROJECT_PATH, BRANCHES, "main");
      },
      { wrapper: Wrapper, initialProps: { draft: "D" } }
    );

    await waitFor(() => {
      expect(getUserPreferences().workspaceCreation).toBeDefined();
      expect(result.current.settings.trunkBranch).toBe("main");
    });
    const settled = result.current;
    // No pick yet, so the selection is the derived default.
    expect(settled.settings.selectedRuntime).toEqual({ mode: "worktree" });

    for (const draft of ["De", "Deb", "Debu", "Debug"]) {
      rerender({ draft });
      expect(result.current.settings.selectedRuntime).toBe(settled.settings.selectedRuntime);
      expect(result.current.setSelectedRuntime).toBe(settled.setSelectedRuntime);
    }
  });
});
