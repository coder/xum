/**
 * UI integration tests for live best-of task progress in the parent workspace.
 *
 * These scenarios run with mock AI enabled but seed the task tool call + child metadata
 * directly so the test can focus on how the full app renders parent best-of progress.
 *
 * Repro coverage:
 * - Parent best-of task cards should recover already-created child candidates from workspace metadata
 *   even when the parent did not observe task-created events live.
 * - The parent best-of progress counter should update as child workspaces report completion.
 */

import "../dom";

import { waitFor } from "@testing-library/react";

import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";

import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";

const BEST_OF_GROUP_ID = "best-of-ui-progress-group";
const TOOL_CALL_ID = "tool-task-best-of-progress";

async function waitForWorkspaceChatToRender(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const messageWindow = container.querySelector('[data-testid="message-window"]');
      if (!messageWindow) {
        throw new Error("Workspace chat view not rendered yet");
      }
    },
    { timeout: 30_000 }
  );
}

async function seedBestOfParentHistory(
  historyService: HistoryService,
  workspaceId: string
): Promise<void> {
  const userMessage = createMuxMessage("user-best-of", "user", "Compare the best options");
  const taskToolMessage = createMuxMessage(
    "assistant-best-of",
    "assistant",
    "",
    { timestamp: Date.now() },
    [
      {
        type: "dynamic-tool" as const,
        toolCallId: TOOL_CALL_ID,
        toolName: "task" as const,
        state: "input-available" as const,
        input: {
          agentId: "explore" as const,
          prompt: "Compare the best options",
          title: "Best of options",
          n: 2,
        },
      },
    ]
  );

  for (const message of [userMessage, taskToolMessage]) {
    const appendResult = await historyService.appendToHistory(workspaceId, message);
    if (!appendResult.success) {
      throw new Error(`Failed to append best-of history: ${appendResult.error}`);
    }
  }
}

async function updateChildMetadata(params: {
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
  repoPath: string;
  metadata: FrontendWorkspaceMetadata;
  parentWorkspaceId: string;
  index: number;
  taskStatus: "queued" | "running" | "awaiting_report" | "interrupted" | "reported";
}): Promise<void> {
  await params.env.config.addWorkspace(params.repoPath, {
    ...params.metadata,
    parentWorkspaceId: params.parentWorkspaceId,
    agentId: "explore",
    agentType: "explore",
    bestOf: {
      groupId: BEST_OF_GROUP_ID,
      index: params.index,
      total: 2,
    },
    taskStatus: params.taskStatus,
    reportedAt: params.taskStatus === "reported" ? new Date().toISOString() : undefined,
  });
}

async function createBestOfChildWorkspace(params: {
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
  repoPath: string;
  trunkBranch: string;
  parentWorkspaceId: string;
  title: string;
  branchPrefix: string;
  index: number;
  taskStatus: "queued" | "running" | "awaiting_report" | "interrupted" | "reported";
}): Promise<FrontendWorkspaceMetadata> {
  const result = await params.env.orpc.workspace.create({
    projectPath: params.repoPath,
    branchName: generateBranchName(params.branchPrefix),
    trunkBranch: params.trunkBranch,
    title: params.title,
  });
  if (!result.success) {
    throw new Error(`Failed to create child workspace (${params.title}): ${result.error}`);
  }

  await updateChildMetadata({
    env: params.env,
    repoPath: params.repoPath,
    metadata: result.metadata,
    parentWorkspaceId: params.parentWorkspaceId,
    index: params.index,
    taskStatus: params.taskStatus,
  });

  return {
    ...result.metadata,
    parentWorkspaceId: params.parentWorkspaceId,
    agentId: "explore",
    agentType: "explore",
    bestOf: {
      groupId: BEST_OF_GROUP_ID,
      index: params.index,
      total: 2,
    },
    taskStatus: params.taskStatus,
    reportedAt: params.taskStatus === "reported" ? new Date().toISOString() : undefined,
  };
}

function emitTaskCreated(params: {
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
  parentWorkspaceId: string;
  taskId: string;
}): void {
  params.env.services.aiService.emit("task-created", {
    type: "task-created",
    workspaceId: params.parentWorkspaceId,
    toolCallId: TOOL_CALL_ID,
    taskId: params.taskId,
    timestamp: Date.now(),
  });
}

async function renderBestOfParentWorkspace(): Promise<{
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
  repoPath: string;
  parentMetadata: FrontendWorkspaceMetadata;
  childOne: FrontendWorkspaceMetadata;
  childTwo: FrontendWorkspaceMetadata;
  cleanupDom: () => void;
  view: RenderedApp;
}> {
  const env = await createTestEnvironment();
  env.services.aiService.enableMockMode();

  const repoPath = await createTempGitRepo();
  await trustProject(env, repoPath);
  const trunkBranch = await detectDefaultTrunkBranch(repoPath);

  const parentResult = await env.orpc.workspace.create({
    projectPath: repoPath,
    branchName: generateBranchName("ui-best-of-parent"),
    trunkBranch,
    title: "Parent workspace",
  });
  if (!parentResult.success) {
    throw new Error(`Failed to create parent workspace: ${parentResult.error}`);
  }

  const historyService = new HistoryService(env.config);
  await seedBestOfParentHistory(historyService, parentResult.metadata.id);

  const childOne = await createBestOfChildWorkspace({
    env,
    repoPath,
    trunkBranch,
    parentWorkspaceId: parentResult.metadata.id,
    title: "Best of options",
    branchPrefix: "ui-best-of-child-1",
    index: 0,
    taskStatus: "running",
  });
  const childTwo = await createBestOfChildWorkspace({
    env,
    repoPath,
    trunkBranch,
    parentWorkspaceId: parentResult.metadata.id,
    title: "Best of options",
    branchPrefix: "ui-best-of-child-2",
    index: 1,
    taskStatus: "running",
  });

  const cleanupDom = installDom();
  const view = renderApp({ apiClient: env.orpc, metadata: parentResult.metadata });
  await setupWorkspaceView(view, parentResult.metadata, parentResult.metadata.id);
  await waitForWorkspaceChatToRender(view.container);

  return {
    env,
    repoPath,
    parentMetadata: parentResult.metadata,
    childOne,
    childTwo,
    cleanupDom,
    view,
  };
}

async function openTaskCard(view: RenderedApp): Promise<HTMLElement> {
  await waitFor(
    () => {
      const toolNames = view.queryAllByText(/^task$/);
      if (toolNames.length === 0) {
        throw new Error("Task tool call not rendered yet");
      }
    },
    { timeout: 10_000 }
  );

  const taskToolName = view
    .getAllByText(/^task$/)
    .find((element) => element.closest('[data-testid="chat-message"]'));
  if (!taskToolName) {
    throw new Error("Task tool call not found in a chat message");
  }

  const taskMessageBlock = taskToolName.closest(
    '[data-testid="chat-message"]'
  );
  if (!taskMessageBlock) {
    throw new Error("Task chat message block not found");
  }

  taskToolName.click();
  await waitFor(() => {
    const text = taskMessageBlock.textContent ?? "";
    if (!text.includes("Best of options") || !text.includes("Prompt")) {
      throw new Error("Expanded best-of task details not visible yet");
    }
  });

  return taskMessageBlock;
}

async function renderCompletedBestOfParentWorkspace(params: {
  requestedCount: number;
  completedReports: { taskId: string; title: string; reportMarkdown: string }[];
}): Promise<{
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
  repoPath: string;
  cleanupDom: () => void;
  view: RenderedApp;
}> {
  const env = await createTestEnvironment();
  env.services.aiService.enableMockMode();

  const repoPath = await createTempGitRepo();
  await trustProject(env, repoPath);
  const trunkBranch = await detectDefaultTrunkBranch(repoPath);

  const parentResult = await env.orpc.workspace.create({
    projectPath: repoPath,
    branchName: generateBranchName("ui-best-of-completed-parent"),
    trunkBranch,
    title: "Parent workspace",
  });
  if (!parentResult.success) {
    throw new Error(`Failed to create completed parent workspace: ${parentResult.error}`);
  }

  const historyService = new HistoryService(env.config);
  const userMessage = createMuxMessage(
    "user-best-of-completed",
    "user",
    "Compare the best options"
  );
  const taskToolMessage = createMuxMessage(
    "assistant-best-of-completed",
    "assistant",
    "",
    { timestamp: Date.now() },
    [
      {
        type: "dynamic-tool" as const,
        toolCallId: "tool-task-best-of-completed",
        toolName: "task" as const,
        state: "output-available" as const,
        input: {
          agentId: "explore" as const,
          prompt: "Compare the best options",
          title: "Best of options",
          n: params.requestedCount,
        },
        output: {
          status: "completed" as const,
          taskIds: params.completedReports.map((report) => report.taskId),
          reports: params.completedReports.map((report) => ({
            taskId: report.taskId,
            title: report.title,
            reportMarkdown: report.reportMarkdown,
            agentId: "explore",
            agentType: "explore",
          })),
        },
      },
    ]
  );

  for (const message of [userMessage, taskToolMessage]) {
    const appendResult = await historyService.appendToHistory(parentResult.metadata.id, message);
    if (!appendResult.success) {
      throw new Error(`Failed to append completed best-of history: ${appendResult.error}`);
    }
  }

  const cleanupDom = installDom();
  const view = renderApp({ apiClient: env.orpc, metadata: parentResult.metadata });
  await setupWorkspaceView(view, parentResult.metadata, parentResult.metadata.id);
  await waitForWorkspaceChatToRender(view.container);

  return {
    env,
    repoPath,
    cleanupDom,
    view,
  };
}

async function renderPartiallySpawnedBestOfParentWorkspace(params: {
  requestedCount: number;
  spawnedTaskIds: string[];
}): Promise<{
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
  repoPath: string;
  cleanupDom: () => void;
  view: RenderedApp;
}> {
  const env = await createTestEnvironment();
  env.services.aiService.enableMockMode();

  const repoPath = await createTempGitRepo();
  await trustProject(env, repoPath);
  const trunkBranch = await detectDefaultTrunkBranch(repoPath);

  const parentResult = await env.orpc.workspace.create({
    projectPath: repoPath,
    branchName: generateBranchName("ui-best-of-partial-parent"),
    trunkBranch,
    title: "Parent workspace",
  });
  if (!parentResult.success) {
    throw new Error(`Failed to create partial parent workspace: ${parentResult.error}`);
  }

  const historyService = new HistoryService(env.config);
  const userMessage = createMuxMessage("user-best-of-partial", "user", "Compare the best options");
  const taskToolMessage = createMuxMessage(
    "assistant-best-of-partial",
    "assistant",
    "",
    { timestamp: Date.now() },
    [
      {
        type: "dynamic-tool" as const,
        toolCallId: "tool-task-best-of-partial",
        toolName: "task" as const,
        state: "output-available" as const,
        input: {
          agentId: "explore" as const,
          prompt: "Compare the best options",
          title: "Best of options",
          n: params.requestedCount,
        },
        output: {
          status: "running" as const,
          taskIds: params.spawnedTaskIds,
          tasks: params.spawnedTaskIds.map((taskId) => ({ taskId, status: "completed" as const })),
          reports: params.spawnedTaskIds.map((taskId, index) => ({
            taskId,
            title: `Candidate ${index + 1}`,
            reportMarkdown: `Report from ${taskId}`,
            agentId: "explore",
            agentType: "explore",
          })),
          note: "Some candidates were never spawned.",
        },
      },
    ]
  );

  for (const message of [userMessage, taskToolMessage]) {
    const appendResult = await historyService.appendToHistory(parentResult.metadata.id, message);
    if (!appendResult.success) {
      throw new Error(`Failed to append partial best-of history: ${appendResult.error}`);
    }
  }

  const cleanupDom = installDom();
  const view = renderApp({ apiClient: env.orpc, metadata: parentResult.metadata });
  await setupWorkspaceView(view, parentResult.metadata, parentResult.metadata.id);
  await waitForWorkspaceChatToRender(view.container);

  return {
    env,
    repoPath,
    cleanupDom,
    view,
  };
}

describe("Best-of parent task progress UI (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("recovers created best-of candidates from matching workspace metadata", async () => {
    const setup = await renderBestOfParentWorkspace();

    try {
      const taskMessageBlock = await openTaskCard(setup.view);

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("0/2 completed");
      });
      expect(taskMessageBlock.textContent).not.toContain("Creating candidates");
      expect(taskMessageBlock.textContent).toContain(setup.childOne.id);
      expect(taskMessageBlock.textContent).toContain(setup.childTwo.id);
    } finally {
      await cleanupView(setup.view, setup.cleanupDom);
      await cleanupTestEnvironment(setup.env);
      await cleanupTempGitRepo(setup.repoPath);
    }
  }, 60_000);

  test("updates the completed count as created child workspaces report", async () => {
    const setup = await renderBestOfParentWorkspace();

    try {
      const taskMessageBlock = await openTaskCard(setup.view);

      emitTaskCreated({
        env: setup.env,
        parentWorkspaceId: setup.parentMetadata.id,
        taskId: setup.childOne.id,
      });
      emitTaskCreated({
        env: setup.env,
        parentWorkspaceId: setup.parentMetadata.id,
        taskId: setup.childTwo.id,
      });

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("0/2 completed");
      });

      await updateChildMetadata({
        env: setup.env,
        repoPath: setup.repoPath,
        metadata: setup.childOne,
        parentWorkspaceId: setup.parentMetadata.id,
        index: 0,
        taskStatus: "reported",
      });
      await setup.env.services.workspaceService.refreshAndEmitMetadata(setup.childOne.id);

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("1/2 completed");
      });
      expect(taskMessageBlock.textContent).toContain("View transcript");

      await updateChildMetadata({
        env: setup.env,
        repoPath: setup.repoPath,
        metadata: setup.childTwo,
        parentWorkspaceId: setup.parentMetadata.id,
        index: 1,
        taskStatus: "reported",
      });
      await setup.env.services.workspaceService.refreshAndEmitMetadata(setup.childTwo.id);

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("2/2 completed");
      });
    } finally {
      await cleanupView(setup.view, setup.cleanupDom);
      await cleanupTestEnvironment(setup.env);
      await cleanupTempGitRepo(setup.repoPath);
    }
  }, 60_000);

  test("does not rebind historical best-of cards to a later matching group", async () => {
    const env = await createTestEnvironment();
    env.services.aiService.enableMockMode();

    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);

    const parentResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName: generateBranchName("ui-best-of-historical-parent"),
      trunkBranch,
      title: "Parent workspace",
    });
    if (!parentResult.success) {
      throw new Error(`Failed to create parent workspace: ${parentResult.error}`);
    }

    const historyService = new HistoryService(env.config);
    const userMessage = createMuxMessage(
      "user-best-of-historical",
      "user",
      "Compare the best options"
    );
    const taskToolMessage = createMuxMessage(
      "assistant-best-of-historical",
      "assistant",
      "",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool" as const,
          toolCallId: "tool-task-best-of-historical",
          toolName: "task" as const,
          state: "output-available" as const,
          input: {
            agentId: "explore" as const,
            prompt: "Compare the best options",
            title: "Best of options",
            n: 2,
          },
          output: {
            status: "running" as const,
            taskIds: ["historical-child-1", "historical-child-2"],
            tasks: [
              { taskId: "historical-child-1", status: "running" as const },
              { taskId: "historical-child-2", status: "running" as const },
            ],
            note: "Waiting on historical candidates.",
          },
        },
      ]
    );

    for (const message of [userMessage, taskToolMessage]) {
      const appendResult = await historyService.appendToHistory(parentResult.metadata.id, message);
      if (!appendResult.success) {
        throw new Error(`Failed to append historical best-of history: ${appendResult.error}`);
      }
    }

    const cleanupDom = installDom();
    const view = renderApp({ apiClient: env.orpc, metadata: parentResult.metadata });
    await setupWorkspaceView(view, parentResult.metadata, parentResult.metadata.id);
    await waitForWorkspaceChatToRender(view.container);

    try {
      await createBestOfChildWorkspace({
        env,
        repoPath,
        trunkBranch,
        parentWorkspaceId: parentResult.metadata.id,
        title: "Best of options",
        branchPrefix: "ui-best-of-historical-child-1",
        index: 0,
        taskStatus: "running",
      });
      await createBestOfChildWorkspace({
        env,
        repoPath,
        trunkBranch,
        parentWorkspaceId: parentResult.metadata.id,
        title: "Best of options",
        branchPrefix: "ui-best-of-historical-child-2",
        index: 1,
        taskStatus: "running",
      });

      const taskMessageBlock = await openTaskCard(view);

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("Best of 2 · Best of options");
      });
      expect(taskMessageBlock.textContent).toContain("historical-child-1");
      expect(taskMessageBlock.textContent).toContain("historical-child-2");
      expect(taskMessageBlock.textContent).not.toContain("ui-best-of-historical-child-1");
      expect(taskMessageBlock.textContent).not.toContain("ui-best-of-historical-child-2");
    } finally {
      await cleanupView(view, cleanupDom);
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 60_000);

  test("uses the realized spawned candidate count after best-of creation stops early", async () => {
    const setup = await renderPartiallySpawnedBestOfParentWorkspace({
      requestedCount: 3,
      spawnedTaskIds: ["spawned-child-1", "spawned-child-2"],
    });

    try {
      const taskMessageBlock = await openTaskCard(setup.view);

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("2/2 completed");
      });
      expect(taskMessageBlock.textContent).not.toContain("2/3 completed");
      expect(taskMessageBlock.textContent).toContain("Best of 2 · Best of options");
    } finally {
      await cleanupView(setup.view, setup.cleanupDom);
      await cleanupTestEnvironment(setup.env);
      await cleanupTempGitRepo(setup.repoPath);
    }
  }, 60_000);

  test("uses the realized completed candidate count when best-of creation finished partially", async () => {
    const setup = await renderCompletedBestOfParentWorkspace({
      requestedCount: 3,
      completedReports: [
        {
          taskId: "completed-child-1",
          title: "Candidate one",
          reportMarkdown: "Report from child one",
        },
        {
          taskId: "completed-child-2",
          title: "Candidate two",
          reportMarkdown: "Report from child two",
        },
      ],
    });

    try {
      const taskMessageBlock = await openTaskCard(setup.view);

      await waitFor(() => {
        expect(taskMessageBlock.textContent).toContain("2/2 completed");
      });
      expect(taskMessageBlock.textContent).not.toContain("2/3 completed");
      expect(taskMessageBlock.textContent).toContain("Best of 2 · Best of options");
    } finally {
      await cleanupView(setup.view, setup.cleanupDom);
      await cleanupTestEnvironment(setup.env);
      await cleanupTempGitRepo(setup.repoPath);
    }
  }, 60_000);
});
