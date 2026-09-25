import * as path from "path";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import { execSync } from "node:child_process";

import {
  Config,
  SecretsStore,
  type ProjectConfig,
  type ProjectsConfig,
  type Workspace as WorkspaceConfigEntry,
  type WorkspaceMetadataOptions,
} from "@/node/config";
import type { AgentAiDefaults, AgentAiSubagentProfile } from "@/common/types/agentAiDefaults";
import type { ThinkingLevel } from "@/common/types/thinking";
import { Ok, Err, type Result } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { AIService } from "@/node/services/aiService";
import type { TurnAdmissionToken, WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { makeWorkspaceHostFake } from "@/node/services/taskWorkspaceSeam.testUtils";
import type { InitStateManager } from "@/node/services/initStateManager";
import { TaskService } from "@/node/services/taskService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { HistoryService } from "@/node/services/historyService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { log } from "@/node/services/log";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type {
  TaskHandleStore,
  WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import type { StreamEndEvent } from "@/common/types/stream";
import type { MuxMessageMetadata } from "@/common/types/message";

export function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

export function findWorkspaceInConfig(config: Config, workspaceId: string) {
  return Array.from(config.loadConfigOrDefault().projects.values())
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
}

export function createMockInitStateManager(): InitStateManager {
  return {
    startInit: mock(() => undefined),
    enterHookPhase: mock(() => undefined),
    appendOutput: mock(() => undefined),
    reportProgress: mock(() => undefined),
    endInit: mock(() => Promise.resolve()),
    getInitState: mock(() => undefined),
    readInitStatus: mock(() => Promise.resolve(null)),
  } as unknown as InitStateManager;
}

export async function createTestConfig(rootDir: string): Promise<Config> {
  const config = new Config(rootDir);
  await fsPromises.mkdir(config.srcDir, { recursive: true });
  return config;
}

export async function createTestProject(
  rootDir: string,
  name = "repo",
  options?: { initGit?: boolean }
): Promise<string> {
  const projectPath = path.join(rootDir, name);
  await fsPromises.mkdir(projectPath, { recursive: true });
  if (options?.initGit ?? true) {
    initGitRepo(projectPath);
  }
  return projectPath;
}

type TestConfigOverrides = Omit<ProjectsConfig, "projects">;

type TestTaskSettings = NonNullable<ProjectsConfig["taskSettings"]>;

type SaveProjectWorkspacesOptions = TestConfigOverrides & {
  extraProjects?: Array<[string, ProjectConfig]>;
};

export function testTaskSettings(
  maxParallelAgentTasks = 3,
  maxTaskNestingDepth = 3
): TestTaskSettings {
  return {
    maxParallelAgentTasks,
    maxTaskNestingDepth,
    // Most TaskService tests exercise transient cleanup mechanics. Persistent-by-default behavior
    // has dedicated coverage below, so keep legacy cleanup explicit in the shared fixture.
    preserveSubagentsUntilArchive: false,
  };
}

export function projectWorkspace(
  projectPath: string,
  directoryName: string,
  id: string,
  options: Omit<Partial<WorkspaceConfigEntry>, "id" | "path"> = {}
): WorkspaceConfigEntry {
  const { name = directoryName, ...workspaceOptions } = options;
  return {
    path: path.join(projectPath, directoryName),
    id,
    name,
    ...workspaceOptions,
  };
}

export async function saveTestConfig(
  config: Config,
  projects: Array<[string, ProjectConfig]>,
  overrides: TestConfigOverrides = {}
): Promise<void> {
  await config.editConfig(() => ({
    projects: new Map(projects),
    ...overrides,
    migrations: {
      persistentSubagentsDefaulted: true,
      ...overrides.migrations,
    },
  }));
}

export async function saveWorkspaces(
  config: Config,
  projectPath: string,
  workspaces: WorkspaceConfigEntry[],
  options: SaveProjectWorkspacesOptions | TestTaskSettings = {}
): Promise<void> {
  const normalizedOptions =
    "maxParallelAgentTasks" in options ? { taskSettings: options } : options;
  const { extraProjects = [], ...overrides } = normalizedOptions;
  await saveTestConfig(
    config,
    [[projectPath, { trusted: true, workspaces }], ...extraProjects],
    overrides
  );
}

export function mergeTestAgentAiDefaults(
  agentAiDefaults?: AgentAiDefaults,
  subagentAiDefaults?: Record<string, AgentAiSubagentProfile>
): AgentAiDefaults | undefined {
  if (!agentAiDefaults && !subagentAiDefaults) return undefined;

  const merged: AgentAiDefaults = { ...agentAiDefaults };
  for (const [agentId, subagent] of Object.entries(subagentAiDefaults ?? {})) {
    merged[agentId] = { ...merged[agentId], subagent: { ...subagent } };
  }
  return merged;
}

export async function saveLocalParentWorkspace(
  config: Config,
  rootDir: string,
  options?: {
    agentAiDefaults?: AgentAiDefaults;
    subagentAiDefaults?: Record<string, AgentAiSubagentProfile>;
    parentAiSettings?: { model: string; thinkingLevel: ThinkingLevel };
    workspaceName?: string;
  }
): Promise<{ parentId: string; projectPath: string }> {
  const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
  const parentId = "1111111111";
  await saveWorkspaces(
    config,
    projectPath,
    [
      {
        path: projectPath,
        id: parentId,
        name: options?.workspaceName ?? "parent",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
        aiSettings: options?.parentAiSettings ?? {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
      },
    ],
    {
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
      agentAiDefaults: mergeTestAgentAiDefaults(
        options?.agentAiDefaults,
        options?.subagentAiDefaults
      ),
      migrations: { execSubagentDefaultsSplit: true },
    }
  );
  return { parentId, projectPath };
}

/** Write a runnable exec-derived custom agent definition into the project's .mux/agents. */
export async function writeCustomAgentDefinition(
  projectPath: string,
  extraFrontmatterLines: string[] = []
): Promise<void> {
  const agentsDir = path.join(projectPath, ".mux", "agents");
  await fsPromises.mkdir(agentsDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(agentsDir, "custom.md"),
    [
      "---",
      "name: Custom",
      "description: Exec-derived custom agent for tests",
      "base: exec",
      "subagent:",
      "  runnable: true",
      ...extraFrontmatterLines,
      "---",
      "",
      "Test agent body.",
      "",
    ].join("\n"),
    "utf-8"
  );
}

export function stubStableIds(config: Config, ids: string[], fallbackId = "fffffffff0"): void {
  let nextIdIndex = 0;
  const configWithStableId = config as unknown as { generateStableId: () => string };
  configWithStableId.generateStableId = () => ids[nextIdIndex++] ?? fallbackId;
}

/** Emitters behind createAIServiceMocks' on/off, keyed by the mock AIService they serve. */
const aiServiceEvents = new WeakMap<AIService, EventEmitter>();
/** The AIService event source each createTaskServiceStack TaskService subscribed to. */
const taskServiceStreamEvents = new WeakMap<TaskService, EventEmitter>();

export function createAIServiceMocks(
  config: Config,
  overrides?: Partial<{
    isStreaming: ReturnType<typeof mock>;
    getWorkspaceMetadata: ReturnType<typeof mock>;
    stopStream: ReturnType<typeof mock>;
    createModel: ReturnType<typeof mock>;
    getStreamInfo: ReturnType<typeof mock>;
    getProvidersConfig: ReturnType<typeof mock>;
    on: ReturnType<typeof mock>;
    off: ReturnType<typeof mock>;
  }>
): {
  aiService: AIService;
  isStreaming: ReturnType<typeof mock>;
  getWorkspaceMetadata: ReturnType<typeof mock>;
  stopStream: ReturnType<typeof mock>;
  createModel: ReturnType<typeof mock>;
  getStreamInfo: ReturnType<typeof mock>;
  getProvidersConfig: ReturnType<typeof mock>;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
  events: EventEmitter;
} {
  const isStreaming = overrides?.isStreaming ?? mock(() => false);
  const getWorkspaceMetadata =
    overrides?.getWorkspaceMetadata ??
    mock(
      async (
        workspaceId: string,
        options?: Pick<WorkspaceMetadataOptions, "persistMigrations">
      ): Promise<Result<WorkspaceMetadata>> => {
        // Match AIService: canceled preparation reads must not start migration writes.
        const found = await config.getWorkspaceMetadataById(workspaceId, options);
        return found ? Ok(found) : Err("not found");
      }
    );

  const stopStream =
    overrides?.stopStream ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const createModel =
    overrides?.createModel ??
    mock((): Promise<Result<never>> => Promise.resolve(Err("createModel not mocked")));
  const getStreamInfo = overrides?.getStreamInfo ?? mock(() => undefined);
  const getProvidersConfig = overrides?.getProvidersConfig ?? mock(() => null);
  const replayStream = mock(() => Promise.resolve());

  // A real emitter behind on/off so TaskService's stream listeners run exactly as in production
  // (see streamEnd below); tests that script their own subscription override on/off.
  const events = new EventEmitter();
  const on =
    overrides?.on ??
    mock((event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
    });
  const off =
    overrides?.off ??
    mock((event: string, listener: (...args: unknown[]) => void) => {
      events.off(event, listener);
    });

  const aiService = {
    isStreaming,
    getWorkspaceMetadata,
    stopStream,
    createModel,
    getStreamInfo,
    getProvidersConfig,
    replayStream,
    acquireStreamStartLock: mock(() => Promise.resolve(undefined)),
    on,
    off,
  } as unknown as AIService;
  aiServiceEvents.set(aiService, events);
  return {
    aiService,
    events,
    isStreaming,
    getWorkspaceMetadata,
    stopStream,
    createModel,
    getStreamInfo,
    getProvidersConfig,
    on,
    off,
  };
}

type WorkspaceHostMockOverrides = Partial<{
  [K in keyof WorkspaceHost]: ReturnType<typeof mock>;
}> & { unarchive?: ReturnType<typeof mock> };

export function createWorkspaceServiceMocks(overrides: WorkspaceHostMockOverrides = {}) {
  const isWorkflowInvocationCurrent =
    overrides.isWorkflowInvocationCurrent ?? mock(() => Promise.resolve(true));
  const mocks = {
    acquireIdleTurnExclusion:
      overrides.acquireIdleTurnExclusion ?? mock(() => Ok({ [Symbol.dispose]: () => undefined })),
    sendMessage:
      overrides.sendMessage ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined))),
    resumeStream:
      overrides.resumeStream ??
      mock((): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true }))),
    clearQueue: overrides.clearQueue ?? mock((): Result<void> => Ok(undefined)),
    removeQueuedWorkspaceTurn:
      overrides.removeQueuedWorkspaceTurn ?? mock((): Result<boolean> => Ok(true)),
    isBusyForMessage: overrides.isBusyForMessage ?? mock(() => false),
    getQueueCutCutter: overrides.getQueueCutCutter ?? mock(() => undefined),
    remove:
      overrides.remove ??
      overrides.removeWhileTaskTreeLocked ??
      mock(
        async (
          _workspaceId: string,
          _force?: boolean,
          options?: { beforeRemove?: () => Promise<boolean> }
        ): Promise<Result<void>> => {
          // Mirror the real remove(): the under-lock precondition decides whether anything happens.
          await options?.beforeRemove?.();
          return Ok(undefined);
        }
      ),
    updateTitle:
      overrides.updateTitle ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined))),
    emitChatEvent: overrides.emitChatEvent ?? mock(() => undefined),
    emit: overrides.emit ?? mock(() => true),
    archive:
      overrides.archive ??
      overrides.archiveWhileTaskTreeLocked ??
      mock((): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))),
    unarchive:
      overrides.unarchive ??
      overrides.unarchiveWhileTaskTreeLocked ??
      mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined))),
    isWorkflowInvocationCurrent,
    // Derived from the boolean mock so tests that override isWorkflowInvocationCurrent keep
    // steering the drain's three-state check.
    getWorkflowInvocationCurrentness:
      overrides.getWorkflowInvocationCurrentness ??
      mock(
        async (workspaceId: string, runId: string) =>
          ((await isWorkflowInvocationCurrent(workspaceId, runId)) === true
            ? "current"
            : "not_current") as "current" | "not_current" | "indeterminate"
      ),
    getWorkflowInvocationBoundaryMessageId:
      overrides.getWorkflowInvocationBoundaryMessageId ??
      mock(() => Promise.resolve<string | null>(null)),
    create:
      overrides.create ??
      mock(
        (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
          Promise.resolve(Err("workspaceHost.create not mocked"))
      ),
    discardExtensionMetadataEntry:
      overrides.discardExtensionMetadataEntry ?? mock(() => Promise.resolve()),
  };
  const { unarchive, ...hostMocks } = mocks;
  // Same mocks for the locked sinks: the lifecycle path holds the (real) task-tree lock and
  // calls the WhileTaskTreeLocked variants; assertions target one archive/remove surface.
  const workspaceService = makeWorkspaceHostFake({
    ...overrides,
    ...hostMocks,
    // The fake host has no session, so no turn can ever exist for a send it accepts: a
    // TurnAdmissionToken the send carried is disposed once the mock settled unless the test's
    // own mock already reported admission (a real WorkspaceService fires exactly one of these
    // at its seams; leaving the token pending would retain every stop latch forever).
    sendMessage: ((...args: Parameters<WorkspaceHost["sendMessage"]>) =>
      disposeTokenAfter(
        mocks.sendMessage(...args),
        args[3]?.turnAdmission
      )) as WorkspaceHost["sendMessage"],
    resumeStream: ((...args: Parameters<WorkspaceHost["resumeStream"]>) =>
      disposeTokenAfter(
        mocks.resumeStream(...args),
        args[2]?.turnAdmission
      )) as WorkspaceHost["resumeStream"],
    archiveWhileTaskTreeLocked: mocks.archive,
    unarchiveWhileTaskTreeLocked: unarchive,
    removeWhileTaskTreeLocked: mocks.remove,
  });

  return { workspaceService, ...mocks };
}

async function disposeTokenAfter<T>(
  result: Promise<T> | T,
  token: TurnAdmissionToken | undefined
): Promise<T> {
  try {
    return await result;
  } finally {
    token?.onDisposed("no-work");
  }
}

export function workspaceTurnManagerFor(
  service: TaskService | WorkspaceTurnManager
): WorkspaceTurnManager {
  if (service instanceof WorkspaceTurnManager) return service;
  return (
    service as unknown as { getWorkspaceTurnManager(): WorkspaceTurnManager }
  ).getWorkspaceTurnManager();
}

/**
 * Private WorkspaceTurnManager state for tests that seed or spy on it. Production registers live
 * handles only inside createWorkspaceTurn/reawakening, so tests that seed that state (or spy on
 * the exact TaskHandleStore instance the manager uses) must reach the owner's private fields.
 */
export function workspaceTurnManagerInternals(service: TaskService | WorkspaceTurnManager) {
  return workspaceTurnManagerFor(service) as unknown as {
    taskHandleStore: TaskHandleStore;
    activeWorkspaceTurnHandleByWorkspaceId: Map<
      string,
      NonNullable<ReturnType<WorkspaceTurnManager["getLiveWorkspaceTurnRegistration"]>>
    >;
  };
}

export function workspaceTurnRecord(
  ownerWorkspaceId: string,
  workspaceId: string,
  handleId: string,
  status: WorkspaceTurnTaskHandleRecord["status"],
  overrides: Partial<WorkspaceTurnTaskHandleRecord> = {}
): WorkspaceTurnTaskHandleRecord {
  return {
    kind: "workspace_turn",
    ownerWorkspaceId,
    workspaceId,
    handleId,
    turnId: "turn",
    status,
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:01.000Z",
    createdWorkspace: false,
    disposableWorkspace: false,
    ...overrides,
  };
}

export function workspaceTurnStreamEndEvent(
  ownerWorkspaceId: string,
  messageId: string,
  text: string,
  options: {
    taskHandleId?: string;
    turnId?: string;
    finishReason?: StreamEndEvent["metadata"]["finishReason"];
  } = {}
): StreamEndEvent {
  return {
    type: "stream-end",
    workspaceId: "childworkspace",
    messageId,
    metadata: {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: options.finishReason ?? "stop",
      muxMetadata: workspaceTurnMuxMetadata(ownerWorkspaceId, options.taskHandleId, options.turnId),
    },
    parts: [{ type: "text", text }],
  };
}

export function workspaceTurnMuxMetadata(
  ownerWorkspaceId: string,
  taskHandleId = "wst_handle",
  turnId = "turn"
): Extract<MuxMessageMetadata, { type: "workspace-turn-task" }> {
  return { type: "workspace-turn-task", taskHandleId, ownerWorkspaceId, turnId };
}

export function createWorkspaceTurnMetadata(projectPath: string): WorkspaceMetadata {
  return {
    id: "childworkspace",
    name: "workspace-turn",
    title: "Workspace turn",
    projectName: "repo",
    projectPath,
    runtimeConfig: { type: "local" },
    createdAt: "2026-06-19T00:00:00.000Z",
  };
}

export function makeWorkspaceTurnCreateMock(config: Config, projectPath: string) {
  return mock(
    async (
      ...args: Parameters<WorkspaceHost["create"]>
    ): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      const tags = args[7];
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        if (project == null) throw new Error("test project must exist");
        project.workspaces.push({
          path: path.join(projectPath, "workspace-turn"),
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          tags,
        });
        return cfg;
      });
      return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
    }
  );
}

export function workspaceTurnSnapshot(
  service: TaskService | WorkspaceTurnManager,
  ownerWorkspaceId: string,
  handleId = "wst_handle"
) {
  return workspaceTurnManagerFor(service).getWorkspaceTurnSnapshot(ownerWorkspaceId, handleId);
}

/**
 * The production TaskService + WorkspaceTurnManager wiring (see di/layers/core.ts), shared by every
 * TaskService suite. The default AIService is createAIServiceMocks' emitter-backed mock, so
 * streamEnd() drives the real stream-end listener. Suites with their own AIService pass its event
 * source as `aiEvents` when they want streamEnd().
 */
export function createTaskServiceStack(
  config: Config,
  overrides: {
    historyService?: HistoryService;
    aiService?: AIService;
    aiEvents?: EventEmitter;
    workspaceService?: WorkspaceHost;
    initStateManager?: InitStateManager;
    sessionUsageService?: SessionUsageService;
    workspaceGoalService?: WorkspaceGoalService;
    desktopInputCoordinator?: DesktopInputCoordinator;
    terminalAttentionStore?: TerminalAttentionStore;
  } = {}
) {
  const historyService = overrides.historyService ?? new HistoryService(config);
  const aiService = overrides.aiService ?? createAIServiceMocks(config).aiService;
  const workspaceService =
    overrides.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
  const initStateManager = overrides.initStateManager ?? createMockInitStateManager();
  const terminalAttentionStore =
    overrides.terminalAttentionStore ?? new TerminalAttentionStore(config);
  const taskService = new TaskService(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    overrides.sessionUsageService,
    overrides.workspaceGoalService,
    new SecretsStore(config.rootDir),
    terminalAttentionStore,
    overrides.desktopInputCoordinator
  );
  const workspaceTurnManager = new WorkspaceTurnManager(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    taskService,
    terminalAttentionStore,
    aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7],
    overrides.desktopInputCoordinator
  );
  taskService.setWorkspaceTurnManager(workspaceTurnManager);
  const events = overrides.aiEvents ?? aiServiceEvents.get(aiService);
  if (events != null) taskServiceStreamEvents.set(taskService, events);
  return {
    historyService,
    taskService,
    workspaceTurnManager,
    aiService,
    workspaceService,
    initStateManager,
    terminalAttentionStore,
  };
}

const STREAM_END_FAILURE_LOG = "TaskService.handleStreamEnd failed";

/**
 * Deliver a stream-end the way StreamManager does: emit it on the AIService TaskService subscribed
 * to, so the listener captures the queue-cut snapshot and the attempt origin in the event's own
 * tick, registers the stream-end decision and serializes on the workspace event lock. Resolves once
 * that lock drained, and rethrows a handler failure the listener would otherwise only log.
 */
export async function streamEnd(taskService: TaskService, event: StreamEndEvent): Promise<void> {
  const events = taskServiceStreamEvents.get(taskService);
  assert(
    events,
    "streamEnd needs a TaskService built by createTaskServiceStack with an event source"
  );
  assert(events.listenerCount("stream-end") > 0, "TaskService is not subscribed to stream-end");
  // Draining needs the lock itself: the listener's chained handler is not otherwise observable.
  const locks = (taskService as unknown as { workspaceEventLocks: MutexMap<string> })
    .workspaceEventLocks;
  const logError = spyOn(log, "error");
  const firstCall = logError.mock.calls.length;
  let failures: unknown[];
  try {
    events.emit("stream-end", event);
    await locks.withLock(event.workspaceId, () => Promise.resolve());
    // The listener logs a rejected handler from a .catch continuation; let it run first.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    failures = logError.mock.calls
      .slice(firstCall)
      .filter((call) => call[0] === STREAM_END_FAILURE_LOG)
      .map((call) => (call[1] as { error?: unknown } | undefined)?.error);
    logError.mockRestore();
  }
  if (failures.length > 0) throw failures[0];
}
