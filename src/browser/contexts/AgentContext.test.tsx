import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalWindow } from "happy-dom";

import { useWorkspaceStoreRaw as getWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { shouldApplyWorkspaceAgentIdFromBackend } from "@/browser/utils/workspaceAiSettingsSync";
import {
  GLOBAL_SCOPE_ID,
  getAgentIdKey,
  getModelKey,
  getProjectScopeId,
  getThinkingLevelKey,
} from "@/common/constants/storage";
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
let rejectAgentDefinitions = false;
let mockWorkspaceMetadata = new Map<
  string,
  { parentWorkspaceId?: string; agentId?: string; agentType?: string }
>();
let updateAgentAISettingsCalls: Array<{
  workspaceId: string;
  agentId: string;
  aiSettings: { model: string; thinkingLevel?: string; reasoningMode?: string } | null;
  persistSelectedAgentId?: boolean | null;
}> = [];
interface UpdateAgentAISettingsResult {
  success: boolean;
  error?: string;
  data?: undefined;
}
let deferUpdateAgentAISettings = false;
let resolveUpdateAgentAISettings: ((result: UpdateAgentAISettingsResult) => void) | null = null;

// Function-boundary read: flow analysis narrows the module let to null after
// an explicit reset and cannot see the mock's runtime reassignment, so tests
// that reset-and-recapture must read through this accessor.
function getDeferredUpdateResolver(): ((result: UpdateAgentAISettingsResult) => void) | null {
  return resolveUpdateAgentAISettings;
}

let APIProvider!: typeof APIModule.APIProvider;
let RouterProvider!: typeof RouterContextModule.RouterProvider;
let ProjectProvider!: typeof ProjectContextModule.ProjectProvider;
let WorkspaceProvider!: typeof WorkspaceContextModule.WorkspaceProvider;
let useWorkspaceMetadata!: typeof WorkspaceContextModule.useWorkspaceMetadata;
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
  ({ WorkspaceProvider, useWorkspaceMetadata } = requireTestModule<{
    WorkspaceProvider: typeof WorkspaceContextModule.WorkspaceProvider;
    useWorkspaceMetadata: typeof WorkspaceContextModule.useWorkspaceMetadata;
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

function MetadataLayoutHarness(props: {
  workspaceId: string;
  onChange: (metadata: FrontendWorkspaceMetadata | undefined) => void;
}) {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const metadata = workspaceMetadata.get(props.workspaceId);

  React.useLayoutEffect(() => {
    props.onChange(metadata);
  }, [metadata, props]);

  return null;
}

function createWorkspaceMetadata(
  workspaceId: string,
  overrides: {
    parentWorkspaceId?: string;
    agentId?: string;
    agentType?: string;
    aiSettingsByAgent?: FrontendWorkspaceMetadata["aiSettingsByAgent"];
  } = {}
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

interface WorkspaceMetadataEvent {
  workspaceId: string;
  metadata: FrontendWorkspaceMetadata | null;
}

// Push-based onMetadata channel so tests can deliver backend echoes mid-flight.
let emitWorkspaceMetadata: ((event: WorkspaceMetadataEvent) => void) | null = null;

function createWorkspaceMetadataIterable(): AsyncIterable<WorkspaceMetadataEvent> {
  const queue: WorkspaceMetadataEvent[] = [];
  let notify: (() => void) | null = null;
  emitWorkspaceMetadata = (event) => {
    queue.push(event);
    notify?.();
  };
  return {
    [Symbol.asyncIterator](): AsyncIterator<WorkspaceMetadataEvent> {
      return {
        next: async () => {
          while (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
          }
          return { done: false, value: queue.shift()! };
        },
      };
    },
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
      list: () =>
        rejectAgentDefinitions
          ? Promise.reject(new Error("agent definitions unavailable"))
          : Promise.resolve(mockAgentDefinitions),
    },
    workspace: {
      list: () => Promise.resolve(workspaceMetadata),
      onMetadata: () => Promise.resolve(createWorkspaceMetadataIterable()),
      onChat: () => Promise.resolve(createEmptyAsyncIterable()),
      getSessionUsage: () => Promise.resolve(undefined),
      activity: {
        list: () => Promise.resolve({}),
        subscribe: () => Promise.resolve(createEmptyAsyncIterable()),
      },
      truncateHistory: () => Promise.resolve({ success: true as const, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true as const, data: undefined }),
      updateAgentAISettings: (
        input: (typeof updateAgentAISettingsCalls)[number]
      ): Promise<UpdateAgentAISettingsResult> => {
        updateAgentAISettingsCalls.push(input);
        if (deferUpdateAgentAISettings) {
          return new Promise((resolve) => {
            resolveUpdateAgentAISettings = resolve;
          });
        }
        return Promise.resolve({ success: true, data: undefined });
      },
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
  onMetadataLayout?: (metadata: FrontendWorkspaceMetadata | undefined) => void;
}) {
  return render(
    <APIProvider client={createApiClient()}>
      <RouterProvider>
        <ProjectProvider>
          <WorkspaceProvider>
            {props.workspaceId && props.onMetadataLayout ? (
              <MetadataLayoutHarness
                workspaceId={props.workspaceId}
                onChange={props.onMetadataLayout}
              />
            ) : null}
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
    rejectAgentDefinitions = false;
    mockWorkspaceMetadata = new Map();
    updateAgentAISettingsCalls = [];
    deferUpdateAgentAISettings = false;
    resolveUpdateAgentAISettings = null;
    emitWorkspaceMetadata = null;

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

  test("built-in workspace switching survives agent descriptor load failure", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    rejectAgentDefinitions = true;
    mockWorkspaceMetadata.set(workspaceId, {});
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));

    let contextValue: AgentContextValue | undefined;
    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.loadFailed).toBe(true);
    });

    contextValue?.setAgentId("plan");

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
    expect(updateAgentAISettingsCalls).toHaveLength(1);
    expect(updateAgentAISettingsCalls[0]).toMatchObject({
      workspaceId,
      agentId: "plan",
      persistSelectedAgentId: true,
    });
  });

  test("workspace agent selection persists to the backend", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT];
    mockWorkspaceMetadata.set(workspaceId, {});
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    contextValue?.setAgentId("plan");

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("plan");
    });
    expect(updateAgentAISettingsCalls).toHaveLength(1);
    expect(updateAgentAISettingsCalls[0]).toMatchObject({
      workspaceId,
      agentId: "plan",
      persistSelectedAgentId: true,
    });
    // The switch persists its resolved settings alongside the selection so a
    // fresh client can hydrate the bucket even when the target agent had none.
    expect(typeof updateAgentAISettingsCalls[0]?.aiSettings?.model).toBe("string");
    expect(updateAgentAISettingsCalls[0]?.aiSettings?.thinkingLevel).toBeDefined();

    // Re-selecting the current agent is a no-op and must not hit the backend.
    contextValue?.setAgentId("plan");
    expect(updateAgentAISettingsCalls).toHaveLength(1);
  });

  test("workspace agent selection persists definition AI defaults", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    const researcherAgent: AgentDefinitionDescriptor = {
      id: "researcher",
      scope: "project",
      name: "Researcher",
      uiSelectable: true,
      subagentRunnable: false,
      base: "exec",
      aiDefaults: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
      ownAiDefaults: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
    };
    mockAgentDefinitions = [EXEC_AGENT, researcherAgent];
    mockWorkspaceMetadata.set(workspaceId, {});
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    window.localStorage.setItem(
      getModelKey(workspaceId),
      JSON.stringify("anthropic:claude-opus-4-6")
    );
    window.localStorage.setItem(getThinkingLevelKey(workspaceId), JSON.stringify("off"));

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    contextValue?.setAgentId("researcher");

    await waitFor(() => {
      expect(updateAgentAISettingsCalls).toHaveLength(1);
    });
    expect(updateAgentAISettingsCalls[0]).toMatchObject({
      workspaceId,
      agentId: "researcher",
      aiSettings: {
        model: "openai:gpt-5.6-sol",
        thinkingLevel: "high",
      },
      persistSelectedAgentId: true,
    });
  });

  test("rejected persistence reverts the local agent selection", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT];
    mockWorkspaceMetadata.set(workspaceId, {});
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    deferUpdateAgentAISettings = true;

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    const toasts: Array<{ workspaceId: string; message: string }> = [];
    const toastListener = (event: Event) =>
      toasts.push((event as CustomEvent<{ workspaceId: string; message: string }>).detail);
    window.addEventListener(CUSTOM_EVENTS.AGENT_SWITCH_ERROR_TOAST, toastListener);

    try {
      contextValue?.setAgentId("plan");

      // Optimistic switch happens immediately...
      await waitFor(() => {
        expect(contextValue?.agentId).toBe("plan");
      });
      await waitFor(() => {
        expect(resolveUpdateAgentAISettings).not.toBeNull();
      });

      // ...and a typed rejection reverts it: the backend refused the selection
      // and kept the previous agent, and sends carrying the rejected selection
      // are refused by the same gate before they can re-persist it, so no
      // self-heal is coming.
      resolveUpdateAgentAISettings?.({ success: false, error: "unpriced model" });

      await waitFor(() => {
        expect(toasts).toEqual([{ workspaceId, message: "unpriced model" }]);
      });
      await waitFor(() => {
        expect(contextValue?.agentId).toBe("exec");
      });
      // The echo guard is released so backend agent updates apply again
      // (probing with a non-matching agent does not mutate the guard).
      expect(shouldApplyWorkspaceAgentIdFromBackend(workspaceId, "exec")).toBe(true);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.AGENT_SWITCH_ERROR_TOAST, toastListener);
    }
  });

  test("rejection does not revert a newer agent selection", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT, REVIEW_PROJECT_AGENT];
    mockWorkspaceMetadata.set(workspaceId, {});
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    deferUpdateAgentAISettings = true;

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    const toasts: Array<{ workspaceId: string; message: string }> = [];
    const toastListener = (event: Event) =>
      toasts.push((event as CustomEvent<{ workspaceId: string; message: string }>).detail);
    window.addEventListener(CUSTOM_EVENTS.AGENT_SWITCH_ERROR_TOAST, toastListener);

    try {
      contextValue?.setAgentId("plan");
      await waitFor(() => {
        expect(resolveUpdateAgentAISettings).not.toBeNull();
      });
      const rejectPlanSwitch = resolveUpdateAgentAISettings;
      resolveUpdateAgentAISettings = null;

      // The user moves on before the rejection lands; the newer choice wins
      // over the revert.
      contextValue?.setAgentId("review");
      await waitFor(() => {
        expect(contextValue?.agentId).toBe("review");
      });

      rejectPlanSwitch?.({ success: false, error: "unpriced model" });

      // The toast proves the rejection handler (including any revert) ran.
      await waitFor(() => {
        expect(toasts).toHaveLength(1);
      });
      expect(contextValue?.agentId).toBe("review");

      await waitFor(() => {
        expect(resolveUpdateAgentAISettings).not.toBeNull();
      });
      getDeferredUpdateResolver()?.({ success: true, data: undefined });
      await waitFor(() => {
        expect(shouldApplyWorkspaceAgentIdFromBackend(workspaceId, "plan")).toBe(true);
      });
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.AGENT_SWITCH_ERROR_TOAST, toastListener);
    }
  });

  test("chained rejections restore the backend's authoritative agent", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT, REVIEW_PROJECT_AGENT];
    // Backend still stores exec: neither chained switch gets accepted.
    mockWorkspaceMetadata.set(workspaceId, { agentId: "exec" });
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    deferUpdateAgentAISettings = true;

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    contextValue?.setAgentId("plan");
    await waitFor(() => {
      expect(resolveUpdateAgentAISettings).not.toBeNull();
    });
    const rejectPlanSwitch = resolveUpdateAgentAISettings;
    resolveUpdateAgentAISettings = null;

    contextValue?.setAgentId("review");
    await waitFor(() => {
      expect(contextValue?.agentId).toBe("review");
    });

    // plan's rejection is skipped (a newer switch is active). Once that
    // serialized write settles, review's rejection must restore the backend's
    // agent (exec), not its captured previous agent (the also-rejected plan).
    rejectPlanSwitch?.({ success: false, error: "unpriced model" });
    await waitFor(() => {
      expect(resolveUpdateAgentAISettings).not.toBeNull();
    });
    getDeferredUpdateResolver()?.({ success: false, error: "unpriced model" });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });
  });

  test("rejection rollback uses metadata committed before passive effects", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT, REVIEW_PROJECT_AGENT];
    mockWorkspaceMetadata.set(workspaceId, { agentId: "exec" });
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    deferUpdateAgentAISettings = true;

    let contextValue: AgentContextValue | undefined;
    let rejectReviewOnPlanCommit: (() => void) | null = null;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
      onMetadataLayout: (metadata) => {
        if (metadata?.agentId !== "plan") return;
        const reject = rejectReviewOnPlanCommit;
        rejectReviewOnPlanCommit = null;
        reject?.();
      },
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    // exec→plan is accepted by the backend.
    contextValue?.setAgentId("plan");
    await waitFor(() => {
      expect(resolveUpdateAgentAISettings).not.toBeNull();
    });
    const acceptPlanSwitch = getDeferredUpdateResolver();
    resolveUpdateAgentAISettings = null;

    // plan→review is selected BEFORE the acceptance echo arrives, so its
    // render-time closure still sees the pre-echo backend state (exec).
    contextValue?.setAgentId("review");
    acceptPlanSwitch?.({ success: true, data: undefined });
    await waitFor(() => {
      expect(resolveUpdateAgentAISettings).not.toBeNull();
    });
    const rejectReviewSwitch = getDeferredUpdateResolver();
    rejectReviewOnPlanCommit = () =>
      rejectReviewSwitch?.({ success: false, error: "unpriced model" });

    // Reject review from a layout effect triggered by the accepted plan echo.
    // This is after plan metadata commits to WorkspaceContext/WorkspaceStore but
    // before AgentContext passive effects can refresh a render-fed ref.
    emitWorkspaceMetadata?.({
      workspaceId,
      metadata: createWorkspaceMetadata(workspaceId, {
        agentId: "plan",
        aiSettingsByAgent: { plan: { model: "openai:echoed-plan", thinkingLevel: "low" } },
      }),
    });

    await waitFor(() => {
      expect(rejectReviewOnPlanCommit).toBeNull();
      expect(contextValue?.agentId).toBe("plan");
    });
  });

  test("chained rejections resolve a legacy agentType baseline", async () => {
    const projectPath = "/tmp/project";
    const workspaceId = "main-workspace";
    mockAgentDefinitions = [EXEC_AGENT, PLAN_AGENT, REVIEW_PROJECT_AGENT];
    // Upgraded workspace: the authoritative selection exists only in the
    // legacy agentType field.
    mockWorkspaceMetadata.set(workspaceId, { agentType: "exec" });
    window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("exec"));
    deferUpdateAgentAISettings = true;

    let contextValue: AgentContextValue | undefined;

    renderAgentHarness({
      workspaceId,
      projectPath,
      onChange: (value) => (contextValue = value),
    });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
    });

    contextValue?.setAgentId("plan");
    await waitFor(() => {
      expect(resolveUpdateAgentAISettings).not.toBeNull();
    });
    const rejectPlanSwitch = resolveUpdateAgentAISettings;
    resolveUpdateAgentAISettings = null;

    contextValue?.setAgentId("review");
    await waitFor(() => {
      expect(contextValue?.agentId).toBe("review");
    });

    rejectPlanSwitch?.({ success: false, error: "unpriced model" });
    await waitFor(() => {
      expect(resolveUpdateAgentAISettings).not.toBeNull();
    });
    getDeferredUpdateResolver()?.({ success: false, error: "unpriced model" });

    await waitFor(() => {
      expect(contextValue?.agentId).toBe("exec");
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
