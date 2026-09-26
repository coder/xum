import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import * as path from "path";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import {
  SEND_ADMISSION_STALE_MESSAGE,
  TASK_REPORT_OUTCOME_INDETERMINATE_UNSENT_MESSAGE,
  TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE,
} from "@/constants/agentMessaging";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
import type { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { InitStateManager } from "@/node/services/initStateManager";
import type { TurnCompletion } from "@/node/services/streamManager";
import { readSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

/**
 * A child task's stream-end decision (TaskService.StreamEndDecision) against the REAL host —
 * WorkspaceService + AgentSession + MessageQueue + TaskService, only the AI stream mocked. A
 * follow-up queued while the child's turn streams must never start under an attempt that turn
 * completed: held while the decision is pending, dispatched under the same attempt when the turn
 * was not the report, refused otherwise — a refused manual follow-up stays with the session as
 * held input (AgentSession.heldInputs) until the user re-sends or discards it.
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
    const ledger: { svc?: Internals; host?: EventEmitter } = {};
    const sessionHarness = await createAgentSessionHarness({
      workspaceId: childId,
      config,
      historyService,
      aiEmitter,
      captureEvents: true,
      // Turn settlement reaches TaskService the way WorkspaceService's own sessions report it.
      onTurnSettled: (turnGeneration) =>
        ledger.host?.emit("workspace-turn-settled", { workspaceId: childId, turnGeneration }),
      onTurnSuperseded: (previous, next) =>
        ledger.host?.emit("workspace-turn-superseded", { workspaceId: childId, previous, next }),
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
    const backgroundProcessManager = new BackgroundProcessManager(
      path.join(config.rootDir, "hold-background-processes")
    );
    const initStateManager = new InitStateManager(config);
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
    ledger.host = workspaceService as unknown as EventEmitter;
    const { taskService } = createTaskServiceStack(config, {
      historyService,
      aiService,
      workspaceService: workspaceService as unknown as WorkspaceHost,
    });
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
    /** Stop restores only: a refused follow-up is held by the session, never restored. */
    const restoreEvents = () =>
      sessionHarness.events.filter(
        (event): event is Extract<typeof event, { type: "restore-to-input" }> =>
          event.type === "restore-to-input"
      );
    const heldInputs = () => sessionHarness.session.getHeldInputs();
    const heldTexts = () => heldInputs().map((held) => held.send.displayText);
    const cleanup = async () => {
      for (const completion of completions) {
        completion.resolve({ status: "aborted", abortReason: "user" });
      }
      await sessionHarness.session.dispose();
      await sessionHarness.cleanup();
    };
    return {
      aiEmitter,
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
      heldInputs,
      heldTexts,
      cleanup,
    };
  }

  test.each(["drain before the decision", "drain after the decision"] as const)(
    "a manual follow-up queued during the report turn never runs under the completed attempt (%s): it is held, then refused and kept by the session as held input",
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
        // The follow-up is held by the session (nothing is pushed into the composer), refused
        // because the task reported — and published with that reason.
        expect(stack.heldTexts()).toEqual(["follow-up text"]);
        expect(stack.heldInputs().map((held) => held.reason)).toEqual(["reported"]);
        const lastHeldEvent = stack.sessionHarness.events.findLast(
          (event) => event.type === "held-inputs-changed"
        );
        expect(lastHeldEvent).toMatchObject({
          heldInputs: [{ reason: "reported", displayText: "follow-up text" }],
        });
        expect(stack.restoreEvents()).toHaveLength(0);
        // A later manual send is a new admission that mints a fresh attempt (released shape).
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(false);
        expect(entryOf(config, childId)?.taskAttemptId).not.toBe(attemptA);
      } finally {
        await stack.cleanup();
      }
    },
    20_000
  );

  test("a Stop after the report released the attempt but before the queue drained keeps the stale-admission follow-up as held input (full payload, once), never executes it, and does not resurrect it after Discard", async () => {
    // Codex PRRT_kwDOPxxmWM6liPhh: the entry's admission reads stale (its attempt was released by
    // the published report), which must block its EXECUTION, not delete the user's input on Stop.
    const childId = "holdstopstale01";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
    const review = {
      filePath: "src/a.ts",
      lineRange: "1-2",
      selectedCode: "const a = 1;",
      userNote: "rename a",
    };
    const fileParts = [{ url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }];
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(
        await workspaceService.sendMessage(childId, "<review>a</review>\nfollow-up", {
          ...sendOptions,
          fileParts,
          muxMetadata: { type: "normal" as const, reviews: [review] },
          authoredText: "follow-up",
        })
      ).toEqual(Ok(undefined));
      // Barrier: the report is published and its attempt released while the reporting turn is
      // still live, so the queued follow-up has not drained.
      const event = stack.endStream(0, { report: "done" }, false);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      await until(() => !svc.ownedAttemptByTaskId.has(childId), "attempt released");
      expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
      expect(stack.heldInputs()).toHaveLength(0);

      // The user presses Stop.
      expect(await workspaceService.interruptStream(childId)).toEqual(Ok(undefined));
      stack.completeStream(0, event);
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue cleared");
      await yieldMacrotasks(30);

      // Kept once, as held input with its full original send; not pushed over the composer draft.
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      const held = stack.heldInputs();
      expect(held.map((input) => input.send.displayText)).toEqual(["follow-up"]);
      expect(held[0].reason).toBe("reported");
      expect(held[0].send).toMatchObject({
        message: "<review>a</review>\nfollow-up",
        attachmentCount: 1,
        reviewCount: 1,
      });
      expect(held[0].send.options).toMatchObject({
        fileParts,
        muxMetadata: { reviews: [review] },
        authoredText: "follow-up",
      });
      expect(
        stack.restoreEvents().filter((restore) => restore.text.includes("follow-up"))
      ).toHaveLength(0);
      // Never executed automatically.
      expect(completions).toHaveLength(1);
      expect(outstanding(svc, childId)).toHaveLength(0);

      // Discarded input is not resurrected by a later Stop.
      expect(workspaceService.discardHeldInput(childId, held[0].id)).toEqual(Ok(undefined));
      expect(await workspaceService.interruptStream(childId)).toEqual(Ok(undefined));
      await yieldMacrotasks(5);
      expect(stack.heldInputs()).toHaveLength(0);
      expect(
        stack.restoreEvents().filter((restore) => restore.text.includes("follow-up"))
      ).toHaveLength(0);
      expect(completions).toHaveLength(1);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("a manual follow-up sent after the report decision resolved but before the reporting turn settles is refused, never queued or dispatched under the completed attempt; the decision drops when that turn settles", async () => {
    const childId = "holdlate001";
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
      // The report turn ends on a terminal agent_report; the session has not finished the turn.
      const event = stack.endStream(0, { report: "done" }, false);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      await until(() => !svc.ownedAttemptByTaskId.has(childId), "release");
      // The decision resolved with no reader queued yet. The user's follow-up arrives now, while
      // the reporting turn is still live: it targets the completed attempt, so it is refused in
      // its preflight (fail closed, text stays with the caller) instead of queueing behind the
      // turn and dispatching once the decision is gone.
      expect(await workspaceService.sendMessage(childId, "late follow-up", sendOptions)).toEqual(
        Err({ type: "unknown", raw: SEND_ADMISSION_STALE_MESSAGE })
      );
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      stack.completeStream(0, event);
      await until(() => !stack.sessionHarness.session.isBusy(), "reporting turn settled");
      await yieldMacrotasks(5);
      // No second stream: nothing ran under the completed attempt.
      expect(completions).toHaveLength(1);
      expect(streamStarts.map((start) => start.messageId)).toEqual(["assistant-1"]);
      expect(entryOf(config, childId)).toMatchObject({
        taskStatus: "reported",
        taskAttemptId: attemptA,
      });
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
      // Nor was it accepted as a user turn of that attempt.
      const history = await fixture.historyService.getLastMessages(childId, 10);
      expect(history.success && history.data.map((message) => message.role)).toEqual(["user"]);
      // Its obligation was discharged, and the decision is gone once the reporting turn settled
      // (bounded: nothing retained past the turn it was decided for).
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
      // After the turn settled, a manual send is a new admission that mints a fresh attempt.
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(false);
      expect(entryOf(config, childId)?.taskAttemptId).not.toBe(attemptA);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("refused manual follow-ups are held with their full sends, in order: never dispatched automatically (drains, force-send, a later manual turn), untouched by Stop and clearQueue, replayed on subscription; Send re-sends one under a fresh attempt and removes it only once accepted; Discard removes", async () => {
    const childId = "holdinput001";
    const stack = await createStack(childId);
    const { config, taskService, workspaceService, sessionHarness, completions } = stack;
    const { streamStarts, sendOptions } = stack;
    const session = sessionHarness.session;
    const review = {
      filePath: "src/a.ts",
      lineRange: "1-2",
      selectedCode: "const a = 1;",
      userNote: "rename a",
    };
    const reviewedSend = {
      ...sendOptions,
      fileParts: [{ url: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" }],
      muxMetadata: { type: "normal" as const, reviews: [review] },
      authoredText: "second authored",
    };
    const replayedHeldLists = async () => {
      const lists: string[][] = [];
      await session.replayHistory(({ message }) => {
        if ("type" in message && message.type === "held-inputs-changed") {
          lists.push(message.heldInputs.map((held) => held.displayText));
        }
      });
      return lists;
    };
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      // Two follow-ups queued during the report turn (task-attempt entries never batch).
      expect(await workspaceService.sendMessage(childId, "first follow-up", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(
        await workspaceService.sendMessage(childId, "<review>a</review>\nsecond", reviewedSend)
      ).toEqual(Ok(undefined));
      stack.endStream(0, { report: "done" }, true);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      await until(() => !workspaceService.hasQueuedMessages(childId), "queue drained");
      await yieldMacrotasks(5);
      expect(completions).toHaveLength(1);

      // Held in order, each with its full original send (review metadata and files included).
      expect(stack.heldTexts()).toEqual(["first follow-up", "second authored"]);
      const [first, second] = stack.heldInputs();
      expect(first.send).toMatchObject({ message: "first follow-up", attachmentCount: 0 });
      expect(first.send.options).toMatchObject(sendOptions);
      expect(second.send).toMatchObject({
        message: "<review>a</review>\nsecond",
        attachmentCount: 1,
        reviewCount: 1,
      });
      expect(second.send.options).toMatchObject({
        ...sendOptions,
        fileParts: reviewedSend.fileParts,
        muxMetadata: { reviews: [review] },
        authoredText: "second authored",
      });
      // Held inputs are not dispatchable work.
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      // Every subscription receives the current list (switching back, reload).
      for (let replay = 0; replay < 2; replay++) {
        expect(await replayedHeldLists()).toEqual([["first follow-up", "second authored"]]);
      }

      // No drain trigger or force-send dispatches them.
      session.drainQueuedMessagesIfIdle();
      expect(session.sendNextUserQueuedMessage()).toBe(false);
      session.sendQueuedMessages("terminal");
      await yieldMacrotasks(3);
      expect(completions).toHaveLength(1);

      // Stop and clearQueue leave them alone.
      expect(await workspaceService.interruptStream(childId)).toEqual(Ok(undefined));
      expect(workspaceService.clearQueue(childId)).toEqual(Ok(undefined));
      expect(stack.heldTexts()).toEqual(["first follow-up", "second authored"]);

      // A Send whose send is not accepted keeps the held input and surfaces the error.
      const refusal = { type: "unknown" as const, raw: "send refused for the test" };
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValueOnce(Err(refusal));
      expect(await workspaceService.sendHeldInput(childId, second.id)).toEqual(Err(refusal));
      sendSpy.mockRestore();
      expect(stack.heldTexts()).toEqual(["first follow-up", "second authored"]);
      expect(completions).toHaveLength(1);

      // Send: a new manual send of the exact held payload, admitted under a FRESH attempt (A was
      // released by its report); a concurrent second Send of the same held input is refused
      // instead of sending it twice.
      const sending = workspaceService.sendHeldInput(childId, second.id);
      expect(await workspaceService.sendHeldInput(childId, second.id)).toEqual(
        Err({ type: "unknown", raw: "This unsent message is already being sent." })
      );
      expect(await sending).toEqual(Ok(undefined));
      expect(completions).toHaveLength(2);
      expect(streamStarts[1].row).not.toBe(attemptA);
      expect(stack.heldTexts()).toEqual(["first follow-up"]);
      expect(await replayedHeldLists()).toEqual([["first follow-up"]]);
      // Each review reaches the provider once: the sent row is exactly the original message.
      const history = await fixture.historyService.getLastMessages(childId, 1);
      const sentRow = history.success ? history.data[0] : undefined;
      expect(sentRow?.role).toBe("user");
      const sentText = sentRow?.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      expect(sentText).toBe("<review>a</review>\nsecond");
      // A second Send of the removed input reports it gone.
      expect(await workspaceService.sendHeldInput(childId, second.id)).toEqual(
        Err({ type: "unknown", raw: "This unsent message is no longer held." })
      );

      // When that later manual turn ends, the remaining held input still does not run.
      stack.endStream(1, { report: "done again" }, true);
      await until(() => !session.isBusy(), "second turn settled");
      await yieldMacrotasks(10);
      expect(completions).toHaveLength(2);
      expect(stack.heldTexts()).toEqual(["first follow-up"]);

      // Discard removes it (and publishes the empty list).
      expect(workspaceService.discardHeldInput(childId, first.id)).toEqual(Ok(undefined));
      expect(stack.heldInputs()).toHaveLength(0);
      expect(await replayedHeldLists()).toEqual([]);
      const heldEvents = sessionHarness.events.filter(
        (event) => event.type === "held-inputs-changed"
      );
      expect(heldEvents.at(-1)).toMatchObject({ heldInputs: [] });
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test.each([
    "turn completes with the stream end",
    "turn completes after report publication",
  ] as const)(
    "a workflow-owned leaf that reports while the user's manual message is queued is not auto-deleted: the message stays held and reachable (%s)",
    async (ordering) => {
      // Codex PRRT_kwDOPxxmWM6ld5y_: auto-deleting the reported workflow leaf disposes its session,
      // which is the only place the queued (then held) manual message lives.
      const late = ordering === "turn completes after report publication";
      const childId = late ? "holdwfleaf0002" : "holdwfleaf0001";
      const stack = await createStack(childId, {
        workflowTask: { runId: "wfr_held_cleanup", stepId: "step" },
      });
      const { config, taskService, workspaceService, completions, sendOptions } = stack;
      try {
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
        expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
        const event = stack.endStream(0, { report: "done" }, !late);
        await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
        // Let report publication, the idle drain and any auto-delete attempt run to completion.
        await yieldMacrotasks(40);
        if (late) {
          // Report published while the entry still waits in the queue: cleanup already ran.
          expect(entryOf(config, childId)).toBeDefined();
          stack.completeStream(0, event);
        }
        // Wait for the hold itself rather than a fixed number of turns (too few on loaded CI).
        await until(() => stack.heldTexts().length > 0, "follow-up held");
        await yieldMacrotasks(20);
        // Not sent under the completed attempt, not deleted, held for the user.
        expect(completions).toHaveLength(1);
        expect(entryOf(config, childId)).toMatchObject({ taskStatus: "reported" });
        expect(stack.heldTexts()).toEqual(["follow-up text"]);

        // Discarding does not re-trigger cleanup (documented trade-off): the leaf stays until the
        // next cleanup trigger.
        const [held] = stack.heldInputs();
        expect(workspaceService.discardHeldInput(childId, held.id)).toEqual(Ok(undefined));
        await yieldMacrotasks(10);
        expect(entryOf(config, childId)).toBeDefined();
      } finally {
        await stack.cleanup();
      }
    },
    20_000
  );

  test("control: a workflow-owned leaf that reports with no pending user input is still auto-deleted", async () => {
    const childId = "holdwfleaf0003";
    const stack = await createStack(childId, {
      workflowTask: { runId: "wfr_held_cleanup", stepId: "step" },
    });
    const { config, taskService, workspaceService, sendOptions } = stack;
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      stack.endStream(0, { report: "done" }, true);
      await until(() => entryOf(config, childId) == null, "leaf auto-deleted");
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("a session holding refused input blocks an app restart until the input is sent or discarded (it lives only in memory)", async () => {
    const childId = "holdrestart001";
    const stack = await createStack(childId);
    const { config, taskService, workspaceService, sendOptions } = stack;
    const heldBlockers = () =>
      workspaceService.collectRestartBlockers().filter((blocker) => blocker.kind === "held-inputs");
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      stack.endStream(0, { report: "done" }, true);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      await until(() => stack.heldInputs().length === 1, "follow-up held");
      await until(() => !stack.sessionHarness.session.isBusy(), "turn settled");
      // Not queued work, yet a restart would lose it.
      expect(workspaceService.hasQueuedMessages(childId)).toBe(false);
      expect(heldBlockers()).toEqual([{ kind: "held-inputs", count: 1 }]);

      const [held] = stack.heldInputs();
      expect(workspaceService.discardHeldInput(childId, held.id)).toEqual(Ok(undefined));
      expect(heldBlockers()).toEqual([]);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("Discard while a Send of the same held input is in flight is refused as busy, so a failed send keeps the only copy", async () => {
    const childId = "holddiscardrace1";
    const stack = await createStack(childId);
    const { config, taskService, workspaceService, sendOptions } = stack;
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(await workspaceService.sendMessage(childId, "follow-up text", sendOptions)).toEqual(
        Ok(undefined)
      );
      stack.endStream(0, { report: "done" }, true);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "report");
      await until(() => stack.heldInputs().length === 1, "follow-up held");
      const [held] = stack.heldInputs();

      // The send stays in flight until the test settles it, then fails.
      const sendSettles = Promise.withResolvers<void>();
      const refusal = { type: "unknown" as const, raw: "send failed for the test" };
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementationOnce(async () => {
        await sendSettles.promise;
        return Err(refusal);
      });
      const sending = workspaceService.sendHeldInput(childId, held.id);
      await until(() => sendSpy.mock.calls.length === 1, "send in flight");
      const discarded = workspaceService.discardHeldInput(childId, held.id);
      expect(discarded.success).toBe(false);
      expect(stack.heldTexts()).toEqual(["follow-up text"]);

      sendSettles.resolve();
      expect(await sending).toEqual(Err(refusal));
      sendSpy.mockRestore();
      // The failed send kept it; with no send in flight, Discard removes it.
      expect(stack.heldTexts()).toEqual(["follow-up text"]);
      expect(workspaceService.discardHeldInput(childId, held.id)).toEqual(Ok(undefined));
      expect(stack.heldInputs()).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("an attachment-only manual follow-up refused after the report is held with its file parts (empty text is not a drop)", async () => {
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
      const held = stack.heldInputs();
      expect(held).toHaveLength(1);
      expect(held[0].send).toMatchObject({ message: "", displayText: "", attachmentCount: 1 });
      expect(held[0].send.options.fileParts).toEqual(fileParts);
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
      expect(stack.heldInputs()).toHaveLength(0);
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
      // Not released (no durable report), not continued: fail closed, the follow-up held — as
      // indeterminate, never as if a report had been confirmed.
      expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).toBe(attemptA);
      expect(stack.heldTexts()).toEqual(["follow-up text"]);
      expect(stack.heldInputs().map((held) => held.reason)).toEqual(["indeterminate"]);
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
      expect(stack.heldTexts()).toEqual(["follow-up text"]);
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
    } finally {
      gate.resolve();
      await stack.cleanup();
    }
  }, 20_000);

  test("a synthetic entry held through the decision keeps its cancel semantics: not kept as held input, callback notified with the refusal", async () => {
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
      expect(stack.heldInputs()).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("another writer re-admitting the row while the decision is pending: the held manual entry is refused as stale and kept as held input, never bound to the successor", async () => {
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
      expect(stack.heldTexts()).toEqual(["follow-up text"]);
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
      expect(stack.heldInputs()).toHaveLength(0);
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
      expect(stack.heldInputs()).toHaveLength(0);
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
      // No successor turn under the completed attempt: the entry was refused and held.
      expect(completions).toHaveLength(1);
      expect(stack.heldTexts()).toEqual(["follow-up text"]);
      expect(outstanding(svc, childId)).toHaveLength(0);
      expect(svc.streamEndDecisionsByTaskId.has(childId)).toBe(false);
      // The hold came from the decision alone: no ownership (settlement/receipt authority) granted.
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
      expect(entryOf(config, childId)?.taskAttemptId).toBe(redriven);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("an unowned re-drive whose row another backend re-admitted meanwhile: its stream end neither fences the successor's input nor publishes its report as the successor's", async () => {
    const childId = "holdredrive002";
    const foreign = "att_00000000000000b7";
    const stack = await createStack(childId, { taskStatus: "running" });
    const { config, taskService, svc, workspaceService, completions, streamStarts, sendOptions } =
      stack;
    const otherBackend = await createTestConfig(rootDir);
    try {
      await taskService.recoverInterruptedTasks();
      await until(() => completions.length === 1, "the re-drive's stream");
      const redriven = entryOf(config, childId)?.taskAttemptId;
      expect(redriven).not.toBe("att_00000000000000a4");
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
      // Backend B admits the row under its own attempt while this backend's stream still runs.
      await otherBackend.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === childId);
          if (ws) {
            ws.taskStatus = "running";
            ws.taskAttemptId = foreign;
            ws.taskAttemptUnproven = true;
          }
        }
        return cfg;
      });
      // A follow-up sent now is bound to B (the current row) and queued behind the live stream.
      expect(await workspaceService.sendMessage(childId, "b follow-up", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(workspaceService.hasQueuedMessages(childId)).toBe(true);
      // The re-driven attempt's stream ends on a terminal agent_report.
      stack.endStream(0, { report: "done by the re-drive" }, true);
      // No decision of the ended stream is ever keyed by B.
      expect(
        (svc.streamEndDecisionsByTaskId.get(childId) ?? []).map((decision) => decision.attemptId)
      ).not.toContain(foreign);
      await until(() => completions.length === 2, "B's follow-up dispatched");
      await yieldMacrotasks(20);
      // B's input ran under B, unfenced by the re-drive's report; nothing was handed back.
      expect(streamStarts[1]).toMatchObject({ row: foreign, status: "running" });
      expect(stack.restoreEvents()).toHaveLength(0);
      // B's row is exactly as its writer left it, and no report was published for it.
      expect(entryOf(config, childId)).toMatchObject({
        taskStatus: "running",
        taskAttemptId: foreign,
        taskAttemptUnproven: true,
      });
      expect(entryOf(config, childId)?.reportedAt).toBeUndefined();
      expect(
        await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), childId)
      ).toBeNull();
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  test("an unowned re-drive's report publication is a CAS on its admitted attempt: a row re-admitted during the publication's own awaits is left to its writer", async () => {
    const childId = "holdredrive003";
    const foreign = "att_00000000000000b8";
    const stack = await createStack(childId, { taskStatus: "running" });
    const { config, taskService, svc, completions } = stack;
    const otherBackend = await createTestConfig(rootDir);
    try {
      await taskService.recoverInterruptedTasks();
      await until(() => completions.length === 1, "the re-drive's stream");
      const redriven = entryOf(config, childId)?.taskAttemptId;
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
      // Backend B re-admits the row right before the publication's status write, i.e. after
      // every earlier check of the stream-end handler read the re-driven attempt.
      let rotated = false;
      const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
      spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (id, updater, options) => {
        const probe = structuredClone(entryOf(config, childId));
        if (id === childId && !rotated && probe != null) {
          updater(probe, config.loadConfigOrDefault());
          if (probe.taskStatus === "reported") {
            rotated = true;
            await otherBackend.editConfig((cfg) => {
              for (const project of cfg.projects.values()) {
                const ws = project.workspaces.find((w) => w.id === childId);
                if (ws) {
                  ws.taskStatus = "running";
                  ws.taskAttemptId = foreign;
                  ws.taskAttemptUnproven = true;
                }
              }
              return cfg;
            });
          }
        }
        return editOriginal(id, updater, options);
      });
      stack.endStream(0, { report: "done by the re-drive" }, true);
      await until(() => rotated, "the publication write");
      await until(
        () =>
          !(svc.streamEndDecisionsByTaskId.get(childId) ?? []).some((d) => d.outcome === "pending"),
        "the decision resolved"
      );
      await yieldMacrotasks(20);
      expect(entryOf(config, childId)).toMatchObject({
        taskStatus: "running",
        taskAttemptId: foreign,
        taskAttemptUnproven: true,
      });
      expect(entryOf(config, childId)?.reportedAt).toBeUndefined();
      expect(
        await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), childId)
      ).toBeNull();
      // The re-drive's decision stayed keyed by its own attempt, and no ownership was granted.
      expect(
        (svc.streamEndDecisionsByTaskId.get(childId) ?? []).map((decision) => decision.attemptId)
      ).not.toContain(foreign);
      expect(redriven).not.toBe(foreign);
      expect(svc.ownedAttemptByTaskId.has(childId)).toBe(false);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);
  test.each(["before its stream ends", "during the report publication write"] as const)(
    "an OWNED attempt whose row another backend re-admitted %s: its stream end never publishes its report as the successor's",
    async (when) => {
      const childId = when.startsWith("before") ? "holdowned001" : "holdowned002";
      const foreign = when.startsWith("before") ? "att_00000000000000c1" : "att_00000000000000c2";
      const stack = await createStack(childId);
      const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
      const otherBackend = await createTestConfig(rootDir);
      const rotate = () =>
        otherBackend.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const ws = project.workspaces.find((w) => w.id === childId);
            if (ws) {
              ws.taskStatus = "running";
              ws.taskAttemptId = foreign;
              ws.taskAttemptUnproven = true;
            }
          }
          return cfg;
        });
      try {
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
        const attemptA = entryOf(config, childId)!.taskAttemptId!;
        expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).toBe(attemptA);
        expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(completions).toHaveLength(1);
        let rotated = false;
        if (when.startsWith("before")) {
          await rotate();
          rotated = true;
        } else {
          // B re-admits the row right before the publication's status write.
          const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
          spyOn(taskService, "editWorkspaceEntry").mockImplementation(
            async (id, updater, options) => {
              const probe = structuredClone(entryOf(config, childId));
              if (id === childId && !rotated && probe != null) {
                updater(probe, config.loadConfigOrDefault());
                if (probe.taskStatus === "reported") {
                  rotated = true;
                  await rotate();
                }
              }
              return editOriginal(id, updater, options);
            }
          );
        }
        stack.endStream(0, { report: "done by A" }, true);
        await until(() => rotated, "the rotation");
        await until(
          () =>
            !(svc.streamEndDecisionsByTaskId.get(childId) ?? []).some(
              (decision) => decision.outcome === "pending"
            ),
          "the decision resolved"
        );
        await yieldMacrotasks(20);
        expect(entryOf(config, childId)).toMatchObject({
          taskStatus: "running",
          taskAttemptId: foreign,
          taskAttemptUnproven: true,
        });
        expect(entryOf(config, childId)?.reportedAt).toBeUndefined();
        expect(
          await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), childId)
        ).toBeNull();
      } finally {
        await stack.cleanup();
      }
    },
    20_000
  );
  test("a stale local owner never claims a successor's stream: B's report, admitted here as unowned after another backend rotated the row, is published for B", async () => {
    const childId = "holdstaleowner1";
    const foreign = "att_00000000000000c5";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
    const otherBackend = await createTestConfig(rootDir);
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).toBe(attemptA);
      // Backend B re-admits the idle row under its own attempt; this process still owns A.
      await otherBackend.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === childId);
          if (ws) {
            ws.taskStatus = "running";
            ws.taskAttemptId = foreign;
            ws.taskAttemptUnproven = true;
          }
        }
        return cfg;
      });
      // A local send is admitted for B (unowned: the stale owner names A).
      expect(await workspaceService.sendMessage(childId, "work for B", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(completions).toHaveLength(1);
      expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).toBe(attemptA);
      stack.endStream(0, { report: "done by B" }, true);
      await until(() => entryOf(config, childId)?.taskStatus === "reported", "B's report");
      expect(entryOf(config, childId)?.taskAttemptId).toBe(foreign);
      // The artifact follows the status write within the same publication.
      let artifact: Awaited<ReturnType<typeof readSubagentReportArtifact>> = null;
      for (let i = 0; i < 200 && artifact == null; i++) {
        artifact = await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), childId);
        if (artifact == null) await yieldMacrotasks(1);
      }
      expect(artifact?.reportMarkdown).toBe("done by B");
    } finally {
      await stack.cleanup();
    }
  }, 20_000);
  test("the interrupted report path publishes only for the stream's attempt: a row re-admitted during the publication write is left to its writer", async () => {
    const childId = "holdinterrupted1";
    const foreign = "att_00000000000000c8";
    const stack = await createStack(childId);
    const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
    const otherBackend = await createTestConfig(rootDir);
    const editRow = (edit: (ws: WorkspaceConfigEntry) => void) =>
      otherBackend.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === childId);
          if (ws) edit(ws);
        }
        return cfg;
      });
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
        Ok(undefined)
      );
      expect(completions).toHaveLength(1);
      // The row is interrupted (same attempt) before the stream ends: the stream end takes the
      // interrupted settlement path with its final report.
      await editRow((ws) => {
        ws.taskStatus = "interrupted";
      });
      // Backend B re-admits the row right before that path's report publication write. The
      // test awaits B's write itself: a flag set when the write starts let the assertions run
      // while it was still in flight (#4558: fsync on a slow CI disk outlasted the yields).
      let rotation: Promise<void> | undefined;
      let waiterOutcome: string | undefined;
      const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
      spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (id, updater, options) => {
        const probe = structuredClone(entryOf(config, childId));
        if (id === childId && rotation === undefined && probe != null) {
          updater(probe, config.loadConfigOrDefault());
          if (probe.taskStatus === "reported") {
            rotation = editRow((ws) => {
              ws.taskStatus = "running";
              ws.taskAttemptId = foreign;
              ws.taskAttemptUnproven = true;
            });
            await rotation;
            // A parent now awaits the task by its stable id: B's waiter.
            void taskService
              .waitForAgentReport(childId, { timeoutMs: 3_000, requestingWorkspaceId: rootId })
              .then(
                () => {
                  waiterOutcome = "resolved";
                },
                (error: unknown) => {
                  waiterOutcome = error instanceof Error ? error.message : String(error);
                }
              );
          }
        }
        return editOriginal(id, updater, options);
      });
      stack.endStream(0, { report: "done by A" }, true);
      await until(() => rotation !== undefined, "the publication write");
      await rotation;
      await until(
        () =>
          !(svc.streamEndDecisionsByTaskId.get(childId) ?? []).some((d) => d.outcome === "pending"),
        "the decision resolved"
      );
      await yieldMacrotasks(20);
      expect(entryOf(config, childId)).toMatchObject({
        taskStatus: "running",
        taskAttemptId: foreign,
        taskAttemptUnproven: true,
      });
      expect(entryOf(config, childId)?.reportedAt).toBeUndefined();
      // B's waiter is neither resolved with A's report nor rejected by A's abandoned publication.
      expect(waiterOutcome).toBeUndefined();
      expect(
        await readSubagentReportArtifact(path.join(config.sessionsDir, rootId), childId)
      ).toBeNull();
      expect(svc.ownedAttemptByTaskId.get(childId)?.attemptId).not.toBe(foreign);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  // ---------------------------------------------------------------------------------------------
  // Shared-desktop user-abort cleanup (PR #4308 thread ld5y7): the handler's queue clear must not
  // drop user input queued by a send made while the handler awaited its row write (a new attempt
  // began meanwhile, in this process or through another backend's re-admission).
  // ---------------------------------------------------------------------------------------------
  describe("shared-desktop user-abort cleanup keeps input queued during the cleanup", () => {
    const SUCCESSOR = "att_00000000000000e1";
    async function admitSuccessorElsewhere(otherBackend: Config, workspaceId: string) {
      await otherBackend.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (ws) {
            ws.taskAttemptId = SUCCESSOR;
            ws.taskAttemptUnproven = true;
            ws.taskStatus = "running";
          }
        }
        return cfg;
      });
    }

    /**
     * A runs stream 1 on a shared-desktop child; `beforeStop` may queue input; the user stops A
     * (session Stop, then TaskService's user-abort handler). B re-admits the row while the handler
     * awaits the execution-mirror finalizer (when `rotate`). `inWindow` runs after the handler's
     * row write resolved and before it continues (closure for the row's id in place, before
     * clearQueue / settleOwnedTaskAttempt).
     */
    async function runAbort(
      childId: string,
      options: {
        rotate: boolean;
        beforeStop?: (stack: Awaited<ReturnType<typeof createStack>>) => Promise<void>;
        inWindow?: (stack: Awaited<ReturnType<typeof createStack>>) => Promise<void>;
      }
    ) {
      const stack = await createStack(childId, { taskDesktopOwnerWorkspaceId: rootId });
      const { config, taskService, svc, workspaceService, completions, sendOptions } = stack;
      const otherBackend = await createTestConfig(rootDir);
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      if (options.beforeStop != null) {
        // A running stream the user stops; input queued behind it (the session's own Stop runs
        // first, as in production). The mock host never winds this session down afterwards, so
        // only scenarios that need a queued-before-Stop entry take this path.
        expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(completions).toHaveLength(1);
        await options.beforeStop(stack);
        expect(await workspaceService.interruptStream(childId)).toEqual(Ok(undefined));
        await yieldMacrotasks(3);
      } else {
        // Idle session (the stopped stream already wound down): only TaskService's user-abort
        // handler is left to run, and later sends take the ordinary idle path.
        expect(stack.sessionHarness.session.isBusy()).toBe(false);
      }
      const queueAtClear: boolean[] = [];
      const realClear = workspaceService.clearQueue.bind(workspaceService);
      const clearSpy = spyOn(workspaceService, "clearQueue").mockImplementation((id, opts) => {
        if (id === childId) queueAtClear.push(workspaceService.hasQueuedMessages(childId));
        return realClear(id, opts);
      });
      const tsvc = taskService as unknown as {
        closeAttemptAdmission: (...args: unknown[]) => void;
        editWorkspaceEntry: (...args: unknown[]) => Promise<boolean>;
        releaseSharedDesktopTaskOnUserStop: (id: string, abortOrigin: unknown) => Promise<void>;
      };
      let armed = false;
      const closures: unknown[] = [];
      const realClose = tsvc.closeAttemptAdmission.bind(taskService);
      const closeSpy = spyOn(tsvc, "closeAttemptAdmission").mockImplementation((...args) => {
        if (args[3] === "user-stop-idle") {
          closures.push(args[1]);
          armed = true;
        }
        realClose(...args);
      });
      const realEdit = tsvc.editWorkspaceEntry.bind(taskService);
      const editSpy = spyOn(tsvc, "editWorkspaceEntry").mockImplementation(async (...args) => {
        const result = await realEdit(...args);
        if (armed) {
          armed = false;
          await options.inWindow?.(stack);
        }
        return result;
      });
      const finalizeSpy = spyOn(
        WorkspaceTurnManager.prototype,
        "finalizeWorkspaceTurnFromStreamAbort"
      ).mockImplementation(async () => {
        if (options.rotate) await admitSuccessorElsewhere(otherBackend, childId);
        return false as never;
      });
      // Deliver the user abort the way StreamManager does: one "stream-abort" event that the
      // session (turn wind-down) and TaskService's listener (handleStreamAbort under the task's
      // event lock) both consume.
      let handler: Promise<void> | undefined;
      const realRelease = tsvc.releaseSharedDesktopTaskOnUserStop.bind(taskService);
      const releaseSpy = spyOn(tsvc, "releaseSharedDesktopTaskOnUserStop").mockImplementation(
        (id: string, abortOrigin: unknown) => {
          handler = realRelease(id, abortOrigin);
          return handler;
        }
      );
      try {
        stack.aiEmitter.emit("stream-abort", {
          type: "stream-abort",
          workspaceId: childId,
          messageId: "assistant-1",
          metadata: {},
          abortReason: "user",
        });
        await until(() => handler != null, "user-abort handler started");
        await handler;
      } finally {
        releaseSpy.mockRestore();
        finalizeSpy.mockRestore();
        editSpy.mockRestore();
        closeSpy.mockRestore();
        clearSpy.mockRestore();
      }
      await yieldMacrotasks(5);
      return { stack, attemptA, closures, queueAtClear, svc };
    }

    test("(c1) input queued before the abort is restored by the session Stop; the handler's clearQueue finds nothing", async () => {
      const { stack, queueAtClear } = await runAbort("r22fc01", {
        rotate: true,
        beforeStop: async ({ workspaceService, sendOptions }) => {
          expect(
            await workspaceService.sendMessage("r22fc01", "queued before stop", sendOptions)
          ).toEqual(Ok(undefined));
          expect(workspaceService.hasQueuedMessages("r22fc01")).toBe(true);
        },
      });
      try {
        const observed = {
          queueAtClear,
          restored: stack.restoreEvents().map((e) => e.text),
          held: stack.heldTexts(),
          streams: stack.streamStarts.length,
          row: entryOf(stack.config, "r22fc01")?.taskStatus,
        };
        expect(observed.restored).toEqual(["queued before stop"]);
      } finally {
        await stack.cleanup();
      }
    }, 20_000);

    test("(c2 with B's rotation) the stale abort leaves B's row alone: no transition, no closure, no queue clear", async () => {
      // #4414: the abort acts for the attempt it captured at the event; B's re-admission during
      // the finalizer await makes the row B's, so the handler stops before any effect.
      const { stack, closures, queueAtClear } = await runAbort("r22fc2r", { rotate: true });
      try {
        expect(closures).toEqual([]);
        expect(queueAtClear).toEqual([]);
        expect(entryOf(stack.config, "r22fc2r")).toMatchObject({
          taskStatus: "running",
          taskAttemptId: SUCCESSOR,
        });
      } finally {
        await stack.cleanup();
      }
    }, 20_000);

    test.each([["single backend", false]] as const)(
      "(c2 %s) a user message queued behind a send made during the handler's write await is not silently dropped by the handler's clearQueue",
      async (_label, rotate) => {
        const childId = "r22fc2s";
        const sends: unknown[] = [];
        const { stack, queueAtClear } = await runAbort(childId, {
          rotate,
          inWindow: async ({ workspaceService, sendOptions }) => {
            sends.push(
              await workspaceService.sendMessage(childId, "first after stop", sendOptions)
            );
            sends.push(
              await workspaceService.sendMessage(childId, "second after stop", sendOptions)
            );
            sends.push(workspaceService.hasQueuedMessages(childId));
          },
        });
        try {
          const row = entryOf(stack.config, childId);
          const observed = {
            sends,
            queueAtClear,
            queuedAfter: stack.workspaceService.hasQueuedMessages(childId),
            restored: stack.restoreEvents().map((e) => e.text),
            held: stack.heldTexts(),
            streams: stack.streamStarts.map((s) => s.messageId),
            row: { status: row?.taskStatus, attemptId: row?.taskAttemptId },
          };
          // Both sends are accepted: the first reawakens a fresh attempt and runs, the second queues
          // behind it. The handler (still on the stale abort) must then leave that queue alone:
          // the second message is kept (queued, restored or held), never dropped silently.
          expect(sends).toEqual([Ok(undefined), Ok(undefined), true]);
          const kept =
            observed.queuedAfter ||
            observed.restored.includes("second after stop") ||
            observed.held.includes("second after stop");
          expect(kept).toBe(true);
        } finally {
          await stack.cleanup();
        }
      },
      20_000
    );
  });

  // #4414 on the real host: the stream-end completion prompt carries an admission token bound to
  // the ended stream's attempt. Untouched, its turn runs under A; when another backend admitted B
  // after the recovery-budget write, the prompt never starts a turn and leaves no obligation.
  test.each([
    ["untouched", false],
    ["B admitted after the budget write", true],
  ] as const)(
    "completion-recovery prompt on the real host (%s)",
    async (_label, rotate) => {
      const childId = rotate ? "promptrotated01" : "promptcontrol01";
      const successor = "att_00000000000000f1";
      const stack = await createStack(childId);
      const { config, taskService, svc, workspaceService, completions, streamStarts, sendOptions } =
        stack;
      try {
        const otherBackend = await createTestConfig(rootDir);
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
        const attemptA = entryOf(config, childId)!.taskAttemptId!;
        expect(await workspaceService.sendMessage(childId, "work", sendOptions)).toEqual(
          Ok(undefined)
        );
        expect(completions).toHaveLength(1);
        // Awaited before asserting, not flagged when it starts: see #4558.
        let rotation: Promise<void> | undefined;
        const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
        const editSpy = spyOn(taskService, "editWorkspaceEntry").mockImplementation(
          async (...args) => {
            const result = await editOriginal(...args);
            if (
              rotate &&
              rotation === undefined &&
              args[0] === childId &&
              entryOf(config, childId)?.taskRecoveryAttempts === 1
            ) {
              rotation = otherBackend.editConfig((cfg) => {
                for (const project of cfg.projects.values()) {
                  const ws = project.workspaces.find((w) => w.id === childId);
                  if (ws) {
                    ws.taskStatus = "running";
                    ws.taskAttemptId = successor;
                    ws.taskAttemptUnproven = true;
                  }
                }
                return cfg;
              });
              await rotation;
            }
            return result;
          }
        );
        try {
          // A's turn ends length-truncated (no agent_report): stream-end recovery prompts.
          stack.endStream(0, { finishReason: "length" }, true);
          if (rotate) {
            await until(() => rotation !== undefined, "B's admission after the budget write");
            await rotation;
            await until(
              () => !stack.sessionHarness.session.isBusy(),
              "A's turn wound down without a successor turn"
            );
            await yieldMacrotasks(20);
            expect(streamStarts).toHaveLength(1);
            expect(entryOf(config, childId)).toMatchObject({
              taskStatus: "running",
              taskAttemptId: successor,
            });
          } else {
            await until(() => completions.length === 2, "A's completion prompt dispatched");
            expect(streamStarts[1]).toMatchObject({ row: attemptA, owner: attemptA });
          }
          expect(outstanding(svc, childId)).toHaveLength(0);
        } finally {
          editSpy.mockRestore();
        }
      } finally {
        await stack.cleanup();
      }
    },
    20_000
  );

  // #4414 on the real host: a plan task's successful propose_plan hands off to exec through the
  // production stream-end listener (whose decision for the ended stream is still pending while
  // the handoff runs). The kickoff, bound to the handoff's attempt, must still start A's exec turn.
  test("plan-handoff kickoff on the real host starts the exec turn under the handoff's attempt", async () => {
    const childId = "planhandoffreal";
    const stack = await createStack(childId, { agentType: "plan", agentId: "plan" });
    const { config, taskService, svc, workspaceService, completions, streamStarts } = stack;
    try {
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(
        await workspaceService.sendMessage(childId, "plan it", { model, agentId: "plan" })
      ).toEqual(Ok(undefined));
      expect(completions).toHaveLength(1);
      const event = {
        type: "stream-end",
        workspaceId: childId,
        messageId: "assistant-1",
        metadata: { model, finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "propose-plan-1",
            toolName: "propose_plan",
            input: { plan: "the plan" },
            state: "output-available",
            output: { success: true, planPath: "/tmp/plan-handoff-real.md" },
          },
        ],
      };
      stack.aiEmitter.emit("stream-end", event);
      stack.completeStream(0, event as ReturnType<typeof streamEndEvent>);
      await until(() => completions.length === 2, "the exec kickoff turn started");
      expect(streamStarts[1]).toMatchObject({ row: attemptA, owner: attemptA });
      expect(entryOf(config, childId)).toMatchObject({ agentId: "exec", taskAttemptId: attemptA });
      expect(outstanding(svc, childId)).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  // #4454: a workflow plan task whose propose_plan succeeded but whose plan file is missing gets
  // a completion prompt instead of a report. The stream-end decision is still pending then (a
  // successful propose_plan is normally the report), so the prompt must decide it first.
  test("a workflow plan task with no plan content still gets its completion prompt (#4454)", async () => {
    const childId = "emptyplan4454";
    const stack = await createStack(childId, {
      agentType: "plan",
      agentId: "plan",
      workflowTask: { runId: "wfr_empty_plan", stepId: "plan" },
    });
    const { config, taskService, svc, workspaceService, completions, streamStarts } = stack;
    try {
      // The owning workflow run is active in production; the harness has no run store.
      spyOn(
        taskService as unknown as { getInactiveWorkflowTaskOwnerForRecovery: () => unknown },
        "getInactiveWorkflowTaskOwnerForRecovery"
      ).mockImplementation(() => Promise.resolve(null));
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(
        await workspaceService.sendMessage(childId, "plan it", { model, agentId: "plan" })
      ).toEqual(Ok(undefined));
      expect(completions).toHaveLength(1);
      const event = {
        type: "stream-end",
        workspaceId: childId,
        messageId: "assistant-1",
        metadata: { model, finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "propose-plan-1",
            toolName: "propose_plan",
            input: { plan: "the plan" },
            state: "output-available",
            output: { success: true, planPath: "/tmp/does-not-exist-4454.md" },
          },
        ],
      };
      // endStream() clears the harness's streaming flag, but builds a report-less text event;
      // this one is hand-built, so report the ended stream as no longer streaming here.
      const ai = stack.sessionHarness.aiService as unknown as { isStreaming: () => boolean };
      const realIsStreaming = ai.isStreaming.bind(ai);
      spyOn(ai, "isStreaming").mockImplementation(() =>
        completions.length === 1 ? false : realIsStreaming()
      );
      stack.aiEmitter.emit("stream-end", event);
      stack.completeStream(0, event as ReturnType<typeof streamEndEvent>);
      await until(() => completions.length === 2, "the completion prompt turn started");
      expect(streamStarts[1]).toMatchObject({
        row: attemptA,
        owner: attemptA,
        status: "awaiting_report",
      });
      expect(outstanding(svc, childId)).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);

  // A workflow step with an output schema ends its turn with plain text and no agent_report. That
  // final response is a report candidate, so the stream-end decision is still pending when schema
  // validation rejects it; the completion prompt must decide it first or its admission is refused
  // and the step waits for a report forever.
  test("a workflow step whose final response fails its output schema still gets its completion prompt", async () => {
    const childId = "schemastep01";
    const stack = await createStack(childId, {
      agentType: "exec",
      agentId: "exec",
      workflowTask: {
        runId: "wfr_schema_step",
        stepId: "implement",
        outputSchema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
      },
    });
    const { config, taskService, svc, workspaceService, completions, streamStarts } = stack;
    try {
      // The owning workflow run is active in production; the harness has no run store.
      spyOn(
        taskService as unknown as { getInactiveWorkflowTaskOwnerForRecovery: () => unknown },
        "getInactiveWorkflowTaskOwnerForRecovery"
      ).mockImplementation(() => Promise.resolve(null));
      expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
      const attemptA = entryOf(config, childId)!.taskAttemptId!;
      expect(
        await workspaceService.sendMessage(childId, "implement it", { model, agentId: "exec" })
      ).toEqual(Ok(undefined));
      expect(completions).toHaveLength(1);
      stack.endStream(0, {}, true);
      await until(() => completions.length === 2, "the completion prompt turn started");
      expect(streamStarts[1]).toMatchObject({
        row: attemptA,
        owner: attemptA,
        status: "awaiting_report",
      });
      expect(outstanding(svc, childId)).toHaveLength(0);
    } finally {
      await stack.cleanup();
    }
  }, 20_000);
});
