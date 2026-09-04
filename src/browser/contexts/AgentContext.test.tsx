import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";

import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { GLOBAL_SCOPE_ID, getAgentIdKey, getProjectScopeId } from "@/common/constants/storage";
import { requireTestModule } from "@/browser/testUtils";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { AgentContextValue } from "./AgentContext";
import type * as AgentContextModule from "./AgentContext";
import type * as APIModule from "./API";
import type { APIClient } from "./API";
import type * as ProjectContextModule from "./ProjectContext";
import type * as RouterContextModule from "./RouterContext";
import type * as WorkspaceContextModule from "./WorkspaceContext";

let mockAgentDefinitions: AgentDefinitionDescriptor[] = [];
let mockWorkspaceMetadata = new Map<string, { parentWorkspaceId?: string; agentId?: string }>();

let APIProvider!: typeof APIModule.APIProvider;
let RouterProvider!: typeof RouterContextModule.RouterProvider;
let ProjectProvider!: typeof ProjectContextModule.ProjectProvider;
let WorkspaceProvider!: typeof WorkspaceContextModule.WorkspaceProvider;
let AgentProvider!: typeof AgentContextModule.AgentProvider;
let useAgent!: typeof AgentContextModule.useAgent;
let isolatedModuleDir: string | null = null;

const contextsDir = dirname(fileURLToPath(import.meta.url));

async function importIsolatedAgentModules() {
  const tempDir = await mkdtemp(join(contextsDir, ".agent-context-test-"));
  const isolatedApiPath = join(tempDir, "API.real.tsx");
  const isolatedRouterPath = join(tempDir, "RouterContext.real.tsx");
  const isolatedProjectPath = join(tempDir, "ProjectContext.real.tsx");
  const isolatedWorkspacePath = join(tempDir, "WorkspaceContext.real.tsx");
  const isolatedAgentPath = join(tempDir, "AgentContext.real.tsx");

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);
  await copyFile(join(contextsDir, "RouterContext.tsx"), isolatedRouterPath);

  const projectContextSource = await readFile(join(contextsDir, "ProjectContext.tsx"), "utf8");
  const isolatedProjectContextSource = projectContextSource.replace(
    'from "@/browser/contexts/API";',
    'from "./API.real.tsx";'
  );

  if (isolatedProjectContextSource === projectContextSource) {
    throw new Error("Failed to rewrite ProjectContext API import for the isolated test copy");
  }

  await writeFile(isolatedProjectPath, isolatedProjectContextSource);

  const workspaceContextSource = await readFile(join(contextsDir, "WorkspaceContext.tsx"), "utf8");
  const isolatedWorkspaceContextSource = workspaceContextSource
    .replaceAll('from "@/browser/contexts/API";', 'from "./API.real.tsx";')
    .replace('from "@/browser/contexts/ProjectContext";', 'from "./ProjectContext.real.tsx";')
    .replace('from "@/browser/contexts/RouterContext";', 'from "./RouterContext.real.tsx";');

  if (isolatedWorkspaceContextSource === workspaceContextSource) {
    throw new Error("Failed to rewrite WorkspaceContext imports for the isolated test copy");
  }

  await writeFile(isolatedWorkspacePath, isolatedWorkspaceContextSource);

  const agentContextSource = await readFile(join(contextsDir, "AgentContext.tsx"), "utf8");
  const isolatedAgentContextSource = agentContextSource
    .replace('from "@/browser/contexts/API";', 'from "./API.real.tsx";')
    .replace('from "@/browser/contexts/WorkspaceContext";', 'from "./WorkspaceContext.real.tsx";');

  if (isolatedAgentContextSource === agentContextSource) {
    throw new Error("Failed to rewrite AgentContext imports for the isolated test copy");
  }

  await writeFile(isolatedAgentPath, isolatedAgentContextSource);

  ({ APIProvider } = requireTestModule<{ APIProvider: typeof APIModule.APIProvider }>(
    isolatedApiPath
  ));
  ({ RouterProvider } = requireTestModule<{
    RouterProvider: typeof RouterContextModule.RouterProvider;
  }>(isolatedRouterPath));
  ({ ProjectProvider } = requireTestModule<{
    ProjectProvider: typeof ProjectContextModule.ProjectProvider;
  }>(isolatedProjectPath));
  ({ WorkspaceProvider } = requireTestModule<{
    WorkspaceProvider: typeof WorkspaceContextModule.WorkspaceProvider;
  }>(isolatedWorkspacePath));
  ({ AgentProvider, useAgent } = requireTestModule<{
    AgentProvider: typeof AgentContextModule.AgentProvider;
    useAgent: typeof AgentContextModule.useAgent;
  }>(isolatedAgentPath));

  return tempDir;
}

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

function createApiClient(): APIClient {
  const workspaceMetadata = Array.from(
    mockWorkspaceMetadata.entries(),
    ([workspaceId, overrides]) => createWorkspaceMetadata(workspaceId, overrides)
  );

  return {
    agents: {
      list: () => Promise.resolve(mockAgentDefinitions),
    },
    workspace: {
      list: () => Promise.resolve(workspaceMetadata),
      onMetadata: () => Promise.resolve(createEmptyAsyncIterable()),
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
  } as unknown as APIClient;
}

function renderAgentHarness(props: {
  projectPath: string;
  workspaceId?: string;
  onChange: (value: AgentContextValue) => void;
}) {
  return render(
    <APIProvider client={createApiClient()}>
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

  beforeEach(async () => {
    isolatedModuleDir = await importIsolatedAgentModules();
    mockAgentDefinitions = [];
    mockWorkspaceMetadata = new Map();

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

  afterEach(async () => {
    cleanup();
    getWorkspaceStoreRaw().dispose();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;

    if (isolatedModuleDir) {
      await rm(isolatedModuleDir, { recursive: true, force: true });
      isolatedModuleDir = null;
    }
  });

  test("project-scoped agent falls back to global default when project preference is unset", async () => {
    const projectPath = "/tmp/project";
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("ask"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
    expect(window.localStorage.getItem(getAgentIdKey(getProjectScopeId(projectPath)))).toBeNull();
  });

  test("project-scoped preference takes precedence over global default", async () => {
    const projectPath = "/tmp/project";
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("ask"));
    window.localStorage.setItem(
      getAgentIdKey(getProjectScopeId(projectPath)),
      JSON.stringify("plan")
    );

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
  });

  test("cycle shortcut advances to next agent", async () => {
    const projectPath = "/tmp/project";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT];
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("exec"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

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
    window.localStorage.setItem(getAgentIdKey(GLOBAL_SCOPE_ID), JSON.stringify("auto"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

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
    const scopeKey = getAgentIdKey(getProjectScopeId(projectPath));
    mockAgentDefinitions = [LOCKED_AGENT, EXEC_AGENT, PLAN_AGENT];
    window.localStorage.setItem(scopeKey, JSON.stringify("mux"));

    let contextValue: AgentContextValue | undefined;
    let openPickerEvents = 0;
    const handleOpenPicker = () => {
      openPickerEvents += 1;
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpenPicker as EventListener);

    try {
      renderAgentHarness({ projectPath, onChange: (value) => (contextValue = value) });

      await waitFor(() => {
        expect(contextValue?.agentId).toBe("exec");
      });
      expect(window.localStorage.getItem(scopeKey)).toBe(JSON.stringify("exec"));

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
