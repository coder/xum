import * as path from "path";
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, Err, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  saveLocalParentWorkspace,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
  upsertTestSubagentReports,
} from "@/node/services/taskService.shared.testHarness";

// Characterization tests for TaskService.drainTerminalAttention paths that no other suite
// reaches: the busy fallback send and its callbacks, an owner deleted with pending wakes, and
// the prompt-free sub-agent resume when it fails or does not start.

const BUSY_IDLE_ONLY: SendMessageError = {
  type: "unknown",
  raw: "Workspace is busy; idle-only send was skipped.",
};

interface SendInternal {
  requireIdle?: boolean;
  onAccepted?: () => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
}

type SendMock = ReturnType<
  typeof mock<(...args: unknown[]) => Promise<Result<void, SendMessageError>>>
>;

/** The idle-only send loses the busy race; the fallback (no requireIdle) runs `fallback`. */
function busyThenFallback(
  fallback: (internal: SendInternal) => Promise<Result<void, SendMessageError>>
): SendMock {
  return mock((...args: unknown[]) => {
    const internal = (args[3] ?? {}) as SendInternal;
    return internal.requireIdle === true
      ? Promise.resolve(Err(BUSY_IDLE_ONLY))
      : fallback(internal);
  });
}

describe("TaskService.drainTerminalAttention", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setup(workspaceOverrides: Parameters<typeof createWorkspaceServiceMocks>[0] = {}) {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    // The owner is idle at once: an after-idle reschedule shows as this call plus a new drain.
    const waitForIdleAndNoQueuedMessages = mock(() => Promise.resolve());
    const mocks = createWorkspaceServiceMocks({
      waitForIdleAndNoQueuedMessages,
      ...workspaceOverrides,
    });
    (
      mocks.workspaceService as unknown as Record<string, unknown>
    ).getWorkflowInvocationCurrentness = mock(() => Promise.resolve("current"));
    const harness = createTaskServiceHarness(config, { workspaceService: mocks.workspaceService });
    const store = new TerminalAttentionStore(config);
    return { config, parentId, store, waitForIdleAndNoQueuedMessages, ...mocks, ...harness };
  }

  /** A pending workspace-turn wake whose handle record is gone: deliverable, never suppressed. */
  async function enqueueWorkspaceTurnWake(store: TerminalAttentionStore, ownerId: string) {
    await store.enqueueIfAbsent({
      ownerWorkspaceId: ownerId,
      sourceKind: "workspace_turn",
      sourceId: "wst_fallback",
    });
    return "workspace_turn:wst_fallback";
  }

  /** A pending sub-agent report wake: its report is durable history, so the drain resumes. */
  async function enqueueAgentReportWake(config: Config, ownerId: string) {
    const childTaskId = "child-report";
    await upsertTestSubagentReports({
      config,
      parentId: ownerId,
      reports: [{ childTaskId, reportMarkdown: "child done", title: "Result" }],
    });
    await new TerminalAttentionStore(config).enqueueIfAbsent({
      ownerWorkspaceId: ownerId,
      sourceKind: "agent_task",
      sourceId: childTaskId,
    });
    return `agent_task:${childTaskId}`;
  }

  test("busy fallback delivers the wake once the fallback send is accepted", async () => {
    const sendMessage = busyThenFallback(async (internal) => {
      await internal.onAccepted?.();
      return Ok(undefined);
    });
    const { parentId, store, taskService } = await setup({ sendMessage });
    const id = await enqueueWorkspaceTurnWake(store, parentId);

    taskService.scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect((sendMessage.mock.calls[1]?.[3] as SendInternal).requireIdle).toBeUndefined();
    expect(String(sendMessage.mock.calls[1]?.[1])).toContain("wst_fallback");
    expect((await store.get(parentId, id))?.status).toBe("delivered");
  });

  test("busy fallback revalidates a current workflow wake and delivers it", async () => {
    const runId = "wfr_fallback_current";
    const sendMessage = busyThenFallback(async (internal) => {
      await internal.onAccepted?.();
      return Ok(undefined);
    });
    const { config, parentId, taskService, historyService } = await setup({ sendMessage });
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: { name: "research", description: "Research", scope: "built-in", executable: true },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    // The fallback rereads the still-current candidate and sends it; nothing re-pokes it.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(String(sendMessage.mock.calls[1]?.[1])).toContain(runId);
    expect((sendMessage.mock.calls[1]?.[3] as SendInternal).requireIdle).toBeUndefined();
  });

  test("a canceled busy fallback retries after idle and delivers", async () => {
    let calls = 0;
    const sendMessage: SendMock = mock(async (...args: unknown[]) => {
      calls += 1;
      const internal = (args[3] ?? {}) as SendInternal;
      if (calls === 1) return Err(BUSY_IDLE_ONLY);
      // The fallback is queued, then its queue entry is canceled before acceptance.
      if (calls === 2) await internal.onCanceled?.("queue cleared");
      return Ok(undefined);
    });
    const { parentId, store, taskService, waitForIdleAndNoQueuedMessages } = await setup({
      sendMessage,
    });
    const id = await enqueueWorkspaceTurnWake(store, parentId);

    taskService.scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);

    // The canceled fallback returns without marking; the after-idle drain's send delivers it.
    expect(waitForIdleAndNoQueuedMessages).toHaveBeenCalledWith(parentId);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect((sendMessage.mock.calls[2]?.[3] as SendInternal).requireIdle).toBe(true);
    expect((await store.get(parentId, id))?.status).toBe("delivered");
  });

  test("busy fallback pre-stream failure returns the delivered wake to pending", async () => {
    let statusAfterAccept: string | undefined;
    let readStatus: () => Promise<string | undefined> = () => Promise.resolve(undefined);
    const sendMessage = busyThenFallback(async (internal) => {
      await internal.onAccepted?.();
      statusAfterAccept = await readStatus();
      const error: SendMessageError = { type: "unknown", raw: "stream startup failed" };
      await internal.onAcceptedPreStreamFailure?.(error);
      return Err(error);
    });
    const { parentId, store, taskService, waitForIdleAndNoQueuedMessages } = await setup({
      sendMessage,
    });
    const id = await enqueueWorkspaceTurnWake(store, parentId);
    readStatus = async () => (await store.get(parentId, id))?.status;

    taskService.scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);

    // Accepted (delivered), then the startup failure re-pends it for the after-idle retry; the
    // non-busy rejection backs the batch off, so the re-poked drain sends nothing.
    expect(statusAfterAccept).toBe("delivered");
    expect((await store.get(parentId, id))?.status).toBe("pending");
    expect(waitForIdleAndNoQueuedMessages).toHaveBeenCalledWith(parentId);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  test("a deleted owner supersedes every pending wake without sending", async () => {
    const { store, taskService, sendMessage, resumeStream } = await setup();
    const goneOwnerId = "owner-gone";
    const id = await enqueueWorkspaceTurnWake(store, goneOwnerId);

    taskService.scheduleTerminalAttentionDrain(goneOwnerId);
    await flushTerminalAttentionDrains(taskService);

    expect((await store.get(goneOwnerId, id))?.status).toBe("superseded");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
  });

  test("a failed prompt-free resume backs off so an agent-bound workflow group sends", async () => {
    const runId = "wfr_agent_bound";
    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }>> => Promise.resolve(Err("model gate"))
    );
    const { config, parentId, store, taskService, historyService, sendMessage } = await setup({
      resumeStream,
    });
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: runId,
      workspaceId: parentId,
      workflow: { name: "research", description: "Research", scope: "built-in", executable: true },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(runId, "running", "2026-06-19T00:00:01.000Z");
    await runStore.appendStatus(runId, "completed", "2026-06-19T00:00:03.000Z");
    await historyService.appendToHistory(
      parentId,
      createMuxMessage("manual", "user", "run the audit", { timestamp: 1_000 })
    );
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      runId,
      agentId: "plan",
    });
    const id = await enqueueAgentReportWake(config, parentId);

    taskService.noteWorkflowRunTerminalAttention({
      ownerWorkspaceId: parentId,
      runId,
      status: "completed",
    });
    await flushTerminalAttentionDrains(taskService);

    // The report batch excluded the agent-bound group; its failed resume backs off and
    // re-pokes, so the group sends under its own agent while the report stays pending.
    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({ agentId: "plan" });
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(runId);
    expect((await store.get(parentId, id))?.status).toBe("pending");
  });

  test("a prompt-free resume that does not start retries after idle", async () => {
    const resumeStream = mock(
      (): Promise<Result<{ started: boolean }>> => Promise.resolve(Ok({ started: true }))
    );
    resumeStream.mockImplementationOnce(() => Promise.resolve(Ok({ started: false })));
    const { config, parentId, store, taskService, sendMessage, waitForIdleAndNoQueuedMessages } =
      await setup({ resumeStream });
    const id = await enqueueAgentReportWake(config, parentId);

    taskService.scheduleTerminalAttentionDrain(parentId);
    await flushTerminalAttentionDrains(taskService);

    // The unstarted resume leaves the report pending; the after-idle drain resumes again.
    expect(waitForIdleAndNoQueuedMessages).toHaveBeenCalledWith(parentId);
    expect(resumeStream).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await store.get(parentId, id))?.status).toBe("delivered");
  });
});
