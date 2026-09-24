import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { SecretsStore } from "@/node/config";
import { Ok, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { TaskService } from "@/node/services/taskService";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type {
  QueueCutReceipt,
  QueueCutSuccessorState,
  SendMessageInternalOptions,
} from "@/node/services/taskWorkspaceSeam";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";

/**
 * Stale-attempt effects with two backends sharing one Xum root (#4414). Each test runs a
 * predecessor A (this backend) → successor B (a second backend rotating the persisted row through
 * its own Config) → A's delayed effect, and asserts that B's row, history and session stay
 * untouched. The "untouched" control proves the harness reaches the effect at all.
 *
 * These fences are only as strong as cross-process config exclusion (#4415).
 *
 * The fake host's sendMessage performs exactly the admission a real WorkspaceService.sendMessage
 * performs for a send that carries no token (admitTaskTurn() → TaskService.admitTaskWorkspaceTurn
 * with no expectedAttemptId), and records which attempt the send was bound to.
 */
const rootId = "root-stale";
const A = "att_00000000000000a1";
const B = "att_00000000000000b1";

interface Internals {
  admittedSendsByTaskId: Map<string, Set<{ attemptId: string; state: string }>>;
  handleStreamEnd: (event: StreamEndEvent) => Promise<void>;
  workspaceEventLocks: MutexMap<string>;
}
const internals = (service: TaskService) => service as unknown as Internals;

describe("stale attempt effects after another backend admits a successor (#4414)", () => {
  let rootDir: string;
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
    rootDir = fixture.tempDir;
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  async function setupChild(id: string, overrides: Partial<WorkspaceConfigEntry>) {
    const config = fixture.config;
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        projectWorkspace(projectPath, id, id, {
          parentWorkspaceId: rootId,
          agentType: "explore",
          agentId: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          runtimeConfig: { type: "local" },
          taskAttemptId: A,
          ...overrides,
        }),
      ],
      testTaskSettings(4, 3)
    );
    return config;
  }

  /** Backend B's admission of the same row (rotation A → B), written through its own Config. */
  async function rotateOnOtherBackend(taskId: string, status: WorkspaceConfigEntry["taskStatus"]) {
    const otherBackend = await createTestConfig(rootDir);
    await otherBackend.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const ws = project.workspaces.find((w) => w.id === taskId);
        if (ws) {
          ws.taskStatus = status;
          ws.taskAttemptId = B;
          ws.taskAttemptUnproven = true;
        }
      }
      return cfg;
    });
  }

  function createHarness(
    config: Config,
    hostOverrides: NonNullable<Parameters<typeof createWorkspaceServiceMocks>[0]> = {},
    /** Runs when the fake host receives a send, before its admission gates (delayed dequeue). */
    beforeSend?: () => Promise<void>
  ) {
    const ledger: { taskService?: TaskService } = {};
    /** Per send: the attempt the generic admission bound it to, or why it was not bound. */
    const bound: string[] = [];
    const sendMessage = mock(
      async (
        workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: SendMessageInternalOptions
      ): Promise<Result<void>> => {
        await beforeSend?.();
        const taskService = ledger.taskService!;
        const sends = internals(taskService).admittedSendsByTaskId;
        const callerToken = internal?.turnAdmission;
        if (callerToken != null) {
          // A caller-minted token: the real host refuses it at its admission gates once stale.
          if (callerToken.admissionStale()) {
            bound.push("stale-token-refused");
            callerToken.onDisposed("refused");
          } else {
            const send = [...(sends.get(workspaceId) ?? [])].find(
              (s) => (s as { token?: unknown }).token === callerToken
            );
            bound.push(send?.attemptId ?? "caller-token");
            callerToken.onDisposed("no-work");
          }
          return Ok(undefined);
        }
        const before = new Set(sends.get(workspaceId) ?? []);
        const admission = taskService.admitTaskWorkspaceTurn(workspaceId, {
          acceptanceOrigin: internal?.acceptanceOrigin ?? "manual",
        });
        if (admission.kind !== "admitted") {
          bound.push(admission.kind);
          return Ok(undefined);
        }
        const send = [...(sends.get(workspaceId) ?? [])].find((s) => !before.has(s));
        bound.push(send?.attemptId ?? "unknown");
        // No session behind the fake host: the admitted obligation produced no turn here.
        admission.token.onDisposed("no-work");
        return Ok(undefined);
      }
    );
    const mocks = createWorkspaceServiceMocks({ ...hostOverrides, sendMessage });
    const { aiService } = createAIServiceMocks(config);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const initStateManager = createMockInitStateManager();
    const taskService = new TaskService(
      config,
      fixture.historyService,
      aiService,
      mocks.workspaceService,
      initStateManager,
      undefined,
      undefined,
      new SecretsStore(config.rootDir),
      terminalAttentionStore
    );
    taskService.setWorkspaceTurnManager(
      new WorkspaceTurnManager(
        config,
        fixture.historyService,
        aiService,
        mocks.workspaceService,
        initStateManager,
        taskService,
        terminalAttentionStore,
        aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
      )
    );
    ledger.taskService = taskService;
    return { taskService, sendMessage, bound, aiService };
  }

  // ---------------------------------------------------------------------------------------------
  // Completion-recovery prompt (#4308 thread ld5yv): B rotates after the recovery-counter CAS, before admission.
  // ---------------------------------------------------------------------------------------------
  test.each(["rotated", "untouched"] as const)(
    "completion-recovery prompt: A's stream-end completion prompt never runs bound to B (row %s after the counter CAS)",
    async (row) => {
      const taskId = row === "rotated" ? "recoveryrotated" : "recoverycontrol";
      const config = await setupChild(taskId, {});
      const { taskService, sendMessage, bound } = createHarness(config);
      let rotated = false;
      const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
      spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (...args) => {
        const result = await editOriginal(...args);
        const ws = findWorkspaceInConfig(config, taskId);
        if (row === "rotated" && !rotated && args[0] === taskId && ws?.taskRecoveryAttempts === 1) {
          // The recovery-counter CAS on A just committed; B's reawaken lands before the send.
          rotated = true;
          await rotateOnOtherBackend(taskId, "running");
        }
        return result;
      });
      await internals(taskService).handleStreamEnd({
        type: "stream-end",
        workspaceId: taskId,
        messageId: "assistant-incomplete",
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts: [],
      });
      if (row === "untouched") {
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(bound).toEqual([A]);
        expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
          taskStatus: "awaiting_report",
          taskAttemptId: A,
          taskRecoveryAttempts: 1,
        });
        return;
      }
      expect(rotated).toBe(true);
      // SAFE outcome: A's stale completion prompt is not admitted under B.
      expect(bound).not.toContain(B);
      expect(sendMessage).not.toHaveBeenCalled();
    }
  );

  // ---------------------------------------------------------------------------------------------
  // Plan-handoff history (#4308 thread ld5yy): B rotates while A awaits workspace metadata (getInfo).
  // ---------------------------------------------------------------------------------------------
  /** A's plan turn ends with a successful propose_plan: the plan→exec auto-handoff runs. */
  async function endPlanStream(taskService: TaskService, taskId: string) {
    await internals(taskService).handleStreamEnd({
      type: "stream-end",
      workspaceId: taskId,
      messageId: "assistant-plan-output",
      metadata: { model: "openai:gpt-5.2" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "propose-plan-call-1",
          toolName: "propose_plan",
          state: "output-available",
          output: { success: true, planPath: "/tmp/test-plan.md" },
          input: { plan: "test plan" },
        },
      ],
    });
  }

  test.each(["rotated", "untouched"] as const)(
    "plan-handoff history: A's plan handoff never appends its compaction boundary to B's history (row %s during getInfo)",
    async (row) => {
      const taskId = row === "rotated" ? "handoffrotated1" : "handoffcontrol1";
      const config = await setupChild(taskId, { agentId: "plan", agentType: "plan" });
      let rotated = false;
      const replaceHistory = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
      const getInfo = mock(async () => {
        if (row === "rotated" && !rotated) {
          rotated = true;
          await rotateOnOtherBackend(taskId, "running");
        }
        return null;
      });
      const { taskService, sendMessage, bound } = createHarness(config, {
        getInfo: getInfo,
        replaceHistory,
      });
      await endPlanStream(taskService, taskId);
      expect(getInfo).toHaveBeenCalledTimes(1);
      if (row === "untouched") {
        expect(replaceHistory).toHaveBeenCalledTimes(1);
        expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
          agentId: "exec",
          taskAttemptId: A,
        });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(bound).toEqual([A]);
        return;
      }
      expect(rotated).toBe(true);
      // The config handoff and kickoff already abort for B (#4308's rowSupersedes CAS) ...
      expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
        agentId: "plan",
        taskStatus: "running",
        taskAttemptId: B,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      // ... SAFE outcome: B's history gets no plan compaction boundary from A either.
      expect(replaceHistory).not.toHaveBeenCalled();
    }
  );

  // Known gap (#4414): the pre-write check is not atomic with the history write. A re-admission
  // landing during replaceHistory's own read (after the check) still gets A's boundary. This
  // test states the safe outcome and is expected to fail until the history write is serialized
  // with attempt rotation; when it starts passing, drop `.failing`.
  test.failing(
    "plan-handoff history (known gap): a re-admission during replaceHistory's own read still gets A's boundary",
    async () => {
      const taskId = "handoffinwrite1";
      const config = await setupChild(taskId, { agentId: "plan", agentType: "plan" });
      const boundaries: string[] = [];
      // Mirrors WorkspaceService.replaceHistory(append-compaction-boundary): read the current
      // epoch's history, then append the boundary. B's admission lands during the read.
      const replaceHistory = mock(async (_workspaceId: string, summary: { id: string }) => {
        await rotateOnOtherBackend(taskId, "running");
        boundaries.push(summary.id);
        return Ok(undefined);
      });
      const { taskService, sendMessage } = createHarness(config, {
        getInfo: mock(() => Promise.resolve(null)),
        replaceHistory,
      });
      await endPlanStream(taskService, taskId);
      expect(replaceHistory).toHaveBeenCalledTimes(1);
      // The rest of the handoff is fenced: B's row keeps its agent and gets no kickoff.
      expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
        agentId: "plan",
        taskAttemptId: B,
      });
      expect(sendMessage).not.toHaveBeenCalled();
      // Safe outcome (currently violated): B's history gets no boundary from A.
      expect(boundaries).toEqual([]);
    }
  );

  // ---------------------------------------------------------------------------------------------
  // Plan-handoff kickoff (#4308 thread lhXRF): B takes the row after the handoff's config edit.
  // ---------------------------------------------------------------------------------------------
  test.each([
    ["lost status write", "handoffkickst1"],
    ["status written, then B admitted before the kickoff", "handoffkickad1"],
    ["kickoff sent, then B admitted before it is dequeued", "handoffkickdq1"],
  ] as const)(
    'plan-handoff kickoff: A\'s "Implement the plan." never runs bound to B (%s)',
    async (when, taskId) => {
      const config = await setupChild(taskId, { agentId: "plan", agentType: "plan" });
      let rotated = false;
      const rotate = async () => {
        if (rotated) return;
        rotated = true;
        await rotateOnOtherBackend(taskId, "running");
      };
      const { taskService, sendMessage, bound } = createHarness(
        config,
        {
          getInfo: mock(() => Promise.resolve(null)),
          replaceHistory: mock(() => Promise.resolve(Ok(undefined))),
        },
        when.startsWith("kickoff sent") ? rotate : undefined
      );
      const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
      spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (...args) => {
        const result = await editOriginal(...args);
        // The handoff's agent switch just committed for A (the row is exec, still A's).
        const ws = findWorkspaceInConfig(config, taskId);
        if (when === "lost status write" && ws?.agentId === "exec" && ws.taskAttemptId === A) {
          await rotate();
        }
        return result;
      });
      const emitOriginal = taskService.emitWorkspaceMetadata.bind(taskService);
      spyOn(taskService, "emitWorkspaceMetadata").mockImplementation(async (...args) => {
        // setTaskStatus(running) wrote for A and now publishes it: B lands before the kickoff.
        const ws = findWorkspaceInConfig(config, taskId);
        if (when.startsWith("status written") && ws?.agentId === "exec") await rotate();
        return await emitOriginal(...args);
      });
      await endPlanStream(taskService, taskId);
      expect(rotated).toBe(true);
      // A's handoff edit landed before B took over; B's admission then owns the row.
      expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
        agentId: "exec",
        taskStatus: "running",
        taskAttemptId: B,
      });
      expect(bound).not.toContain(B);
      if (when.startsWith("kickoff sent")) {
        // Bound to A before the handoff; the host refuses the stale token at dequeue.
        expect(bound).toEqual(["stale-token-refused"]);
      } else {
        expect(sendMessage).not.toHaveBeenCalled();
      }
    }
  );

  // ---------------------------------------------------------------------------------------------
  // Deferred-cut recovery (#4308 thread ld5y3): B startup-rotates while A waits; A's successor cancels.
  // ---------------------------------------------------------------------------------------------
  function createQueueCutReceiptFake() {
    const receipts = new Map<string, QueueCutReceipt>();
    const listeners = new Set<(workspaceId: string) => void>();
    const turnGeneration = Symbol("source-turn");
    const release = (entryId: string) => {
      const receipt = receipts.get(entryId);
      if (receipt?.sourceHandled && (receipt.disposed || receipt.successor === "streaming")) {
        receipts.delete(entryId);
      }
    };
    return {
      receipts,
      register(entryId: string, successor: QueueCutSuccessorState = "pending") {
        receipts.set(entryId, {
          sourceTurnGeneration: turnGeneration,
          successor,
          sourceHandled: false,
          disposed: false,
        });
      },
      record(entryId: string, successor: QueueCutSuccessorState) {
        const receipt = receipts.get(entryId);
        if (!receipt) throw new Error(`no receipt for ${entryId}`);
        receipt.successor = successor;
        release(entryId);
      },
      notify(workspaceId: string) {
        for (const listener of listeners) listener(workspaceId);
      },
      overrides: {
        getTurnGeneration: mock(() => turnGeneration),
        clearQueueCutReceipts: mock(() => receipts.clear()),
        getQueueCutReceipt: mock((_workspaceId: string, entryId: string) => receipts.get(entryId)),
        markQueueCutSourceHandled: mock((_workspaceId: string, entryId: string) => {
          const receipt = receipts.get(entryId);
          if (receipt) receipt.sourceHandled = true;
          release(entryId);
        }),
        disposeQueueCut: mock((_workspaceId: string, entryId: string) => {
          const receipt = receipts.get(entryId);
          if (!receipt || receipt.disposed) return false;
          receipt.disposed = true;
          release(entryId);
          return true;
        }),
        onQueuedMessageChanged: mock((listener: (workspaceId: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      },
    };
  }

  test.each(["rotated", "untouched"] as const)(
    "deferred-cut recovery: A's deferred-cut recovery leaves a row B startup-rotated alone (row %s before the successor cancels)",
    async (row) => {
      const taskId = row === "rotated" ? "deferralrotated" : "deferralcontrol";
      const config = await setupChild(taskId, {});
      const receiptFake = createQueueCutReceiptFake();
      const { taskService, sendMessage, bound } = createHarness(config, receiptFake.overrides);
      const settleEventLock = () =>
        internals(taskService).workspaceEventLocks.withLock(taskId, () => Promise.resolve());
      receiptFake.register("entry-1");
      // A's stream is cut for queued input whose continuation is still pending: A defers.
      await internals(taskService).handleStreamEnd({
        type: "stream-end",
        workspaceId: taskId,
        messageId: "assistant-cut",
        metadata: {
          model: "openai:gpt-5.2",
          finishReason: "tool-calls",
          stopCause: { kind: "queued-input", entryId: "entry-1" },
        },
        parts: [],
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("running");
      if (row === "rotated") {
        // B's startup re-drive rotates the running row (status stays running).
        await rotateOnOtherBackend(taskId, "running");
      }
      // A's continuation is withdrawn: the deferral recovers.
      receiptFake.record("entry-1", "canceled");
      receiptFake.notify(taskId);
      await settleEventLock();
      if (row === "untouched") {
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(bound).toEqual([A]);
        expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
          taskStatus: "awaiting_report",
          taskAttemptId: A,
          taskRecoveryAttempts: 1,
        });
        return;
      }
      // SAFE outcome: B's row keeps its status and budget, and nothing is admitted under B.
      expect(findWorkspaceInConfig(config, taskId)).toMatchObject({
        taskStatus: "running",
        taskAttemptId: B,
      });
      expect(findWorkspaceInConfig(config, taskId)?.taskRecoveryAttempts).toBeUndefined();
      expect(bound).not.toContain(B);
      expect(sendMessage).not.toHaveBeenCalled();
    }
  );
});
