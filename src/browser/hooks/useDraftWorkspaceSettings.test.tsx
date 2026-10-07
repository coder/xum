import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ProjectProvider } from "@/browser/contexts/ProjectContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getRuntimeKey } from "@/common/constants/storage";
import { CODER_RUNTIME_PLACEHOLDER } from "@/common/types/runtime";
import { useDraftWorkspaceSettings } from "./useDraftWorkspaceSettings";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";

function createStubApiClient(
  preferences?: UserPreferences,
  defaultRuntime: string | null = null
): APIClient {
  // useModelLRU() only needs providers.getConfig + providers.onConfigChanged.
  // Provide a minimal stub so tests can run without spinning up a real oRPC client.
  async function* empty() {
    // no-op
  }

  const config = createTestPreferencesConfig(preferences);
  return createTestApiClient({
    config: {
      ...config,
      getConfig: async () => ({ ...(await config.getConfig()), defaultRuntime }),
    },
    providers: {
      getConfig: () => Promise.resolve({}),
      onConfigChanged: () => Promise.resolve(empty()),
    },
    // ProjectProvider calls api.projects.list() on mount.
    projects: {
      list: () => Promise.resolve([]),
    },
  });
}

const runtimeConfigPrefs = (path: string, lastRuntimeConfig: Record<string, unknown>) => ({
  workspaceCreation: { byProject: { [path]: { lastRuntimeConfig } } },
});

function createWrapper(
  projectPath: string,
  preferences?: UserPreferences,
  defaultRuntime?: string
): React.FC<{ children: React.ReactNode }> {
  const client = createStubApiClient(preferences, defaultRuntime);
  const Wrapper: React.FC<{ children: React.ReactNode }> = (props) => (
    <APIProvider client={client}>
      <ProjectProvider>
        <ThinkingProvider projectPath={projectPath}>{props.children}</ThinkingProvider>
      </ProjectProvider>
    </APIProvider>
  );

  Wrapper.displayName = "DraftWorkspaceSettingsTestWrapper";
  return Wrapper;
}

describe("useDraftWorkspaceSettings", () => {
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
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("uses global default agent when project preference is unset", async () => {
    const projectPath = "/tmp/project";

    const wrapper = createWrapper(projectPath, { ai: { globalDefaults: { agentId: "ask" } } });

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.agentId).toBe("ask");
    });
  });

  test("prefers project agent over global default", async () => {
    const projectPath = "/tmp/project";

    const wrapper = createWrapper(projectPath, {
      ai: {
        globalDefaults: { agentId: "ask" },
        projectDefaults: { [projectPath]: { agentId: "plan" } },
      },
    });

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.agentId).toBe("plan");
    });
  });

  test("preserves explicit gateway model in the project preference", async () => {
    const projectPath = "/tmp/project";

    const wrapper = createWrapper(projectPath, {
      ai: { projectDefaults: { [projectPath]: { model: "openrouter:openai/gpt-5" } } },
    });

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.model).toBe("openrouter:openai/gpt-5");
    });
  });

  test("preserves explicit gateway model in the global default preference", async () => {
    const projectPath = "/tmp/project";

    getAppConfigStore().updateOptimistically({ defaultModel: "openrouter:openai/gpt-5" });

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.model).toBe("openrouter:openai/gpt-5");
    });
  });

  test("does not reset selected runtime to the default while editing SSH host", async () => {
    const projectPath = "/tmp/project";

    const wrapper = createWrapper(projectPath);

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    act(() => {
      result.current.setSelectedRuntime({ mode: "ssh", host: "dev@host" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({ mode: "ssh", host: "dev@host" });
    });
  });

  test("applies remembered runtime options that load after mount", async () => {
    const projectPath = "/tmp/project";
    getAppConfigStore().updateOptimistically({ defaultRuntime: "docker" });
    const lastRuntimeConfig = { docker: { image: "ubuntu:22.04" } };
    const wrapper = createWrapper(
      projectPath,
      runtimeConfigPrefs(projectPath, lastRuntimeConfig),
      "docker"
    );

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });
    expect(result.current.settings.selectedRuntime).toMatchObject({ image: "" });
    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toMatchObject({ image: "ubuntu:22.04" });
    });
  });

  test("seeds SSH host from the remembered value when switching modes", async () => {
    const projectPath = "/tmp/project";

    const lastRuntimeConfig = {
      ssh: { host: "remembered@host" },
    };

    const wrapper = createWrapper(projectPath, runtimeConfigPrefs(projectPath, lastRuntimeConfig));

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => expect(getUserPreferences().workspaceCreation).toBeDefined());
    act(() => {
      // Simulate UI switching into ssh mode with an empty field.
      result.current.setSelectedRuntime({ mode: "ssh", host: "" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "ssh",
        host: "remembered@host",
      });
    });
  });

  test("seeds Docker image from the remembered value when switching modes", async () => {
    const projectPath = "/tmp/project";

    const lastRuntimeConfig = {
      docker: { image: "ubuntu:22.04", shareCredentials: true },
    };

    const wrapper = createWrapper(projectPath, runtimeConfigPrefs(projectPath, lastRuntimeConfig));

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => expect(getUserPreferences().workspaceCreation).toBeDefined());
    act(() => {
      // Simulate UI switching into docker mode with an empty field.
      result.current.setSelectedRuntime({ mode: "docker", image: "" });
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "docker",
        image: "ubuntu:22.04",
        shareCredentials: true,
      });
    });
  });

  test("keeps Coder default even after plain SSH usage", async () => {
    const projectPath = "/tmp/project";

    getAppConfigStore().updateOptimistically({ defaultRuntime: "coder" });
    updatePersistedState(getRuntimeKey(projectPath), "ssh dev@host");
    const lastRuntimeConfig = {
      ssh: {
        host: "dev@host",
        coderEnabled: false,
        coderConfig: { existingWorkspace: false },
      },
    };

    const wrapper = createWrapper(projectPath, runtimeConfigPrefs(projectPath, lastRuntimeConfig));

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.settings.defaultRuntimeMode).toBe("coder");
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "ssh",
        host: CODER_RUNTIME_PLACEHOLDER,
        coder: { existingWorkspace: false },
      });
    });
  });

  test("persists Coder default string when toggling default", async () => {
    const projectPath = "/tmp/project";

    const lastRuntimeConfig = {
      ssh: {
        host: "dev@host",
        coderEnabled: false,
        coderConfig: { existingWorkspace: false },
      },
    };

    const wrapper = createWrapper(projectPath, runtimeConfigPrefs(projectPath, lastRuntimeConfig));

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    act(() => {
      result.current.setDefaultRuntimeChoice("coder");
    });

    await waitFor(() => {
      expect(result.current.settings.selectedRuntime).toEqual({
        mode: "ssh",
        host: CODER_RUNTIME_PLACEHOLDER,
        coder: { existingWorkspace: false },
      });
    });

    const defaultRuntimeString = readPersistedState<string | undefined>(
      getRuntimeKey(projectPath),
      undefined
    );
    expect(defaultRuntimeString).toBe(`ssh ${CODER_RUNTIME_PLACEHOLDER}`);
  });

  test("exposes persisted Coder config as fallback when re-selecting Coder", async () => {
    const projectPath = "/tmp/project";
    const savedCoderConfig = { existingWorkspace: true, workspaceName: "saved-workspace" };

    const lastRuntimeConfig = {
      ssh: {
        host: "dev@host",
        coderEnabled: false,
        coderConfig: savedCoderConfig,
      },
    };

    const wrapper = createWrapper(projectPath, runtimeConfigPrefs(projectPath, lastRuntimeConfig));

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.coderConfigFallback).toEqual(savedCoderConfig);
    });
  });

  test("exposes persisted SSH host as fallback when leaving Coder", async () => {
    const projectPath = "/tmp/project";

    const lastRuntimeConfig = {
      ssh: {
        host: "dev@host",
      },
    };

    const wrapper = createWrapper(projectPath, runtimeConfigPrefs(projectPath, lastRuntimeConfig));

    const { result } = renderHook(() => useDraftWorkspaceSettings(projectPath, ["main"], "main"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.sshHostFallback).toBe("dev@host");
    });
  });
});
