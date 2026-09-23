import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import { SecretsStore } from "@/node/config";
import {
  SEND_ADMISSION_STALE_MESSAGE,
  TASK_REPORT_OUTCOME_INDETERMINATE_UNSENT_MESSAGE,
  TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE,
} from "@/constants/agentMessaging";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { TurnCompletion } from "@/node/services/streamManager";
import { TaskService } from "@/node/services/taskService";
import {
  createMockInitStateManager,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

/**
 * A child task's stream-end decision (TaskService.StreamEndDecision) against the REAL host —
 * WorkspaceService + AgentSession + MessageQueue + TaskService, only the AI stream mocked. A
 * follow-up queued while the child's turn streams must never start under an attempt that turn
 * completed: held while the decision is pending, dispatched under the same attempt when the turn
 * was not the report, refused and handed back as unsent input otherwise.
 */
const rootId = "root-hold";
const model = "openai:gpt-5.2";

interface Internals {
  ownedAttemptByTaskId: Map<string, { attemptId?: string }>;
  attemptSettlementByTaskId: Map<string, { attemptId?: string; phase: string }>;
  admittedSendsByTaskId: Map<string, Set<{ state: string; attemptId: string }>>;
  streamEndDecisionsByTaskId: Map<string, Array<{ attemptId: string; outcome: string }>>;
  workspaceStopRecords: Map<string, unknown>;
  emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
}
const internals = (service: TaskService) => service as unknown as Internals;

function streamEndEvent(
  taskId: string,
  messageId: string,
  options: { report?: string; finishReason?: string }
) {
  const parts: unknown[] = [];
  if (options.report != null) {
    parts.push({
      type: "dynamic-tool",
      toolCallId: `${messageId}-report`,
      toolName: "agent_report",
      input: { reportMarkdown: options.report },
      state: "output-available",
      output: { success: true, report: { reportMarkdown: options.report } },
    });
  }
  parts.push({ type: "text", text: options.report ?? "still working" });
  return {
    type: "stream-end",
    workspaceId: taskId,
    messageId,
    metadata: { model, finishReason: options.finishReason ?? "stop" },
    parts,
  };
}

describe("report-decision hold for queued follow-ups (real host)", () => {
  let rootDir: string;
  // The real HistoryService and its Config come from the shared fixture (see AGENTS.md "Testing:
  // HistoryService"); its temp dir is the root every config/project in a test lives under.
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  beforeEach(async () => {
    fixture = await createTestHistoryService();
    rootDir = fixture.tempDir;
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  const entryOf = (config: Config, id: string) => findWorkspaceInConfig(config, id);
  /** Obligations that could still start a turn (an admitted one belongs to its turn until it settles). */
  const outstanding = (svc: Internals, id: string) =>
    [...(svc.admittedSendsByTaskId.get(id) ?? [])].filter((send) => send.state !== "admitted");
  async function until(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!condition()) throw new Error(`timed out waiting for ${label}`);
  }
  async function yieldMacrotasks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async function createStack(childId: string, overrides?: Partial<WorkspaceConfigEntry>) {
    const { config, historyService } = fixture;
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        {
          ...projectWorkspace(projectPath, childId, childId, {
            parentWorkspaceId: rootId,
            agentType: "explore",
            agentId: "explore",
            taskStatus: "interrupted",
            taskAttemptId: "att_00000000000000a4",
            taskModelString: model,
            runtimeConfig: { type: "local" },
            ...overrides,
          }),
          // Project-dir local runtimes execute in the project root; persist that path.
          path: projectPath,
        },
      ],
      testTaskSettings(4, 3)
    );
    const aiEmitter = new EventEmitter();
    const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
    /** Per stream start: the ledger's sends and the row/owner the stream runs under. */
    const streamStarts: Array<{
      messageId: string;
      row: string | undefined;
      status: string | undefined;
      owner: string | undefined;
    }> = [];
    let streaming = false;
    const ledger: { svc?: Internals } = {};
    const sessionHarness = await createAgentSessionHarness({
      workspaceId: childId,
      config,
      historyService,
      aiEmitter,
      captureEvents: true,
      aiServiceOverrides: {
        isStreaming: () => streaming,
        getWorkspaceMetadata: mock(async (workspaceId: string) => {
          const all = await config.getAllWorkspaceMetadata();
          const found = all.find((m) => m.id === workspaceId);
          return found ? Ok(found) : Err("not found");
        }),
        streamMessage: mock((opts: { workspaceId: string }) => {
          // Only the child's streams are under test. The root shares this mocked AIService, and
          // its terminal-attention wake (the `<mux_subagent_report>` delivery) would otherwise be
          // counted as a second child stream whenever it lands before the assertions.
          if (opts.workspaceId !== childId) {
            return Promise.resolve(
              Ok({
                messageId: `root-${Date.now()}`,
                completion: Promise.resolve({
                  status: "aborted",
                  abortReason: "user",
                } as TurnCompletion),
              })
            );
          }
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          streaming = true;
          const messageId = `assistant-${completions.length}`;
          const row = entryOf(config, childId);
          streamStarts.push({
            messageId,
            row: row?.taskAttemptId,
            status: row?.taskStatus,
            owner: ledger.svc?.ownedAttemptByTaskId.get(childId)?.attemptId,
          });
          aiEmitter.emit("stream-start", {
            type: "stream-start",
            workspaceId: childId,
            messageId,
            model,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
        stopStream: mock(() => {
          streaming = false;
          completions.at(-1)?.resolve({ status: "aborted", abortReason: "user" });
          return Promise.resolve(Ok(undefined));
        }),
      },
    });
    const backgroundProcessManager = Object.assign(new EventEmitter(), {
      cleanup: mock(() => Promise.resolve()),
      hasRunningBackgroundProcesses: mock(() => false),
      hasOrphanedRunningBackgroundProcesses: mock(() => Promise.resolve(false)),
      setMessageQueued: mock(() => undefined),
    }) as unknown as BackgroundProcessManager;
    const initStateManager = {
      on: mock(() => undefined),
      off: mock(() => undefined),
      getInitState: mock(() => undefined),
      waitForInit: mock(() => Promise.resolve()),
      clearInMemoryState: mock(() => undefined),
    } as unknown as InitStateManager;
    const aiService = sessionHarness.aiService as unknown as AIService;
    const workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      initStateManager,
      new ExtensionMetadataService(path.join(config.rootDir, "hold-extension-metadata.json")),
      backgroundProcessManager
    );
    (workspaceService as unknown as { sessions: Map<string, unknown> }).sessions.set(
      childId,
      sessionHarness.session
    );
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const taskService = new TaskService(
      config,
      historyService,
      aiService,
      workspaceService as unknown as WorkspaceHost,
      createMockInitStateManager(),
      undefined,
      undefined,
      new SecretsStore(config.rootDir),
      terminalAttentionStore
    );
    taskService.setWorkspaceTurnManager(
      new WorkspaceTurnManager(
        config,
        historyService,
        aiService,
        workspaceService as unknown as WorkspaceHost,
        createMockInitStateManager(),
        taskService,
        terminalAttentionStore,
        aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
      )
    );
    const svc = internals(taskService);
    ledger.svc = svc;
    workspaceService.setAgentTaskIntegration(
      taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
    );
    const sendOptions = { model, agentId: "explore" };
    /** End the current stream the way StreamManager does: the event first, then the completion. */
    const endStream = (
      index: number,
      options: { report?: string; finishReason?: string },
      completeTurn: boolean
    ) => {
      const event = streamEndEvent(childId, `assistant-${index + 1}`, options);
      streaming = false;
      aiEmitter.emit("stream-end", event);
      if (completeTurn) completeStream(index, event);
      return event;
    };
    const completeStream = (index: number, event: ReturnType<typeof streamEndEvent>) => {
      completions[index]?.resolve({
        status: "completed",
        streamEnd: { ...event, messageId: undefined } as unknown as Extract<
          TurnCompletion,
          { status: "completed" }
        >["streamEnd"],
      });
    };
    const restoreEvents = () =>
      sessionHarness.events.filter(
        (event): event is Extract<typeof event, { type: "restore-to-input" }> =>
          event.type === "restore-to-input"
      );
    const cleanup = async () => {
      for (const completion of completions) {
        completion.resolve({ status: "aborted", abortReason: "user" });
      }
      await sessionHarness.session.dispose();
      await sessionHarness.cleanup();
    };
    return {
      config,
      taskService,
      svc,
      workspaceService,
      sessionHarness,
      completions,
      streamStarts,
      sendOptions,
      endStream,
      completeStream,
      restoreEvents,
      cleanup,
    };
  }

  test.each(["drain before the decision", "drain after the decision"] as const)(
    "a manual follow-up queued during the report turn never runs under the completed attempt (%s): it is held, then refused and handed back as unsent input",
    async (ordering) => {
      const childId = ordering.startsWith("drain before") ? "holdreport001" : "holdreport002";
      const stack = await createStack(childId);
      const { config, taskService, svc, workspaceService, completions, streamStarts, sendOptions } =
        stack;
      try {
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
        const attemptA = entryOf(config, childId)!.taskAttemptId!;
        expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(completions).toHaveLength(1);
        // The user's follow-up arrives mid-stream: queued, bound to A.
        expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
        // The report turn ends on a terminal agent_report.
        const event = stack.endStream(0, { report: "done" }, ordering.startsWith("drain before"));
        if (ordering.startsWith("drain before")) {
          // The session's terminal drain runs while TaskService still decides: the entry is HELD
          // — still queued, no turn claimed, nothing dispatched.
          await yieldMacrotasks(3);
          expect(svc.streamEndDecisionsByTaskId.get(childId)?.[0]).toMatchObject({
            attemptId: attemptA,
          });
        }
        await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
        if (!ordering.startsWith("drain before")) {
          // The decision landed before the session finished the turn: the drain reads it late.
          await until(() => !svc.ownedAttemptByTaskId.has(childId), "release");
          stack.completeStream(0, event);
        }
        await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
        await yieldMacrotasks(5);
        // No second stream: nothing ran under the released attempt.
        expect(completions).toHaveLength(1);
        expect(streamStarts.map((start) => start.messageId)).toEqual(["assistant-1"]);
        expect(entryOf(config, childId)).toMatchObject({
          taskStatus: "reported",
          taskAttemptId: attemptA,
        });
        expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
        // The follow-up's obligation was discharged exactly once and the decision pruned.
        expect(outstanding(svc, childId)).toHaveLength(0);
        expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
        // The text is back with the user — appended, never replacing what they typed since.
        const restored = stack.restoreEvents();
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
          workspaceId: childId,
          text: "follow-up text",
          mode: "append",
        });
        // A later manual send is a new admission that mints a fresh attempt (released shape).
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(false);
        expect(entryOf(config, childId)?.taskAttemptId).not.toBe(attemptA);
      } finally {
        await stack.cleanup();
      }
    },
    20_000
  );

  test("the refused follow-up's unsent input is retained until the renderer acknowledges it: every onChat replay re-sends it under one restore id", async () => {
    // The renderer subscribes to onChat only for the workspace it shows, so a refusal that lands
    // while the user looks at another workspace reaches it only through a later replay.
    const childId = "holdretain001";
    const stack = await createStack(childId);
    const { config, taskService, workspaceService, sessionHarness, sendOptions } = stack;
    const replayedRestores = async () => {
      const events: Array<{ type?: string; restoreId?: string; text?: string }> = [];
      await sessionHarness.session.replayHistory(({ message }) => {
        if ("type" in message && message.type === "restore-to-input") events.push(message);
      });
      return events;
    };
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      const event = stack.endStream(0, { report: "done" }, false);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      stack.completeStream(0, event);
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      const [live] = stack.restoreEvents();
      expect(live).toMatchObject({ text: "follow-up text", mode: "append" });
      const restoreId = live?.restoreId;
      expect(typeof restoreId).toBe("string");
      // Unacknowledged: each new subscription (switching back, reconnect) receives it again,
      // under the same id so the renderer can tell a re-delivery from a new restoration.
      for (let replay = 0; replay < 2; replay++) {
        expect(await replayedRestores()).toMatchObject([
          { restoreId, text: "follow-up text", mode: "append" },
        ]);
      }
      expect(workspaceService.acknowledgeInputRestore(childId, restoreId!)).toEqual(Ok(undefined));
      expect(await replayedRestores()).toEqual([]);
      // Acknowledging again (a renderer re-acking a re-delivery it already applied) is harmless.
      expect(workspaceService.acknowledgeInputRestore(childId, restoreId!)).toEqual(Ok(undefined));
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("an attachment-only manual follow-up refused after the report is handed back with its file parts (empty text is not a drop)", async () => {
    const childId = "holdattachment01";
    const stack = await createStack(childId);
    const { taskService, svc, workspaceService, completions, sendOptions } = stack;
    const fileParts = [{ url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }];
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      // Attachment-only sends are valid user input (AgentSession accepts files without text).
      expect(
        await workspaceService.sendMessage(childId, "", { ...sendOptions, fileParts })
      ).toEqual(Ok(undefined));
      expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
      stack.endStream(0, { report: "done" }, true);
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(5);
      expect(completions).toHaveLength(1);
      expect(outstanding(svc, childId)).toHaveLength(0);
      const restored = stack.restoreEvents();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ workspaceId: childId, text: "", mode: "append" });
      expect(restored[0].fileParts).toEqual(fileParts);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("a follow-up queued during a turn that was NOT the report is held and then dispatched under the same attempt, ahead of the recovery nudge", async () => {
    const childId = "holdcontinue001";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, streamStarts, sendOptions } =
      stack;
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      // A turn that ended on tool calls carries no report (and cannot be promoted to one).
      stack.endStream(0, { finishReason: "tool-calls" }, true);
      await until(() => completions.length === 2, "follow-up dispatched");
      // The follow-up runs under the same, still-owned attempt (the row's status may already read
      // awaiting_report: the handler's own recovery bookkeeping continues after the early decision).
      expect(streamStarts[1]).toMatchObject({
        messageId: "assistant-2",
        row: attemptA,
        owner: attemptA,
      });
      // The follow-up went out (turn admitted); any recovery nudge queues behind it; the decision
      // has no reader left.
      const sends = [...(svc.admittedSendsByTaskId.get(childId) ?? [])];
      expect(sends.some((send) => send.state === "admitted" && send.attemptId === attemptA)).toBe(
        true
      );
      // The decision reads `nonreport` for as long as a queued reader (the nudge) is bound to A.
      expect(
        (svc.streamEndDecisionsByTaskId.get(childId) ?? []).every(
          (decision) => decision.outcome === "nonreport"
        )
      ).toBe(true);
      expect(stack.restoreEvents()).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("a report whose artifact is not durable everywhere leaves the attempt owned and refuses the held follow-up as indeterminate", async () => {
    const childId = "holdindeterminate1";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      const onCanceled = mock((_reason: string) => undefined);
      expect(
        await workspaceService.sendMessage(childId, "follow-up text", sendOptions, { onCanceled })
      ).toEqual(Ok(undefined));
      // The parent's session dir is a file: the report artifact cannot be written there.
      const parentSessionDir = path.join(config.sessionsDir, rootId);
      await fsPromises.rm(parentSessionDir, { recursive: true, force: true });
      await fsPromises.writeFile(parentSessionDir, "not a directory");
      stack.endStream(0, { report: "done" }, true);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "reported row");
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(5);
      expect(completions).toHaveLength(1);
      // Not released (no durable report), not continued: fail closed, text handed back.
      expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).toBe(attemptA);
      expect(stack.restoreEvents()).toHaveLength(1);
      expect(stack.restoreEvents()[0]).toMatchObject({ text: "follow-up text", mode: "append" });
      // Refused as indeterminate — not as a completed report and not as a plain stale attempt.
      expect(onCanceled).toHaveBeenCalledWith(TASK_REPORT_OUTCOME_INDETERMINATE_UNSENT_MESSAGE);
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("while the decision is pending no drain trigger dispatches the held entry and a direct send in preflight is refused; the hold never blocks the session", async () => {
    const childId = "holdtriggers001";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, sessionHarness, completions, sendOptions } =
      stack;
    // Block TaskService's handler inside its first awaited write so the decision stays pending.
    const gate = Promise.withResolvers<void>();
    let blocked = false;
    const emitOriginal = svc.emitWorkspaceMetadata.bind(taskService);
    spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
      if (id === childId && entryOf(config, childId)?.taskStatus === "reported" && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return emitOriginal(id);
    });
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      stack.endStream(0, { report: "done" }, true);
      await until(() => blocked, "handler blocked");
      // The session finished its turn (idle) with the entry still queued: every trigger holds.
      await until(() => !sessionHarness.session.isBusy(), "session idle");
      sessionHarness.session.drainQueuedMessagesIfIdle();
      expect(sessionHarness.session.sendNextUserQueuedMessage()).toBe(true);
      sessionHarness.session.sendQueuedMessages("terminal");
      sessionHarness.session.sendQueuedMessages("provider-tool");
      await yieldMacrotasks(3);
      expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
      expect(completions).toHaveLength(1);
      // A direct send reaching the idle session now is refused (fail closed, text stays with the
      // caller), not admitted under the attempt about to complete.
      const direct = await workspaceService.sendMessage(childId, "direct text", sendOptions);
      expect(direct).toEqual(Err({ type: "unknown", raw: SEND_ADMISSION_STALE_MESSAGE }));
      expect(completions).toHaveLength(1);
      // Release the handler: the decision resolves, the drain is woken, the held entry refused.
      gate.resolve();
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(5);
      expect(completions).toHaveLength(1);
      expect(stack.restoreEvents().map((event) => event.text)).toEqual(["follow-up text"]);
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
    } finally {
      gate.resolve();
      await stack.cleanup();
    }
  }, 20_000);

  test("a synthetic entry held through the decision keeps its cancel semantics: no composer restore, callback notified with the refusal", async () => {
    const childId = "holdsynthetic001";
    const stack = await createStack(childId);
    const { taskService, workspaceService, completions, sendOptions } = stack;
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      const onCanceled = mock((_reason: string) => undefined);
      expect(
        await workspaceService.sendMessage(childId, "synthetic wake", sendOptions, {
          synthetic: true,
          agentInitiated: true,
          onCanceled,
        })
      ).toEqual(Ok(undefined));
      stack.endStream(0, { report: "done" }, true);
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(5);
      expect(completions).toHaveLength(1);
      expect(onCanceled).toHaveBeenCalledWith(TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE);
      expect(stack.restoreEvents()).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("another writer re-admitting the row while the decision is pending: the held manual entry is refused as stale and handed back, never bound to the successor", async () => {
    const childId = "holdforeign001";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
    const otherBackend = await createTestConfig(rootDir);
    const gate = Promise.withResolvers<void>();
    let blocked = false;
    const emitOriginal = svc.emitWorkspaceMetadata.bind(taskService);
    spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
      if (id === childId && entryOf(config, childId)?.taskStatus === "reported" && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return emitOriginal(id);
    });
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      stack.endStream(0, { report: "done" }, true);
      await until(() => blocked, "handler blocked");
      // The other backend reawakens the reported row under its own attempt during the hold.
      await otherBackend.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === childId);
          if (ws) {
            ws.taskAttemptId = "att_00000000000000b4";
            ws.taskAttemptUnproven = true;
          }
        }
        return cfg;
      });
      gate.resolve();
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(5);
      expect(completions).toHaveLength(1);
      expect(entryOf(config, childId)?.taskAttemptId).toBe("att_00000000000000b4");
      expect(stack.restoreEvents().map((event) => event.text)).toEqual(["follow-up text"]);
      const sends = [...(svc.admittedSendsByTaskId.get(childId) ?? [])];
      expect(sends.some((send) => send.attemptId === "att_00000000000000b4")).toBe(false);
      expect(outstanding(svc, childId).filter((send) => send.attemptId === attemptA)).toHaveLength(
        0
      );
    } finally {
      gate.resolve();
      await stack.cleanup();
    }
  }, 20_000);

  /** Hold the decision pending (handler blocked past its `reported` write) with a manual follow-up held. */
  async function holdWithQueuedFollowUp(
    stack: Awaited<ReturnType<typeof createStack>>,
    childId: string
  ) {
    const { config, taskService, svc, workspaceService, sessionHarness, sendOptions } = stack;
    const gate = Promise.withResolvers<void>();
    let blocked = false;
    const emitOriginal = svc.emitWorkspaceMetadata.bind(taskService);
    spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
      if (id === childId && entryOf(config, childId)?.taskStatus === "reported" && !blocked) {
        blocked = true;
        await gate.promise;
      }
      return emitOriginal(id);
    });
    expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
    const attemptA = entryOf(config, childId)!.taskAttemptId!;
    expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(Ok(undefined));
    const onCanceled = mock((_reason: string) => undefined);
    expect(
      await workspaceService.sendMessage(childId, "follow-up text", sendOptions, { onCanceled })
    ).toEqual(Ok(undefined));
    stack.endStream(0, { report: "done" }, true);
    await until(() => blocked, "handler blocked");
    await until(() => !sessionHarness.session.isBusy(), "session idle");
    await yieldMacrotasks(3);
    // Held: still queued, obligation still enqueued, decision pending.
    expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
    expect(outstanding(svc, childId).map((send) => send.state)).toEqual(["enqueued"]);
    expect(svc.streamEndDecisionsByTaskId.get(childId)?.map((d) => d.outcome)).toEqual(["pending"]);
    return { gate, attemptA, onCanceled };
  }

  test("a user Stop on the child while the decision is pending: the held entry is cleared once (no dispatch), its text restored by the Stop itself, the obligation discharged, and the decision pruned once the handler settles", async () => {
    const childId = "holdstopuser001";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, streamStarts } = stack;
    const { gate, attemptA, onCanceled } = await holdWithQueuedFollowUp(stack, childId);
    try {
      // The session is idle with the entry held: the Stop's own queue restore hands the text back
      // through the ordinary Stop path (replace, like any Stop) because the entry's token is not
      // stale while the decision is pending — the hold never turns a Stop into a silent drop.
      expect(await workspaceService.interruptStream(childId)).toEqual(Ok(undefined));
      await yieldMacrotasks(3);
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      expect(stack.restoreEvents()).toHaveLength(1);
      expect(stack.restoreEvents()[0]).toMatchObject({
        workspaceId: childId,
        text: "follow-up text",
      });
      expect(stack.restoreEvents()[0].mode).toBeUndefined();
      expect(onCanceled).toHaveBeenCalledTimes(1);
      expect(onCanceled).toHaveBeenCalledWith("Queued message cleared before dispatch.");
      // The obligation is discharged by the clear; the decision still belongs to the handler.
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.get(childId)?.map((d) => d.outcome)).toEqual([
        "pending",
      ]);
      expect(completions).toHaveLength(1);
      // Handler resumes: publishes and releases A; no reader is left, so the decision is dropped.
      gate.resolve();
      await until(() => !svc.streamEndDecisionsByTaskId.has(childId), "decision pruned");
      await until(() => !svc.ownedAttemptByTaskId.has(childId), "attempt released");
      await yieldMacrotasks(5);
      expect(entryOf(config, childId)).toMatchObject({
        taskStatus: "reported",
        taskAttemptId: attemptA,
      });
      // Nothing dispatched under A, nothing handed back twice, no stop latch retained.
      expect(completions).toHaveLength(1);
      expect(streamStarts.map((start) => start.messageId)).toEqual(["assistant-1"]);
      expect(stack.restoreEvents()).toHaveLength(1);
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(taskService.isWorkspaceStopInProgress(childId)).toBe(false);
      // Sending the restored text again is a fresh admission that mints a new attempt.
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(false);
      expect(entryOf(config, childId)?.taskAttemptId).not.toBe(attemptA);
    } finally {
      gate.resolve();
      await stack.cleanup();
    }
  }, 20_000);

  test("the parent's cascade Stop while the decision is pending: the held entry is cleared once (no dispatch), the obligation discharged, the stop record released, the reported row preserved, and the decision pruned once the handler settles", async () => {
    const childId = "holdstopcascade1";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, streamStarts } = stack;
    const { gate, attemptA, onCanceled } = await holdWithQueuedFollowUp(stack, childId);
    try {
      // The row already reads `reported` (written before the handler blocked): the cascade
      // preserves the completed report rather than marking it interrupted, and still latches the
      // child, clears its queue and releases once its captured obligations are gone.
      expect(await taskService.terminateAllDescendantAgentTasks(rootId)).toEqual([]);
      await yieldMacrotasks(3);
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      // Cascade clears never restore input (a descendant stopped by its parent keeps no pending
      // input); the callback is notified exactly once and the obligation discharged.
      expect(stack.restoreEvents()).toHaveLength(0);
      expect(onCanceled).toHaveBeenCalledTimes(1);
      expect(onCanceled).toHaveBeenCalledWith("Queued message cleared before dispatch.");
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.workspaceStopRecords.has(childId)).toBe(false);
      expect(taskService.isWorkspaceStopInProgress(childId)).toBe(false);
      expect(svc.streamEndDecisionsByTaskId.get(childId)?.map((d) => d.outcome)).toEqual([
        "pending",
      ]);
      expect(completions).toHaveLength(1);
      gate.resolve();
      await until(() => !svc.streamEndDecisionsByTaskId.has(childId), "decision pruned");
      await until(() => !svc.ownedAttemptByTaskId.has(childId), "attempt released");
      await yieldMacrotasks(5);
      expect(entryOf(config, childId)).toMatchObject({
        taskStatus: "reported",
        taskAttemptId: attemptA,
      });
      expect(completions).toHaveLength(1);
      expect(streamStarts.map((start) => start.messageId)).toEqual(["assistant-1"]);
      expect(stack.restoreEvents()).toHaveLength(0);
      expect(outstanding(svc, childId)).toHaveLength(0);
    } finally {
      gate.resolve();
      await stack.cleanup();
    }
  }, 20_000);

  test.each(["interrupted", "reported"] as const)(
    "a manual send whose reawaken of a %s child loses the identity CAS to another backend is refused, never admitted under the winner's attempt",
    async (status) => {
      const childId = status === "interrupted" ? "holdcasloss01" : "holdcasloss02";
      const stack = await createStack(childId, { taskStatus: status });
      const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
      const otherBackend = await createTestConfig(rootDir);
      const winner = "att_00000000000000f9";
      // XUM_ALLOW_MULTIPLE_INSTANCES: another backend's manual resume commits its reawaken
      // between this backend's decision (the lineage read) and its identity CAS.
      const lineage = taskService as unknown as {
        evaluateAttemptLineage: (id: string, entry: unknown) => Promise<unknown>;
      };
      const evaluate = lineage.evaluateAttemptLineage.bind(taskService);
      spyOn(lineage, "evaluateAttemptLineage").mockImplementation(async (id, entry) => {
        await otherBackend.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const ws = project.workspaces.find((w) => w.id === childId);
            if (ws == null) continue;
            if (status === "interrupted") ws.taskStatus = "running";
            ws.taskAttemptId = winner;
          }
          return cfg;
        });
        return evaluate(id, entry);
      });
      try {
        if (status === "reported") {
          // The released shape of an ordinary reported child (no owner, no settlement entry).
          expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
        }
        const result = await workspaceService.sendMessage(childId, "manual follow-up", sendOptions);
        expect(result.success).toBe(false);
        // Nothing streams under the winner's attempt here and no obligation is left bound to it.
        await yieldMacrotasks(3);
        expect(completions).toHaveLength(0);
        expect(outstanding(svc, childId)).toHaveLength(0);
        expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).not.toBe(winner);
        expect(entryOf(config, childId)?.taskAttemptId).toBe(winner);
      } finally {
        await stack.cleanup();
      }
    },
    20_000
  );

  test("a startup re-drive's unowned attempt that reports holds the queued manual follow-up and refuses it: nothing dispatches under the completed attempt", async () => {
    const childId = "holdredrive001";
    const stack = await createStack(childId, { taskStatus: "running" });
    const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
    try {
      // Restart recovery re-drives the running child under a rotated, UNOWNED attempt.
      await taskService.recoverInterruptedTasks();
      await until(() => completions.length === 1, "the re-drive's stream");
      const redriven = entryOf(config, childId)?.taskAttemptId;
      expect(redriven).not.toBe("att_00000000000000a4");
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
      // The user's follow-up arrives mid-stream: queued, bound to the re-driven attempt.
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
      // The re-driven turn ends on a terminal agent_report.
      stack.endStream(0, { report: "done" }, true);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(20);
      // No successor turn under the completed attempt: the entry was refused and handed back.
      expect(completions).toHaveLength(1);
      expect(stack.restoreEvents().map((event) => event.text)).toEqual(["follow-up text"]);
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
      // The hold came from the decision alone: no ownership (settlement/receipt authority) granted.
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
      expect(entryOf(config, childId)?.taskAttemptId).toBe(redriven);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);
});
