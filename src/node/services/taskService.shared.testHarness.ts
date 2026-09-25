// Helpers shared by the taskService.*.test.ts files. They were moved here verbatim when
// taskService.test.ts was split by section; each split file wraps its tests in
// describe("TaskService") and calls registerTaskServiceTestRoot() so full test names and the
// per-test temp root are unchanged.
import type { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import * as path from "path";
import { expect, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config } from "@/node/config";
import type { WorkspaceTurnTaskHandleRecord } from "@/node/services/taskHandleStore";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { TaskService } from "@/node/services/taskService";
import type { AgentPeerMessageBroker } from "@/node/services/agentPeerMessageBroker";
import { Ok, type Result } from "@/common/types/result";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import type { InitStateManager } from "@/node/services/initStateManager";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTaskServiceStack,
  createWorkspaceServiceMocks,
  makeWorkspaceTurnCreateMock,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";

/**
 * Per-test temp root. Each split file owns its `rootDir` and installs it with
 *   let rootDir: string;
 *   beforeEach(async () => { rootDir = await createTaskServiceTestRoot(); });
 *   afterEach(async () => { await removeTaskServiceTestRoot(rootDir); });
 * so no mutable state is shared across files; helpers below take the root as a parameter.
 */
export async function createTaskServiceTestRoot(): Promise<string> {
  return await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
}

export async function removeTaskServiceTestRoot(rootDir: string): Promise<void> {
  await fsPromises.rm(rootDir, { recursive: true, force: true });
}

export async function collectFullHistory(service: HistoryService, workspaceId: string) {
  const messages: MuxMessage[] = [];
  const result = await service.iterateFullHistory(workspaceId, "forward", (chunk) => {
    messages.push(...chunk);
  });
  assert(result.success, `collectFullHistory failed: ${result.success ? "" : result.error}`);
  return messages;
}

/**
 * Where a seeded live workspace-turn registration comes from in production:
 * - "recovered": the startup restart path. The handle record goes through the real store and
 *   reconcileAgentTaskExecutionIds() registers it (fail-closed, unaccepted) together with the
 *   task's execution mirror; the helper asserts that the restart path really did.
 * - "reserved" / "accepted": createWorkspaceTurn's registration before / after the owner's send
 *   passed turn admission. That path generates the handle and turn IDs and sends through the
 *   host, which these admission tests assert against, so these seeds (a documented residual)
 *   write the owner's registration map directly after the same real-store record write.
 */
export type LiveWorkspaceTurnSource = "recovered" | "reserved" | "accepted";

export async function registerLiveWorkspaceTurnHandle(
  taskService: TaskService,
  workspaceId: string,
  handleId: string,
  ownerWorkspaceId = "tree-root",
  source: LiveWorkspaceTurnSource = "accepted",
  recordOverrides: Partial<WorkspaceTurnTaskHandleRecord> = {}
): Promise<void> {
  const manager = workspaceTurnManagerFor(taskService);
  const internals = workspaceTurnManagerInternals(taskService);
  await internals.taskHandleStore.upsertWorkspaceTurn(
    workspaceTurnRecord(ownerWorkspaceId, workspaceId, handleId, "running", {
      turnId: `${handleId}-turn`,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      ...recordOverrides,
    })
  );
  if (source === "recovered") {
    await manager.reconcileAgentTaskExecutionIds();
    assert(
      manager.getLiveWorkspaceTurnRegistration(workspaceId)?.handleId === handleId,
      `reconcileAgentTaskExecutionIds did not register ${handleId} for ${workspaceId}`
    );
    return;
  }
  internals.activeWorkspaceTurnHandleByWorkspaceId.set(workspaceId, {
    handleId,
    ownerWorkspaceId,
    accepted: source === "accepted",
  });
}

export async function createAgentTask(
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

export function createTaskServiceHarness(
  config: Config,
  overrides?: {
    historyService?: HistoryService;
    aiService?: AIService;
    workspaceService?: WorkspaceHost;
    initStateManager?: InitStateManager;
    sessionUsageService?: SessionUsageService;
    workspaceGoalService?: WorkspaceGoalService;
    desktopInputCoordinator?: DesktopInputCoordinator;
  }
) {
  const stack = createTaskServiceStack(config, overrides);
  return { ...stack, partialService: stack.historyService };
}

export function reserveFamilyMessageTargetSlots(
  taskService: TaskService,
  targetId: string,
  count: number
): void {
  const broker = (taskService as unknown as { agentPeerMessageBroker: AgentPeerMessageBroker })
    .agentPeerMessageBroker;
  for (let i = 0; i < count; i++) {
    expect(broker.reserveBudget(`prefill-${i}`, targetId, 1)).not.toBeNull();
  }
}

export async function waitForWorkspaceTaskStatus(
  config: Config,
  workspaceId: string,
  expectedStatus: WorkspaceConfigEntry["taskStatus"],
  timeoutMs = 20_000
): Promise<void> {
  const start = Date.now();
  while (findWorkspaceInConfig(config, workspaceId)?.taskStatus !== expectedStatus) {
    if (Date.now() - start > timeoutMs) {
      const actualStatus = findWorkspaceInConfig(config, workspaceId)?.taskStatus;
      throw new Error(
        `Timed out waiting for workspace task status (workspaceId=${workspaceId}, expected=${String(expectedStatus)}, actual=${String(actualStatus)})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function createNullInitLogger() {
  return {
    logStep: (_message: string) => undefined,
    logStdout: (_line: string) => undefined,
    logStderr: (_line: string) => undefined,
    logComplete: (_exitCode: number) => undefined,
    enterHookPhase: () => undefined,
  };
}

export async function startWorkspaceTurnForTest(
  rootDir: string,
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
    waitForPendingCompactionCompletionDecision?: ReturnType<typeof mock>;
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

export interface BestOfTestChildWorkspace {
  id: string;
  name: string;
  taskStatus: NonNullable<WorkspaceMetadata["taskStatus"]>;
  bestOf: NonNullable<WorkspaceMetadata["bestOf"]>;
  title?: string;
  createdAt?: string;
  pathName?: string;
  agentType?: string;
  agentId?: string;
}

export async function createBestOfTaskServiceTestHarness(params: {
  rootDir: string;
  parentId: string;
  children: readonly BestOfTestChildWorkspace[];
}) {
  const config = await createTestConfig(params.rootDir);
  const projectPath = path.join(params.rootDir, "repo");

  await saveWorkspaces(
    config,
    projectPath,
    [
      projectWorkspace(projectPath, "parent", params.parentId),
      ...params.children.map((child) => ({
        path: path.join(projectPath, child.pathName ?? child.id),
        id: child.id,
        name: child.name,
        ...(child.title ? { title: child.title } : {}),
        parentWorkspaceId: params.parentId,
        agentType: child.agentType ?? "explore",
        ...(child.agentId ? { agentId: child.agentId } : {}),
        taskStatus: child.taskStatus,
        ...(child.createdAt ? { createdAt: child.createdAt } : {}),
        bestOf: child.bestOf,
      })),
    ],
    testTaskSettings()
  );

  const { aiService } = createAIServiceMocks(config);
  const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
    await removeWorkspaceFromTestConfig(config, workspaceId);
    return Ok(undefined);
  });
  const { workspaceService } = createWorkspaceServiceMocks({ remove });

  return {
    config,
    remove,
    ...createTaskServiceHarness(config, { aiService, workspaceService }),
  };
}

export async function writePendingBestOfParentPartial(params: {
  partialService: ReturnType<typeof createTaskServiceHarness>["partialService"];
  parentId: string;
  messageId: string;
  toolCallId: string;
  title: string;
  n?: number;
  legacyVariants?: string[];
  timestamp: number;
  prompt?: string;
  additionalParts?: MuxMessage["parts"];
}): Promise<void> {
  const parentPartial = createMuxMessage(
    params.messageId,
    "assistant",
    "Waiting on best-of subagents…",
    { timestamp: params.timestamp },
    [
      {
        type: "dynamic-tool",
        toolCallId: params.toolCallId,
        toolName: "task",
        input: {
          subagent_type: "explore",
          prompt: params.prompt ?? "compare options",
          title: params.title,
          ...(params.n != null ? { n: params.n } : {}),
          ...(params.legacyVariants ? { variants: params.legacyVariants } : {}),
        },
        state: "input-available",
      },
      ...(params.additionalParts ?? []),
    ]
  );
  expect((await params.partialService.writePartial(params.parentId, parentPartial)).success).toBe(
    true
  );
}

export function getTaskToolPart(
  message: MuxMessage | null
): (DynamicToolPart & { state: string; output?: unknown }) | undefined {
  return message?.parts.find((part) => isDynamicToolPart(part) && part.toolName === "task") as
    | (DynamicToolPart & { state: string; output?: unknown })
    | undefined;
}

export async function flushTerminalAttentionDrains(taskService: TaskService): Promise<void> {
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

export async function upsertTestSubagentReports(params: {
  config: Config;
  parentId: string;
  reports: ReadonlyArray<{
    childTaskId: string;
    reportMarkdown: string;
    title: string;
  }>;
}): Promise<void> {
  const parentSessionDir = path.join(params.config.sessionsDir, params.parentId);
  for (const report of params.reports) {
    await upsertSubagentReportArtifact({
      workspaceId: params.parentId,
      workspaceSessionDir: parentSessionDir,
      childTaskId: report.childTaskId,
      parentWorkspaceId: params.parentId,
      ancestorWorkspaceIds: [params.parentId],
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      nowMs: Date.now(),
    });
  }
}

/**
 * A remove() stand-in that mirrors the real one: the under-lock `beforeRemove` precondition
 * decides whether the workspace actually leaves the config.
 */
export function createConfigBackedRemoveMock(config: Config) {
  return mock(
    async (
      workspaceId: string,
      _force?: boolean,
      options?: { beforeRemove?: () => Promise<boolean> }
    ): Promise<Result<void>> => {
      if (options?.beforeRemove != null && !(await options.beforeRemove())) {
        return Ok(undefined);
      }
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    }
  );
}

export async function removeWorkspaceFromTestConfig(
  config: Config,
  workspaceId: string
): Promise<void> {
  const cfg = config.loadConfigOrDefault();
  let removed = false;

  for (const project of cfg.projects.values()) {
    const nextWorkspaces = project.workspaces.filter((workspace) => workspace.id !== workspaceId);
    if (nextWorkspaces.length === project.workspaces.length) {
      continue;
    }

    project.workspaces = nextWorkspaces;
    removed = true;
  }

  assert(removed, `Expected workspace ${workspaceId} to exist in test config`);
  await config.editConfig(() => cfg);
}
