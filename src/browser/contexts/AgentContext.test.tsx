import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";

import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { getAgentIdKey } from "@/common/constants/storage";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { getAppConfigStore, getUserPreferences } from "@/browser/stores/AppConfigStore";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { AgentProvider, useAgent, type AgentContextValue } from "./AgentContext";
import { APIProvider, type APIClient } from "./API";
import { ProjectProvider } from "./ProjectContext";
import { RouterProvider } from "./RouterContext";
import { WorkspaceProvider } from "./WorkspaceContext";
import {
  createTestApiClient,
  createTestConfig,
  createTestPreferencesConfig,
} from "@/browser/testUtils";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import { getWorkspaceAiSelection } from "@/browser/utils/workspaceAiSettingsSync";

let mockAgentDefinitions: AgentDefinitionDescriptor[] = [];
let mockWorkspaceMetadata = new Map<string, { parentWorkspaceId?: string; agentId?: string }>();
let mockAgentListFails = false;

const EXEC_AGENT: AgentDefinitionDescriptor = {
  id: "exec",
  scope: "built-in",
  name: "Exec",
  uiSelectable: true,
  subagentRunnable: false,
};

const PLAN_AGENT: AgentDefinitionDescriptor = {
  id: "plan",
  scope: "built-in",
  name: "Plan",
  uiSelectable: true,
  subagentRunnable: false,
};

const AUTO_PROJECT_AGENT: AgentDefinitionDescriptor = {
  id: "auto",
  scope: "project",
  name: "Auto",
  uiSelectable: true,
  subagentRunnable: false,
};

const REVIEW_PROJECT_AGENT: AgentDefinitionDescriptor = {
  id: "review",
  scope: "project",
  name: "Review",
  uiSelectable: true,
  subagentRunnable: false,
};

const LOCKED_AGENT: AgentDefinitionDescriptor = {
  id: "locked_agent",
  scope: "built-in",
  name: "Locked Agent",
  uiSelectable: false,
  subagentRunnable: false,
};

interface HarnessProps {
  onChange: (value: AgentContextValue) => void;
}

function Harness(props: HarnessProps) {
  const value = useAgent();

  React.useEffect(() => {
    props.onChange(value);
  }, [props, value]);

  return null;
}

function createWorkspaceMetadata(
  workspaceId: string,
  overrides: { parentWorkspaceId?: string; agentId?: string } = {}
): FrontendWorkspaceMetadata {
  return {
    id: workspaceId,
    projectPath: "/tmp/project",
    projectName: "project",
    name: "main",
    namedWorkspacePath: `/tmp/project/${workspaceId}`,
    createdAt: "2025-01-01T00:00:00.000Z",
    runtimeConfig: { type: "local", srcBaseDir: "/tmp/.mux/src" },
    ...overrides,
  };
}

function createEmptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => Promise.resolve({ done: true, value: undefined as T }),
      };
    },
  };
}

function createApiClient(
  preferences?: UserPreferences,
  agentAiDefaults?: AgentAiDefaults
): APIClient {
  const workspaceMetadata = Array.from(
    mockWorkspaceMetadata.entries(),
    ([workspaceId, overrides]) => createWorkspaceMetadata(workspaceId, overrides)
  );

  return createTestApiClient({
    config: {
      ...createTestPreferencesConfig(preferences),
      ...(agentAiDefaults != null
        ? {
            getConfig: () =>
              Promise.resolve(
                createTestConfig({ userPreferences: preferences ?? {}, agentAiDefaults })
              ),
          }
        : {}),
    },
    agents: {
      list: () =>
        mockAgentListFails
          ? Promise.reject(new Error("agents unavailable"))
          : Promise.resolve(mockAgentDefinitions),
    },
    workspace: {
      list: () => Promise.resolve(workspaceMetadata),
      onMetadata: () =>
        Promise.resolve(
          (async function* () {
            yield {
              type: "snapshot" as const,
              workspaces: await Promise.resolve(workspaceMetadata),
            };
          })()
        ),
      onChat: () => Promise.resolve(createEmptyAsyncIterable()),
      getSessionUsage: () => Promise.resolve(undefined),
      activity: {
        list: () => Promise.resolve({}),
        subscribe: () => Promise.resolve(createEmptyAsyncIterable()),
      },
      truncateHistory: () => Promise.resolve({ success: true as const, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true as const, data: undefined }),
    },
    projects: {
      list: () => Promise.resolve([]),
      listBranches: () => Promise.resolve({ branches: ["main"], recommendedTrunk: "main" }),
      secrets: {
        get: () => Promise.resolve([]),
      },
    },
    server: {
      getLaunchProject: () => Promise.resolve(null),
    },
    terminal: {
      openWindow: () => Promise.resolve(),
    },
  });
}

function renderAgentHarness(props: {
  projectPath: string;
  workspaceId?: string;
  preferences?: UserPreferences;
  agentAiDefaults?: AgentAiDefaults;
  onChange: (value: AgentContextValue) => void;
}) {
  return render(
    <APIProvider client={createApiClient(props.preferences, props.agentAiDefaults)}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>
            <AgentProvider workspaceId={props.workspaceId} projectPath={props.projectPath}>
              <Harness onChange={props.onChange} />
            </AgentProvider>
          </WorkspaceProvider>
        </ProjectProvider>
      </RouterProvider>
    </APIProvider>
  );
}

describe("AgentContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    mockAgentDefinitions = [];
    mockWorkspaceMetadata = new Map();
    mockAgentListFails = false;

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    const dom = new GlobalWindow();
    globalThis.window = dom as unknown as Window & typeof globalThis;
    globalThis.document = dom.document as unknown as Document;
    globalThis.localStorage = dom.localStorage as unknown as Storage;
    window.api = {
      platform: "darwin",
      versions: {},
      consumePendingDeepLinks: () => [],
      onDeepLink: () => () => undefined,
    };
  });

  afterEach(() => {
    cleanup();
    getAppConfigStore().updateOptimistically({
      userPreferences: undefined,
      agentAiDefaults: undefined,
    });
    getWorkspaceStoreRaw().dispose();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  });

  test("project-scoped agent falls back to global default when project preference is unset", async () => {
    const projectPath = "/tmp/project";

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      projectPath,
      preferences: { ai: { globalDefaults: { agentId: "ask" } } },
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
    expect(getUserPreferences().ai?.projectDefaults).toBeUndefined();
  });

  test("readers outside the agent context resolve a custom agent's inherited defaults", async () => {
    const workspaceId = "ws-custom-agent";
    mockAgentDefinitions = [EXEC_AGENT, { ...REVIEW_PROJECT_AGENT, base: "exec" }];
    mockWorkspaceMetadata = new Map([[workspaceId, { agentId: "review" }]]);

    renderAgentHarness({
      projectPath: "/tmp/project",
      workspaceId,
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.2" } },
      onChange: () => undefined,
    });

    await waitFor(() => {
      expect(getWorkspaceAiSelection(workspaceId, "review").model).toBe("openai:gpt-5.2");
    });
  });

  test("a failed agent refresh drops the inherited defaults it loaded before", async () => {
    const workspaceId = "ws-custom-agent";
    mockAgentDefinitions = [EXEC_AGENT, { ...REVIEW_PROJECT_AGENT, base: "exec" }];
    mockWorkspaceMetadata = new Map([[workspaceId, { agentId: "review" }]]);
    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      projectPath: "/tmp/project",
      workspaceId,
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.2" } },
      onChange: (value) => (contextValue = value),
    });
    await waitFor(() => {
      expect(getWorkspaceAiSelection(workspaceId, "review").model).toBe("openai:gpt-5.2");
    });

    mockAgentListFails = true;
    await act(async () => {
      await contextValue?.refresh();
    });

    expect(contextValue?.loadFailed).toBe(true);
    expect(getWorkspaceAiSelection(workspaceId, "review").model).not.toBe("openai:gpt-5.2");
  });

  test("project-scoped preference takes precedence over global default", async () => {
    const projectPath = "/tmp/project";

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      projectPath,
      preferences: {
        ai: {
          globalDefaults: { agentId: "ask" },
          projectDefaults: { [projectPath]: { agentId: "plan" } },
        },
      },
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
  });

  test("cycle shortcut advances to next agent", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT];

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      projectPath,
      preferences: { ai: { globalDefaults: { agentId: "exec" } } },
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["exec", "plan"]);
    });

    window.api = { platform: "darwin", versions: {} };

    fireEvent.keyDown(window, {
      key: ".",
      code: "Period",
      metaKey: true,
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
  });

  test("cycle shortcut advances away from a custom auto agent", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [AUTO_PROJECT_AGENT, REVIEW_PROJECT_AGENT];

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      projectPath,
      preferences: { ai: { globalDefaults: { agentId: "auto" } } },
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("auto");
      expect(contextValue?.agents.map((agent) => agent.id)).toEqual(["auto", "review"]);
    });

    window.api = { platform: "darwin", versions: {} };

    fireEvent.keyDown(window, {
      key: ".",
      code: "Period",
      metaKey: true,
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("review");
    });
  });

  test("shortcut actions do not override a locked workspace agent", async () => {
    const projectPath = "/tmp/project";
    const lockedWorkspaceId = "locked-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT];
    mockWorkspaceMetadata.set(lockedWorkspaceId, {
      parentWorkspaceId: "parent-workspace",
      agentId: "exec",
    });
    window.localStorage.setItem(getAgentIdKey(lockedWorkspaceId), JSON.stringify("plan"));

    let contextValue: AgentContextValue | undefined;
    let openPickerEvents = 0;
    const handleOpenPicker = () => {
      openPickerEvents += 1;
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpenPicker as EventListener);

    try {
      renderAgentHarness({
        workspaceId: lockedWorkspaceId,
        projectPath,
        onChange: (value) => (contextValue = value),
      });

      await waitFor(() => {
        // Backend-assigned agent overrides stale localStorage in locked workspaces.
        expect(contextValue?.agentId).toBe("exec");
      });

      window.api = { platform: "darwin", versions: {} };

      // Open picker shortcut should no-op for locked workspaces.
      fireEvent.keyDown(window, {
        key: "A",
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      });

      // Cycle and secondary shortcut actions should no-op as well.
      fireEvent.keyDown(window, {
        key: ".",
        code: "Period",
        metaKey: true,
      });
      fireEvent.keyDown(window, {
        key: ">",
        code: "Period",
        metaKey: true,
        shiftKey: true,
      });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("exec");
      });
      expect(openPickerEvents).toBe(0);
    } finally {
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_AGENT_PICKER,
        handleOpenPicker as EventListener
      );
    }
  });

  test("removed non-selectable agent in mutable workspace remaps and does not block shortcut actions", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [LOCKED_AGENT, EXEC_AGENT, PLAN_AGENT];

    let contextValue: AgentContextValue | undefined;
    let openPickerEvents = 0;
    const handleOpenPicker = () => {
      openPickerEvents += 1;
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpenPicker as EventListener);

    try {
      renderAgentHarness({
        projectPath,
        preferences: { ai: { projectDefaults: { [projectPath]: { agentId: "mux" } } } },
        onChange: (value) => (contextValue = value),
      });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("exec");
      });
      // The removed agent resolves at read time; no repair write reaches config.json.
      expect(getUserPreferences().ai?.projectDefaults?.[projectPath]?.agentId).toBe("mux");

      window.api = { platform: "darwin", versions: {} };

      fireEvent.keyDown(window, {
        key: "A",
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      });

      fireEvent.keyDown(window, {
        key: ".",
        code: "Period",
        metaKey: true,
      });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("plan");
      });
      expect(openPickerEvents).toBe(1);
    } finally {
      window.removeEventListener(
        CUSTOM_EVENTS.OPEN_AGENT_PICKER,
        handleOpenPicker as EventListener
      );
    }
  });
});
