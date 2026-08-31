import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { execSync } from "node:child_process";
import {
  SecretsStore,
  Config,
  type ProjectConfig,
  type ProjectsConfig,
  type Workspace as WorkspaceConfigEntry,
} from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
  upsertSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import {
  TerminalAttentionStore,
  type TerminalAttentionOutcome,
} from "@/node/services/terminalAttentionStore";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import { TaskService, ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, Err, type Result } from "@/common/types/result";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import type { AgentAiDefaults, AgentAiSubagentProfile } from "@/common/types/agentAiDefaults";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { SendMessageError } from "@/common/types/errors";
import type { ErrorEvent, StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { makeWorkspaceHostFake } from "@/node/services/taskWorkspaceSeam.testUtils";
import type { InitStateManager } from "@/node/services/initStateManager";
import assert from "node:assert";

function initGitRepo(projectPath: string): void {
  execSync("git init -b main", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: projectPath, stdio: "ignore" });
  // Ensure tests don't hang when developers have global commit signing enabled.
  execSync("git config commit.gpgsign false", { cwd: projectPath, stdio: "ignore" });
  execSync("bash -lc 'echo \"hello\" > README.md'", { cwd: projectPath, stdio: "ignore" });
  execSync("git add README.md", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });
}

/**
 * Git-prove the owner workspace's checked-out branch: owner-side agent prechecks and
 * unreachable-target vouching only apply when the effective base branch is verified
 * against the branch actually checked out in the owner.
 */
function checkoutOwnerBranch(projectPath: string, branch: string): void {
  initGitRepo(projectPath);
  execSync(`git checkout -b ${branch}`, { cwd: projectPath, stdio: "ignore" });
}

/**
 * Commit pending agent-definition files: owner-side vouching additionally requires the
 * agent-definition paths to be clean (uncommitted changes diverge from the committed
 * base a new checkout is created from).
 */
function commitOwnerAgentFiles(projectPath: string): void {
  execSync("git add -A && git commit -q -m agents", { cwd: projectPath, stdio: "ignore" });
}

function findWorkspaceInConfig(config: Config, workspaceId: string) {
  return Array.from(config.loadConfigOrDefault().projects.values())
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === workspaceId);
}

function createWorkspaceTurnMetadata(projectPath: string): WorkspaceMetadata {
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

function createMockInitStateManager(): InitStateManager {
  return {
    startInit: mock(() => undefined),
    enterHookPhase: mock(() => undefined),
    appendOutput: mock(() => undefined),
    endInit: mock(() => Promise.resolve()),
    getInitState: mock(() => undefined),
    readInitStatus: mock(() => Promise.resolve(null)),
  } as unknown as InitStateManager;
}

async function createTestConfig(rootDir: string): Promise<Config> {
  const config = new Config(rootDir);
  await fsPromises.mkdir(config.srcDir, { recursive: true });
  return config;
}

async function createTestProject(
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

function testTaskSettings(maxParallelAgentTasks = 3, maxTaskNestingDepth = 3): TestTaskSettings {
  return {
    maxParallelAgentTasks,
    maxTaskNestingDepth,
    // Most TaskService tests exercise transient cleanup mechanics. Persistent-by-default behavior
    // has dedicated coverage below, so keep legacy cleanup explicit in the shared fixture.
    preserveSubagentsUntilArchive: false,
  };
}

function projectWorkspace(
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

/**
 * Register a live workspace-turn handle for a reawakened persistent child. Peer-send admission
 * only honors a "running" execution mirror when the in-memory handle registration matches, and
 * the delegated-turn correlation lookup validates the registration against the handle store —
 * so tests exercising active reawakened executions must seed both.
 */
async function registerLiveWorkspaceTurnHandle(
  taskService: TaskService,
  workspaceId: string,
  handleId: string,
  ownerWorkspaceId = "tree-root",
  // Admission additionally requires the registration to be ACCEPTED (creation-time
  // reservations are registered before the owner's send passes turn admission); pass false to
  // model that pre-acceptance window.
  accepted = true
): Promise<void> {
  const internals = taskService as unknown as {
    activeWorkspaceTurnHandleByWorkspaceId: Map<
      string,
      { handleId: string; ownerWorkspaceId: string; accepted: boolean }
    >;
    taskHandleStore: TaskHandleStore;
  };
  await internals.taskHandleStore.upsertWorkspaceTurn({
    kind: "workspace_turn",
    handleId,
    ownerWorkspaceId,
    workspaceId,
    turnId: `${handleId}-turn`,
    status: "running",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    createdWorkspace: false,
    disposableWorkspace: false,
  });
  internals.activeWorkspaceTurnHandleByWorkspaceId.set(workspaceId, {
    handleId,
    ownerWorkspaceId,
    accepted,
  });
}

async function saveTestConfig(
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

async function saveWorkspaces(
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

function mergeTestAgentAiDefaults(
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

async function saveLocalParentWorkspace(
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
async function writeCustomAgentDefinition(
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

function stubStableIds(config: Config, ids: string[], fallbackId = "fffffffff0"): void {
  let nextIdIndex = 0;
  const configWithStableId = config as unknown as { generateStableId: () => string };
  configWithStableId.generateStableId = () => ids[nextIdIndex++] ?? fallbackId;
}

function createAIServiceMocks(
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
} {
  const isStreaming = overrides?.isStreaming ?? mock(() => false);
  const getWorkspaceMetadata =
    overrides?.getWorkspaceMetadata ??
    mock(async (workspaceId: string): Promise<Result<WorkspaceMetadata>> => {
      const all = await config.getAllWorkspaceMetadata();
      const found = all.find((m) => m.id === workspaceId);
      return found ? Ok(found) : Err("not found");
    });

  const stopStream =
    overrides?.stopStream ?? mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
  const createModel =
    overrides?.createModel ??
    mock((): Promise<Result<never>> => Promise.resolve(Err("createModel not mocked")));
  const getStreamInfo = overrides?.getStreamInfo ?? mock(() => undefined);
  const getProvidersConfig = overrides?.getProvidersConfig ?? mock(() => null);
  const replayStream = mock(() => Promise.resolve());

  const on = overrides?.on ?? mock(() => undefined);
  const off = overrides?.off ?? mock(() => undefined);

  return {
    aiService: {
      isStreaming,
      getWorkspaceMetadata,
      stopStream,
      createModel,
      getStreamInfo,
      getProvidersConfig,
      replayStream,
      on,
      off,
    } as unknown as AIService,
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

async function createAgentTask(
  taskService: TaskService,
  parentWorkspaceId: string,
  prompt: string,
  options: Partial<Parameters<TaskService["create"]>[0]> = {}
) {
  return taskService.create({
    parentWorkspaceId,
    kind: "agent",
    agentType: "explore",
    prompt,
    title: "Test task",
    ...options,
  });
}

type WorkspaceHostMockOverrides = Partial<{
  [K in keyof WorkspaceHost]: ReturnType<typeof mock>;
}> & { unarchive?: ReturnType<typeof mock> };

function createWorkspaceServiceMocks(overrides: WorkspaceHostMockOverrides = {}) {
  const isWorkflowInvocationCurrent =
    overrides.isWorkflowInvocationCurrent ?? mock(() => Promise.resolve(true));
  const mocks = {
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
      mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined))),
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
    archiveWhileTaskTreeLocked: mocks.archive,
    unarchiveWhileTaskTreeLocked: unarchive,
    removeWhileTaskTreeLocked: mocks.remove,
  });

  return { workspaceService, ...mocks };
}

// Registers the created workspace-turn checkout in config the way the real create()
// would, so handle persistence and cleanup paths see a config entry.
function makeWorkspaceTurnCreateMock(config: Config, projectPath: string) {
  return mock(
    async (
      ...args: Parameters<WorkspaceHost["create"]>
    ): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      const tags = args[7];
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
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

function makeCreateMockReturning(result: Result<{ metadata: WorkspaceMetadata }>) {
  return mock((): Promise<Result<{ metadata: WorkspaceMetadata }>> => Promise.resolve(result));
}

const workspaceTurnManagerByTaskService = new WeakMap<TaskService, WorkspaceTurnManager>();

function workspaceTurnManagerFor(taskService: TaskService): WorkspaceTurnManager {
  const manager = workspaceTurnManagerByTaskService.get(taskService);
  assert(manager, "workspace turn manager must be registered for test harness");
  return manager;
}

function createTaskServiceHarness(
  config: Config,
  overrides?: {
    aiService?: AIService;
    workspaceService?: WorkspaceHost;
    initStateManager?: InitStateManager;
    sessionUsageService?: SessionUsageService;
    workspaceGoalService?: WorkspaceGoalService;
  }
): {
  historyService: HistoryService;
  partialService: HistoryService;
  taskService: TaskService;
  aiService: AIService;
  workspaceService: WorkspaceHost;
  initStateManager: InitStateManager;
} {
  const historyService = new HistoryService(config);
  const partialService = historyService;

  const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
  const workspaceService =
    overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
  const initStateManager = overrides?.initStateManager ?? createMockInitStateManager();

  const streamManager = aiService as unknown as ConstructorParameters<typeof TaskService>[7];
  const terminalAttentionStore = new TerminalAttentionStore(config);
  const taskService = new TaskService(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    overrides?.sessionUsageService,
    overrides?.workspaceGoalService,
    streamManager,
    new SecretsStore(config.rootDir),
    terminalAttentionStore
  );
  const workspaceTurnManager = new WorkspaceTurnManager(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    taskService,
    terminalAttentionStore,
    new MutexMap<string>(),
    streamManager
  );
  taskService.setWorkspaceTurnManager(workspaceTurnManager);
  workspaceTurnManagerByTaskService.set(taskService, workspaceTurnManager);
  const managerInternals = workspaceTurnManager as unknown as {
    taskHandleStore: TaskHandleStore;
    activeWorkspaceTurnHandleByWorkspaceId: Map<
      string,
      { handleId: string; ownerWorkspaceId: string; accepted: boolean }
    >;
  };
  Object.defineProperties(taskService, {
    taskHandleStore: { value: managerInternals.taskHandleStore },
    activeWorkspaceTurnHandleByWorkspaceId: {
      value: managerInternals.activeWorkspaceTurnHandleByWorkspaceId,
    },
  });
  const managerRecord = workspaceTurnManager as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(WorkspaceTurnManager.prototype)) {
    if (name === "constructor" || name in taskService) continue;
    const method = managerRecord[name];
    if (typeof method === "function") {
      Object.defineProperty(taskService, name, { value: method.bind(workspaceTurnManager) });
    }
  }

  return {
    historyService,
    partialService,
    taskService,
    aiService,
    workspaceService,
    initStateManager,
  };
}

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function startWorkspaceTurnForTest(
    options: {
      stableIds?: string[];
      disposable?: boolean;
      sendMessage?: ReturnType<typeof mock>;
      remove?: ReturnType<typeof mock>;
      isStreaming?: ReturnType<typeof mock>;
      hasQueuedMessages?: ReturnType<typeof mock>;
      hasPendingQueuedOrPreparingTurn?: ReturnType<typeof mock>;
      hasPendingBashMonitorWakeContinuation?: ReturnType<typeof mock>;
      hasPendingWorkspaceTurnContinuation?: ReturnType<typeof mock>;
      getQueueCutCutter?: ReturnType<typeof mock>;
      hasPendingAutoRetry?: ReturnType<typeof mock>;
      waitForPendingStreamErrorRecoveryDecision?: ReturnType<typeof mock>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, options.stableIds ?? ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, ...options });
    const aiMocks = createAIServiceMocks(config, {
      ...(options.isStreaming != null ? { isStreaming: options.isStreaming } : {}),
    });
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new", ...(options.disposable === true ? { disposable: true } : {}) },
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error(created.error);
    }

    return {
      config,
      parentId,
      projectPath,
      taskService,
      workspaceMocks,
      aiMocks,
      historyService,
      created: created.data,
    };
  }

  async function createWorkspaceLifecycleHarness(
    options: {
      archived?: boolean;
      archive?: ReturnType<typeof mock>;
      unarchive?: ReturnType<typeof mock>;
      preflightArchive?: ReturnType<typeof mock>;
      listLiveWorkspaceActivity?: ReturnType<typeof mock>;
      hasRunningBackgroundBashProcesses?: ReturnType<typeof mock>;
      isSnapshotArchiveEligibilityMutationSensitive?: ReturnType<typeof mock>;
      hasUntrackableExternalAppOpen?: ReturnType<typeof mock>;
      create?: ReturnType<typeof mock>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "child"),
        id: "childworkspace",
        name: "child",
        title: "Child workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
        ...(options.archived ? { archivedAt: new Date().toISOString() } : {}),
      });
      project.workspaces.push({
        path: path.join(projectPath, "unowned"),
        id: "unownedworkspace",
        name: "unowned",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const workspaceMocks = createWorkspaceServiceMocks(options);
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_created",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-created",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Created child",
    });
    return { config, parentId, projectPath, taskService, taskHandleStore, ...workspaceMocks };
  }

  function markWorkspaceTurnActive(
    taskService: TaskService,
    workspaceId: string,
    handleId: string,
    ownerWorkspaceId: string
  ): void {
    // normalizeWorkspaceTurnRecord self-heals "running" records that have no live
    // in-process execution, so active-turn tests must register the handle as live.
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceId, { handleId, ownerWorkspaceId });
  }

  test("workspace lifecycle archives only parent-owned created workspace turns", async () => {
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness();

    const archived = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    const unowned = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "unownedworkspace" },
      {}
    );

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "archive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle treats existing follow-up handles as owned when the workspace was created by the parent", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_existing",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-existing",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Existing child",
    });

    const result = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_existing" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        taskId: "wst_existing",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
  });

  test("workspace lifecycle serializes concurrent handles that resolve to the same workspace", async () => {
    let archiveCallCount = 0;
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      archiveCallCount += 1;
      await Promise.resolve();
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_existing",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-existing",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Existing child",
    });

    const results = await Promise.all([
      workspaceTurnManagerFor(harness.taskService).archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_created" },
        {}
      ),
      workspaceTurnManagerFor(harness.taskService).archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_existing" },
        {}
      ),
    ]);

    expect(results.map((result) => (result.success ? result.data.status : "error")).sort()).toEqual(
      ["already_archived", "archived"]
    );
    expect(archiveCallCount).toBe(1);
  });

  test("workspace lifecycle rejects existing follow-up handles for workspaces this parent did not create", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_foreignexisting",
      ownerWorkspaceId: parentId,
      workspaceId: "unownedworkspace",
      turnId: "turn-foreign-existing",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "Unowned existing child",
    });

    const result = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_foreignexisting" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "invalid_scope",
        action: "archive",
        taskId: "wst_foreignexisting",
        workspaceId: "unownedworkspace",
      })
    );
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle returns archive confirmation and treats already archived as idempotent", async () => {
    const confirmationArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const { config, parentId, projectPath, taskService, taskHandleStore } =
      await createWorkspaceLifecycleHarness({ archive: confirmationArchive });

    const confirmation = await workspaceTurnManagerFor(
      taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(confirmation).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", ["scratch.txt"], {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    const confirmationByTaskId = await workspaceTurnManagerFor(
      taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_created" },
      { acknowledgedUntrackedPathsByWorkspaceId: { childworkspace: ["task-scratch.txt"] } }
    );

    expect(confirmationByTaskId).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        taskId: "wst_created",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", ["task-scratch.txt"], {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    await config.editConfig((cfg) => {
      const child = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.archivedAt = new Date().toISOString();
      return cfg;
    });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    const alreadyArchived = await workspaceTurnManagerFor(
      taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(alreadyArchived).toEqual(
      Ok({
        status: "already_archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(confirmationArchive).toHaveBeenCalledTimes(2);
  });

  test("workspace lifecycle requires explicit interruption for active workspace turns before archive", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(taskService, "childworkspace", "wst_running", parentId);

    const active = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(archive).not.toHaveBeenCalled();

    const interrupted = await workspaceTurnManagerFor(
      taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(interrupted).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
    const runningRecord = await taskHandleStore.getWorkspaceTurn(parentId, "wst_running");
    expect(runningRecord?.status).toBe("interrupted");
  });

  test("workspace lifecycle unarchives archived owned workspaces and treats unarchived as idempotent", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const unarchive = mock(async (): Promise<Result<void>> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before unarchive runs");
      assert(projectPath, "harness project path must be assigned before unarchive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.unarchivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok(undefined);
    });
    const harness = await createWorkspaceLifecycleHarness({ archived: true, unarchive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const unarchived = await workspaceTurnManagerFor(
      harness.taskService
    ).unarchiveOwnedWorkspaceTurnWorkspace(harness.parentId, { taskId: "wst_created" });

    expect(unarchived).toEqual(
      Ok({
        status: "unarchived",
        action: "unarchive",
        taskId: "wst_created",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(unarchive).toHaveBeenCalledWith("childworkspace");

    const alreadyUnarchived = await workspaceTurnManagerFor(
      harness.taskService
    ).unarchiveOwnedWorkspaceTurnWorkspace(harness.parentId, { workspaceId: "childworkspace" });

    expect(alreadyUnarchived).toEqual(
      Ok({
        status: "already_unarchived",
        action: "unarchive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(unarchive).toHaveBeenCalledTimes(1);

    const unowned = await workspaceTurnManagerFor(
      harness.taskService
    ).unarchiveOwnedWorkspaceTurnWorkspace(harness.parentId, { workspaceId: "unownedworkspace" });

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "unarchive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle unarchive reports active turns without interrupting", async () => {
    const { parentId, taskService, taskHandleStore, unarchive } =
      await createWorkspaceLifecycleHarness({ archived: true });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(taskService, "childworkspace", "wst_running", parentId);

    const result = await workspaceTurnManagerFor(taskService).unarchiveOwnedWorkspaceTurnWorkspace(
      parentId,
      {
        workspaceId: "childworkspace",
      }
    );

    expect(result).toEqual(
      Ok({
        status: "active",
        action: "unarchive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(unarchive).not.toHaveBeenCalled();
    const runningRecord = await taskHandleStore.getWorkspaceTurn(parentId, "wst_running");
    expect(runningRecord?.status).toBe("running");
  });

  test("workspace lifecycle archive blocks existing-mode follow-ups until unarchive restores them", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const editChildWorkspace = async (
      edit: (child: WorkspaceConfigEntry) => void
    ): Promise<void> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned");
      assert(projectPath, "harness project path must be assigned");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        edit(child);
        return cfg;
      });
    };
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await editChildWorkspace((child) => {
        child.archivedAt = new Date().toISOString();
      });
      return Ok({ kind: "archived" });
    });
    const unarchive = mock(async (): Promise<Result<void>> => {
      await editChildWorkspace((child) => {
        child.unarchivedAt = new Date().toISOString();
      });
      return Ok(undefined);
    });
    const harness = await createWorkspaceLifecycleHarness({ archive, unarchive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archived = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, { workspaceId: "childworkspace" }, {});
    expect(archived.success && archived.data.status === "archived").toBe(true);

    const refused = await workspaceTurnManagerFor(harness.taskService).createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(refused).toEqual(Err("Task.createWorkspaceTurn: existing workspace is archived"));

    const unarchived = await workspaceTurnManagerFor(
      harness.taskService
    ).unarchiveOwnedWorkspaceTurnWorkspace(harness.parentId, { workspaceId: "childworkspace" });
    expect(unarchived.success && unarchived.data.status === "unarchived").toBe(true);

    const followUp = await workspaceTurnManagerFor(harness.taskService).createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
  });

  test("workspace lifecycle serializes archive with follow-up handle persistence", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await archiveGate;
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archivePromise = workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, { workspaceId: "childworkspace" }, {});
    // Wait until the archive operation holds the lifecycle lock (it is inside
    // workspaceService.archive, gated on archiveGate).
    const waitStart = Date.now();
    while (archive.mock.calls.length === 0) {
      if (Date.now() - waitStart > 5000) throw new Error("archive mock was never invoked");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Launch a follow-up while the archive is mid-flight: it must serialize on the shared
    // lifecycle lock and be refused after the archive lands, instead of persisting a handle
    // the already-committed archive would silently truncate.
    const followUpPromise = workspaceTurnManagerFor(harness.taskService).createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseArchive?.();

    const [archived, followUp] = await Promise.all([archivePromise, followUpPromise]);
    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(followUp.success).toBe(false);
    expect(followUp.success ? "" : followUp.error).toMatch(/archived/);
    const activeHandles = await workspaceTurnManagerFor(harness.taskService).listWorkspaceTurnTasks(
      harness.parentId,
      {
        statuses: ["queued", "starting", "running"],
      }
    );
    expect(activeHandles).toEqual([]);
  });

  test("workspace lifecycle archive blocks on active turns owned by the target", async () => {
    const { config, parentId, projectPath, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "grandchild"),
        id: "grandchildworkspace",
        name: "grandchild",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    // Nested delegation: the peer (childworkspace) owns an active turn targeting a grandchild.
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_nested",
      ownerWorkspaceId: "childworkspace",
      workspaceId: "grandchildworkspace",
      turnId: "turn-nested",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: true,
      disposableWorkspace: false,
      title: "Nested turn",
    });
    markWorkspaceTurnActive(taskService, "grandchildworkspace", "wst_nested", "childworkspace");

    const active = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_nested"],
      })
    );
    expect(archive).not.toHaveBeenCalled();

    // interrupt_active does not cascade into turns running in OTHER workspaces: the nested
    // workspace never gets the activity checks and admission holds the target does, so
    // interruption (and any disposable cleanup) there could destroy user work unseen.
    const refusedNested = await workspaceTurnManagerFor(
      taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(refusedNested.success).toBe(true);
    if (refusedNested.success) {
      expect(refusedNested.data.status).toBe("active");
      expect(refusedNested.data.note).toContain("nested workspaces (grandchildworkspace)");
    }
    expect(archive).not.toHaveBeenCalled();
    const nested = await taskHandleStore.getWorkspaceTurn("childworkspace", "wst_nested");
    expect(nested?.status).toBe("running");
  });

  test("workspace lifecycle preflights lossy confirmation before interrupting active turns", async () => {
    const preflightArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // Unacknowledged lossy confirmation must surface BEFORE any interruption so a refused
    // confirmation leaves the in-flight work running.
    const confirmation = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(confirmation).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");

    // With acknowledged paths the preflight is skipped (archive re-validates at capture time)
    // and interruption proceeds.
    const archived = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    // Preflight runs before interruption on BOTH calls; the acknowledged set covering the
    // reported paths is what lets the second call proceed.
    expect(preflightArchive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledWith("childworkspace", ["scratch.txt"], {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
    const interrupted = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test("workspace lifecycle refuses archive when worktree archive behavior deletes checkouts", async () => {
    const { config, parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      cfg.worktreeArchiveBehavior = "delete";
      // The refusal is scoped to targets the worktree archive hook would actually delete, so
      // this test's child must be a managed worktree runtime.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = { type: "local", srcBaseDir: "/tmp/src" };
        }
      }
      return cfg;
    });

    const result = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("Delete checkout");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses snapshot archive after a native terminal was opened", async () => {
    // Native emulator lifetime is untrackable, so a snapshot archive (which removes the
    // checkout) must fail closed instead of deleting the directory under the user's shell.
    const harness = await createWorkspaceLifecycleHarness({
      isSnapshotArchiveEligibilityMutationSensitive: mock(() => true),
      hasUntrackableExternalAppOpen: mock(() => true),
    });

    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("native terminal");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle archives non-worktree targets despite the delete worktree policy", async () => {
    const { config, parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      cfg.worktreeArchiveBehavior = "delete";
      // SSH runtime: the worktree archive hook skips non-worktree runtimes, so the unrelated
      // global delete policy must not make reversible archive unavailable for this peer.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "peer.example",
            srcBaseDir: "/home/user/src",
          };
        }
      }
      return cfg;
    });

    const result = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "delete",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
  });

  test("workspace lifecycle serializes nested turn creation with archiving its owner", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await archiveGate;
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const create = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before create runs");
      assert(projectPath, "harness project path must be assigned before create runs");
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: path.join(projectPath, "grandchild"),
          id: "grandchildworkspace",
          name: "grandchild",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      return Ok({
        metadata: {
          id: "grandchildworkspace",
          name: "grandchild",
          projectName: "repo",
          projectPath,
          runtimeConfig: { type: "local" },
          createdAt: new Date().toISOString(),
        },
      });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive, create });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archivePromise = workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, { workspaceId: "childworkspace" }, {});
    const waitStart = Date.now();
    while (archive.mock.calls.length === 0) {
      if (Date.now() - waitStart > 5000) throw new Error("archive mock was never invoked");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The peer starts a nested workspace turn while its own archive is mid-flight. The
    // persist section locks on the OWNER too, so it must serialize behind the archive and be
    // refused instead of leaving an active nested handle owned by an archived workspace.
    const nestedPromise = workspaceTurnManagerFor(harness.taskService).createWorkspaceTurn({
      ownerWorkspaceId: "childworkspace",
      prompt: "Nested work",
      title: "Nested work",
      workspace: { mode: "new" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseArchive?.();

    const [archived, nested] = await Promise.all([archivePromise, nestedPromise]);
    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(nested.success).toBe(false);
    expect(nested.success ? "" : nested.error).toMatch(/owner workspace was archived/);
    // The refused nested creation had already materialized its workspace; without an ownership
    // handle the archived owner could never manage it, so it must be removed, not leaked.
    expect(harness.remove).toHaveBeenCalledWith("grandchildworkspace", true);
    const nestedHandles = await workspaceTurnManagerFor(harness.taskService).listWorkspaceTurnTasks(
      "childworkspace",
      {
        statuses: ["queued", "starting", "running"],
      }
    );
    expect(nestedHandles).toEqual([]);
  });

  test("workspace lifecycle refuses archive while the target has live non-turn activity", async () => {
    const listLiveWorkspaceActivity = mock(() => ({
      streaming: true,
      terminalSessions: true,
      desktopSession: false,
    }));
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness({
      listLiveWorkspaceActivity,
    });

    // No delegated turns explain the stream, and terminals are never turn-driven; even
    // interrupt_active must not let the tool kill user activity.
    const result = await workspaceTurnManagerFor(taskService).archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.note : "").toContain("an active stream");
    expect(data?.status === "active" ? data.note : "").toContain("open terminal sessions");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle re-confirms when acknowledged paths no longer cover the preflight", async () => {
    const preflightArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(
          Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt", "new-file.txt"] })
        )
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // The acknowledged set predates a new untracked file: surface a fresh confirmation
    // BEFORE interrupting instead of destroying the turn and then failing the archive.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, acknowledgedUntrackedPaths: ["scratch.txt"] }
    );

    expect(result).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt", "new-file.txt"],
      })
    );
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle re-confirms when acknowledged paths include entries the preflight no longer reports", async () => {
    const preflightArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // The acknowledged set is a stale SUPERSET (one acknowledged file was removed). The archive
    // sink requires exact list equality, so a subset check here would interrupt the turn and
    // then still bounce with requires_confirmation — the acknowledgement must be re-confirmed
    // BEFORE anything is interrupted.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true, acknowledgedUntrackedPaths: ["scratch.txt", "stale.txt"] }
    );

    expect(result).toEqual(
      Ok({
        status: "requires_confirmation",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        paths: ["scratch.txt"],
      })
    );
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle refuses interrupt_active when snapshot eligibility is mutation-sensitive", async () => {
    const isSnapshotArchiveEligibilityMutationSensitive = mock(() => true);
    const harness = await createWorkspaceLifecycleHarness({
      isSnapshotArchiveEligibilityMutationSensitive,
    });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // Snapshot archives require an exact untracked-file acknowledgement that running turns can
    // invalidate mid-interruption, so honoring interrupt_active could destroy in-flight work and
    // still bounce with requires_confirmation. Refuse instead and leave the turn running.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.activeTaskIds : []).toEqual(["wst_running"]);
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain(
      "interrupt_active was not honored"
    );
    expect(harness.archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle archive interruption never removes a disposable target workspace", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_disposable",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-disposable",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: true,
      disposableWorkspace: true,
    });
    markWorkspaceTurnActive(
      harness.taskService,
      "childworkspace",
      "wst_disposable",
      harness.parentId
    );

    // Interrupting a disposable workspace-turn normally auto-removes its workspace; when the
    // interruption serves an archive (retain), that cleanup would delete the checkout out from
    // under the subsequent archive call, which would then fail with "Workspace not found".
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(harness.remove).not.toHaveBeenCalled();
    const interrupted = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_disposable"
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test("workspace lifecycle refuses archive when the workflow activity scan fails", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    // A corrupt run record makes the strict activity scan throw: the absence of active
    // workflow runs is no longer provable, so archive must refuse instead of proceeding
    // while a crash-recovered run might still resume into the archived workspace.
    await fsPromises.mkdir(
      path.join(
        path.join(harness.config.sessionsDir, "childworkspace"),
        "workflows",
        "wfr_corrupt"
      ),
      { recursive: true }
    );

    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("Could not verify");
    expect(harness.archive).not.toHaveBeenCalled();
    // The sink-side recheck fails closed on the same unreadable store.
    expect(
      await harness.taskService.hasActiveTopLevelWorkflowRunsForWorkspace("childworkspace")
    ).toBe(true);
  });

  test("workspace lifecycle refuses archive while the target owns an active workflow run", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(harness.config.sessionsDir, "childworkspace"),
    });
    await runStore.createRun({
      id: "wfr_child_active",
      workspaceId: "childworkspace",
      workflow: {
        name: "child-active",
        description: "Active child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: new Date().toISOString(),
    });

    // Workflows idle between steps own no descendant agent or turn at that instant, but
    // archiving would break the next step; interrupt_active must not apply to workflow runs.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.activeTaskIds : []).toContain("wfr_child_active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("workflow runs");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle treats queued user messages as live activity", async () => {
    const listLiveWorkspaceActivity = mock(() => ({
      streaming: false,
      queuedMessages: true,
      terminalSessions: false,
      desktopSession: false,
    }));
    const harness = await createWorkspaceLifecycleHarness({ listLiveWorkspaceActivity });

    // No delegated queued turn explains the queue entry, so it is user work: a queued message
    // would dispatch through AgentSession's internal send path after archive and stream hidden.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("queued messages");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses archive of a dedicated Coder workspace under the delete policy", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      cfg.coderWorkspaceArchiveBehavior = "delete";
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });

    // The before-archive hook would permanently delete the dedicated remote Coder workspace
    // and unarchive cannot recreate it — the reversible model-facing verb must fail closed.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain(
      "Coder workspace archive behavior"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses stopping a dedicated Coder workspace under an untrackable app", async () => {
    // Snapshot capture never runs for SSH runtimes, but a "stop" Coder policy still pulls the
    // remote environment out from under a native terminal/editor the user may be connected
    // through — the untrackable-app refusal must cover that hazard too.
    const harness = await createWorkspaceLifecycleHarness({
      hasUntrackableExternalAppOpen: mock(() => true),
    });
    await harness.config.editConfig((cfg) => {
      cfg.coderWorkspaceArchiveBehavior = "stop";
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });

    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain(
      "stop the dedicated remote Coder workspace"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active for nested disposable turn workspaces", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      for (const [, project] of cfg.projects) {
        if (project.workspaces.some((w) => w.id === "childworkspace")) {
          project.workspaces.push({
            path: `${project.workspaces[0].path}-grandchild`,
            id: "grandchildworkspace",
            name: "grandchild",
            title: "Grandchild workspace",
            createdAt: new Date().toISOString(),
            runtimeConfig: { type: "local" },
          });
        }
      }
      return cfg;
    });
    // Nested turn OWNED BY the archive target, running in its own disposable workspace:
    // interrupting it would trigger that workspace's disposable force-removal without any of
    // the activity checks or admission holds the target gets — user terminals/editors/queued
    // work there would be destroyed unseen. interrupt_active must refuse instead of
    // cascading; the caller stops the turn explicitly (task_stop), which runs the same
    // user-visible cleanup as normal settlement.
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_nested",
      ownerWorkspaceId: "childworkspace",
      workspaceId: "grandchildworkspace",
      turnId: "turn-nested",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: true,
      disposableWorkspace: true,
    });
    markWorkspaceTurnActive(
      harness.taskService,
      "grandchildworkspace",
      "wst_nested",
      "childworkspace"
    );

    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
      expect(result.data.activeTaskIds).toEqual(["wst_nested"]);
      expect(result.data.note).toContain("nested workspaces (grandchildworkspace)");
    }
    expect(harness.archive).not.toHaveBeenCalled();
    // Nothing was interrupted or removed: the nested turn and its workspace are untouched.
    expect(harness.remove).not.toHaveBeenCalled();
    const nestedRecord = await harness.taskHandleStore.getWorkspaceTurn(
      "childworkspace",
      "wst_nested"
    );
    expect(nestedRecord?.status).toBe("running");
  });

  test("workspace lifecycle refuses archive while background bash processes are running", async () => {
    const hasRunningBackgroundBashProcesses = mock((): Promise<boolean> => Promise.resolve(true));
    const harness = await createWorkspaceLifecycleHarness({ hasRunningBackgroundBashProcesses });

    // Detached background bash outlives its spawning turn: interruption cannot stop it, and a
    // snapshot archive could remove the worktree under a process still writing.
    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain(
      "running background bash processes"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active for a dedicated Coder workspace under the stop policy", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      // Default Coder policy is "stop": the sink's before-archive hook stops the remote
      // workspace and can fail AFTER interruption destroyed the turns.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_running",
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      turnId: "turn-running",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("fallible remote stop");
    expect(harness.archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle interruption tolerates turns that settled after collection", async () => {
    // The preflight runs between collection and interruption; settle one of the two active
    // turns there to prove a now-terminal handle is skipped instead of aborting the archive.
    const harnessRefs: {
      taskHandleStore?: TaskHandleStore;
      taskService?: TaskService;
      parentId?: string;
    } = {};
    const preflightArchive = mock(async (): Promise<Result<{ kind: "ready" }>> => {
      const { taskHandleStore, taskService, parentId } = harnessRefs;
      assert(taskHandleStore && taskService && parentId, "harness refs must be assigned");
      const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_settling");
      assert(settled, "settling turn must exist");
      await taskHandleStore.upsertWorkspaceTurn({
        ...settled,
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
      (
        taskService as unknown as {
          activeWorkspaceTurnHandleByWorkspaceId: Map<string, unknown>;
        }
      ).activeWorkspaceTurnHandleByWorkspaceId.delete("childworkspace");
      return Ok({ kind: "ready" });
    });
    const harness = await createWorkspaceLifecycleHarness({ preflightArchive });
    harnessRefs.taskHandleStore = harness.taskHandleStore;
    harnessRefs.taskService = harness.taskService;
    harnessRefs.parentId = harness.parentId;
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    };
    await harness.taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_settling",
      turnId: "turn-settling",
      status: "running",
    });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_queued",
      turnId: "turn-queued",
      status: "queued",
    });
    markWorkspaceTurnActive(
      harness.taskService,
      "childworkspace",
      "wst_settling",
      harness.parentId
    );

    const result = await workspaceTurnManagerFor(
      harness.taskService
    ).archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    const settled = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_settling"
    );
    expect(settled?.status).toBe("completed");
    const queued = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_queued");
    expect(queued?.status).toBe("interrupted");
  });

  test("createWorkspaceTurn creates a normal workspace and starts a correlated turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      taskId: "wst_childworkspace",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
    expect(childConfig?.tags).toMatchObject({
      "mux.taskHandleId": "wst_childworkspace",
      "mux.taskOwnerWorkspaceId": parentId,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    expect(sendMessageCall[1]).toBe("Summarize the repo");
    expect(sendMessageCall[2]).toMatchObject({ agentId: "exec" });
    expect(sendMessageCall[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: true,
      agentInitiated: true,
    });
  });

  test("createWorkspaceTurn launches a new workspace with an explicit agent id", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan a small change",
      title: "Plan dogfood",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[0]).toBe("childworkspace");
    // Explicit overrides also arm stream-time strict resolution, pinning the validated
    // definition's provenance (scope + exact source): pre-dispatch validation races
    // init hooks/user edits, so the stream must fail loudly instead of silently
    // swapping in exec (or running a different definition for the same id) post-init.
    expect(sendMessageCall[2]).toMatchObject({
      agentId: "plan",
      strictAgentResolution: {
        expectedScope: "built-in",
        expectedSource: "built-in",
        // The full base chain is pinned too: stream-time inheritance resolution
        // reloads every base independently.
        expectedChain: [{ id: "plan", scope: "built-in", source: "built-in" }],
      },
    });
  });

  test("createWorkspaceTurn keeps prechecks advisory when the owner has uncommitted agent changes", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    // A GITIGNORED hidden shadow of the built-in plan exists only in the owner's
    // working tree (plain `git status` would not even list it): the new checkout is
    // created from committed branch state and validly resolves the built-in, so the
    // owner-side miss must stay advisory (branch equality is not checkout equality).
    await fsPromises.writeFile(path.join(projectPath, ".gitignore"), ".mux/agents/\n");
    commitOwnerAgentFiles(projectPath);
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "plan.md"),
      ["---", "name: Plan", "base: plan", "ui:", "  hidden: true", "---", "Shadow."].join("\n")
    );

    const cleanCheckout = path.join(rootDir, "clean-target-checkout");
    await fsPromises.mkdir(cleanCheckout, { recursive: true });
    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: cleanCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan from the committed base",
      title: "Dirty owner shadow",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ agentId: "plan" });
  });

  test("createWorkspaceTurn owner-side misses are always advisory (target decides)", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // No owner-side equivalence proof is sound (fetched origin commits, existing
    // branchName targets, submodules, init hooks): the created checkout is the only
    // authoritative source, so a miss defers instead of rejecting pre-create.
    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "doesnotexist",
      prompt: "Should defer to the target",
      title: "Advisory miss",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("unknown agentId");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects bad agent ids without ever dispatching a turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const attempt = (agentId: string) =>
      workspaceTurnManagerFor(taskService).createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        agentId,
        prompt: "Should not run",
        title: "Bad agent",
        workspace: { mode: "new" },
      });

    // Syntactically invalid ids are checkout-independent and fail before any
    // workspace exists.
    const invalidSyntax = await attempt("Not A Valid Id!");
    expect(invalidSyntax.success).toBe(false);
    if (!invalidSyntax.success) expect(invalidSyntax.error).toContain("invalid agentId");
    expect(createWorkspace).not.toHaveBeenCalled();

    // Definition-dependent verdicts are decided by the created target checkout
    // (owner-side prechecks are advisory): unknown and internal (ui.hidden) ids
    // fail there, with the workspace retained as owned evidence and no dispatch.
    const unknown = await attempt("doesnotexist");
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error).toContain("unknown agentId");
      expect(unknown.error).toContain("no turn was dispatched");
    }

    const internal = await attempt("compact");
    expect(internal.success).toBe(false);
    if (!internal.success) {
      expect(internal.error).toContain("not selectable");
      expect(internal.error).toContain("no turn was dispatched");
    }

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects disabled agents without dispatching a turn", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { custom: { enabled: false } },
    });
    checkoutOwnerBranch(projectPath, "parent");
    await writeCustomAgentDefinition(projectPath);
    commitOwnerAgentFiles(projectPath);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not run",
      title: "Disabled agent",
      workspace: { mode: "new" },
    });

    // Enablement is decided at the created target checkout (owner prechecks are
    // advisory); the disabled verdict settles post-create with no dispatch.
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("disabled");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn does not dispatch when the agent is unavailable in the created workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Project-local agent exists in the OWNER's checkout, but the created workspace's checkout
    // diverges (no agent definition there) — post-create re-validation must fail instead of
    // silently streaming exec. Worktree runtime: the only local runtime whose created
    // workspaces get a checkout separate from the project root.
    await writeCustomAgentDefinition(projectPath);
    const divergedCheckout = path.join(rootDir, "diverged-checkout");
    await fsPromises.mkdir(divergedCheckout, { recursive: true });

    const divergedMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: divergedCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: divergedMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not dispatch",
      title: "Diverged agent",
      workspace: { mode: "new" },
      // Background launch: on this synchronous failure the policy must NOT be persisted —
      // settleWorkspaceTurn derives the terminal wake from the persisted record, which
      // would duplicate the Err returned directly to the caller.
      attentionPolicy: "notify_on_terminal",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    // The failure settles through the handle machinery, so the created workspace stays
    // owner-owned: a mode="existing" retry must pass the ownership check (not invalid_scope).
    const turns = await (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: () => Promise<Array<{ status: string; attentionPolicy?: string }>>;
        };
      }
    ).taskHandleStore.listAllWorkspaceTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "error", createdWorkspace: true });
    expect(turns[0]?.attentionPolicy).toBeUndefined();

    const retry = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Retry without the diverged agent",
      title: "Diverged agent retry",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(retry.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("createWorkspaceTurn respects a project shadow of a built-in id at the target", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    // Shadow the built-in plan agent with a hidden project-local override: target-side
    // eligibility must consult the shadow, not just the embedded definition.
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "plan.md"),
      [
        "---",
        "name: Plan",
        "description: Hidden shadowed plan",
        "base: plan",
        "ui:",
        "  hidden: true",
        "---",
        "",
        "Shadow body.",
        "",
      ].join("\n"),
      "utf-8"
    );
    commitOwnerAgentFiles(projectPath);

    const createWorkspace = makeCreateMockReturning(
      Ok({ metadata: createWorkspaceTurnMetadata(projectPath) })
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not run",
      title: "Shadowed plan",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not selectable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn divergent trunkBranch defers validation to the target checkout", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Agent exists ONLY on the target branch checkout, not in the owner's checkout: an
    // owner-side miss must not fail-fast when a different base branch was requested.
    const targetBranchCheckout = path.join(rootDir, "target-branch-checkout");
    const targetAgentsDir = path.join(targetBranchCheckout, ".mux", "agents");
    await fsPromises.mkdir(targetAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(targetAgentsDir, "custom.md"),
      [
        "---",
        "name: Custom",
        "description: Target-branch-only agent",
        "base: exec",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "utf-8"
    );

    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: targetBranchCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Run the target-branch agent",
      title: "Target branch agent",
      workspace: { mode: "new", trunkBranch: "feature-branch" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({ agentId: "custom" });
  });

  test("createWorkspaceTurn divergent trunkBranch fails closed for unreachable targets", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    // A different base branch can shadow ANY id (even built-ins), so an unreachable
    // target created from it cannot be verified at all.
    const unreachableMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: path.join(rootDir, "not-provisioned-branch"),
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: unreachableMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Divergent unreachable",
      workspace: { mode: "new", trunkBranch: "feature-branch" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not reachable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn unreachable created checkout: built-ins launch, custom agents fail with a reachability error", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");
    await writeCustomAgentDefinition(projectPath);
    commitOwnerAgentFiles(projectPath);
    // Deferred-provisioning runtimes return from create before the checkout is reachable.
    const unreachableCheckout = path.join(rootDir, "not-provisioned-yet");

    const deferredMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: unreachableCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: deferredMetadata }))
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Custom agents cannot be verified in an unreachable checkout; dispatching anyway
    // would risk a silent exec fallback at stream time, so the launch must fail loudly.
    const custom = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Launch despite pending provisioning",
      title: "Deferred runtime",
      workspace: { mode: "new" },
    });
    expect(custom.success).toBe(false);
    if (!custom.success) {
      expect(custom.error).toContain("not reachable");
      expect(custom.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();

    // Built-in agents are embedded in every checkout, so the launch is provably safe.
    const builtIn = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan despite pending provisioning",
      title: "Deferred runtime plan",
      workspace: { mode: "new" },
    });
    expect(builtIn.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0];
    expect(sendMessageCall?.[2]).toMatchObject({ agentId: "plan" });
  });

  test("createWorkspaceTurn treats sanitized branch-name collisions as unproven bases", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    // Owner is checked out on feature/foo, whose workspace name sanitizes to feature-foo.
    // A request for the DISTINCT branch feature-foo collides with that name, so the owner
    // must not vouch for the unreachable target: even a built-in id fails closed (the
    // colliding branch could shadow it).
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      workspaceName: "feature-foo",
    });
    checkoutOwnerBranch(projectPath, "feature/foo");

    const unreachableMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: path.join(rootDir, "not-provisioned-collision"),
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: unreachableMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Colliding branch",
      workspace: { mode: "new", trunkBranch: "feature-foo" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not reachable");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();

    // The owner's real branch, by contrast, is a proven base: the same launch succeeds.
    const sameBranch = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Plan from the owner's own branch",
      title: "Same branch",
      workspace: { mode: "new", trunkBranch: "feature/foo" },
    });
    expect(sameBranch.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("createWorkspaceTurn defers owner-side misses to the target when the base is unproven", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    // Owner is on feature/foo but its workspace name is feature-foo: with trunkBranch
    // omitted, the child is created from the DISTINCT feature-foo branch, which may carry
    // agents absent from the owner's branch. An owner-side miss must not fail-fast here —
    // the created target checkout is authoritative.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      workspaceName: "feature-foo",
    });
    checkoutOwnerBranch(projectPath, "feature/foo");

    const targetOnlyCheckout = path.join(rootDir, "target-only-agent");
    const targetAgentsDir = path.join(targetOnlyCheckout, ".mux", "agents");
    await fsPromises.mkdir(targetAgentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(targetAgentsDir, "custom.md"),
      ["---", "name: Custom", "base: exec", "---", "Target-only agent."].join("\n")
    );

    const targetMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: targetOnlyCheckout,
    };
    const createWorkspace = makeCreateMockReturning(Ok({ metadata: targetMetadata }));
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Run the target-only agent",
      title: "Target-only agent",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ agentId: "custom" });
  });

  test("createWorkspaceTurn unreachable cross-host target fails closed even for built-ins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    checkoutOwnerBranch(projectPath, "parent");

    // The created target lives on a remote host (per-workspace containers, Coder-style
    // per-workspace hosts). The owner's global agent roots say nothing about that host —
    // even a built-in could be shadowed by a target-host global definition — so
    // owner-side resolution must not vouch while the checkout is unreachable.
    const remoteMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "docker", image: "node:20" },
      namedWorkspacePath: "/workspace/repo",
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: remoteMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Should not dispatch",
      title: "Cross-host unreachable",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("different host");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
    // The unreachable probe drives real docker CLI calls whose internal
    // timeouts (10-30s) can exceed the 5s default on loaded CI runners.
  }, 20_000);

  test("createWorkspaceTurn does not verify agents while the created workspace is still initializing", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath);
    // Reachable checkout whose init hook is still running: the hook may still be
    // installing/rewriting agent definitions, so a strict-validation miss is not a
    // trustworthy "unknown agentId" verdict — the launch must fail with a transient
    // error instead of a definitive one (and never dispatch an unverified id).
    const initializingCheckout = path.join(rootDir, "initializing-checkout");
    await fsPromises.mkdir(initializingCheckout, { recursive: true });

    const initializingMetadata: WorkspaceMetadata & { namedWorkspacePath: string } = {
      ...createWorkspaceTurnMetadata(projectPath),
      runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
      namedWorkspacePath: initializingCheckout,
    };
    const createWorkspace = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Ok({ metadata: initializingMetadata }))
    );
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const initStateManager = {
      startInit: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
      appendOutput: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      getInitState: mock((workspaceId: string) =>
        workspaceId === "childworkspace" ? { status: "running" } : undefined
      ),
      readInitStatus: mock(() => Promise.resolve(null)),
    } as unknown as InitStateManager;
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
      initStateManager,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "custom",
      prompt: "Should not dispatch",
      title: "Initializing target",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("still initializing");
      expect(result.error).toContain("no turn was dispatched");
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn unreachable existing target: explicit overrides fail closed, default identity works", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "childworkspace",
      "firstturn",
      "planhandle",
      "planturn",
      "customhandle",
    ]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath);
    // Simulates a stopped-container/deferred target: entry exists, checkout unreachable.
    const unreachableCheckout = path.join(rootDir, "stopped-target");

    const createWorkspace = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: unreachableCheckout,
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
        });
        return cfg;
      });
      return Ok({
        metadata: {
          ...createWorkspaceTurnMetadata(projectPath),
          runtimeConfig: { type: "worktree", srcBaseDir: path.join(rootDir, "wt") },
        },
      });
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Initial turn",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Existing targets have unknown checkout provenance (any branch, uncommitted shadows),
    // so ALL explicit overrides fail closed while the checkout is unreachable — even
    // built-ins, whose id could be shadowed by a project definition on the target.
    for (const agentId of ["plan", "custom"]) {
      const overridden = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        agentId,
        prompt: `${agentId} follow-up`,
        title: `${agentId} follow-up`,
        workspace: { mode: "existing", workspaceId: "childworkspace" },
      });
      expect(overridden.success).toBe(false);
      if (!overridden.success) {
        expect(overridden.error).toContain("not reachable");
        expect(overridden.error).not.toContain("unknown agentId");
      }
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Omitting agentId keeps working: the default identity needs no verification.
    const withoutOverride = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Default follow-up",
      title: "Default follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(withoutOverride.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("createWorkspaceTurn rejects explicit agentId for descendant agent workspace targets", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["overridehandle", "overrideturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childWorkspaceId = "reported-child-override";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "reported-child"),
        id: childWorkspaceId,
        name: "agent_explore_reported_child",
        createdAt: "2026-06-19T00:00:00.000Z",
        parentWorkspaceId: parentId,
        agentType: "explore",
        taskStatus: "reported",
        reportedAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Persistent children are pinned to their persisted identity at stream time
    // (resolveAgentForStream ignores per-send agentId when parentWorkspaceId is set),
    // so an override must be rejected instead of silently running the old agent.
    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Re-plan the follow-up",
      title: "Override turn",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: childWorkspaceId },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("descendant agent workspaces");
    }
    expect(sendMessage).not.toHaveBeenCalled();
    const childEntry = findWorkspaceInConfig(config, childWorkspaceId);
    expect(childEntry?.agentType).toBe("explore");
    expect(childEntry?.agentId).toBeUndefined();
  });

  test("createWorkspaceTurn existing-target agent override dispatches without persisting AI settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "firstturn", "followuphandle", "followupturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          // Project-dir local workspaces execute in the project root itself.
          path: projectPath,
          id: "childworkspace",
          name: "workspace-turn",
          title: "Workspace turn",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      return Ok({ metadata: createWorkspaceTurnMetadata(projectPath) });
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Initial turn",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const followUp = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      agentId: "plan",
      prompt: "Per-turn plan follow-up",
      title: "Override follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const followUpCall = sendMessage.mock.calls[1];
    expect(followUpCall[0]).toBe("childworkspace");
    // Override reaches the stream (normal workspaces honor the per-send agentId) but must
    // not overwrite the target's saved agent/settings.
    expect(followUpCall[2]).toMatchObject({ agentId: "plan", skipAiSettingsPersistence: true });
    // The default path keeps persisting (first send carries no override).
    expect(sendMessage.mock.calls[0]?.[2]).not.toMatchObject({ skipAiSettingsPersistence: true });
  });

  test("createWorkspaceTurn inherits pro mode from the parent's active non-exec agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["childworkspace", "turnhandle"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Pro was toggled while a custom agent was active — no exec bucket
          // exists, so inheritance must read the active-agent bucket.
          agentId: "researcher",
          aiSettingsByAgent: {
            researcher: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize the repo",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendMessageCall = sendMessage.mock.calls[0] as unknown[];
    expect(sendMessageCall[2]).toMatchObject({ reasoningMode: "pro" });
  });

  test("createWorkspaceTurn resolves AI settings: agent defaults on create, target settings on follow-up, explicit override wins", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, [
      "firsthandle",
      "firstturn",
      "secondhandle",
      "secondturn",
      "thirdhandle",
      "thirdturn",
    ]);
    // Owner persisted at opus/high (helper default); configured exec agent
    // defaults differ from both the owner's persisted and live settings.
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "openai:gpt-5.2", thinkingLevel: "xhigh" } },
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation: configured agent defaults outrank the owner's live runtime
    // settings (owner turned down to medium must not produce medium children).
    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({
      agentId: "exec",
      model: "openai:gpt-5.2",
      thinkingLevel: "xhigh",
    });

    // Simulate the child's own last-used settings (persist-on-send or a manual
    // flip inside the child workspace).
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "anthropic:claude-opus-4-6", thinkingLevel: "low" },
      };
      return cfg;
    });

    // Follow-up: the target continues its own settings; the owner's bump to
    // high must not drag the child along, and agent defaults no longer apply.
    const second = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      parentRuntimeAiSettings: {
        modelString: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[2]).toMatchObject({
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "low",
    });

    // Explicit per-launch overrides still outrank the target's own settings.
    const third = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Third prompt",
      title: "Override",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(third.success).toBe(true);
    const thirdSend = sendMessage.mock.calls[2];
    expect(thirdSend[2]).toMatchObject({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "medium",
    });
  });

  test("createWorkspaceTurn follow-ups do not re-inject the owner's pro mode over the target's own settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
          },
        },
      ],
      testTaskSettings()
    );

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    // Creation still inherits the owner's pro mode.
    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    const firstSend = sendMessage.mock.calls[0];
    expect(firstSend[2]).toMatchObject({ reasoningMode: "pro" });

    // The child was switched back to standard (absent = standard per
    // WorkspaceAISettingsSchema); follow-ups must respect that.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
      };
      return cfg;
    });

    const second = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(second.success).toBe(true);
    const secondSend = sendMessage.mock.calls[1];
    // The bucket's absent reasoning resolves to explicit standard; the owner's
    // pro must not leak through.
    expect((secondSend[2] as { reasoningMode?: string }).reasoningMode).not.toBe("pro");
  });

  test("createWorkspaceTurn rejects multi-project owners instead of dropping secondary repos", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary", {
      initGit: false,
    });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: secondaryProjectPath, projectName: "repo-secondary" },
          ],
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        extraProjects: [[secondaryProjectPath, { trusted: true, workspaces: [] }]],
      }
    );
    const createWorkspace = makeCreateMockReturning(Err("should not create workspace"));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize all projects",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("multi-project workspace turns are not supported");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn rejects fork mode until workspace turns support forking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const createWorkspace = makeCreateMockReturning(Err("should not create workspace"));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize fork",
      title: "Workspace turn",
      workspace: { mode: "fork" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('workspace.mode="fork" is not supported');
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn marks accepted pre-stream failures as handle errors", async () => {
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        const internal = args[3] as
          | { onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void }
          | undefined;
        await internal?.onAcceptedPreStreamFailure?.({
          type: "unknown",
          raw: "Runtime startup failed",
        });
        return Ok(undefined);
      }
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({ sendMessage });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Runtime startup failed",
      workspaceId: "childworkspace",
    });
  });

  test("createWorkspaceTurn reprompts only owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const taskHandleStore = (
      taskService as unknown as {
        taskHandleStore: {
          listAllWorkspaceTurns: (options?: { statuses?: readonly string[] }) => Promise<unknown[]>;
        };
      }
    ).taskHandleStore;
    const listAllWorkspaceTurns = spyOn(taskHandleStore, "listAllWorkspaceTurns");

    const second = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Second prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      taskId: "wst_secondhandle",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "running",
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Second prompt");
    expect(secondSend[3]).toMatchObject({ requireIdle: true });
    const secondSnapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_secondhandle"
    );
    expect(secondSnapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "running",
    });
    expect(listAllWorkspaceTurns).toHaveBeenCalledTimes(1);
    listAllWorkspaceTurns.mockRestore();

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "other-parent"),
        id: "other-parent",
        name: "other-parent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    const foreign = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: "other-parent",
      prompt: "Should not run",
      title: "Foreign",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(foreign.success).toBe(false);
    if (foreign.success) return;
    expect(foreign.error).toContain("invalid_scope");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("internal workspace-turn execution can continue a reported descendant agent workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["followuphandle", "followupturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childWorkspaceId = "reported-child-workspace";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "reported-child"),
        id: childWorkspaceId,
        name: "agent_explore_reported_child",
        parentWorkspaceId: parentId,
        agentType: "explore",
        taskStatus: "reported",
        reportedAt: "2026-06-19T00:00:00.000Z",
        aiSettingsByAgent: {
          explore: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "medium" },
        },
        taskModelString: "openai:gpt-5.2",
        taskThinkingLevel: "high",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Investigate the follow-up root cause",
      title: "Continue reported child",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: childWorkspaceId },
    });

    expect(result).toEqual(
      Ok({
        taskId: "wst_followuphandle",
        kind: "workspace_turn",
        status: "running",
        workspaceId: childWorkspaceId,
      })
    );
    expect(sendMessage).toHaveBeenCalledWith(
      childWorkspaceId,
      "Investigate the follow-up root cause",
      expect.objectContaining({
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        thinkingLevel: "medium",
      }),
      expect.objectContaining({ requireIdle: true })
    );
  });

  test("continuation settlement delivers a stable child report and suppresses the private wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["continuationreporthandle", "continuationreportturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childWorkspaceId = "reported-child-continuation-result";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "reported-child", childWorkspaceId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Tooling Mapper",
        })
      );
      return cfg;
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true }))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage, resumeStream });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Map the remaining tooling surface.",
      title: "Tooling Mapper",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childWorkspaceId },
    });
    expect(created).toMatchObject({ success: true, data: { workspaceId: childWorkspaceId } });
    if (!created.success) return;

    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: childWorkspaceId,
      messageId: "msg-continuation-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: created.data.taskId,
          ownerWorkspaceId: parentId,
          turnId: "continuationreportturn",
        },
      },
      parts: [{ type: "text", text: "Mapped the tooling surface." }],
    });
    await flushTerminalAttentionDrains(taskService);

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).toContain("<mux_subagent_report>");
    expect(JSON.stringify(parentHistory)).toContain(childWorkspaceId);
    expect(JSON.stringify(parentHistory)).toContain("Mapped the tooling surface.");
    expect(
      sendMessage.mock.calls.some(
        (call) =>
          call[0] === parentId &&
          typeof call[1] === "string" &&
          call[1].includes("Background workspace turn(s) have reached a terminal state")
      )
    ).toBe(false);
    expect(resumeStream).toHaveBeenCalledWith(
      parentId,
      expect.any(Object),
      expect.objectContaining({ agentInitiated: true })
    );

    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const terminalRecord = await taskHandleStore.getWorkspaceTurn(parentId, created.data.taskId);
    assert(terminalRecord, "terminal continuation record must exist");
    const attentionGenerationId = `${terminalRecord.handleId}:${terminalRecord.status}:${terminalRecord.updatedAt}`;
    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", childWorkspaceId, attentionGenerationId)
      )
    ).toMatchObject({ status: "delivered" });
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          created.data.taskId,
          attentionGenerationId
        )
      )
    ).toMatchObject({ status: "superseded" });
    const recordWithoutDeliveryMarker = { ...terminalRecord };
    delete recordWithoutDeliveryMarker.directParentResultDeliveredAt;
    await taskHandleStore.upsertWorkspaceTurn(recordWithoutDeliveryMarker);
    await (
      workspaceTurnManagerFor(taskService) as unknown as {
        recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
      }
    ).recoverTerminalWorkspaceTurnAttentionNotifications();
    await flushTerminalAttentionDrains(taskService);

    const recoveredHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(recoveredHistory).match(/Mapped the tooling surface\./g)).toHaveLength(1);
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, created.data.taskId))
        ?.directParentResultDeliveredAt
    ).toBeDefined();
  });

  test("exec continuation refreshes the stable child patch artifact from the last applied head", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["execcontinuationhandle", "execcontinuationturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-exec-continuation";
    const childId = "child-exec-continuation";
    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    initGitRepo(childPath);
    const launchBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();
    execSync("bash -lc 'echo \"first\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "first child change"', { cwd: childPath, stdio: "ignore" });
    const firstPatchHeadSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId, {
          runtimeConfig: { type: "local" },
        }),
        projectWorkspace(projectPath, "child", childId, {
          parentWorkspaceId: parentId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-08-18T00:00:00.000Z",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: launchBaseCommitSha,
        }),
      ],
      testTaskSettings()
    );

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    await upsertSubagentGitPatchArtifact({
      workspaceId: parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: childId,
      updater: () => ({
        childTaskId: childId,
        parentWorkspaceId: parentId,
        createdAtMs: 1,
        updatedAtMs: 2,
        status: "ready",
        projectArtifacts: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            status: "ready",
            baseCommitSha: launchBaseCommitSha,
            headCommitSha: firstPatchHeadSha,
            commitCount: 1,
            mboxPath: getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo"),
            appliedAtMs: 3,
          },
        ],
        readyProjectCount: 1,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 1,
      }),
    });

    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const continuation = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Make the follow-up fix.",
      title: "Exec continuation",
      allowAgentWorkspace: true,
      workspace: { mode: "existing", workspaceId: childId },
    });
    expect(continuation.success).toBe(true);
    if (!continuation.success) return;

    execSync("bash -lc 'echo \"second\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "second continuation change"', { cwd: childPath, stdio: "ignore" });
    const continuationHeadSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: childId,
      messageId: "msg-exec-continuation-result",
      metadata: {
        model: "test-model",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: continuation.data.taskId,
          ownerWorkspaceId: parentId,
          turnId: "execcontinuationturn",
        },
      },
      parts: [{ type: "text", text: "Implemented the follow-up fix." }],
    });

    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");
    const startedAt = Date.now();
    let artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    while (artifact?.status === "pending") {
      if (Date.now() - startedAt > 20_000) {
        throw new Error(`Timed out waiting for continuation patch: ${JSON.stringify(artifact)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    }

    expect(artifact?.status).toBe("ready");
    expect(artifact?.projectArtifacts[0]).toMatchObject({
      baseCommitSha: firstPatchHeadSha,
      headCommitSha: continuationHeadSha,
      commitCount: 1,
    });
    const patch = await fsPromises.readFile(patchPath, "utf-8");
    expect(patch).toContain("Subject: [PATCH] second continuation change");
    expect(patch).not.toContain("Subject: [PATCH] first child change");
  }, 20_000);

  test("late direct-parent snapshot consumption suppresses duplicate continuation delivery", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-late-direct-parent-await";
    const handleId = "wst_late_direct_parent_await";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Late Await Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const terminalRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "late-direct-parent-await",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Already returned by task_await.",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(terminalRecord);

    const consumed = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      handleId,
      {
        consumingWorkspaceId: parentId,
      }
    );
    expect(consumed?.directParentResultDeliveredAt).toBeDefined();

    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(terminalRecord, new Set());

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Already returned by task_await.");
  });

  test("queue-cut supersede settlement is delivered to the persistent child's direct parent", async () => {
    // The old error settlement appended a terminal failure to the direct
    // parent; the interrupted supersede settlement must not silently vanish.
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-superseded-delivery";
    const handleId = "wst_superseded_delivery";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Superseded Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const supersededRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "superseded-delivery",
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(supersededRecord);

    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(supersededRecord, new Set());

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    const serialized = JSON.stringify(parentHistory);
    expect(serialized).toContain("workspace_turn_superseded");
    expect(serialized).toContain("superseded by new input in the target workspace");
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, handleId))?.directParentResultDeliveredAt
    ).toBeDefined();

    // Explicit cancellations (no supersede reason) must stay silent.
    const { error: _supersedeReason, ...canceledBase } = supersededRecord;
    const canceledRecord: WorkspaceTurnTaskHandleRecord = {
      ...canceledBase,
      handleId: "wst_canceled_delivery",
      turnId: "canceled-delivery",
    };
    await taskHandleStore.upsertWorkspaceTurn(canceledRecord);
    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(canceledRecord, new Set());
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_canceled_delivery"))
        ?.directParentResultDeliveredAt
    ).toBeUndefined();
  });

  test("terminal recovery skips legacy delivery records and contains per-record replay failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-terminal-delivery-recovery";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
        })
      );
      return cfg;
    });
    const { taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      status: "completed" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Recovered result",
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_legacy_delivery",
      turnId: "legacy-delivery",
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_required_delivery",
      turnId: "required-delivery",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    });
    const internal = workspaceTurnManagerFor(taskService) as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
      recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
    };
    const replay = spyOn(
      internal,
      "deliverPersistentChildWorkspaceTurnResult"
    ).mockRejectedValueOnce(new Error("read-only session"));

    try {
      await internal.recoverTerminalWorkspaceTurnAttentionNotifications();
      expect(replay).toHaveBeenCalledTimes(1);
      expect(replay.mock.calls[0]?.[0].handleId).toBe("wst_required_delivery");
    } finally {
      replay.mockRestore();
    }
  });

  test("terminal recovery dedupes a matching ordinary legacy workspace-turn notification", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_legacy_ordinary_recovery",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "legacy-ordinary-recovery",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Already delivered ordinary result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(record);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: "completed",
      createdAt: "2026-08-11T00:00:01.500Z",
    });
    assert(legacy, "legacy ordinary attention must exist");
    await terminalAttentionStore.markDelivered(parentId, legacy.id);

    expect(
      await (
        workspaceTurnManagerFor(taskService) as unknown as {
          recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
        }
      ).recoverTerminalWorkspaceTurnAttentionNotifications()
    ).toBe(1);

    const versionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      record.handleId,
      `${record.handleId}:${record.status}:${record.updatedAt}`
    );
    expect(await terminalAttentionStore.get(parentId, versionedId)).toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, record.handleId))
        ?.terminalAttentionNotifiedAt
    ).toBeDefined();
  });

  test("terminal recovery versions corrected workspace-turn attention past a legacy tombstone", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_corrected_attention_recovery",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "corrected-attention-recovery",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:02.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Corrected recovered result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(record);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: "error",
    });
    assert(legacy, "legacy workspace-turn attention must exist");
    await terminalAttentionStore.markDelivered(parentId, legacy.id);

    const recovered = await (
      workspaceTurnManagerFor(taskService) as unknown as {
        recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
      }
    ).recoverTerminalWorkspaceTurnAttentionNotifications();
    expect(recovered).toBe(1);

    const versionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      record.handleId,
      `${record.handleId}:${record.status}:${record.updatedAt}`
    );
    expect(await terminalAttentionStore.get(parentId, versionedId)).not.toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, record.handleId))
        ?.terminalAttentionNotifiedAt
    ).toBeDefined();
  });

  test("terminal recovery contains per-record attention persistence failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    for (const [index, handleId] of ["wst_attention_failure", "wst_attention_success"].entries()) {
      await taskHandleStore.upsertWorkspaceTurn({
        kind: "workspace_turn",
        handleId,
        ownerWorkspaceId: parentId,
        workspaceId: parentId,
        turnId: `attention-recovery-${index}`,
        status: "completed",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: `2026-08-11T00:00:0${index + 1}.000Z`,
        createdWorkspace: false,
        disposableWorkspace: false,
        attentionPolicy: "notify_on_terminal",
        reportMarkdown: `Recovered result ${index}`,
      });
    }
    const internal = taskService as unknown as {
      enqueueTerminalAttention: (params: {
        ownerWorkspaceId: string;
        sourceKind: "workspace_turn";
        terminalOutcome: TerminalAttentionOutcome;
        sourceId: string;
        generationId?: string;
      }) => Promise<void>;
      recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
    };
    const enqueueTerminalAttention = internal.enqueueTerminalAttention.bind(taskService);
    const enqueue = spyOn(internal, "enqueueTerminalAttention")
      .mockRejectedValueOnce(new Error("read-only attention store"))
      .mockImplementation(enqueueTerminalAttention);

    try {
      expect(await internal.recoverTerminalWorkspaceTurnAttentionNotifications()).toBe(1);
      expect(enqueue).toHaveBeenCalledTimes(2);
    } finally {
      enqueue.mockRestore();
    }
    const records = await taskHandleStore.listWorkspaceTurns(parentId);
    expect(records.filter((record) => record.terminalAttentionNotifiedAt != null)).toHaveLength(1);
  });

  test("higher-ancestor waiters do not suppress continuation delivery to the direct parent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["nestedwaiterhandle", "nestedwaiterturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-continuation-result";
    const childTaskId = "nested-child-continuation-result";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "direct-parent", directParentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: directParentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Nested Reviewer",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: directParentTaskId,
      prompt: "Continue the nested review.",
      title: "Nested Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const waited = workspaceTurnManagerFor(taskService).waitForWorkspaceTurn(created.data.taskId, {
      requestingWorkspaceId: rootWorkspaceId,
      ownerWorkspaceId: directParentTaskId,
      timeoutMs: 5_000,
    });
    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "msg-nested-continuation-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: created.data.taskId,
          ownerWorkspaceId: directParentTaskId,
          turnId: "nestedwaiterturn",
        },
      },
      parts: [{ type: "text", text: "Nested review complete." }],
    });
    expect(await waited).toMatchObject({ reportMarkdown: "Nested review complete." });

    const directParentHistory =
      await historyService.getHistoryFromLatestBoundary(directParentTaskId);
    expect(JSON.stringify(directParentHistory)).toContain("Nested review complete.");
    expect(JSON.stringify(directParentHistory)).toContain(childTaskId);
  });

  test("a direct-parent foreground waiter does not suppress the continuation owner's wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["ownerwaiterhandle", "ownerwaiterturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-owner-wake";
    const childTaskId = "nested-child-owner-wake";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "direct-parent", directParentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: directParentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Owner Wake Reviewer",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: rootWorkspaceId,
      prompt: "Continue the root-owned nested review.",
      title: "Owner Wake Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const waited = workspaceTurnManagerFor(taskService).waitForWorkspaceTurn(created.data.taskId, {
      requestingWorkspaceId: directParentTaskId,
      ownerWorkspaceId: rootWorkspaceId,
      timeoutMs: 5_000,
    });
    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "msg-owner-wake-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "explore",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: created.data.taskId,
          ownerWorkspaceId: rootWorkspaceId,
          turnId: "ownerwaiterturn",
        },
      },
      parts: [{ type: "text", text: "Root-owned nested review complete." }],
    });
    expect(await waited).toMatchObject({ reportMarkdown: "Root-owned nested review complete." });
    await flushTerminalAttentionDrains(taskService);

    // The direct parent consumed the result through its waiter, so the distinct continuation
    // owner must retain terminal attention (pending until idle, or already delivered).
    const terminalRecord = await new TaskHandleStore(config).getWorkspaceTurn(
      rootWorkspaceId,
      created.data.taskId
    );
    assert(terminalRecord, "terminal continuation record must exist");
    const ownerAttention = await new TerminalAttentionStore(config).get(
      rootWorkspaceId,
      TerminalAttentionStore.notificationId(
        "workspace_turn",
        created.data.taskId,
        `${terminalRecord.handleId}:${terminalRecord.status}:${terminalRecord.updatedAt}`
      )
    );
    expect(ownerAttention).toMatchObject({
      sourceKind: "workspace_turn",
      sourceId: created.data.taskId,
    });
    assert(ownerAttention, "continuation owner attention must remain persisted");
    expect(["pending", "delivered"]).toContain(ownerAttention.status);
  });

  test("createWorkspaceTurn queues busy owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      return cfg;
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void, SendMessageError>> =>
        Promise.resolve(Ok(undefined))
    );
    const busyWorkspaceIds = new Set<string>();
    const isStreaming = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const isBusyForMessage = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const hasQueuedMessages = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const workspaceMocks = createWorkspaceServiceMocks({
      create: createWorkspace,
      sendMessage,
      hasQueuedWorkspaceTurn: mock(
        (workspaceId: string, handleId: string) =>
          workspaceId === "childworkspace" && handleId === "wst_secondhandle"
      ),
      isBusyForMessage,
      hasQueuedMessages,
    });
    const aiMocks = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    busyWorkspaceIds.add("childworkspace");

    const second = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      taskId: "wst_secondhandle",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "queued",
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Queued prompt");
    expect(secondSend[2]).toMatchObject({
      queueDispatchMode: "turn-end",
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_secondhandle",
        ownerWorkspaceId: parentId,
        turnId: "secondturn",
      },
    });
    expect(secondSend[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: false,
      agentInitiated: true,
    });
    expect(secondSend[3]).toHaveProperty("onAccepted");

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_secondhandle"
    );
    expect(snapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "queued",
    });

    const internal = taskService as unknown as { countActiveWorkspaceTurns: () => Promise<number> };
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);

    const interrupted = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_secondhandle"
    );
    expect(interrupted.success).toBe(true);
    expect(workspaceMocks.removeQueuedWorkspaceTurn).toHaveBeenCalledWith(
      "childworkspace",
      "wst_secondhandle",
      { cancelReason: "Workspace turn interrupted" }
    );
    const sendInternal = secondSend[3] as { onAccepted: () => Promise<void> };
    let acceptedAfterInterruptError: unknown;
    try {
      await sendInternal.onAccepted();
    } catch (error) {
      acceptedAfterInterruptError = error;
    }
    if (!(acceptedAfterInterruptError instanceof Error)) {
      throw new Error("Expected onAccepted to reject after interrupt");
    }
    expect(acceptedAfterInterruptError.message).toMatch(/canceled before stream start/);
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn reserves a slot before queueing a manually busy existing workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["queuedhandle", "queuedturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        {
          path: path.join(projectPath, "childworkspace"),
          id: "childworkspace",
          name: "childworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        },
        {
          path: path.join(projectPath, "otherworkspace"),
          id: "otherworkspace",
          name: "otherworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        }
      );
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      isBusyForMessage: mock((workspaceId: string) => workspaceId === "childworkspace"),
    });
    const aiMocks = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === "otherworkspace"),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_owned",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "ownedturn",
      status: "completed",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_other",
      ownerWorkspaceId: parentId,
      workspaceId: "otherworkspace",
      turnId: "otherturn",
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("maxParallelAgentTasks exceeded");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn counts active workspace turns across all owners", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const otherParentId = "other-parent";
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, otherParentId),
        id: otherParentId,
        name: otherParentId,
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const second = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: otherParentId,
      prompt: "Second prompt",
      title: "Other workspace turn",
      workspace: { mode: "new" },
    });
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error).toContain("maxParallelAgentTasks exceeded");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("active workspace turn count excludes foreground-waiting workspace turns", async () => {
    const { taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      countActiveWorkspaceTurns: () => Promise<number>;
      startForegroundAwait: (workspaceId: string) => () => void;
    };

    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    const stopForegroundAwait = internal.startForegroundAwait("childworkspace");
    try {
      expect(await internal.countActiveWorkspaceTurns()).toBe(0);
    } finally {
      stopForegroundAwait();
    }
  });

  test("parallel quota counts a reawakened child only through its continuation handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const reawakenedTaskId = "reawakened-quota-child";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "ordinary-child", "ordinary-quota-child", {
          parentWorkspaceId: parentId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "reawakened-child", reawakenedTaskId, {
          parentWorkspaceId: parentId,
          taskStatus: "reported",
          taskExecutionId: "wst_reawakened_quota",
          taskExecutionStatus: "running",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === reawakenedTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_reawakened_quota",
      ownerWorkspaceId: parentId,
      workspaceId: reawakenedTaskId,
      turnId: "turn-reawakened-quota",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    const internal = taskService as unknown as {
      countActiveAgentTasks: (cfg: ReturnType<Config["loadConfigOrDefault"]>) => number;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    const activeAgentCount = internal.countActiveAgentTasks(config.loadConfigOrDefault());
    const activeWorkspaceTurnCount = await internal.countActiveWorkspaceTurns();

    expect(activeAgentCount).toBe(1);
    expect(activeWorkspaceTurnCount).toBe(1);
    expect(activeAgentCount + activeWorkspaceTurnCount).toBe(2);
  });

  test("active workspace turn count settles stale persisted handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(0);

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("active workspace turn count keeps startup-retrying handles live", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    expect(hasPendingQueuedOrPreparingTurn).toHaveBeenCalledWith("childworkspace");

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("getWorkspaceTurnSnapshot settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("uncorrelated stream-end before queued workspace turn prompt does not interrupt it", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const oldAssistant = createMuxMessage("old-assistant", "assistant", "Previous turn", {
      model: "anthropic:claude-opus-4-6",
      finishReason: "stop",
    });
    const queuedPrompt = createMuxMessage("queued-prompt", "user", "Queued follow-up", {
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: created.taskId,
        ownerWorkspaceId: parentId,
        turnId: "turn",
      },
    });
    expect((await historyService.appendToHistory(created.workspaceId, oldAssistant)).success).toBe(
      true
    );
    expect((await historyService.appendToHistory(created.workspaceId, queuedPrompt)).success).toBe(
      true
    );

    const internal = taskService as unknown as {
      interruptWorkspaceTurnFromUncorrelatedStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };
    const handled = await internal.interruptWorkspaceTurnFromUncorrelatedStreamEnd({
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "old-assistant",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        finishReason: "stop",
      },
      parts: [],
    });

    expect(handled).toBe(true);
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      created.taskId
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
  });

  test("getWorkspaceTurnSnapshot recovers stale completed handles from matching history", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_completed", "assistant", "Recovered final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: created.taskId,
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      created.taskId
    );
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: created.workspaceId,
      messageId: "msg_completed",
      reportMarkdown: "Recovered final text",
      finalMessageRef: { messageId: "msg_completed", finishReason: "stop", textCharCount: 20 },
    });
  });

  test("getWorkspaceTurnSnapshot recovers stale truncated handles from matching history as errors", async () => {
    const { parentId, taskService, historyService, created } = await startWorkspaceTurnForTest();
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_truncated_history", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: created.taskId,
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      created.taskId
    );
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: created.workspaceId,
      messageId: "msg_truncated_history",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("listWorkspaceTurnTasks settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(
      await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(parentId, {
        statuses: ["running"],
      })
    ).toEqual([]);

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "interrupted", workspaceId: "childworkspace" });
  });

  test("workspace-turn stream-end finalizes the handle without agent_report semantics", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [
        // StreamManager stores provider text deltas as adjacent parts; concatenate them exactly.
        { type: "text", text: "## Verified" },
        { type: "text", text: " root" },
        { type: "text", text: " cause\n\n" },
        { type: "text", text: "- Fixed" },
        // Non-text parts separate rendered text runs and must remain a report block boundary.
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          input: { script: "true" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Follow-up" },
        { type: "text", text: " complete." },
      ],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      reportMarkdown: "## Verified root cause\n\n- Fixed\n\nFollow-up complete.",
      finalMessageRef: { messageId: "msg_1", agentId: "exec", textCharCount: 50 },
    });
    const childConfig = findWorkspaceInConfig(config, "childworkspace");
    expect(childConfig?.parentWorkspaceId).toBeUndefined();
    expect(childConfig?.taskStatus).toBeUndefined();
  });

  test("terminal notify policy updates preserve the terminal outcome version", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const terminal: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      reportMarkdown: "Terminal result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(terminal);

    await taskService.markBackgroundWorkNotifyOnTerminal(terminal.handleId, parentId);

    const updated = await taskHandleStore.getWorkspaceTurn(parentId, terminal.handleId);
    expect(updated).toMatchObject({
      status: "completed",
      updatedAt: terminal.updatedAt,
      attentionPolicy: "notify_on_terminal",
    });
    const attentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      terminal.handleId,
      `${terminal.handleId}:${terminal.status}:${terminal.updatedAt}`
    );
    expect(await new TerminalAttentionStore(config).get(parentId, attentionId)).not.toBeNull();
  });

  test("notify_on_terminal workspace turn wakes the owner via task_await on completion", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    // Register the child workspace the handle points at.
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "workspace-turn"),
        id: "childworkspace",
        name: "workspace-turn",
        title: "Workspace turn",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const workspaceMocks = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      pendingTerminalAttentionDrains: Set<Promise<void>>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });

    // Drain runs asynchronously; await any in-flight drains before asserting.
    await Promise.all([...internal.pendingTerminalAttentionDrains]);

    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeDefined();
    const prompt = wakeCall?.[1] as string;
    expect(prompt).toContain("task_await");
    expect(prompt).toContain("timeout_secs: 0");
    expect(wakeCall?.[3]).toMatchObject({ synthetic: true, requireIdle: true });

    // Restart-safe dedupe marker and the exact terminal outcome notification are persisted.
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
    assert(snapshot, "terminal workspace-turn snapshot must exist");
    const attentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      snapshot.handleId,
      `${snapshot.handleId}:${snapshot.status}:${snapshot.updatedAt}`
    );
    expect(await new TerminalAttentionStore(config).get(parentId, attentionId)).toMatchObject({
      status: "delivered",
    });
  });

  test("notify_on_terminal workspace turn defers wake-up while owner has a queued turn", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "workspace-turn"),
        id: "childworkspace",
        name: "workspace-turn",
        title: "Workspace turn",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    // Owner is preparing/queuing a user turn: terminal wake-up must NOT inject ahead of it.
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      pendingTerminalAttentionDrains: Set<Promise<void>>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });
    await Promise.all([...internal.pendingTerminalAttentionDrains]);

    // No wake-up sent while a queued/preparing turn exists.
    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeUndefined();

    // Notification remains pending; once the owner is idle, draining delivers it.
    hasPendingQueuedOrPreparingTurn.mockImplementation(() => false);
    await internal.drainTerminalAttention(parentId);
    const drained = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(drained).toBeDefined();
  });

  test("orphaned agent attention does not block unrelated terminal work", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "orphaned-agent-task",
    });
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_valid",
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.drainTerminalAttention(parentId);

    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.stringContaining("wst_valid"),
      expect.any(Object),
      expect.any(Object)
    );
    expect(
      await terminalAttentionStore.get(parentId, "agent_task:orphaned-agent-task")
    ).toMatchObject({ status: "superseded" });
  });

  test("persistent child reports supersede their private continuation wake prompt", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-continuation-report";
    const childTaskId = "child-continuation-report";
    const handleId = "wst_continuation_report";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:02.000Z",
          taskExecutionId: handleId,
          taskExecutionStatus: "completed",
        }),
      ],
      testTaskSettings()
    );

    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }, SendMessageError>> =>
        Promise.resolve(Ok({ started: true }))
    );
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ resumeStream, sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentWorkspaceId,
      workspaceId: childTaskId,
      turnId: "turn-continuation-report",
      status: "completed",
      createdAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:02.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Private continuation output",
    });
    await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage(
        "continuation-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: childTaskId,
          agentType: "explore",
          status: "completed",
          title: "Tooling Mapper",
          reportMarkdown: "Stable child report",
        }),
        {
          timestamp: Date.parse("2026-08-10T00:00:02.000Z"),
          synthetic: true,
          uiVisible: true,
        }
      )
    );

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      sourceId: childTaskId,
    });
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: handleId,
    });

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentWorkspaceId);

    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `workspace_turn:${handleId}`)
    ).toMatchObject({ status: "superseded" });
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `agent_task:${childTaskId}`)
    ).toMatchObject({ status: "delivered" });
  });

  test("persistent child continuation keeps the wake prompt when no current report was delivered", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-continuation-fallback";
    const childTaskId = "child-continuation-fallback";
    const handleId = "wst_continuation_fallback";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskExecutionId: handleId,
          taskExecutionStatus: "completed",
        }),
      ],
      testTaskSettings()
    );

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentWorkspaceId,
      workspaceId: childTaskId,
      turnId: "turn-continuation-fallback",
      status: "completed",
      createdAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:02.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Continuation output without a new agent report",
    });
    await historyService.appendToHistory(
      parentWorkspaceId,
      createMuxMessage(
        "old-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: childTaskId,
          agentType: "explore",
          status: "completed",
          title: "Earlier report",
          reportMarkdown: "This report predates the continuation.",
        }),
        {
          timestamp: Date.parse("2026-08-10T00:00:00.000Z"),
          synthetic: true,
          uiVisible: true,
        }
      )
    );

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: handleId,
    });

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentWorkspaceId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(childTaskId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("task_await");
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `workspace_turn:${handleId}`)
    ).toMatchObject({ status: "delivered" });
  });

  test("stuck pending outbox attention is re-poked by the sweep-cadence reconciler", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_stuck",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      schedulePendingTerminalAttentionOwnerDrains: () => Promise<number>;
    };

    // Transient restriction read failure: the drain fails closed, leaving the durable record
    // pending with no later stream or task event to retry it.
    const iterateSpy = spyOn(historyService, "iterateFullHistory")
      // Lazy rejection: an eager mockRejectedValueOnce promise trips bun's unhandled-rejection
      // detector on this host before the drain consumes it.
      .mockImplementationOnce(() => Promise.reject(new Error("EIO: history unreadable")));
    try {
      await internal.drainTerminalAttention(parentId);
      expect(sendMessage).not.toHaveBeenCalled();

      expect(await internal.schedulePendingTerminalAttentionOwnerDrains()).toBe(1);
      await flushTerminalAttentionDrains(taskService);
    } finally {
      iterateSpy.mockRestore();
    }
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("wst_stuck");
    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_stuck")).toMatchObject({
      status: "delivered",
    });
  });

  test("a rejected non-workflow send backs off and lets an agent-bound group deliver", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_nonworkflow_backoff";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    // The workspace-turn batch's conversation-identity send is persistently rejected; the
    // agent-bound group's own pinned identity can still send.
    const sendMessage = mock((..._args: unknown[]): Promise<Result<void, SendMessageError>> => {
      const options = _args[2] as { agentId?: string } | undefined;
      return options?.agentId === "plan"
        ? Promise.resolve(Ok(undefined))
        : Promise.resolve(Err({ type: "unknown", raw: "agent not resolvable" }));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "plan",
    });

    // A deliverable (non-suppressed) workspace-turn wake keeps the agent-bound group out of
    // the batch until the batch's send is rejected.
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_backoff_deliverable",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "backoff-deliverable",
      status: "completed",
      reportMarkdown: "turn done",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_backoff_deliverable",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    await (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention(parentId);
    await flushTerminalAttentionDrains(taskService);

    // First attempt sends the non-workflow batch and is rejected; the re-poked drain lets the
    // backed-off batch sit out so the agent-bound group delivers in the same cycle.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[2]).toMatchObject({ agentId: "plan" });
    expect(String(sendMessage.mock.calls[1]?.[1])).toContain(runId);
    // The rejected wake stays pending for the sweep-cadence retry, never dropped.
    const stillPending = await terminalAttentionStore.listPending(parentId);
    expect(stillPending.map((notification) => notification.sourceId)).toEqual([
      "wst_backoff_deliverable",
    ]);
    const queued = (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.get(parentId);
    expect(queued?.has(runId) ?? false).toBe(false);
  });

  test("mixed drains keep workspace-turn attention off the workflow's agent", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_mixed";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("agent-turn", "assistant", "on it", { timestamp: 1_001, agentId: "plan" })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "exec",
    });

    // A workspace-turn result resumes under the conversation's own identity; sharing its wake
    // with an agent-bound workflow group would process it under the workflow's agent instead.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_mixed_handle",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));
    await drain(parentId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const firstPrompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(firstPrompt).toContain("wst_mixed_handle");
    expect(firstPrompt).not.toContain(runId);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "plan",
    });

    await drain(parentId);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondPrompt = String(sendMessage.mock.calls[1]?.[1]);
    expect(secondPrompt).toContain(runId);
    expect(sendMessage.mock.calls[1]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "exec",
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("a fully suppressed batch re-pokes the drain for unselected workflow groups", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const runId = "wfr_repoke";
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: {
        name: "research",
        description: "Research workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    (workspaceService as unknown as Record<string, unknown>).getWorkflowInvocationCurrentness =
      mock(() => Promise.resolve("current"));
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const drain = (
      taskService as unknown as {
        drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
      }
    ).drainTerminalAttention.bind(taskService);

    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "exec",
    });

    // A pending workspace-turn notification whose handle already carries an owner-follow-up
    // supersede: the pre-suppression batch counts it (excluding the agent-bound workflow
    // group from the send), then the last-moment reread drops it, emptying the batch.
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_repoke_suppressed",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "repoke-suppressed",
      status: "interrupted",
      error:
        "Workspace turn superseded by follow-up turn wst_repoke_successor from the same owner workspace",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_repoke_suppressed",
    });
    (
      taskService as unknown as { pendingWorkflowRunAttention: Map<string, Set<string>> }
    ).pendingWorkflowRunAttention.set(parentId, new Set([runId]));

    // The empty suppressed batch must re-poke the drain, not park the wake on the sweep.
    await drain(parentId);
    await flushTerminalAttentionDrains(taskService);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendMessage.mock.calls[0]?.[1]);
    expect(prompt).toContain(runId);
    expect(sendMessage.mock.calls[0]?.[2] as Record<string, unknown>).toMatchObject({
      agentId: "exec",
    });
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(0);
  });

  test("initialize contains task execution reconciliation scan failures", async () => {
    const config = await createTestConfig(rootDir);
    await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const listAllWorkspaceTurns = spyOn(
      taskHandleStore,
      "listAllWorkspaceTurns"
    ).mockRejectedValueOnce(new Error("permission denied"));

    try {
      await taskService.initialize();
    } finally {
      listAllWorkspaceTurns.mockRestore();
    }
  });

  test("initialize recovers an unreferenced persistent child execution handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-unreferenced-execution";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-unreferenced", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "React lifecycle expert",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_unreferenced",
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "turn-unreferenced",
      status: "running",
      createdAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      title: "React lifecycle expert",
      prompt: "Continue investigating.",
    });

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_unreferenced");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");
  });

  test("initialize prefers a newer unreferenced execution over a stale child pointer", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-newer-execution";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-newer", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "React lifecycle expert",
          taskExecutionId: "wst_old",
          taskExecutionStatus: "completed",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_old",
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "turn-old",
      status: "completed",
      createdAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:02.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_new",
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "turn-new",
      status: "running",
      createdAt: "2026-08-10T00:00:03.000Z",
      updatedAt: "2026-08-10T00:00:04.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_new");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");
  });

  test("initialize ignores parseable non-ISO timestamps when selecting the latest handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-invalid-execution-timestamp";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-invalid-timestamp", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          taskExecutionId: "wst_invalid_timestamp",
          taskExecutionStatus: "completed",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_invalid_timestamp",
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "turn-invalid-timestamp",
      status: "completed",
      createdAt: "2026-08-10T00:00:02.000Z",
      updatedAt: "9999",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_valid_timestamp",
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "turn-valid-timestamp",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_valid_timestamp");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");
  });

  test("initialize contains per-child reconciliation persistence failures", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-reconciliation-write-failure";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child-write-failure", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_write_failure",
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "turn-write-failure",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    const internal = taskService as unknown as {
      emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
    };
    spyOn(internal, "emitWorkspaceMetadata").mockImplementation((workspaceId: string) =>
      workspaceId === childTaskId
        ? Promise.reject(new Error("read-only session"))
        : Promise.resolve()
    );

    let initializationError: unknown;
    try {
      await taskService.initialize();
    } catch (error: unknown) {
      initializationError = error;
    }

    expect(initializationError).toBeUndefined();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe("wst_write_failure");
  });

  test("resolves a nested child execution through the ancestor that owns its handle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-execution-owner";
    const parentTaskId = "parent-execution-owner";
    const childTaskId = "child-execution-owner";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentTaskId,
          taskStatus: "reported",
          taskExecutionId: "wst_nested_execution",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createTaskServiceHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_nested_execution",
      ownerWorkspaceId: parentTaskId,
      workspaceId: childTaskId,
      turnId: "turn-nested-execution",
      status: "running",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    const execution = await taskService.getDescendantAgentTaskExecutionSnapshot(
      rootWorkspaceId,
      childTaskId
    );

    expect(execution?.ownerWorkspaceId).toBe(parentTaskId);
    expect(execution?.record).toMatchObject({
      handleId: "wst_nested_execution",
      workspaceId: childTaskId,
      status: "running",
    });
  });

  test("initialize recovers terminal notify workspace turns without pending notification", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const handleId = "wst_restart_missing_notification";
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Done before notification persisted",
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(handleId);
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      handleId
    );
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });

  test("initialize defers terminal wake-up while blocking task-owned work is active", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "task_done",
    });

    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_blocking_active",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("childworkspace", {
      handleId: "wst_blocking_active",
      ownerWorkspaceId: parentId,
    });

    await taskService.initialize();
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(await terminalAttentionStore.listPending(parentId)).toHaveLength(1);
  });

  test("workspace-turn stream-end with non-stop finish marks the handle error", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Partial" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end defers to a queued wake continuation", async () => {
    // A queued bash-monitor wake cuts the correlated stream at a tool boundary
    // (finishReason "tool-calls") while the child seamlessly continues the
    // same turn — the handle must stay running.
    const hasPendingBashMonitorWakeContinuation = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingBashMonitorWakeContinuation,
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    const correlation = {
      type: "workspace-turn-task",
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    } as const;

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_queue_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Kicked off verification" }],
    });

    const running = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(running).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(running?.error).toBeUndefined();

    // The continuation stream inherits the correlation metadata (see
    // AgentSession.inheritOpenWorkspaceTurnMetadata); its terminal stream-end
    // settles the turn with the real outcome.
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_continuation_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Final review report" }],
    });

    const settled = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(settled).toMatchObject({
      status: "completed",
      messageId: "msg_continuation_final",
      reportMarkdown: "Final review report",
    });
  });

  test("nested agent progress preserves workspace-turn correlation", async () => {
    const hasPendingWorkspaceTurnContinuation = mock(
      (
        workspaceId: string,
        metadata: { taskHandleId: string; ownerWorkspaceId: string; turnId: string }
      ) =>
        workspaceId === "childworkspace" &&
        metadata.taskHandleId === "wst_handle" &&
        metadata.turnId === "turn"
    );
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      hasPendingWorkspaceTurnContinuation,
    });
    const correlation = {
      type: "workspace-turn-task",
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    } as const;

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-agent"),
        id: "nested-agent",
        name: "nested-agent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
        taskModelString: "anthropic:claude-opus-4-6",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-agent", "progress-call", {
      reportMarkdown: "The nested agent found the issue.",
    });
    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[2]).toMatchObject({
      muxMetadata: correlation,
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_nested_report_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Nested report interrupted the turn" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
    });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      const nestedAgent = project.workspaces.find((workspace) => workspace.id === "nested-agent");
      assert(nestedAgent, "nested agent must exist");
      nestedAgent.taskStatus = "reported";
      nestedAgent.reportedAt = "2026-06-19T00:00:01.000Z";
      return cfg;
    });

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_nested_report_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: correlation,
      },
      parts: [{ type: "text", text: "Nested report continuation completed" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      reportMarkdown: "Nested report continuation completed",
    });
  });

  test("failed nested agent progress settles the correlated workspace turn", async () => {
    let sendCount = 0;
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        sendCount += 1;
        if (sendCount === 2) {
          const internal = args[3] as
            | { onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void }
            | undefined;
          await internal?.onAcceptedPreStreamFailure?.({
            type: "unknown",
            raw: "Progress wake failed",
          });
        }
        return Ok(undefined);
      }
    );
    const { config, parentId, taskService } = await startWorkspaceTurnForTest({ sendMessage });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-progress-failure"),
        id: "nested-progress-failure",
        name: "nested-progress-failure",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-progress-failure", "progress-call", {
      reportMarkdown: "The progress wake cannot start.",
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      error: "Progress wake failed",
    });
  });

  test("canceled nested agent progress interrupts the correlated workspace turn", async () => {
    let sendCount = 0;
    const sendMessage = mock(
      async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        sendCount += 1;
        if (sendCount === 2) {
          const internal = args[3] as
            | { onCanceled?: (reason: string) => Promise<void> | void }
            | undefined;
          await internal?.onCanceled?.("Progress wake was canceled");
        }
        return Ok(undefined);
      }
    );
    const { config, parentId, taskService } = await startWorkspaceTurnForTest({ sendMessage });

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-progress-canceled"),
        id: "nested-progress-canceled",
        name: "nested-progress-canceled",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
      });
      return cfg;
    });

    await taskService.reportAgentProgress("nested-progress-canceled", "progress-call", {
      reportMarkdown: "The progress wake was canceled.",
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error: "Progress wake was canceled",
    });
  });

  test("terminal nested agent report resumes a workspace turn with correlation", async () => {
    const { config, parentId, taskService, workspaceMocks, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(path.join(rootDir, "repo"));
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(rootDir, "repo", "nested-terminal-agent"),
        id: "nested-terminal-agent",
        name: "nested-terminal-agent",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        agentType: "explore",
        taskModelString: "anthropic:claude-opus-4-6",
      });
      return cfg;
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: "nested-terminal-agent",
      messageId: "assistant-nested-terminal-agent",
      metadata: { model: "anthropic:claude-opus-4-6", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "nested-report-call",
          toolName: "agent_report",
          input: { reportMarkdown: "The nested terminal report is complete." },
          state: "output-available",
          output: {
            success: true,
            report: { reportMarkdown: "The nested terminal report is complete." },
          },
        },
        { type: "text", text: "The nested terminal report is complete." },
      ],
    });

    const childHistory = await historyService.getHistoryFromLatestBoundary("childworkspace");
    expect(childHistory.success).toBe(true);
    if (!childHistory.success) throw new Error("child history read failed");
    const reportMessage = childHistory.data.find(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) =>
            part.type === "text" && part.text.includes("The nested terminal report is complete.")
        )
    );
    expect(reportMessage?.metadata?.muxMetadata).toEqual({
      type: "workspace-turn-task",
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    });

    await Promise.all([
      ...(taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> })
        .pendingTerminalAttentionDrains,
    ]);

    expect(workspaceMocks.resumeStream).toHaveBeenCalledWith(
      "childworkspace",
      expect.objectContaining({
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      }),
      { agentInitiated: true }
    );
  });

  test("backfills workspace-turn correlation on an existing terminal report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-restart-backfill";
    const workspaceTurnId = "workspace-turn-restart-backfill";
    const nestedTaskId = "nested-restart-backfill";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "workspace-turn", workspaceTurnId),
        projectWorkspace(projectPath, "nested-agent", nestedTaskId, {
          parentWorkspaceId: workspaceTurnId,
          taskStatus: "reported",
          reportedAt: "2026-08-14T00:00:01.000Z",
          agentType: "explore",
        }),
      ],
      testTaskSettings()
    );

    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_restart_backfill",
      ownerWorkspaceId: parentId,
      workspaceId: workspaceTurnId,
      turnId: "turn-restart-backfill",
      status: "running",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const reportMessage = createMuxMessage(
      "existing-terminal-report",
      "user",
      formatSubagentReportEnvelope({
        taskId: nestedTaskId,
        agentType: "explore",
        status: "completed",
        title: "Existing result",
        reportMarkdown: "The existing report survived the restart.",
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    await historyService.appendToHistory(workspaceTurnId, reportMessage);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const notification = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: workspaceTurnId,
      sourceKind: "agent_task",
      sourceId: nestedTaskId,
    });
    assert(notification, "terminal attention notification must be created");

    const internal = taskService as unknown as {
      ensureAgentTerminalMessages: (
        ownerWorkspaceId: string,
        notifications: ReadonlyArray<typeof notification>
      ) => Promise<unknown>;
    };
    await internal.ensureAgentTerminalMessages(workspaceTurnId, [notification]);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceTurnId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) throw new Error("workspace-turn history read failed");
    const updatedReport = historyResult.data.find((message) => message.id === reportMessage.id);
    expect(updatedReport?.metadata?.muxMetadata).toEqual({
      type: "workspace-turn-task",
      taskHandleId: "wst_restart_backfill",
      ownerWorkspaceId: parentId,
      turnId: "turn-restart-backfill",
    });
  });

  test("preserves an existing terminal report correlation from an earlier workspace turn", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-restart-preserve";
    const workspaceTurnId = "workspace-turn-restart-preserve";
    const nestedTaskId = "nested-restart-preserve";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "workspace-turn", workspaceTurnId),
        projectWorkspace(projectPath, "nested-agent", nestedTaskId, {
          parentWorkspaceId: workspaceTurnId,
          taskStatus: "reported",
          reportedAt: "2026-08-14T00:00:01.000Z",
          agentType: "explore",
        }),
      ],
      testTaskSettings()
    );

    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_restart_preserve",
      ownerWorkspaceId: parentId,
      workspaceId: workspaceTurnId,
      turnId: "turn-restart-preserve",
      status: "running",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const previousCorrelation = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_previous_turn",
      ownerWorkspaceId: parentId,
      turnId: "turn-previous",
    };
    const reportMessage = createMuxMessage(
      "existing-terminal-report-previous-turn",
      "user",
      formatSubagentReportEnvelope({
        taskId: nestedTaskId,
        agentType: "explore",
        status: "completed",
        title: "Previous result",
        reportMarkdown: "This report belongs to the previous turn.",
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true, muxMetadata: previousCorrelation }
    );
    await historyService.appendToHistory(workspaceTurnId, reportMessage);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const notification = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: workspaceTurnId,
      sourceKind: "agent_task",
      sourceId: nestedTaskId,
    });
    assert(notification, "terminal attention notification must be created");

    const internal = taskService as unknown as {
      ensureAgentTerminalMessages: (
        ownerWorkspaceId: string,
        notifications: ReadonlyArray<typeof notification>
      ) => Promise<{ deliverableNotificationIds: Set<string> }>;
    };
    const ensureResult = await internal.ensureAgentTerminalMessages(workspaceTurnId, [
      notification,
    ]);
    expect(ensureResult.deliverableNotificationIds.has(notification.id)).toBe(false);
    expect(await terminalAttentionStore.get(workspaceTurnId, notification.id)).toMatchObject({
      status: "superseded",
    });

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceTurnId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) throw new Error("workspace-turn history read failed");
    const preservedReport = historyResult.data.find((message) => message.id === reportMessage.id);
    expect(preservedReport?.metadata?.muxMetadata).toEqual(previousCorrelation);
  });

  test("workspace-turn tool-calls stream-end with superseding queued input settles interrupted", async () => {
    // Ordinary queued input (manual message, bare /compact) also cuts the
    // stream at a tool boundary, but it supersedes the delegated turn instead
    // of continuing it — the handle must settle now, not defer forever. The
    // child keeps working under the new input, so the owner sees an
    // interruption with a supersede reason, not a task failure.
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_superseded_cut",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Cut mid-work" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      messageId: "msg_superseded_cut",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  const OWNER_FOLLOW_UP_SUPERSEDE_PREFIX = "Workspace turn superseded by follow-up turn ";

  function ownerFollowUpCutter(ownerWorkspaceId: string, successorHandleId: string) {
    return {
      stage: "queued" as const,
      dispatchMode: "tool-end" as const,
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: successorHandleId,
        ownerWorkspaceId,
        turnId: "turn2",
      },
    };
  }

  function ownerFollowUpCutEvent(parentId: string, messageId: string): StreamEndEvent {
    return {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId,
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Cut mid-work" }],
    };
  }

  test("workspace-turn cut by the owner's own tool-end follow-up settles quietly", async () => {
    // The owner initiated the successor itself (mode="existing" tool-end
    // follow-up), so the old handle settles interrupted with a reason naming
    // the successor and produces NO terminal-attention wake — the follow-up's
    // task tool result already announced this outcome.
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace" ? ownerFollowUpCutter(parentId, "wst_successor") : undefined
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_owner_follow_up_cut"));

    const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(settled, "settled handle must exist");
    expect(settled).toMatchObject({
      status: "interrupted",
      messageId: "msg_owner_follow_up_cut",
    });
    expect(settled.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(settled.error).toContain("wst_successor");
    // Quiet: no wake enqueued, no parent envelope required. The notified
    // marker IS stamped as the downgrade-compatible suppression marker so an
    // older build's startup recovery also skips this record.
    expect(settled.terminalAttentionNotifiedAt).toBeDefined();
    expect(settled.directParentResultDeliveryRequiredAt).toBeUndefined();
    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workspace_turn", "wst_handle")
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:interrupted:${settled.updatedAt}`
        )
      )
    ).toBeNull();
  });

  test("workspace-turn cut by a different owner's follow-up keeps the generic supersede wake", async () => {
    // Cross-owner ancestor cutter (allowAgentWorkspace descendant path): the
    // settling handle's owner did not cause the cut, so it must still be woken.
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter("ancestorownerws", "wst_ancestor_follow_up")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_cross_owner_cut"));

    const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(settled, "settled handle must exist");
    expect(settled).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
    expect(settled.terminalAttentionNotifiedAt).toBeDefined();
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:interrupted:${settled.updatedAt}`
        )
      )
    ).not.toBeNull();
  });

  test("same-owner follow-up queued at turn-end keeps the generic supersede reason", async () => {
    // A turn-end head did not cause a tool-boundary cut, so it must not claim
    // quiet owner-follow-up attribution.
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    workspaceMocks.getQueueCutCutter.mockImplementation(() => ({
      ...ownerFollowUpCutter(parentId, "wst_successor"),
      dispatchMode: "turn-end" as const,
    }));
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_turn_end_cut"));

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("an engaged no-metadata cutter is never attributed to a follow-up queued behind it", async () => {
    // A manual message in PREPARING is the engaged cutter even when a
    // same-owner follow-up sits queued behind it: the cutter reports stage
    // "preparing" with undefined metadata, which classifies generic (notify).
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    workspaceMocks.getQueueCutCutter.mockImplementation(() => ({
      stage: "preparing" as const,
      muxMetadata: undefined,
    }));
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_engaged_manual_cut"));

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("an already-streaming same-owner follow-up settles the cut handle quietly", async () => {
    // The queue drained before this stream-end was processed: the successor is
    // identified from the uncorrelated active stream's metadata instead.
    const { config, parentId, taskService, aiMocks } = await startWorkspaceTurnForTest();
    aiMocks.getStreamInfo.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace"
        ? {
            messageId: "msg_successor_stream",
            model: "anthropic:claude-opus-4-6",
            historySequence: 3,
            startTime: Date.now(),
            parts: [],
            toolCompletionTimestamps: new Map(),
            muxMetadata: {
              type: "workspace-turn-task",
              taskHandleId: "wst_successor",
              ownerWorkspaceId: parentId,
              turnId: "turn2",
            },
          }
        : undefined
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_streaming_successor_cut"));

    const settled = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
    expect(settled).toMatchObject({ status: "interrupted" });
    expect(settled?.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(settled?.error).toContain("wst_successor");
  });

  test("foreground waiters on a quietly superseded handle reject with the successor id", async () => {
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    const waited = workspaceTurnManagerFor(taskService)
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 5_000,
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_waiter_cut"));

    const error = await waited;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("wst_successor");
  });

  test("late foreground waiters read the persisted quiet supersede reason", async () => {
    // Codex P2: a waiter whose initial record read completes after the quiet
    // settlement misses the live waiter path; the terminal `interrupted`
    // branch must preserve the persisted reason (and its successor handle id)
    // instead of a generic message.
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_late_waiter_cut"));

    let error: unknown;
    try {
      await workspaceTurnManagerFor(taskService).waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 5_000,
      });
      expect.unreachable("late waiter must reject");
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof Error, "late waiter must reject with an Error");
    expect(error.message.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(error.message).toContain("wst_successor");
  });

  test("cut attribution is captured at event time, before the workspace event lock", async () => {
    // Codex P1: when another operation holds the workspace event lock as
    // stream-end arrives, the session can drain the real manual cutter and
    // engage a later same-owner follow-up during the wait. The snapshot must
    // be captured synchronously in the event listener (before the lock), so
    // the manual supersede keeps its wake.
    const { config, parentId, taskService, workspaceMocks, aiMocks } =
      await startWorkspaceTurnForTest();
    let followUpEngaged = false;
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      followUpEngaged
        ? ownerFollowUpCutter(parentId, "wst_successor")
        : { stage: "preparing" as const, muxMetadata: undefined }
    );
    const streamEndListener = aiMocks.on.mock.calls.find(
      (call: unknown[]) => call[0] === "stream-end"
    )?.[1] as ((payload: unknown) => void) | undefined;
    assert(streamEndListener != null, "stream-end listener must be registered");
    const internal = taskService as unknown as {
      workspaceEventLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    };

    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockOwner = internal.workspaceEventLocks.withLock("childworkspace", async () => {
      await lockHeld;
    });
    // Event arrives while the lock is held: capture happens NOW (manual
    // cutter engaged), handling is queued behind the lock.
    streamEndListener(ownerFollowUpCutEvent(parentId, "msg_lock_wait_cut"));
    // The follow-up engages before the queued handler can run.
    followUpEngaged = true;
    assert(releaseLock != null, "lock owner must have started");
    releaseLock();
    await lockOwner;
    // Sequence after the queued stream-end handler.
    await internal.workspaceEventLocks.withLock("childworkspace", () => Promise.resolve());

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("cancelled successor forwards disposable ownership to the next queued follow-up", async () => {
    // Codex P1 (three-handle chain): A transferred ownership to B; B is then
    // cancelled through the non-stream settlement path while C is still
    // queued. Cleanup must forward ownership to C instead of deleting the
    // workspace under it, and only the last handle in the chain removes it.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      disposable: true,
      remove,
    });
    const taskHandleStore = new TaskHandleStore(config);
    const queuedBase = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      status: "queued" as const,
      createdWorkspace: false,
      disposableWorkspace: false,
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...queuedBase,
      handleId: "wst_successor",
      turnId: "turn2",
      createdAt: "2026-08-11T00:00:01.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...queuedBase,
      handleId: "wst_successor2",
      turnId: "turn3",
      createdAt: "2026-08-11T00:00:02.000Z",
      updatedAt: "2026-08-11T00:00:02.000Z",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_chain_cut"));
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor"))?.disposableWorkspace
    ).toBe(true);

    const stopped = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_successor"
    );
    expect(stopped.success).toBe(true);
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor")).toMatchObject({
      status: "interrupted",
      disposableWorkspace: false,
    });
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor2"))?.disposableWorkspace
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    // The last handle in the chain has no live successor left: remove for real.
    const stoppedLast = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_successor2"
    );
    expect(stoppedLast.success).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("late correlated completion self-heals a quiet supersede and re-arms the corrected wake", async () => {
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_owner_follow_up_cut"));
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() => undefined);

    // Late correlated evidence proves the turn actually completed: the quiet
    // supersede stays self-heal eligible and the corrected outcome re-arms the
    // (non-suppressed) wake.
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_late_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Late done" }],
    });

    const healed = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(healed, "healed handle must exist");
    expect(healed).toMatchObject({ status: "completed", reportMarkdown: "Late done" });
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:completed:${healed.updatedAt}`
        )
      )
    ).not.toBeNull();
  });

  test("startup recovery does not resurrect a quiet owner-follow-up supersede wake", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    const base = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      status: "interrupted" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal" as const,
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...base,
      handleId: "wst_quiet_recovery",
      turnId: "quiet-recovery",
      error: `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...base,
      handleId: "wst_generic_recovery",
      turnId: "generic-recovery",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });

    expect(
      await (
        workspaceTurnManagerFor(taskService) as unknown as {
          recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
        }
      ).recoverTerminalWorkspaceTurnAttentionNotifications()
    ).toBe(1);

    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_quiet_recovery",
          "wst_quiet_recovery:interrupted:2026-08-11T00:00:01.000Z"
        )
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_generic_recovery",
          "wst_generic_recovery:interrupted:2026-08-11T00:00:01.000Z"
        )
      )
    ).not.toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_quiet_recovery"))
        ?.terminalAttentionNotifiedAt
    ).toBeUndefined();
  });

  test("owner-follow-up supersede skips the direct-parent envelope only when the parent initiated it", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-quiet-supersede";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Quiet Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createTaskServiceHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const quietError = `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`;
    const ownerInitiated: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_quiet_owner_parent",
      // The direct parent IS the owner that initiated the successor.
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "quiet-owner-parent",
      status: "interrupted",
      error: quietError,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(ownerInitiated);
    const internal = taskService as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
      workspaceTurnRequiresDirectParentDelivery: (record: WorkspaceTurnTaskHandleRecord) => boolean;
    };

    await internal.deliverPersistentChildWorkspaceTurnResult(ownerInitiated, new Set());
    const ownerHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(ownerHistory.success).toBe(true);
    expect(JSON.stringify(ownerHistory)).not.toContain("workspace_turn_superseded");
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, ownerInitiated.handleId))
        ?.directParentResultDeliveredAt
    ).toBeUndefined();

    // A different owner's follow-up cut is NOT the direct parent's doing: the
    // envelope still gets delivered with the supersede error type.
    const ancestorInitiated: WorkspaceTurnTaskHandleRecord = {
      ...ownerInitiated,
      handleId: "wst_quiet_ancestor",
      ownerWorkspaceId: "ancestorownerws",
      turnId: "quiet-ancestor",
    };
    await taskHandleStore.upsertWorkspaceTurn(ancestorInitiated);
    await internal.deliverPersistentChildWorkspaceTurnResult(ancestorInitiated, new Set());
    const delivered = await historyService.getHistoryFromLatestBoundary(parentId);
    const serialized = JSON.stringify(delivered);
    expect(serialized).toContain("workspace_turn_superseded");
    expect(serialized).toContain("wst_successor");

    // Settle-path predicate agrees, so no delivery-required marker is ever set
    // for the owner-initiated flavor.
    expect(internal.workspaceTurnRequiresDirectParentDelivery(ownerInitiated)).toBe(false);
    expect(internal.workspaceTurnRequiresDirectParentDelivery(ancestorInitiated)).toBe(true);
  });

  test("snapshot history repair preserves the owner-follow-up supersede flavor", async () => {
    // Same race as the generic supersede repair test: a snapshot read from the
    // SAME correlated final must keep the quiet flavor instead of downgrading
    // it to the generic reason or a truncation error.
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const quietReason = `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`;
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_owner_cut", "assistant", "Cut mid-work", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      error: quietReason,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_owner_cut",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: quietReason,
      messageId: "msg_owner_cut",
    });
  });

  test("task_stop on a quietly superseded handle stays a no-op", async () => {
    // The widened supersede matcher must not change the interrupt gate: the
    // handle is already interrupted, so a stale task_stop must not stop the
    // target workspace's successor stream.
    const { parentId, taskService, workspaceMocks, aiMocks } = await startWorkspaceTurnForTest();
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_stop_noop_cut"));
    aiMocks.stopStream.mockClear();

    const repeat = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(repeat).toEqual(Ok({ workspaceId: "childworkspace" }));
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("mode=existing tool-end follow-up reports the same-owner turn it may supersede", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2", "handle3", "turn3"],
      hasPendingQueuedOrPreparingTurn,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUp = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.status).toBe("queued");
    expect(followUp.data.maySupersedeTaskId).toBe("wst_handle");

    // turn-end dispatch never cuts the active turn, so no announcement.
    const turnEnd = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up later",
      title: "Follow up later",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });
    expect(turnEnd.success).toBe(true);
    if (!turnEnd.success) throw new Error(turnEnd.error);
    expect(turnEnd.data.maySupersedeTaskId).toBeUndefined();
  });

  test("mode=existing follow-up to an idle target reports no supersession", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2"],
    });

    const followUp = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.status).toBe("running");
    expect(followUp.data.maySupersedeTaskId).toBeUndefined();
  });

  test("cut attribution uses the state captured at stream-end, not later live state", async () => {
    // Race pin (Codex P1): a manual/cross-owner input cuts the turn, then a
    // same-owner follow-up engages while handleStreamEnd's awaits run.
    // Classification must use the attribution snapshot captured synchronously
    // at the stream-end event (the manual cutter) — not whatever is engaged by
    // classification time — so the real manual supersede keeps its wake.
    let cutterReads = 0;
    const getQueueCutCutter = mock(() => {
      cutterReads += 1;
      return cutterReads === 1
        ? { stage: "preparing" as const, muxMetadata: undefined }
        : ownerFollowUpCutter("will-be-set-below", "wst_successor");
    });
    const { config, parentId, taskService } = await startWorkspaceTurnForTest({
      getQueueCutCutter,
    });
    getQueueCutCutter.mockImplementation(() => {
      cutterReads += 1;
      return cutterReads === 1
        ? { stage: "preparing" as const, muxMetadata: undefined }
        : ownerFollowUpCutter(parentId, "wst_successor");
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_snapshot_race_cut"));

    expect(cutterReads).toBeGreaterThanOrEqual(1);
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });
  });

  test("quiet supersede transfers disposable ownership to the successor", async () => {
    // Codex P1: settling the old handle must not force-remove a disposable
    // workspace out from under the announced successor. Ownership moves to the
    // successor handle, whose own terminal settlement cleans the workspace up.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      disposable: true,
      remove,
    });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_successor",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn2",
      status: "queued",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_disposable_transfer"));

    const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    expect(settled).toMatchObject({ status: "interrupted", disposableWorkspace: false });
    expect(settled?.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor"))?.disposableWorkspace
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  test("quiet supersede keeps disposable cleanup when the successor is unavailable", async () => {
    // Transfer fail-safe: a missing (or already terminal) successor record
    // cannot inherit cleanup responsibility, so the old handle keeps it and
    // the disposable workspace is not leaked.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      disposable: true,
      remove,
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_missing_successor")
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_disposable_no_successor"));

    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      disposableWorkspace: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("quiet resettle deletes the stale wake enqueued by the superseded settlement", async () => {
    // Codex P2: an error settlement enqueued a pending wake; a later
    // correlated tool-calls resettle to the quiet owner-follow-up flavor must
    // delete that stale generation instead of letting the drain deliver it.
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    // Length-truncated correlated final settles the handle as error and arms a wake.
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_error",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Truncated" }],
    });
    const errored = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(errored, "errored handle must exist");
    expect(errored.status).toBe("error");
    const attentionStore = new TerminalAttentionStore(config);
    const staleVersionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      "wst_handle",
      `wst_handle:error:${errored.updatedAt}`
    );
    expect(await attentionStore.get(parentId, staleVersionedId)).not.toBeNull();

    // Same-turn auto-retry gets cut by the owner's follow-up: quiet resettle.
    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_quiet_resettle_cut"));

    const resettled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(resettled, "resettled handle must exist");
    expect(resettled.status).toBe("interrupted");
    expect(resettled.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    // Stale delivered marker cleared by the resettle, then re-stamped as the
    // quiet flavor's downgrade-compatible suppression marker.
    expect(resettled.terminalAttentionNotifiedAt).toBeDefined();
    expect(await attentionStore.get(parentId, staleVersionedId)).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("workspace_turn", "wst_handle")
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_handle",
          `wst_handle:interrupted:${resettled.updatedAt}`
        )
      )
    ).toBeNull();
  });

  test("mode=existing announcement names the immediate queued predecessor", async () => {
    // Codex P2: with A active and same-owner tool-end follow-ups B and C
    // queued, C supersedes B (not A) at B's first boundary — and B's own
    // settlement wake is suppressed, so C's announcement is the only place
    // B's interruption can surface.
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2", "handle3", "turn3"],
      hasPendingQueuedOrPreparingTurn,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUpB = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up B",
      title: "Follow up B",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUpB.success).toBe(true);
    if (!followUpB.success) throw new Error(followUpB.error);
    expect(followUpB.data.maySupersedeTaskId).toBe("wst_handle");

    // createdAt is per-process monotonic (nextWorkspaceTurnCreatedAt), so the
    // newest-first predecessor scan is deterministic even when the original
    // turn and follow-up B are created within the same millisecond.
    const followUpC = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up C",
      title: "Follow up C",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUpC.success).toBe(true);
    if (!followUpC.success) throw new Error(followUpC.error);
    expect(followUpC.data.maySupersedeTaskId).toBe(followUpB.data.taskId);
  });

  test("drain drops a stale wake whose handle has settled into the quiet flavor", async () => {
    // Codex P2: a drain's listPending() snapshot can predate a quiet
    // resettle's notification delete, so the files alone cannot retract the
    // wake. The handle record re-read inside the drain is the source of
    // truth: a suppressed handle must be dropped, not delivered.
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void>> => Promise.resolve(Ok(undefined))
    );
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string): boolean => workspaceId === "owner"
    );
    const { config, parentId, taskService } = await startWorkspaceTurnForTest({
      sendMessage,
      hasPendingQueuedOrPreparingTurn,
    });
    // Keep the owner busy while the error settlement arms the wake so it stays pending.
    hasPendingQueuedOrPreparingTurn.mockImplementation(
      (workspaceId: string) => workspaceId === parentId
    );
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    await taskHandleStore.upsertWorkspaceTurn({
      ...running,
      attentionPolicy: "notify_on_terminal",
    });
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      pendingTerminalAttentionDrains: Set<Promise<void>>;
      drainTerminalAttention: (ownerWorkspaceId: string) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_before_quiet",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Truncated" }],
    });
    await Promise.all([...internal.pendingTerminalAttentionDrains]);
    const errored = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(errored, "errored handle must exist");
    const attentionStore = new TerminalAttentionStore(config);
    const staleVersionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      "wst_handle",
      `wst_handle:error:${errored.updatedAt}`
    );
    expect(await attentionStore.get(parentId, staleVersionedId)).toMatchObject({
      status: "pending",
    });

    // The quiet flavor lands on the record while the pending files survive
    // (drain snapshot semantics): the drain must drop the wake anyway.
    await taskHandleStore.upsertWorkspaceTurn({
      ...errored,
      status: "interrupted",
      error: `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`,
    });
    hasPendingQueuedOrPreparingTurn.mockImplementation(() => false);
    await internal.drainTerminalAttention(parentId);

    const wakeCall = sendMessage.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("wst_handle")
    );
    expect(wakeCall).toBeUndefined();
    expect(await attentionStore.get(parentId, staleVersionedId)).toMatchObject({
      status: "superseded",
    });
  });

  test("settlement preserves a disposable ownership transfer that raced its snapshot", async () => {
    // Codex P2: a settlement built from a record read BEFORE
    // transferDisposableWorkspaceToSuccessor flipped disposableWorkspace on
    // disk must not persist the stale false bit — the record reloaded inside
    // the settlement lock is authoritative, so the successor still cleans up
    // the transferred checkout instead of leaking it.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService } = await startWorkspaceTurnForTest({ remove });
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    const staleSnapshot = { ...running };
    expect(staleSnapshot.disposableWorkspace).toBe(false);
    // Transfer lands after the snapshot was taken.
    await taskHandleStore.upsertWorkspaceTurn({ ...running, disposableWorkspace: true });
    const internal = taskService as unknown as {
      settleWorkspaceTurn: (params: {
        record: WorkspaceTurnTaskHandleRecord;
        next: WorkspaceTurnTaskHandleRecord;
        waiterSettlement: { status: "error"; error: Error };
      }) => Promise<void>;
    };

    await internal.settleWorkspaceTurn({
      record: staleSnapshot,
      next: {
        ...staleSnapshot,
        status: "interrupted",
        updatedAt: new Date().toISOString(),
        error: "Workspace turn interrupted",
      },
      waiterSettlement: { status: "error", error: new Error("Workspace turn interrupted") },
    });

    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      disposableWorkspace: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("natural completion transfers disposable ownership to the queued same-owner follow-up", async () => {
    // Codex P1: a disposable predecessor that finishes naturally (finishReason
    // "stop") while a same-owner follow-up is queued — here turn-end, which
    // never cuts and is deliberately NOT supersede evidence — must still move
    // ownership: the follow-up dispatches at this stream end and would
    // otherwise lose its workspace to the settlement cleanup.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      disposable: true,
      remove,
    });
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_successor",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn2",
      status: "queued",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    workspaceMocks.getQueueCutCutter.mockImplementation(() => ({
      stage: "queued" as const,
      dispatchMode: "turn-end" as const,
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_successor",
        ownerWorkspaceId: parentId,
        turnId: "turn2",
      },
    }));
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_natural_completion",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });

    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "completed",
      disposableWorkspace: false,
    });
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_successor"))?.disposableWorkspace
    ).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  test("quiet resettle deletes the stale direct-parent envelope generation", async () => {
    // Codex P2: an error settlement already delivered/queued the direct
    // parent's failure envelope; the later quiet resettle skips the
    // requiresDirectParentDelivery block (parent == owner), so it must
    // invalidate the stale direct-parent generation itself instead of leaving
    // the parent to wake on the corrected-away failure.
    const { config, parentId, taskService, workspaceMocks, projectPath } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      const child = project.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.parentWorkspaceId = parentId;
      return cfg;
    });
    const taskHandleStore = new TaskHandleStore(config);
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_direct_parent",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Truncated" }],
    });
    const errored = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(errored, "errored handle must exist");
    expect(errored.status).toBe("error");
    const attentionStore = new TerminalAttentionStore(config);
    const directParentGenerationId = TerminalAttentionStore.notificationId(
      "agent_task",
      "childworkspace",
      `wst_handle:error:${errored.updatedAt}`
    );
    await attentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "childworkspace",
      generationId: `wst_handle:error:${errored.updatedAt}`,
    });
    expect(await attentionStore.get(parentId, directParentGenerationId)).not.toBeNull();

    workspaceMocks.getQueueCutCutter.mockImplementation(() =>
      ownerFollowUpCutter(parentId, "wst_successor")
    );
    await internal.handleStreamEnd(ownerFollowUpCutEvent(parentId, "msg_quiet_direct_parent_cut"));

    const resettled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(resettled, "resettled handle must exist");
    expect(resettled.status).toBe("interrupted");
    expect(resettled.error?.startsWith(OWNER_FOLLOW_UP_SUPERSEDE_PREFIX)).toBe(true);
    expect(await attentionStore.get(parentId, directParentGenerationId)).toBeNull();
  });

  test("mode=existing follow-up over a different owner's active turn reports no supersession", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest({
      stableIds: ["handle", "turn", "handle2", "turn2"],
      hasPendingQueuedOrPreparingTurn,
    });
    const interrupted = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(interrupted.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_other_owner_turn",
      ownerWorkspaceId: "ancestorownerws",
      workspaceId: "childworkspace",
      turnId: "other-owner-turn",
      status: "running",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUp = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.maySupersedeTaskId).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end defers to a streaming inherited continuation", async () => {
    // The wake already dispatched: the active stream (a newer messageId)
    // inherited this turn's correlation, proving the turn is continuing.
    const { parentId, taskService, aiMocks } = await startWorkspaceTurnForTest();
    aiMocks.getStreamInfo.mockImplementation((workspaceId: string) =>
      workspaceId === "childworkspace"
        ? {
            messageId: "msg_continuation_active",
            model: "anthropic:claude-opus-4-6",
            historySequence: 2,
            startTime: Date.now(),
            parts: [],
            toolCompletionTimestamps: new Map(),
            muxMetadata: {
              type: "workspace-turn-task",
              taskHandleId: "wst_handle",
              ownerWorkspaceId: parentId,
              turnId: "turn",
            },
          }
        : undefined
    );
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_queue_cut_streaming",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Cut mid-work" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("uncorrelated compaction stream-end does not interrupt an active workspace turn", async () => {
    // On-send compaction can consume a monitor-wake continuation mid-turn; the
    // compact turn's own stream-end is uncorrelated and must not supersede the
    // still-running delegated turn.
    const { parentId, taskService, created } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "msg_compaction_summary",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted context" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      created.taskId
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
    expect(snapshot?.error).toBeUndefined();
  });

  test("workspace-turn tool-calls stream-end without queue-cut evidence settles error", async () => {
    // A "tool-calls" finish without any queued/preparing/streaming successor is
    // not a queue cut (e.g. a successful required-tool stop condition); it must
    // keep the truncation error handling rather than claim a supersede.
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_tool_calls_terminal",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "tool-calls",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Partial" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      messageId: "msg_tool_calls_terminal",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
    });
  });

  test("parent stream-end auto-resumes for active background workspace turns", async () => {
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: parentId,
      messageId: "parent_msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Parent done" }],
    });

    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[0]).toBe(parentId);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[1]).toContain("wst_handle");
  });

  test("workspace-turn stream-end waits for active descendants before finalizing", async () => {
    const { config, parentId, projectPath, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[0]).toBe("childworkspace");
  });

  test("workspace-turn stream-end ignores nonblocking notify descendants", async () => {
    const { config, parentId, projectPath, taskService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "notify-descendant-task"),
        id: "notify-descendant-task",
        name: "notify-descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        taskAttentionPolicy: "notify_on_terminal",
      });
      return cfg;
    });

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_notify_only",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Final text despite background work" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "completed", workspaceId: "childworkspace" });
    expect(snapshot).not.toMatchObject({ deferredMessageIds: ["msg_notify_only"] });
  });

  test("workspace-turn deferred stream-end does not finalize the handle", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const event: StreamEndEvent = {
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    };
    const internal = taskService as unknown as {
      markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      finalizeWorkspaceTurnFromStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };

    await internal.markWorkspaceTurnStreamEndDeferred(event);
    expect(await internal.finalizeWorkspaceTurnFromStreamEnd(event)).toBe(true);

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_deferred"],
    });
  });

  test("workspace-turn deferred marker does not rewrite terminal handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const interruptResult = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(interruptResult.success).toBe(true);
    await (
      taskService as unknown as {
        markWorkspaceTurnStreamEndDeferred: (event: StreamEndEvent) => Promise<void>;
      }
    ).markWorkspaceTurnStreamEndDeferred({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_deferred_after_interrupt",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Pre-handoff text" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "interrupted" });
    expect(snapshot?.deferredMessageIds).toBeUndefined();
  });

  test("repeat interrupt of an already-interrupted workspace turn is a no-op", async () => {
    // A queue-cut supersede settles the handle interrupted while the target
    // workspace keeps streaming under the new input. A stale task_stop for the
    // settled handle must not stop that unrelated stream.
    const { parentId, taskService, aiMocks } = await startWorkspaceTurnForTest();
    const first = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(first.success).toBe(true);
    aiMocks.stopStream.mockClear();

    const repeat = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(repeat).toEqual(Ok({ workspaceId: "childworkspace" }));
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("workspace-turn stale recovery skips deferred pre-handoff stream-end history", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Premature final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_prehandoff"],
    });
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const recovered = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(recovered).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });
    expect(recovered?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred handles after descendants stop blocking", async () => {
    const { config, parentId, projectPath, taskService, historyService, workspaceMocks } =
      await startWorkspaceTurnForTest({ disposable: true });
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Recovered final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered final text" }],
    });
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    const repaired = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(repaired).toMatchObject({
      status: "completed",
      messageId: "msg_prehandoff",
      reportMarkdown: "Recovered final text",
    });
    expect(repaired?.error).toBeUndefined();
    expect(workspaceMocks.remove).toHaveBeenCalledWith("childworkspace", true);
  });

  test("listWorkspaceTurnTasks repairs restart-interrupted deferred handles before filtering", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_recovered_list", "assistant", "Recovered list text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      deferredMessageIds: ["msg_recovered_list"],
      error: "Workspace turn interrupted after restart",
    });

    const listed = await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(parentId, {
      statuses: ["interrupted", "completed"],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      handleId: "wst_handle",
      status: "completed",
      messageId: "msg_recovered_list",
      reportMarkdown: "Recovered list text",
    });
    expect(listed[0]?.error).toBeUndefined();

    const interruptedOnly = await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(
      parentId,
      {
        statuses: ["interrupted"],
      }
    );
    expect(interruptedOnly.map((record) => record.handleId)).not.toContain("wst_handle");
  });

  test("workspace-turn stale recovery repairs restart-interrupted deferred error handles", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
        archivedAt: "2026-06-19T00:01:00.000Z",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_truncated", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      deferredMessageIds: ["msg_truncated"],
      error: "Workspace turn interrupted after restart",
    });

    const repaired = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(repaired).toMatchObject({
      status: "error",
      messageId: "msg_truncated",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
  });

  test("correlated stream-end corrects a stale error settlement after self-healed retry", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_retry_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered after retry" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_retry_final",
      reportMarkdown: "Recovered after retry",
    });
    expect(snapshot?.directParentResultDeliveryRequiredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(parentHistory)).toContain("Recovered after retry");
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
  });

  test("resettled workspace turn re-arms a consumed notify_on_terminal wake-up", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
      attentionPolicy: "notify_on_terminal",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    // The stale error's wake-up was already delivered; without the tombstone reset,
    // enqueueIfAbsent would swallow the corrected outcome's notification.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_retry_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Recovered after retry" }],
    });

    const corrected = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(corrected).toMatchObject({
      status: "completed",
      reportMarkdown: "Recovered after retry",
    });
    assert(corrected, "corrected workspace-turn record must exist");
    const correctedAttentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      corrected.handleId,
      `${corrected.handleId}:${corrected.status}:${corrected.updatedAt}`
    );
    // A stale drain completing after replacement can only transition the legacy ID; the corrected
    // generation remains independently persisted and therefore cannot be swallowed.
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    expect(await terminalAttentionStore.get(parentId, correctedAttentionId)).not.toBeNull();
  });

  test("duplicate correlated stream-end replay keeps a settled error handle unchanged", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_truncated_replay",
      error: "Workspace turn ended before completion (finishReason: length)",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_replay",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Partial text" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      messageId: "msg_truncated_replay",
      updatedAt: "2026-06-19T00:00:01.000Z",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
  });

  test("late correlated stream-end does not resettle an explicitly interrupted workspace turn", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    // Explicit interrupt (user Esc / task_terminate): status interrupted WITHOUT the
    // stale-restart marker. An in-flight stream-end completing after the cancel must not
    // make the canceled turn appear completed.
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_late_final",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Late final text" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("explicitly interrupted workspace turns are not revived by same-turn retry evidence", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      isStreaming,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "interrupted",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
  });

  test("correlated stream-end never overwrites a completed workspace turn", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_first",
      reportMarkdown: "First result",
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_second",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Second result" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: "msg_first",
      reportMarkdown: "First result",
    });
  });

  test("snapshot history repair does not downgrade a supersede settlement before the successor lands", async () => {
    // Queue-cut supersede race: the handle settles interrupted from the
    // tool-calls stream-end, but the superseding queued input has not appended
    // its user message to child history yet. A task_await snapshot read in that
    // window repairs from the SAME correlated final and must preserve the
    // supersede classification instead of downgrading it to a truncation error.
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const supersedeReason =
      "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report";
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_queue_cut", "assistant", "Cut mid-work", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      error: supersedeReason,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_queue_cut",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: supersedeReason,
      messageId: "msg_queue_cut",
    });
  });

  test("snapshot history repair does not upgrade an error settlement to a supersede", async () => {
    // A tool-calls turn correctly settled as error (no live queue-cut evidence,
    // e.g. a required-tool stop) must stay an error even after unrelated user
    // messages land in child history: order is not causal queue-cut evidence.
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_required_tool_stop", "assistant", "Stopped on required tool", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_unrelated_later_input", "user", "Unrelated later question")
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      messageId: "msg_required_tool_stop",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      error: "Workspace turn ended before completion (finishReason: tool-calls)",
      messageId: "msg_required_tool_stop",
    });
  });

  test("getWorkspaceTurnSnapshot repairs a stale error handle from self-healed history", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "exec";
      child.agentType = "exec";
      child.taskStatus = "reported";
      return cfg;
    });
    const patchGeneration = spyOn(
      (
        taskService as unknown as {
          gitPatchArtifactService: { maybeStartGeneration: (...args: unknown[]) => Promise<void> };
        }
      ).gitPatchArtifactService,
      "maybeStartGeneration"
    ).mockResolvedValue(undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_selfhealed", "assistant", "Self-healed final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
    });

    expect(
      (
        await historyService.appendToHistory(
          parentId,
          createMuxMessage(
            "stale-direct-parent-failure",
            "user",
            [
              "<mux_subagent_failure>",
              "<task_id>childworkspace</task_id>",
              "<execution_version>wst_handle:error:2026-06-19T00:00:01.000Z</execution_version>",
              "<execution_id>wst_handle</execution_id>",
              "<agent_type>explore</agent_type>",
              "<error_type>workspace_turn_error</error_type>",
              "<error_message>",
              "Stream error: provider overloaded",
              "</error_message>",
              "</mux_subagent_failure>",
            ].join("\n"),
            { timestamp: Date.now(), synthetic: true, uiVisible: true }
          )
        )
      ).success
    ).toBe(true);

    const terminalAttentionStore = new TerminalAttentionStore(config);
    const staleAttention = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "agent_task",
      sourceId: "childworkspace",
      generationId: "wst_handle:error:2026-06-19T00:00:01.000Z",
      createdAt: "2026-06-19T00:00:01.750Z",
    });
    assert(staleAttention, "stale direct-parent attention must exist");
    await terminalAttentionStore.markDelivered(parentId, staleAttention.id);

    // List paths skip history repair for settled handles (no runtime activity), so the
    // stale record stays visible there until a snapshot read reconciles it.
    const listed = await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(parentId, {
      statuses: ["error"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed",
      reportMarkdown: "Self-healed final text",
    });
    expect(patchGeneration).toHaveBeenCalledWith(parentId, "childworkspace", expect.any(Function), {
      refreshForContinuation: true,
    });
    const deliveredSnapshot = await new TaskHandleStore(config).getWorkspaceTurn(
      parentId,
      "wst_handle"
    );
    expect(deliveredSnapshot?.directParentResultDeliveryRequiredAt).toBeDefined();
    expect(deliveredSnapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(deliveredSnapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(JSON.stringify(parentHistory)).toContain("Stream error: provider overloaded");
    expect(JSON.stringify(parentHistory)).toContain("wst_handle:completed:");
    expect(JSON.stringify(parentHistory)).toContain("Self-healed final text");
    assert(deliveredSnapshot, "repaired terminal record must exist");
    const correctedGenerationId = `${deliveredSnapshot.handleId}:${deliveredSnapshot.status}:${deliveredSnapshot.updatedAt}`;
    expect(
      await terminalAttentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", correctedGenerationId)
      )
    ).not.toBeNull();
    expect(await terminalAttentionStore.get(parentId, staleAttention.id)).toBeNull();
    expect(snapshot?.error).toBeUndefined();
  });

  test("direct-parent snapshot consumption suppresses replay of a history-repaired outcome", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_consumed_repair", "assistant", "Consumed repaired result", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle",
      {
        consumingWorkspaceId: parentId,
      }
    );
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_consumed_repair",
      reportMarkdown: "Consumed repaired result",
    });
    expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
    expect(snapshot?.directParentResultDeliveredAt).not.toBe("2026-06-19T00:00:01.750Z");

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Consumed repaired result");
    assert(snapshot, "repaired terminal record must exist");
    const correctedGenerationId = `${snapshot.handleId}:${snapshot.status}:${snapshot.updatedAt}`;
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", correctedGenerationId)
      )
    ).toBeNull();
  });

  test("direct-parent repair consumption marks a concurrent terminal winner before replay", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const staleRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
    };
    const concurrentWinner: WorkspaceTurnTaskHandleRecord = {
      ...staleRecord,
      status: "completed",
      updatedAt: "2026-06-19T00:00:02.000Z",
      reportMarkdown: "Concurrent corrected result",
      messageId: "msg_concurrent_corrected",
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:02.000Z",
    };
    delete concurrentWinner.directParentResultDeliveredAt;
    delete concurrentWinner.error;
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(concurrentWinner);

    const internal = taskService as unknown as {
      persistRepairedSettledWorkspaceTurn: (
        record: WorkspaceTurnTaskHandleRecord,
        recovered: WorkspaceTurnTaskHandleRecord,
        options: { consumingWorkspaceId?: string }
      ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
    };
    const observed = await internal.persistRepairedSettledWorkspaceTurn(
      staleRecord,
      {
        ...staleRecord,
        status: "completed",
        updatedAt: "2026-06-19T00:00:03.000Z",
        reportMarkdown: "Losing history repair",
      },
      { consumingWorkspaceId: parentId }
    );
    expect(observed).toMatchObject({
      status: "completed",
      messageId: "msg_concurrent_corrected",
      reportMarkdown: "Concurrent corrected result",
    });
    expect(observed?.directParentResultDeliveredAt).toBeDefined();

    await internal.deliverPersistentChildWorkspaceTurnResult(concurrentWinner, new Set());
    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Concurrent corrected result");
    const generationId = `${concurrentWinner.handleId}:${concurrentWinner.status}:${concurrentWinner.updatedAt}`;
    expect(
      await new TerminalAttentionStore(config).get(
        parentId,
        TerminalAttentionStore.notificationId("agent_task", "childworkspace", generationId)
      )
    ).toBeNull();
  });

  test("direct-parent consumption suppresses a concurrently resettled workspace-turn wake", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const child = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = parentId;
      child.agentId = "explore";
      child.agentType = "explore";
      child.taskStatus = "reported";
      return cfg;
    });
    const staleRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Stream error: provider overloaded",
      attentionPolicy: "notify_on_terminal",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    };
    await new TaskHandleStore(config).upsertWorkspaceTurn(staleRecord);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
      terminalOutcome: "error",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");

    let releasePostSettlementDelivery: () => void = () => undefined;
    const postSettlementDeliveryBlocked = new Promise<void>((resolve) => {
      releasePostSettlementDelivery = resolve;
    });
    let signalPostSettlementDelivery: () => void = () => undefined;
    const postSettlementDeliveryStarted = new Promise<void>((resolve) => {
      signalPostSettlementDelivery = resolve;
    });
    const streamHost = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    const internal = workspaceTurnManagerFor(taskService) as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
    };
    const deliverPersistentChildWorkspaceTurnResult =
      internal.deliverPersistentChildWorkspaceTurnResult.bind(workspaceTurnManagerFor(taskService));
    const delivery = spyOn(
      internal,
      "deliverPersistentChildWorkspaceTurnResult"
    ).mockImplementation(async (record, waiterWorkspaceIds) => {
      // Preserve the production direct-parent report/marker path, then pause before
      // settleWorkspaceTurn can re-arm the corrected private workspace-turn wake.
      await deliverPersistentChildWorkspaceTurnResult(record, waiterWorkspaceIds);
      signalPostSettlementDelivery();
      await postSettlementDeliveryBlocked;
    });
    const settling = streamHost.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_concurrent_resettle",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Concurrently corrected result" }],
    });

    try {
      await postSettlementDeliveryStarted;
      const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
        parentId,
        "wst_handle",
        {
          consumingWorkspaceId: parentId,
        }
      );
      expect(snapshot).toMatchObject({
        status: "completed",
        messageId: "msg_concurrent_resettle",
        reportMarkdown: "Concurrently corrected result",
      });
      expect(snapshot?.directParentResultDeliveredAt).toBeDefined();
      expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
    } finally {
      releasePostSettlementDelivery();
      await settling;
      delivery.mockRestore();
    }

    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle")).toMatchObject({
      status: "delivered",
    });
    expect(
      (await terminalAttentionStore.listPending(parentId)).filter(
        (notification) => notification.sourceKind === "workspace_turn"
      )
    ).toEqual([]);
  });

  test("direct-parent consumption preserves a higher continuation owner's terminal wake", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["ownerpreservehandle", "ownerpreserveturn"]);
    const { parentId: rootWorkspaceId, projectPath } = await saveLocalParentWorkspace(
      config,
      rootDir
    );
    const directParentTaskId = "direct-parent-preserve-owner-wake";
    const childTaskId = "child-preserve-owner-wake";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "direct-parent", directParentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: directParentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Owner Wake Reviewer",
        }),
      ],
      testTaskSettings()
    );
    const { taskService } = createTaskServiceHarness(config);
    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: rootWorkspaceId,
      prompt: "Continue work owned by the root ancestor.",
      title: "Owner Wake Reviewer",
      allowAgentWorkspace: true,
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "existing", workspaceId: childTaskId },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;
    const taskHandleStore = new TaskHandleStore(config);
    const active = await taskHandleStore.getWorkspaceTurn(rootWorkspaceId, created.data.taskId);
    assert(active, "continuation record must exist");
    const terminal: WorkspaceTurnTaskHandleRecord = {
      ...active,
      status: "completed",
      updatedAt: "2026-08-11T00:00:02.000Z",
      reportMarkdown: "Higher owner result",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:02.000Z",
      directParentResultDeliveredAt: "2026-08-11T00:00:02.500Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(terminal);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: rootWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: terminal.handleId,
      terminalOutcome: "completed",
    });

    const consumed = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      rootWorkspaceId,
      terminal.handleId,
      {
        consumingWorkspaceId: directParentTaskId,
      }
    );
    expect(consumed?.directParentResultDeliveredAt).toBe("2026-08-11T00:00:02.500Z");
    expect(consumed?.terminalAttentionNotifiedAt).toBeUndefined();
    await workspaceTurnManagerFor(taskService).markWorkspaceTurnTerminalAttentionConsumed({
      ownerWorkspaceId: rootWorkspaceId,
      consumingWorkspaceId: directParentTaskId,
      handleId: terminal.handleId,
      updatedAt: terminal.updatedAt,
      status: terminal.status,
    });
    expect(
      await terminalAttentionStore.get(
        rootWorkspaceId,
        TerminalAttentionStore.notificationId("workspace_turn", terminal.handleId)
      )
    ).toMatchObject({ status: "pending" });
  });

  test("getWorkspaceTurnSnapshot revives an interrupted handle while the child retries the same turn", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
    );
    expect(appendResult.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "interrupted",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-06-19T00:00:01.500Z",
      directParentResultDeliveredAt: "2026-06-19T00:00:01.750Z",
      error: "Workspace turn interrupted after restart",
      terminalAttentionNotifiedAt: "2026-06-19T00:00:02.000Z",
    });
    // Delivered tombstone from the stale settlement; revive must clear it so the revived
    // turn's eventual real settlement can enqueue a fresh wake-up.
    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: "wst_handle",
    });
    await terminalAttentionStore.markDelivered(parentId, "workspace_turn:wst_handle");
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string; accepted: boolean }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.directParentResultDeliveryRequiredAt).toBeUndefined();
    expect(snapshot?.directParentResultDeliveredAt).toBeUndefined();
    expect(snapshot?.error).toBeUndefined();
    expect(snapshot?.terminalAttentionNotifiedAt).toBeUndefined();
    expect(await terminalAttentionStore.get(parentId, "workspace_turn:wst_handle")).toBeNull();
    // Revival registers as accepted: the revived turn was already admitted once, so peer
    // admission and delegated correlation may treat it as live immediately.
    expect(internal.activeWorkspaceTurnHandleByWorkspaceId.get("childworkspace")).toEqual({
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      accepted: true,
    });
  });

  test("history repair of a stale error handle waits for active child background work", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    // The retried turn emitted its correlated final while a descendant task was still
    // running; reporting completed before it finishes would hand the parent an
    // incomplete result that active handles avoid via deferred stream-ends. Instead the
    // handle is revived with the final recorded as deferred, then settles once the
    // blocker is gone.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_blocked_final", "assistant", "Blocked final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });

    const blocked = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(blocked).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_blocked_final"],
    });
    expect(blocked?.error).toBeUndefined();
    expect(blocked?.reportMarkdown).toBeUndefined();

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: "msg_blocked_final",
      reportMarkdown: "Blocked final text",
    });
  });

  test("turn-end blocker scan keeps a stale handle live between retry streams via child blockers", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    // Codex handoff gap: the retried child's stream ended, no auto-retry is pending, but
    // its descendant work is still running. The blocker scan must still treat the turn as
    // live so the parent cannot end its turn during that window.
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("turn-end blocker scan revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // The parent turn-end path must treat the stale-but-retrying handle as live work so
    // the parent cannot end its turn while the child is still running.
    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toContain("wst_handle");
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("active-only listWorkspaceTurnTasks revives and includes a stale retrying handle", async () => {
    const hasPendingAutoRetry = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    // task_list defaults to active statuses; the status filter applies AFTER
    // normalization, so the stale-but-retrying handle is revived and reported as
    // running instead of silently disappearing from the active view.
    const listed = await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(parentId, {
      statuses: ["queued", "starting", "running"],
    });
    expect(listed.map((record) => record.handleId)).toContain("wst_handle");
    expect(listed.find((record) => record.handleId === "wst_handle")?.status).toBe("running");
  });

  test("queued manual input does not revive a settled workspace turn", async () => {
    // Ordinary queued input is not yet in history, so the newest-correlated-prompt guard
    // cannot see it; the liveness gate must not treat it as a same-turn continuation.
    const hasQueuedMessages = mock((workspaceId: string) => workspaceId === "childworkspace");
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      hasQueuedMessages,
      hasPendingQueuedOrPreparingTurn,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      listActiveWorkspaceTurnTaskIdsForOwner: (ownerWorkspaceId: string) => Promise<string[]>;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(await internal.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).not.toContain(
      "wst_handle"
    );
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("a newer unrelated child prompt does not revive a settled workspace turn", async () => {
    const isStreaming = mock((workspaceId: string) => workspaceId === "childworkspace");
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest({
      isStreaming,
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_prompt", "user", "Summarize", { muxMetadata })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };
    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      error: "Stream error: provider overloaded",
    });
  });

  test("revive does not clobber a newer same-status settlement written after the stale read", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest();
    const taskHandleStore = new TaskHandleStore(config);
    // The record currently on disk: a FRESH error settled by the live retry itself.
    const freshError = {
      kind: "workspace_turn" as const,
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error" as const,
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:05:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: retry also failed",
    };
    await taskHandleStore.upsertWorkspaceTurn(freshError);
    const internal = taskService as unknown as {
      reviveRetryingWorkspaceTurn: (record: typeof freshError) => Promise<typeof freshError | null>;
    };

    // Reconcile observed an OLDER error record (same status, earlier updatedAt) before the
    // retry failed; the revive must notice the newer settlement and leave it untouched.
    const revived = await internal.reviveRetryingWorkspaceTurn({
      ...freshError,
      updatedAt: "2026-06-19T00:00:01.000Z",
      error: "Stream error: provider overloaded",
    });

    expect(revived).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "error",
      updatedAt: "2026-06-19T00:05:00.000Z",
      error: "Stream error: retry also failed",
    });
  });

  test("history repair scans past newer unrelated prompts to a correlated final message", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    // The turn self-healed and finished, THEN the child received an unrelated manual
    // prompt before the parent ever called task_await.
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_selfhealed_final", "assistant", "Self-healed final text", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "stop",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_manual_later", "user", "Manual follow-up", {})
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "error",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      error: "Stream error: provider overloaded",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "completed",
      messageId: "msg_selfhealed_final",
      reportMarkdown: "Self-healed final text",
    });
    expect(snapshot?.error).toBeUndefined();
  });

  test("workspace-turn stale recovery uses deferred history after archived descendants stop blocking", async () => {
    const { config, parentId, projectPath, taskService, historyService } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_prehandoff", "assistant", "Premature final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_prehandoff",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_prehandoff"],
    });

    await config.editConfig((cfg) => {
      const descendant = Array.from(cfg.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === "descendant-task");
      assert(descendant, "descendant task must exist");
      descendant.archivedAt = "2026-06-19T00:01:00.000Z";
      return cfg;
    });

    const recovered = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(recovered).toMatchObject({
      status: "completed",
      messageId: "msg_prehandoff",
      reportMarkdown: "Premature final text",
    });
    expect(recovered?.deferredMessageIds).toBeUndefined();
  });

  test("workspace-turn deferred recovery waits for active workflow blockers", async () => {
    const { config, parentId, taskService, historyService } = await startWorkspaceTurnForTest();
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, "childworkspace"),
    });
    await runStore.createRun({
      id: "wfr_child_background",
      workspaceId: "childworkspace",
      workflow: {
        name: "child-background",
        description: "Child background workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus("wfr_child_background", "running", "2026-06-19T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, "childworkspace"),
      runId: "wfr_child_background",
      createdAtMs: Date.parse("2026-06-19T00:00:01.000Z"),
    });

    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    const appendResult = await historyService.appendToHistory(
      "childworkspace",
      createMuxMessage("msg_workflow_blocked", "assistant", "Workflow-blocked final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);

    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_workflow_blocked",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata,
      },
      parts: [{ type: "text", text: "Workflow-blocked final text" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      deferredMessageIds: ["msg_workflow_blocked"],
    });

    await runStore.appendStatus("wfr_child_background", "completed", "2026-06-19T00:00:02.000Z");
    const recovered = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(recovered).toMatchObject({
      status: "completed",
      messageId: "msg_workflow_blocked",
      reportMarkdown: "Workflow-blocked final text",
    });
  });

  test("workspace-turn auto-resume preserves handle metadata", async () => {
    const { config, parentId, projectPath, taskService, workspaceMocks } =
      await startWorkspaceTurnForTest();
    await config.editConfig((cfg) => {
      const project = Array.from(cfg.projects.values())[0];
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "descendant-task"),
        id: "descendant-task",
        name: "descendant-task",
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
        parentWorkspaceId: "childworkspace",
        taskStatus: "running",
      });
      return cfg;
    });

    await (
      taskService as unknown as { handleStreamEnd: (event: StreamEndEvent) => Promise<void> }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Premature final text" }],
    });

    expect(workspaceMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(workspaceMocks.sendMessage.mock.calls[1]?.[2]).toMatchObject({
      muxMetadata: {
        type: "workspace-turn-task",
        taskHandleId: "wst_handle",
        ownerWorkspaceId: parentId,
        turnId: "turn",
      },
    });
  });

  test("workspace-turn stream-end ignores unrelated mux metadata", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "compaction_msg",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
      },
      parts: [{ type: "text", text: "Compaction summary" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
  });

  test("workspace-turn stream-end without correlation metadata interrupts the active handle", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };
    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Done without correlation metadata" }],
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("workspace-turn stream errors mark the handle failed", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["handle", "turn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const created = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Summarize",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(created.success).toBe(true);

    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Provider failed",
      errorType: "authentication",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Provider failed",
    });
  });

  test("workspace-turn terminal stream errors mark the handle failed", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_unknown_error",
      error: "Provider returned no usable result",
      errorType: "unknown",
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Provider returned no usable result",
    });
  });

  test("workspace-turn recoverable stream errors stay running while retry is pending", async () => {
    let retryDecisionAwaited = false;
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => retryDecisionAwaited && workspaceId === "childworkspace"
    );
    const waitForPendingStreamErrorRecoveryDecision = mock((): Promise<void> => {
      retryDecisionAwaited = true;
      return Promise.resolve();
    });
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
      waitForPendingStreamErrorRecoveryDecision,
    });
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      error: "Context too large",
      errorType: "context_exceeded",
    });

    expect(waitForPendingStreamErrorRecoveryDecision).toHaveBeenCalledWith(
      "childworkspace",
      "msg_1"
    );
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  // Regression: stream_truncated (a transient provider drop) previously fell
  // outside the recoverable allowlist and terminally settled the handle even
  // though the child session had already scheduled an in-session auto-retry,
  // falsely reporting the turn as failed to the parent.
  test("workspace-turn auto-retryable stream errors stay running while retry is pending", async () => {
    let retryDecisionAwaited = false;
    const hasPendingAutoRetry = mock(
      (workspaceId: string) => retryDecisionAwaited && workspaceId === "childworkspace"
    );
    const waitForPendingStreamErrorRecoveryDecision = mock((): Promise<void> => {
      retryDecisionAwaited = true;
      return Promise.resolve();
    });
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingAutoRetry,
      waitForPendingStreamErrorRecoveryDecision,
    });
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated",
      error: "Anthropic stream closed unexpectedly before the response completed.",
      errorType: "stream_truncated",
    });

    expect(waitForPendingStreamErrorRecoveryDecision).toHaveBeenCalledWith(
      "childworkspace",
      "msg_truncated"
    );
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });
  });

  test("workspace-turn auto-retryable stream errors without a pending retry mark the handle failed", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_exhausted",
      error: "Anthropic stream closed unexpectedly before the response completed.",
      errorType: "stream_truncated",
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Anthropic stream closed unexpectedly before the response completed.",
    });
  });

  // Codex review: unrelated queued manual messages must not keep the handle
  // running for auto-retryable errors — they start a different turn, so the
  // failed turn would never resume. Only an actual pending auto-retry counts.
  test("workspace-turn auto-retryable stream errors with only queued messages mark the handle failed", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(() => true);
    const hasPendingAutoRetry = mock(() => false);
    const { parentId, taskService } = await startWorkspaceTurnForTest({
      hasPendingQueuedOrPreparingTurn,
      hasPendingAutoRetry,
    });
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_truncated_queued_only",
      error: "Anthropic stream closed unexpectedly before the response completed.",
      errorType: "stream_truncated",
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Anthropic stream closed unexpectedly before the response completed.",
    });
  });

  test("workspace-turn exhausted recoverable stream errors mark the handle failed", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
    };

    await internal.handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_exhausted_context",
      error: "Context still too large after retry",
      errorType: "context_exceeded",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: "childworkspace",
      error: "Context still too large after retry",
    });
  });

  test("workspace-turn system stream aborts keep the handle running for resume", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamAbort: (event: StreamAbortEvent) => Promise<void>;
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
    };

    await internal.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "childworkspace",
      messageId: "msg_system_abort",
      abortReason: "system",
    });
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "running",
      workspaceId: "childworkspace",
    });

    await internal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_resumed",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Resumed done" }],
    });
    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(parentId, "wst_handle")
    ).toMatchObject({
      status: "completed",
      messageId: "msg_resumed",
      reportMarkdown: "Resumed done",
    });
  });

  test("workspace-turn stream aborts mark the handle interrupted", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamAbort: (event: StreamAbortEvent) => Promise<void>;
    };

    await internal.handleStreamAbort({
      type: "stream-abort",
      workspaceId: "childworkspace",
      messageId: "msg_1",
      abortReason: "user",
    });

    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentId,
      "wst_handle"
    );
    expect(snapshot).toMatchObject({
      status: "interrupted",
      workspaceId: "childworkspace",
    });
  });

  test("waitForWorkspaceTurn handles completion racing with waiter registration", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();
    const internal = taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      taskHandleStore: {
        getWorkspaceTurn: WorkspaceTurnManager["getWorkspaceTurnSnapshot"];
      };
    };
    const originalGetWorkspaceTurn = internal.taskHandleStore.getWorkspaceTurn.bind(
      internal.taskHandleStore
    );
    let triggered = false;
    spyOn(internal.taskHandleStore, "getWorkspaceTurn").mockImplementation(
      async (ownerWorkspaceId: string, handleId: string) => {
        const record = await originalGetWorkspaceTurn(ownerWorkspaceId, handleId);
        if (!triggered && handleId === "wst_handle" && record?.status === "running") {
          triggered = true;
          await internal.handleStreamEnd({
            type: "stream-end",
            workspaceId: "childworkspace",
            messageId: "msg_1",
            metadata: {
              model: "anthropic:claude-opus-4-6",
              agentId: "exec",
              finishReason: "stop",
              muxMetadata: {
                type: "workspace-turn-task",
                taskHandleId: "wst_handle",
                ownerWorkspaceId: parentId,
                turnId: "turn",
              },
            },
            parts: [{ type: "text", text: "Done" }],
          });
        }
        return record;
      }
    );

    const report = await workspaceTurnManagerFor(taskService).waitForWorkspaceTurn("wst_handle", {
      requestingWorkspaceId: parentId,
      timeoutMs: 100,
    });

    expect(triggered).toBe(true);
    expect(report.reportMarkdown).toBe("Done");
  });

  test("workspace-turn terminal settlements do not overwrite each other", async () => {
    const completed = await startWorkspaceTurnForTest();
    const staleRunningRecord = await workspaceTurnManagerFor(
      completed.taskService
    ).getWorkspaceTurnSnapshot(completed.parentId, "wst_handle");
    assert(staleRunningRecord, "expected running workspace-turn record");
    const completedInternal = completed.taskService as unknown as {
      handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      settleWorkspaceTurn: (params: unknown) => Promise<void>;
    };
    await completedInternal.handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_done",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: completed.parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });
    await completedInternal.settleWorkspaceTurn({
      record: staleRunningRecord,
      next: {
        ...staleRunningRecord,
        status: "interrupted",
        updatedAt: "2026-06-19T00:00:01.000Z",
      },
      waiterSettlement: { status: "error", error: new Error("late interrupt") },
    });
    expect(
      await workspaceTurnManagerFor(completed.taskService).getWorkspaceTurnSnapshot(
        completed.parentId,
        "wst_handle"
      )
    ).toMatchObject({
      status: "completed",
      messageId: "msg_done",
      reportMarkdown: "Done",
    });

    const interrupted = await startWorkspaceTurnForTest({
      stableIds: ["secondhandle", "secondturn"],
    });
    const staleInterruptedRecord = await workspaceTurnManagerFor(
      interrupted.taskService
    ).getWorkspaceTurnSnapshot(interrupted.parentId, "wst_secondhandle");
    assert(staleInterruptedRecord, "expected second running workspace-turn record");
    await interrupted.config.editConfig((cfg) => {
      const project = cfg.projects.get(interrupted.projectPath);
      const child = project?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "workspace-turn child must exist");
      child.parentWorkspaceId = interrupted.parentId;
      child.taskStatus = "reported";
      child.taskExecutionId = "wst_secondhandle";
      child.taskExecutionStatus = "running";
      return cfg;
    });
    const interruptResult = await workspaceTurnManagerFor(
      interrupted.taskService
    ).interruptWorkspaceTurn(interrupted.parentId, "wst_secondhandle");
    expect(interruptResult.success).toBe(true);
    await (
      interrupted.taskService as unknown as {
        settleWorkspaceTurn: (params: unknown) => Promise<void>;
      }
    ).settleWorkspaceTurn({
      record: staleInterruptedRecord,
      next: {
        ...staleInterruptedRecord,
        status: "completed",
        updatedAt: "2026-06-19T00:00:01.000Z",
        messageId: "msg_late_done",
        reportMarkdown: "Late done",
      },
      waiterSettlement: {
        status: "completed",
        result: {
          taskId: "wst_secondhandle",
          workspaceId: "childworkspace",
          reportMarkdown: "Late done",
        },
      },
    });
    const interruptedSnapshot = await workspaceTurnManagerFor(
      interrupted.taskService
    ).getWorkspaceTurnSnapshot(interrupted.parentId, "wst_secondhandle");
    expect(interruptedSnapshot).toMatchObject({ status: "interrupted" });
    expect(findWorkspaceInConfig(interrupted.config, "childworkspace")?.taskExecutionStatus).toBe(
      "interrupted"
    );
    expect(interruptedSnapshot?.reportMarkdown).toBeUndefined();
  });

  test("waitForWorkspaceTurn foreground waits can be sent to background", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest();

    const waitResult = workspaceTurnManagerFor(taskService)
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .then(
        () => null,
        (error: unknown) => error
      );

    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(1);
    expect(await waitResult).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  test("waitForWorkspaceTurn backgrounds when tool-end message was already queued", async () => {
    const hasQueuedMessages = mock(() => true);
    const { parentId, taskService } = await startWorkspaceTurnForTest({ hasQueuedMessages });

    const waitError = await workspaceTurnManagerFor(taskService)
      .waitForWorkspaceTurn("wst_handle", {
        requestingWorkspaceId: parentId,
        timeoutMs: 1_000,
        backgroundOnMessageQueued: true,
      })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    expect(hasQueuedMessages).toHaveBeenCalledWith(parentId, "tool-end");
    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
  });

  test("disposable workspace turns are removed after completion, error, or interruption", async () => {
    const completedRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const completed = await startWorkspaceTurnForTest({
      disposable: true,
      remove: completedRemove,
    });
    await (
      completed.taskService as unknown as {
        handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
      }
    ).handleStreamEnd({
      type: "stream-end",
      workspaceId: "childworkspace",
      messageId: "msg_completed",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: "wst_handle",
          ownerWorkspaceId: completed.parentId,
          turnId: "turn",
        },
      },
      parts: [{ type: "text", text: "Done" }],
    });
    expect(completedRemove).toHaveBeenCalledWith("childworkspace", true);

    const errorRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const failed = await startWorkspaceTurnForTest({ disposable: true, remove: errorRemove });
    await (
      failed.taskService as unknown as {
        handleTaskStreamError: (event: ErrorEvent) => Promise<void>;
      }
    ).handleTaskStreamError({
      type: "error",
      workspaceId: "childworkspace",
      messageId: "msg_error",
      error: "Provider failed",
      errorType: "authentication",
    });
    expect(errorRemove).toHaveBeenCalledWith("childworkspace", true);

    const interruptedRemove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const interrupted = await startWorkspaceTurnForTest({
      disposable: true,
      remove: interruptedRemove,
      isStreaming: mock(() => true),
    });
    const interruptResult = await workspaceTurnManagerFor(
      interrupted.taskService
    ).interruptWorkspaceTurn(interrupted.parentId, "wst_handle");
    expect(interruptResult.success).toBe(true);
    expect(interruptedRemove).toHaveBeenCalledWith("childworkspace", true);
  });

  test("markBackgroundWorkNotifyOnTerminal wakes for terminal workspace-turn records", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const handleId = "wst_timeout_race";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: rootWorkspaceId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Done before notify policy persisted",
    });

    // Simulates the race Codex caught: the workspace turn settled before the queued/timeout detach
    // persisted notify_on_terminal, so the persistence helper must enqueue the missing wake-up.
    await taskService.markBackgroundWorkNotifyOnTerminal(handleId, rootWorkspaceId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(handleId);
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("timeout_secs: 0");
    const snapshot = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      rootWorkspaceId,
      handleId
    );
    expect(snapshot?.attentionPolicy).toBe("notify_on_terminal");
    expect(snapshot?.terminalAttentionNotifiedAt).toBeDefined();
  });

  test("sendAgentTreeMessage rechecks hard interruption at admission after awaited lookups", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // Simulate the user's Stop landing DURING the awaited pre-send lookup (interruptStream
    // marks suppression without taking the target's event lock): the admission-time recheck
    // must cancel the send instead of restarting the stopped ancestor.
    const internals = workspaceTurnManagerFor(taskService) as unknown as {
      getActiveWorkspaceTurnMuxMetadataForWorkspace: (workspaceId: string) => Promise<null>;
    };
    internals.getActiveWorkspaceTurnMuxMetadataForWorkspace = (workspaceId) => {
      taskService.markParentWorkspaceInterrupted(workspaceId);
      return Promise.resolve(null);
    };

    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "status?")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage carries the target's active workspace-turn correlation on the trigger", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // The root is executing a delegated workspace turn owned elsewhere: the trigger must keep
    // that correlation or the queued peer wake would settle the owner's turn as superseded.
    const turnMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wt-1",
      ownerWorkspaceId: "owner-1",
      turnId: "turn-1",
    };
    const internals = workspaceTurnManagerFor(taskService) as unknown as {
      getActiveWorkspaceTurnMuxMetadataForWorkspace: (
        workspaceId: string
      ) => Promise<typeof turnMetadata | null>;
    };
    internals.getActiveWorkspaceTurnMuxMetadataForWorkspace = (workspaceId) =>
      Promise.resolve(workspaceId === "tree-root" ? turnMetadata : null);

    const result = await taskService.sendAgentTreeMessage("child-a", "tree-root", "Blocked.");
    expect(result.success).toBe(true);
    const [, , options, internalArg] = sendMessage.mock.calls[0] as [
      string,
      string,
      { muxMetadata?: { type?: string; agentPeerMessageTrigger?: object } },
      { workspaceTurnContinuation?: boolean; preTurnMessages?: MuxMessage[] },
    ];
    // The correlation replaces peer attribution, so the nested attribution must survive it —
    // it keeps the UI rendering this row as a machine notification even if the correlation is
    // later stripped for a superseded continuation.
    expect(options.muxMetadata).toEqual({
      ...turnMetadata,
      agentPeerMessageTrigger: {
        fromWorkspaceId: "child-a",
        fromTitle: "child-a",
        relationship: "descendant",
      },
    });
    expect(internalArg.workspaceTurnContinuation).toBe(true);
    // Peer attribution stays on the assistant payload row.
    expect(internalArg.preTurnMessages?.[0]?.metadata?.muxMetadata?.type).toBe(
      "agent-peer-message"
    );
  });

  test("sendAgentTreeMessage honors active reawakened executions on both endpoints", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        // Reawakened persistent children: the stable taskStatus stays terminal (`reported`)
        // while the current execution runs under a workspace-turn handle mirror.
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_a",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_b",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // The execution mirror only counts when backed by a LIVE handle registration (a stale
    // mirror can outlive its handle after a crash or failed reconciliation).
    await registerLiveWorkspaceTurnHandle(taskService, "sib-a", "wst_a");
    await registerLiveWorkspaceTurnHandle(taskService, "sib-b", "wst_b");

    // Both endpoints are effectively executing: the reawakened sender may message peers, and
    // the reawakened target (advertised as running by task_list's execution overlay) accepts.
    const result = await taskService.sendAgentTreeMessage("sib-a", "sib-b", "sync up");
    expect(result).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sendAgentTreeMessage refuses a stale running mirror without a live handle", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Stale mirror: a crash between terminal handle persistence and the config mirror
        // write (or a failed startup reconciliation) can leave taskExecutionStatus="running"
        // on a stably reported task with no live handle. Admitting a send here would be
        // uncorrelated and would peer-reactivate the terminal task.
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_stale",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "reported",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses a reawakening reservation until the turn is accepted", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakening in flight: createWorkspaceTurn registers the handle and writes the
        // "running" mirror BEFORE its sendMessage passes turn admission. A peer send winning
        // this window could start the terminal child's only turn when the owner's requireIdle
        // send subsequently fails — a prohibited peer reactivation.
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_preaccept",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "sib-b",
      "wst_preaccept",
      "tree-root",
      false
    );

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "reported",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // Once the owner's turn is admitted (onAccepted marks the registration accepted), the same
    // target accepts peer messages.
    await registerLiveWorkspaceTurnHandle(taskService, "sib-b", "wst_preaccept", "tree-root", true);
    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello again")).toEqual(
      Ok({ delivery: "queued", relation: "peer", queueDispatchMode: "tool-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sendAgentTreeMessage refuses peer sends to queued reawakened executions", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "sib-a", "sib-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakening turn queued behind existing activity: the new execution has not been
        // admitted, so its handle carries no correlation — a peer entry would cut or trail
        // the delegated replay as an unrelated generic turn (peer reactivation).
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_b",
          taskExecutionStatus: "queued",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "hello")).toEqual(
      Err({
        code: "not_active",
        taskStatus: "reported",
        message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendAgentTreeMessage refuses at the admission probe when the sender is stopped mid-send", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const workspaces = (senderExecution: "running" | "interrupted") => [
      projectWorkspace(projectPath, "root", "tree-root"),
      // Reawakened persistent child: stable status stays `reported` while the current
      // execution runs under a workspace-turn handle mirror.
      projectWorkspace(projectPath, "sib-a", "sib-a", {
        parentWorkspaceId: "tree-root",
        taskStatus: "reported" as const,
        taskExecutionId: "wst_a",
        taskExecutionStatus: senderExecution,
      }),
      projectWorkspace(projectPath, "sib-b", "sib-b", {
        parentWorkspaceId: "tree-root",
        taskStatus: "running" as const,
      }),
    ];
    await saveWorkspaces(config, projectPath, workspaces("running"), testTaskSettings());

    // Simulate the sender's owner interrupting its workspace turn while the send is in
    // flight: interruptWorkspaceTurn marks the execution mirror terminal WITH the handle
    // transition (before stopStream), so the admission probe observes the stop and the
    // winding-down tool call cannot wake an idle peer.
    const sendMessage = mock(
      async (
        _targetId: string,
        _message: string,
        _options: unknown,
        internal: { admissionStale?: () => boolean }
      ) => {
        await saveWorkspaces(config, projectPath, workspaces("interrupted"), testTaskSettings());
        expect(internal.admissionStale?.()).toBe(true);
        return Err({ type: "unknown", raw: "send admission stale" });
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // Live handle registration lets the reawakened sender pass the ENTRY check; the mid-send
    // interruption is then only observable through the admission probe's mirror re-read.
    await registerLiveWorkspaceTurnHandle(taskService, "sib-a", "wst_a");

    expect(await taskService.sendAgentTreeMessage("sib-a", "sib-b", "still there?")).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
  });

  test("unconfirmed stream stop retains the latch for a completed descendant with live execution", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Reawakened completed child: the cascade preserves its terminal report, so it persists
        // neither an interrupted status nor a terminal execution mirror.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    // The child's stream cancellation fails (contained by the cascade): with the report
    // preserved, nothing admission-visible would mark the stop once the latch drops, so the
    // still-running child could message a cousin right after Stop.
    const { aiService } = createAIServiceMocks(config, {
      stopStream: mock((): Promise<Result<void>> => Promise.resolve(Err("cancel failed"))),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskStatus).toBe("reported");

    // User resume clears the level-triggered suppression; only the retained latch refuses.
    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the unconfirmed stop")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // The retained latch is releasable, not permanent: authoritative terminal settlement of the
    // child's execution (here an explicit turn interrupt persisting the terminal mirror) must
    // free it — otherwise the child stays barred from peer messaging until restart even after
    // every admission-visible marker refuses on its own.
    const internals = taskService as unknown as {
      workspaceStopsInProgress: Map<string, number>;
      taskHandleStore: {
        upsertWorkspaceTurn: (record: Record<string, unknown>) => Promise<void>;
      };
    };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    // A STALE handle settling for the same workspace is NOT settlement for the live execution:
    // the mirror still points at wst_leaf, so releasing here would let the still-running child
    // resume peer messaging with nothing admission-visible refusing it.
    await internals.taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: "wst_stale",
      ownerWorkspaceId: "tree-root",
      workspaceId: "leaf-a",
      turnId: "wst_stale-turn",
      status: "running",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });
    const staleInterrupt = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "tree-root",
      "wst_stale"
    );
    expect(staleInterrupt.success).toBe(true);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    const interrupted = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "tree-root",
      "wst_leaf"
    );
    expect(interrupted.success).toBe(true);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
  });

  test("successful no-op stream stop still retains the latch for an unsettled PREPARING execution", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Accepted-but-PREPARING reawakened child: the turn was admitted (accepted live handle,
        // running mirror) but no stream registered yet, so the cascade's stopStream no-ops with
        // SUCCESS while the prepared turn can still start afterward. Only terminal settlement
        // confirms the stop — the latch must be retained despite the successful stop call.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskStatus).toBe("reported");

    const internals = taskService as unknown as { workspaceStopsInProgress: Map<string, number> };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    // User resume clears the level-triggered suppression; only the retained latch refuses the
    // prepared turn's child until its execution settles.
    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape the preparing stop")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    // Terminal settlement of the prepared execution releases the retained latch.
    const interrupted = await workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "tree-root",
      "wst_leaf"
    );
    expect(interrupted.success).toBe(true);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
  });

  test("settlement with a swallowed mirror write still refuses peer sends via registration removal", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sib-b", "sib-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    // Establish a retained latch (accepted-but-unsettled live execution under a hard stop).
    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");
    const internals = taskService as unknown as {
      workspaceStopsInProgress: Map<string, number>;
      activeWorkspaceTurnHandleByWorkspaceId: Map<string, { handleId: string }>;
      updateAgentTaskExecutionState: (
        workspaceId: string,
        handleId: string,
        status: "interrupted"
      ) => Promise<void>;
    };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(true);

    // Settlement's terminal mirror write is SWALLOWED (Config.saveConfig logs and drops write
    // errors), so the on-disk mirror keeps claiming "running". Releasing the latch on the
    // unverified write must therefore be accompanied by removing the live registration in the
    // same tick — otherwise a peer admission probe in the pre-caller-delete window sees the
    // stale running mirror plus the accepted handle and escapes the stop.
    const saveSpy = spyOn(
      config as unknown as { saveConfig: (config: unknown) => Promise<void> },
      "saveConfig"
    ).mockImplementation(() => Promise.resolve());
    await internals.updateAgentTaskExecutionState("leaf-a", "wst_leaf", "interrupted");
    saveSpy.mockRestore();

    // The stale mirror really is still on disk...
    expect(findWorkspaceInConfig(config, "leaf-a")?.taskExecutionStatus).toBe("running");
    // ...but the registration is gone and the latch released: admission refuses on its own.
    expect(internals.activeWorkspaceTurnHandleByWorkspaceId.has("leaf-a")).toBe(false);
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);

    taskService.resetAutoResumeCount("branch-a");
    expect(
      await taskService.sendAgentTreeMessage("leaf-a", "sib-b", "escape via stale mirror")
    ).toEqual(
      Err({
        code: "refused",
        reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("park-after-settlement race releases the latch on already-settled evidence", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "branch-a", "branch-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Mid-settlement snapshot: a racing settlement already persisted the terminal mirror
        // (and ran its retained-latch release) but has not yet deleted the live handle entry.
        // The cascade's park lands AFTER the only settlement callback — without the post-park
        // recheck the latch would hold until restart even though the persisted mirror already
        // refuses peer sends on its own.
        projectWorkspace(projectPath, "leaf-a", "leaf-a", {
          parentWorkspaceId: "branch-a",
          taskStatus: "reported",
          taskExecutionId: "wst_leaf",
          taskExecutionStatus: "interrupted",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService } = createWorkspaceServiceMocks();
    const { aiService } = createAIServiceMocks(config, {
      stopStream: mock((): Promise<Result<void>> => Promise.resolve(Err("cancel failed"))),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });
    await registerLiveWorkspaceTurnHandle(taskService, "leaf-a", "wst_leaf");

    taskService.markParentWorkspaceInterrupted("branch-a");
    await taskService.terminateAllDescendantAgentTasks("branch-a");

    const internals = taskService as unknown as { workspaceStopsInProgress: Map<string, number> };
    expect(internals.workspaceStopsInProgress.has("leaf-a")).toBe(false);
  });

  test("sendAgentTreeMessage refuses root sends while an interrupted workspace turn winds down", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // task_stop on a delegated workspace turn whose target is the tree ROOT: the root has no
    // task lifecycle status to refuse on, so during the stopStream wind-down only the held
    // latch keeps an upward send from queueing behind the dying stream and auto-dispatching
    // when it ends — which would defeat the stop.
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === "tree-root") {
        markStopStarted?.();
        await stopGate;
      }
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    await registerLiveWorkspaceTurnHandle(taskService, "tree-root", "wst_root_turn", "owner-ws");

    const interrupting = workspaceTurnManagerFor(taskService).interruptWorkspaceTurn(
      "owner-ws",
      "wst_root_turn"
    );
    await stopStarted;

    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "wake the root")).toEqual(
      Err({
        code: "refused",
        reason:
          "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
      })
    );
    expect(sendMessage).not.toHaveBeenCalled();

    releaseStop?.();
    expect(await interrupting).toEqual(Ok({ workspaceId: "tree-root" }));
    // Once the stop settles, the idle root accepts peer messages again (fresh turn on delivery).
    expect(
      await taskService.sendAgentTreeMessage("child-a", "tree-root", "after the stop")
    ).toEqual(
      Ok({ delivery: "queued", relation: "target_ancestor", queueDispatchMode: "turn-end" })
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("sendAgentTreeMessage withholds correlation from unaccepted workspace-turn registrations", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child-a", "child-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // Creation-time reservation on the ROOT: the record is persisted as running BEFORE the
    // owner's requireIdle send passes admission. Correlating a peer trigger with it would let
    // that trigger's stream-end settle the owner's unaccepted handle as the delegated result.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "tree-root",
      "wst_unaccepted_corr",
      "owner-ws",
      false
    );

    expect(await taskService.sendAgentTreeMessage("child-a", "tree-root", "status?")).toEqual(
      Ok({ delivery: "queued", relation: "target_ancestor", queueDispatchMode: "turn-end" })
    );
    const [, , options, internalArg] = sendMessage.mock.calls[0] as [
      string,
      string,
      { muxMetadata?: { type?: string } },
      { workspaceTurnContinuation?: boolean },
    ];
    expect(options.muxMetadata?.type).toBe("agent-peer-message");
    expect(internalArg.workspaceTurnContinuation).toBe(false);

    // Once the owner's turn is admitted, the same registration correlates again.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "tree-root",
      "wst_unaccepted_corr",
      "owner-ws",
      true
    );
    expect(
      (await taskService.sendAgentTreeMessage("child-a", "tree-root", "second update")).success
    ).toBe(true);
    const [, , secondOptions, secondInternal] = sendMessage.mock.calls[1] as [
      string,
      string,
      { muxMetadata?: { type?: string } },
      { workspaceTurnContinuation?: boolean },
    ];
    expect(secondOptions.muxMetadata?.type).toBe("workspace-turn-task");
    expect(secondInternal.workspaceTurnContinuation).toBe(true);
  });

  test("listTaskTreeAgents strips stale execution overlays from peer rows", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "a", "task-a", {
          parentWorkspaceId: "tree-root",
          taskStatus: "running",
        }),
        // Stale persisted mirror: taskExecutionStatus survived a crash/failed reconciliation
        // with no live handle. Peer admission refuses this target, so sibling discovery must
        // keep its stable terminal status instead of advertising a running overlay.
        projectWorkspace(projectPath, "b", "task-b", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_stale_overlay",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);

    const stale = taskService
      .listTaskTreeAgents("task-a")
      .tasks.find((task) => task.taskId === "task-b");
    expect(stale?.relationship).toBe("sibling");
    expect(stale?.status).toBe("reported");
    expect(stale?.executionStatus).toBeUndefined();
    expect(stale?.executionTaskId).toBeUndefined();

    // Backed by an ACCEPTED live handle (the same predicate peer admission uses), the overlay
    // is advertised again.
    await registerLiveWorkspaceTurnHandle(taskService, "task-b", "wst_stale_overlay");
    const live = taskService
      .listTaskTreeAgents("task-a")
      .tasks.find((task) => task.taskId === "task-b");
    expect(live?.executionStatus).toBe("running");
    expect(live?.executionTaskId).toBe("wst_stale_overlay");

    // A pre-acceptance reservation is not live for peers either.
    await registerLiveWorkspaceTurnHandle(
      taskService,
      "task-b",
      "wst_stale_overlay",
      "tree-root",
      false
    );
    const reserved = taskService
      .listTaskTreeAgents("task-a")
      .tasks.find((task) => task.taskId === "task-b");
    expect(reserved?.executionStatus).toBeUndefined();
  });

  test("sendMessageToDescendantAgentTask reawakens legacy archived descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-archived-guidance";
    const intermediateTaskId = "intermediate-archived-guidance";
    const childTaskId = "child-archived-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "intermediate", intermediateTaskId, {
          parentWorkspaceId,
          taskStatus: "reported",
          archivedAt: "2026-08-03T00:00:00.000Z",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: intermediateTaskId,
          taskStatus: "reported",
          archivedAt: "2026-08-03T00:00:00.000Z",
        }),
      ],
      testTaskSettings()
    );

    const unarchive = mock(async (workspaceId: string): Promise<Result<void>> => {
      await config.editConfig((cfg) => {
        const workspace = Array.from(cfg.projects.values())
          .flatMap((project) => project.workspaces)
          .find((candidate) => candidate.id === workspaceId);
        if (workspace) workspace.unarchivedAt = "2026-08-10T00:00:00.000Z";
        return cfg;
      });
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ unarchive });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Correction",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    if (!reactivated.success) return;
    expect(reactivated.data.delivery).toBe("reactivated");
    expect(reactivated.data.executionTaskId).toMatch(/^wst_/);
    expect(unarchive.mock.calls.map((call) => call[0])).toEqual([intermediateTaskId, childTaskId]);
    expect(sendMessage).toHaveBeenCalled();
  });

  test("sendMessageToDescendantAgentTask rejects non-descendants and settled children", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-guidance-scope";
    const otherParentId = "other-guidance-scope";
    const otherChildId = "other-child-guidance-scope";
    const settledChildId = "settled-child-guidance";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "other-parent", otherParentId),
        projectWorkspace(projectPath, "other-child", otherChildId, {
          parentWorkspaceId: otherParentId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "settled-child", settledChildId, {
          parentWorkspaceId,
          taskStatus: "reported",
          title: "React lifecycle expert",
        }),
      ],
      testTaskSettings()
    );

    const { taskService } = createTaskServiceHarness(config);

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        otherChildId,
        "Correction",
        "tool-end"
      )
    ).toEqual(Err({ code: "invalid_scope" }));
    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      settledChildId,
      "Correction",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    if (!reactivated.success) return;
    expect(reactivated.data.delivery).toBe("reactivated");
    const executionTaskId = reactivated.data.executionTaskId;
    assert(executionTaskId != null, "reactivated execution ID is required");
    const execution = await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
      parentWorkspaceId,
      executionTaskId
    );
    expect(execution?.title).toBe("React lifecycle expert");
    expect(reactivated.data.executionTaskId).toMatch(/^wst_/);
  });

  test("reawakening a stopped queued child replays its preserved initial brief", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["queuedreplayhandle", "queuedreplayturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-queued-replay";
    const childTaskId = "child-queued-replay";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskPrompt: "Inspect the original queued assignment.",
          title: "Queued task expert",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Also verify the regression tests.",
      "tool-end"
    );

    expect(result).toMatchObject({
      success: true,
      data: { delivery: "reactivated", executionTaskId: "wst_queuedreplayhandle" },
    });
    expect(sendMessage.mock.calls[0]?.[1]).toBe(
      "Inspect the original queued assignment.\n\nUpdated guidance from parent:\n\nAlso verify the regression tests."
    );
    expect(findWorkspaceInConfig(config, childTaskId)?.taskPrompt).toBeUndefined();
  });

  test("higher ancestors steer a nested active continuation without reawakening it again", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-nested-active-guidance";
    const parentTaskId = "parent-nested-active-guidance";
    const childTaskId = "child-nested-active-guidance";
    const executionTaskId = "wst_nested_active_guidance";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          taskExecutionId: executionTaskId,
          taskExecutionStatus: "queued",
          taskModelString: "anthropic:claude-sonnet-4-6",
          taskThinkingLevel: "low",
          aiSettingsByAgent: {
            explore: {
              model: "openai:gpt-5.6-sol",
              thinkingLevel: "high",
              reasoningMode: "pro",
            },
          },
          title: "React lifecycle expert",
        }),
      ],
      testTaskSettings()
    );
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === childTaskId
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      hasPendingQueuedOrPreparingTurn,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: executionTaskId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: childTaskId,
      turnId: "turn-nested-active-guidance",
      status: "queued",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
    });

    expect(
      await taskService.sendMessageToDescendantAgentTask(
        rootWorkspaceId,
        childTaskId,
        "Keep investigating the existing continuation.",
        "tool-end"
      )
    ).toEqual(Ok({ delivery: "queued", queueDispatchMode: "tool-end" }));

    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionId).toBe(executionTaskId);
    expect(await taskHandleStore.listAllWorkspaceTurns()).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "openai:gpt-5.6-sol",
      agentId: "explore",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
  });

  test("reactivated children can report progress while retaining their completed task status", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["reactivatehandle", "reactivateturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-reactivated-progress";
    const childTaskId = "child-reactivated-progress";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "React lifecycle expert",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Investigate the new regression.",
      "tool-end"
    );
    expect(reactivated.success).toBe(true);
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("reported");
    expect(findWorkspaceInConfig(config, childTaskId)?.taskExecutionStatus).toBe("running");

    await taskService.reportAgentProgress(childTaskId, "progress-call", {
      reportMarkdown: "The regression is in the effect cleanup path.",
    });
    expect(
      sendMessage.mock.calls.some(
        (call) =>
          call[0] === parentWorkspaceId &&
          typeof call[1] === "string" &&
          call[1].includes("effect cleanup path")
      )
    ).toBe(true);
  });

  test("reawakened child stays active through compaction and settles from its correlated follow-up", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["compactionhandle", "compactionturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-reactivated-compaction";
    const childTaskId = "child-reactivated-compaction";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "Compaction specialist",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivated = await taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Continue after compacting the prior context.",
      "tool-end"
    );
    expect(reactivated).toMatchObject({
      success: true,
      data: { delivery: "reactivated", executionTaskId: "wst_compactionhandle" },
    });
    const handleId = "wst_compactionhandle";
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const activeRecord = await taskHandleStore.getWorkspaceTurn(parentWorkspaceId, handleId);
    assert(activeRecord, "reactivated workspace-turn record is required");

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "reactivated-compaction-summary",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        agentId: "compact",
        mode: "compact",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Compacted specialist context" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
        parentWorkspaceId,
        handleId
      )
    ).toMatchObject({
      status: "running",
      workspaceId: childTaskId,
    });
    expect(findWorkspaceInConfig(config, childTaskId)).toMatchObject({
      taskStatus: "reported",
      taskExecutionId: handleId,
      taskExecutionStatus: "running",
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: childTaskId,
      messageId: "reactivated-post-compaction-result",
      metadata: {
        model: "anthropic:claude-sonnet-4-6",
        finishReason: "stop",
        muxMetadata: {
          type: "workspace-turn-task",
          taskHandleId: handleId,
          ownerWorkspaceId: parentWorkspaceId,
          turnId: activeRecord.turnId,
        },
      },
      parts: [{ type: "text", text: "Post-compaction result" }],
    });

    expect(
      await workspaceTurnManagerFor(taskService).getWorkspaceTurnSnapshot(
        parentWorkspaceId,
        handleId
      )
    ).toMatchObject({
      status: "completed",
      workspaceId: childTaskId,
      messageId: "reactivated-post-compaction-result",
      reportMarkdown: "Post-compaction result",
    });
    expect(findWorkspaceInConfig(config, childTaskId)).toMatchObject({
      taskStatus: "reported",
      taskExecutionId: handleId,
      taskExecutionStatus: "completed",
    });
  });

  test("concurrent inactive-child messages create only one continuation execution", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["singlehandle", "singleturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-concurrent-reactivation";
    const childTaskId = "child-concurrent-reactivation";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "API reliability expert",
        }),
      ],
      testTaskSettings()
    );
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const results = await Promise.all([
      taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Check the retry path.",
        "tool-end"
      ),
      taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Also inspect timeout handling.",
        "tool-end"
      ),
    ]);

    expect(
      results.filter((result) => result.success && result.data.delivery === "reactivated")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.success && result.data.delivery !== "reactivated")
    ).toHaveLength(1);
    expect(
      await workspaceTurnManagerFor(taskService).listWorkspaceTurnTasks(parentWorkspaceId)
    ).toHaveLength(1);
  });

  test("reawakened terminal agents with active continuations can create children", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["afterinterrupted", "afterreporteda", "afterreportedb"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-reawakened-create";
    const interruptedTaskId = "child-interrupted-reawakened-create";
    const reportedTaskId = "child-reported-reawakened-create";
    const activeSiblingId = "sibling-reawakened-create";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "interrupted", interruptedTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskExecutionId: "wst_interrupted_reawakened_create",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "reported", reportedTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-11T00:00:00.000Z",
          taskExecutionId: "wst_reported_reawakened_create",
          taskExecutionStatus: "running",
        }),
        projectWorkspace(projectPath, "sibling", activeSiblingId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      { ...testTaskSettings(), maxParallelAgentTasks: 1 }
    );
    const { taskService } = createTaskServiceHarness(config);

    const afterInterrupted = await createAgentTask(
      taskService,
      interruptedTaskId,
      "Delegate from the stopped continuation"
    );
    const afterReported = await createAgentTask(
      taskService,
      reportedTaskId,
      "Delegate from the reported continuation"
    );
    const bulkAfterReported = await taskService.createMany([
      {
        parentWorkspaceId: reportedTaskId,
        kind: "agent",
        agentId: "explore",
        prompt: "Delegate a workflow worker from the reported continuation",
        title: "Nested workflow worker",
      },
    ]);

    expect(afterInterrupted).toMatchObject({ success: true, data: { status: "queued" } });
    expect(afterReported).toMatchObject({ success: true, data: { status: "queued" } });
    expect(bulkAfterReported).toMatchObject({
      success: true,
      data: [{ status: "queued" }],
    });
    const nestedTasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter(
        (workspace) =>
          workspace.parentWorkspaceId === interruptedTaskId ||
          workspace.parentWorkspaceId === reportedTaskId
      );
    expect(nestedTasks).toHaveLength(3);
    expect(nestedTasks.every((workspace) => workspace.taskStatus === "queued")).toBe(true);
  });

  test("does not accept agent_report while task-owned workspace turns are still active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: workspaceTurnId,
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
    });

    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceTurnId, {
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Too early" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      parentTaskId,
      expect.stringContaining(workspaceTurnHandleId),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal workspace turns are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: workspaceTurnId,
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceTurnId, {
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
    });

    await handleTaskServiceStreamEndForTest(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("initialize does not request agent_report while task-owned notify_on_terminal work is active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workspaceTurnId = "workspace-turn-child";
    const workspaceTurnHandleId = "wst_childturn_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );
    await new TaskHandleStore(config).upsertWorkspaceTurn({
      kind: "workspace_turn",
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
      workspaceId: workspaceTurnId,
      turnId: "turn-1",
      status: "running",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceTurnId, {
      handleId: workspaceTurnHandleId,
      ownerWorkspaceId: parentTaskId,
    });

    await taskService.initialize();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  async function handleTaskServiceStreamEndForTest(
    taskService: TaskService,
    event: StreamEndEvent
  ): Promise<void> {
    await (
      taskService as unknown as {
        handleStreamEnd: (streamEndEvent: StreamEndEvent) => Promise<void>;
      }
    ).handleStreamEnd(event);
  }

  async function flushTerminalAttentionDrains(taskService: TaskService): Promise<void> {
    // Terminal wake-ups are delivered by an async drain; await any in-flight drains, then await
    // again in case a drain scheduled another (idempotent, settles quickly).
    for (let i = 0; i < 3; i++) {
      const drains = (
        taskService as unknown as { pendingTerminalAttentionDrains: Set<Promise<void>> }
      ).pendingTerminalAttentionDrains;
      if (drains.size === 0) break;
      await Promise.all([...drains]);
    }
  }
});
