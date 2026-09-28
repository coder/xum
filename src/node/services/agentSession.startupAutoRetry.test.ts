import { STARTUP_RECOVERY_MAX_READ_ATTEMPTS } from "@/constants/startupRecovery";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import type { TurnCoordinator } from "./turnCoordinator";
import { runSessionTerminalPolicy } from "./agentSession.testHarness";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as fsPromises from "fs/promises";
import path from "path";
import {
  type AgentSession,
  clearProviderConfigFixableAbandonMarkers,
  type AgentSessionAIService,
} from "./agentSession";
import {
  createAgentSessionAIServiceFake,
  createAgentSessionHarness,
  createFailedTurnHandle,
  createStartedTurnHandle,
  createStreamLifecycleMocks,
  seedAutoCompactionThreshold,
} from "./agentSession.testHarness";
import { makeTestEffectRunner, type TestEffectRunner } from "./di/testEffectRunner";
import { Duration } from "effect";
import { createTestHistoryService } from "./testHistoryService";
import { waitForCondition } from "./testDispatchHelpers";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceChatMessage, SendMessageOptions } from "@/common/orpc/types";
import {
  createMuxMessage,
  pickStartupRetrySendOptions,
  type MuxMessage,
} from "@/common/types/message";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Err, Ok } from "@/common/types/result";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { formatSubagentReportEnvelope } from "@/common/utils/subagentReportEnvelope";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { StreamErrorType } from "@/common/types/errors";

interface AutoRetryResumeRequest {
  options: SendMessageOptions;
  agentInitiated?: boolean;
  goalKind?: typeof GOAL_CONTINUATION_KIND;
}

interface RetryableSessionForTests {
  retryActiveStream: () => Promise<void>;
  lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
}

interface SessionBundle {
  session: AgentSession;
  config: Config;
  historyService: HistoryService;
  aiService: AgentSessionAIService;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
  cleanup: () => Promise<void>;
}

async function createSessionBundle(
  workspaceId: string,
  aiServiceOverrides?: Partial<AgentSessionAIService>,
  options?: {
    /**
     * Runs the retry backoff on virtual time: the session schedules its RetryManager on the
     * stream manager's runner, so a test fires a scheduled retry with `fireScheduledRetry`.
     */
    clock?: TestEffectRunner;
  }
): Promise<SessionBundle> {
  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: workspaceId,
    projectName: "project",
    projectPath: "/tmp/project",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    aiSettingsByAgent: {
      [WORKSPACE_DEFAULTS.agentId]: {
        model: "anthropic:claude-sonnet-4-5",
        thinkingLevel: "medium",
      },
    },
  };

  return createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      ...aiServiceOverrides,
    },
    initStateManagerOverrides: {
      replayInit: mock(() => Promise.resolve()),
    },
    ...(options?.clock
      ? { streamManager: { ...createStreamLifecycleMocks(), effectRunner: options.clock.runner } }
      : {}),
    captureEvents: true,
  });
}

/** Advances virtual time past the latest scheduled backoff, firing that retry. */
async function fireScheduledRetry(
  clock: TestEffectRunner,
  events: WorkspaceChatMessage[]
): Promise<void> {
  const scheduled = events.findLast(
    (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-scheduled" }> =>
      event.type === "auto-retry-scheduled"
  );
  if (!scheduled) throw new Error("Expected a scheduled auto-retry to fire");
  await clock.adjust(Duration.millis(scheduled.delayMs));
}

let failedTurnCount = 0;

/**
 * Runs one turn whose stream fails with `errorType`. A non-retryable failure persists the
 * startup abandon marker for the turn's user row through the session's real writer.
 */
async function failTurnWith(
  session: AgentSession,
  aiService: AgentSessionAIService,
  errorType: StreamErrorType
): Promise<void> {
  failedTurnCount += 1;
  const messageId = `assistant-failed-${failedTurnCount}`;
  const stream = spyOn(aiService, "streamMessage").mockResolvedValueOnce(
    Ok(createFailedTurnHandle(messageId, { error: `${errorType} failure`, errorType }))
  );
  try {
    const result = await session.sendMessage("Interrupted prompt", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(result.success).toBe(true);
    // The failed turn settles only after its terminal policy (including the marker write) ran.
    await session.waitForIdle();
  } finally {
    stream.mockRestore();
  }
}

/** Stream starts that fail as retryable runtime errors, the way a cold runtime refuses them. */
function failingStreamStart(): Partial<AgentSessionAIService> {
  return {
    streamMessage: mock(() =>
      Promise.resolve(Err({ type: "runtime_start_failed" as const, message: "startup failed" }))
    ),
  };
}

/**
 * Sends a turn whose stream start fails, which arms the auto-retry of that send through the
 * public path (retry envelope + scheduled backoff) instead of seeding private retry state.
 */
async function sendIntoScheduledRetry(
  session: AgentSession,
  events: WorkspaceChatMessage[]
): Promise<void> {
  const sendResult = await session.sendMessage("hello", {
    model: "anthropic:claude-sonnet-4-5",
    agentId: "exec",
  });
  expect(sendResult.success).toBe(false);
  expect(events.filter((event) => event.type === "auto-retry-scheduled")).toHaveLength(1);
}

/** The durable auto-retry preference file that a restarted session reads. */
function autoRetryPreferencePath(config: Config, workspaceId: string): string {
  return path.join(config.sessionsDir, workspaceId, "auto-retry-preference.json");
}

describe("AgentSession startup auto-retry recovery", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  test("schedules startup auto-retry for interrupted user tail", async () => {
    const workspaceId = "startup-retry-user-tail";
    const clock = makeTestEffectRunner();
    const { session, historyService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Hello from interrupted turn", {
        timestamp: Date.now(),
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
        disableWorkspaceAgents: true,
      })
    );
    expect(appendResult.success).toBe(true);

    const appendSnapshotResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snapshot-1", "user", "<snapshot>", {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["token"],
      })
    );
    expect(appendSnapshotResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    const scheduledEvent = events.find((event) => event.type === "auto-retry-scheduled");
    expect(scheduledEvent).toBeDefined();

    // The scheduled retry resumes with the options recovered from the interrupted user row.
    const resumeStream = spyOn(session, "resumeStream").mockResolvedValue(Ok({ started: true }));
    await fireScheduledRetry(clock, events);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    const retryOptions = { options: resumeStream.mock.calls[0][0] };
    expect(retryOptions.options.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.options.agentId).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(retryOptions.options.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);
    expect(retryOptions.options.disableWorkspaceAgents).toBe(true);

    await session.dispose();
  });

  test("startup auto-retry does not dispatch once the workspace is archived on disk", async () => {
    const workspaceId = "startup-retry-archived";
    const { session, config, historyService, events, cleanup } =
      await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before the archive", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    // The archive lands while the check is still reading history (a regular session the client
    // created is not disposed by archive, so only the durable state can stop the dispatch).
    const getLastMessages = historyService.getLastMessages.bind(historyService);
    spyOn(historyService, "getLastMessages").mockImplementation(async (id, count) => {
      const result = await getLastMessages(id, count);
      await config.editConfig((cfg) => {
        cfg.projects.set("/tmp/project", {
          workspaces: [
            {
              id: workspaceId,
              path: `/tmp/project/${workspaceId}`,
              name: workspaceId,
              archivedAt: new Date().toISOString(),
            },
          ],
        });
        return cfg;
      });
      return result;
    });

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    // Completed rather than deferred: nothing reruns the check for an archived workspace.

    await session.dispose();
  });

  test("auto-retry abandons instead of resuming once the workspace is archived on disk", async () => {
    const workspaceId = "startup-retry-archived-before-timer";
    const clock = makeTestEffectRunner();
    const { session, config, events, cleanup } = await createSessionBundle(
      workspaceId,
      failingStreamStart(),
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    await sendIntoScheduledRetry(session, events);
    const resumeStreamMock = spyOn(session, "resumeStream").mockResolvedValue(
      Ok({ started: true })
    );

    // The archive lands during the backoff countdown; only the durable state can stop the timer.
    await config.editConfig((cfg) => {
      cfg.projects.set("/tmp/project", {
        workspaces: [
          {
            id: workspaceId,
            path: `/tmp/project/${workspaceId}`,
            name: workspaceId,
            archivedAt: new Date().toISOString(),
          },
        ],
      });
      return cfg;
    });

    await fireScheduledRetry(clock, events);

    expect(resumeStreamMock).not.toHaveBeenCalled();
    const abandonedReasons = events
      .filter(
        (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-abandoned" }> =>
          event.type === "auto-retry-abandoned"
      )
      .map((event) => event.reason);
    expect(abandonedReasons).toEqual(["workspace_archived"]);

    await session.dispose();
  });

  test("beginShutdown cancels the pending retry and stops re-arming or streaming", async () => {
    const workspaceId = "startup-retry-shutdown";
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
    );
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId, {
      streamMessage,
    });
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      handleStreamFailureForAutoRetry: (error: { type: string; message?: string }) => Promise<void>;
    };
    await privateSession.handleStreamFailureForAutoRetry({ type: "unknown", message: "boom" });
    expect(session.shouldRetainAfterStartupRecovery()).toBe(true);
    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(scheduledBefore).toBe(1);

    session.beginShutdown();

    expect(session.shouldRetainAfterStartupRecovery()).toBe(false);
    await privateSession.handleStreamFailureForAutoRetry({ type: "unknown", message: "boom" });
    expect(events.filter((event) => event.type === "auto-retry-scheduled").length).toBe(
      scheduledBefore
    );
    // Not disposed, but sends are refused before any row lands: a follow-up row persisted here
    // would read as a dispatched turn on the next startup while its stream never ran.
    const sendResult = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(sendResult.success).toBe(false);
    expect(streamMessage).not.toHaveBeenCalled();
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);

    await session.dispose();
  });

  test.each(["materialize", "append"] as const)(
    "beginShutdown inside the %s await preserves only accepted user input",
    async (window) => {
      const workspaceId = `startup-retry-shutdown-mid-${window}`;
      const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
      );
      const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
        streamMessage,
      });
      cleanups.push(cleanup);
      const seeded = [
        createMuxMessage("user-0", "user", "earlier turn", { timestamp: Date.now() }),
        createMuxMessage("assistant-0", "assistant", "earlier answer", { timestamp: Date.now() }),
      ];
      for (const row of seeded) {
        expect((await historyService.appendToHistory(workspaceId, row)).success).toBe(true);
      }

      // Shutdown lands after the pre-persist latch check passed, inside a later pre-acceptance
      // await: snapshot materialization, or the user row's own append (already durable then).
      if (window === "materialize") {
        const internals = session as unknown as {
          materializeAgentSkillSnapshots: (...args: unknown[]) => Promise<MuxMessage[]>;
        };
        const materialize = internals.materializeAgentSkillSnapshots.bind(session);
        internals.materializeAgentSkillSnapshots = async (...args: unknown[]) => {
          const snapshots = await materialize(...args);
          session.beginShutdown();
          return snapshots;
        };
      } else {
        const append = historyService.acceptCompactionReplacement.bind(historyService);
        spyOn(historyService, "acceptCompactionReplacement").mockImplementation(async (...args) => {
          const result = await append(...args);
          session.beginShutdown();
          return result;
        });
      }

      const sendResult = await session.sendMessage("hello", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      });
      expect(sendResult.success).toBe(false);
      expect(streamMessage).not.toHaveBeenCalled();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data.slice(0, seeded.length) : ["unexpected"]).toMatchObject(
        seeded
      );
      expect(history.success && history.data.length).toBe(
        seeded.length + (window === "append" ? 1 : 0)
      );
      if (window === "append" && history.success)
        expect(history.data.at(-1)?.parts).toMatchObject([{ type: "text", text: "hello" }]);

      await session.dispose();
    }
  );

  test.each(["materialize", "append"] as const)(
    "beginShutdown inside an edit's %s await keeps the replacement row after truncation",
    async (window) => {
      const workspaceId = `startup-retry-shutdown-edit-${window}`;
      const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
        Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
      );
      const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
        streamMessage,
      });
      cleanups.push(cleanup);
      for (const [id, role, text] of [
        ["u0", "user", "first turn"],
        ["a0", "assistant", "first answer"],
        ["u1", "user", "original wording"],
        ["a1", "assistant", "answer to the original"],
      ] as const) {
        const row = createMuxMessage(id, role, text, { timestamp: Date.now() });
        expect((await historyService.appendToHistory(workspaceId, row)).success).toBe(true);
      }

      // The edit has already truncated u1 and a1 when shutdown lands; only the replacement row
      // records the user's input now, so it must survive instead of being rolled back.
      if (window === "materialize") {
        const internals = session as unknown as {
          materializeAgentSkillSnapshots: (...args: unknown[]) => Promise<MuxMessage[]>;
        };
        const materialize = internals.materializeAgentSkillSnapshots.bind(session);
        internals.materializeAgentSkillSnapshots = async (...args: unknown[]) => {
          const snapshots = await materialize(...args);
          session.beginShutdown();
          return snapshots;
        };
      } else {
        const append = historyService.acceptCompactionReplacement.bind(historyService);
        spyOn(historyService, "acceptCompactionReplacement").mockImplementation(async (...args) => {
          const result = await append(...args);
          session.beginShutdown();
          return result;
        });
      }

      const sendResult = await session.sendMessage("edited wording", {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        editMessageId: "u1",
      });
      expect(sendResult.success).toBe(false);
      expect(streamMessage).not.toHaveBeenCalled();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data : ["unexpected"]).toMatchObject([
        { id: "u0" },
        { id: "a0" },
        { role: "user", parts: [{ type: "text", text: "edited wording" }] },
      ]);

      await session.dispose();
    }
  );

  test("beginShutdown during pre-stream awaits stops the stream before the provider", async () => {
    const workspaceId = "startup-retry-shutdown-mid-prepare";
    const streamMessage = mock<AgentSessionAIService["streamMessage"]>(() =>
      Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal, "assistant-1")))
    );
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
      streamMessage,
    });
    cleanups.push(cleanup);

    // Shutdown lands while the stream start is already past its entry check, awaiting disk I/O.
    const commitPartial = historyService.commitPartial.bind(historyService);
    spyOn(historyService, "commitPartial").mockImplementation(async (id) => {
      const result = await commitPartial(id);
      session.beginShutdown();
      return result;
    });

    const sendResult = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(sendResult.success).toBe(true);
    expect(streamMessage).not.toHaveBeenCalled();

    await session.dispose();
  });

  test("visible completed subagent report cards do not schedule startup auto-retry", async () => {
    const workspaceId = "startup-retry-subagent-report-card";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(
        "completed-subagent-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: "child-task",
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    await session.dispose();
  });

  test("visible completed subagent report cards do not mask recoverable assistant partials", async () => {
    const workspaceId = "startup-retry-subagent-report-with-partial";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("original-user", "user", "Continue the original task", {
        timestamp: Date.now(),
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(
        "completed-subagent-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: "child-task",
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true, uiVisible: true }
      )
    );
    await historyService.writePartial(
      workspaceId,
      createMuxMessage("assistant-partial", "assistant", "Interrupted response", {
        timestamp: Date.now(),
        partial: true,
      })
    );

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    await session.dispose();
  });

  test("hidden completed subagent reports preserve the existing startup retry fallback", async () => {
    const workspaceId = "startup-retry-hidden-subagent-report";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("original-user", "user", "Continue the original task", {
        timestamp: Date.now(),
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage(
        "hidden-completed-subagent-report",
        "user",
        formatSubagentReportEnvelope({
          taskId: "child-task",
          agentType: "explore",
          status: "completed",
          title: "Final report",
          reportMarkdown: "Investigation complete.",
        }),
        { timestamp: Date.now(), synthetic: true }
      )
    );

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    await session.dispose();
  });

  test("startup auto-retry reuses workspace-turn metadata from the retry user message", async () => {
    const workspaceId = "startup-retry-workspace-turn-metadata";
    const clock = makeTestEffectRunner();
    const { session, historyService, aiService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-id",
    };
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Complete the workspace turn", {
        timestamp: Date.now(),
        retrySendOptions: { model: "openai:gpt-4o", agentId: "exec" },
        muxMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const streamed = Promise.withResolvers<void>();
    const streamMessageMock = mock<AgentSessionAIService["streamMessage"]>(() => {
      streamed.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    aiService.streamMessage = streamMessageMock;

    await session.ensureStartupAutoRetryCheck();
    await fireScheduledRetry(clock, events);
    await streamed.promise;

    // The recovered envelope's metadata reaches the provider request itself.
    expect(streamMessageMock).toHaveBeenCalledTimes(1);
    expect(streamMessageMock.mock.calls[0]?.[0]).toMatchObject({ muxMetadata });

    await session.dispose();
  });

  test.each([
    ["disabled (100%) persisted threshold", { seed: 100 }, false],
    ["corrupt persisted threshold entry", { corrupt: true }, true],
  ] as const)(
    "startup recovery resumes with the %s and no frontend push",
    async (_label, fixture, rolloverAvailable) => {
      const workspaceId = "startup-retry-persisted-threshold";
      const clock = makeTestEffectRunner();
      const { session, config, historyService, aiService, events, cleanup } =
        await createSessionBundle(workspaceId, undefined, { clock });
      cleanups.push(() => clock.dispose(), cleanup);
      const model = "openai:gpt-4o";
      if ("seed" in fixture) {
        await seedAutoCompactionThreshold(config, model, fixture.seed);
      } else {
        // Written behind the schema on purpose: a hand-edited or downgraded config must
        // resolve to the default without crashing startup.
        await fsPromises.writeFile(
          path.join(config.rootDir, "config.json"),
          JSON.stringify({
            projects: [],
            userPreferences: {
              ai: { autoCompactionThresholdByModel: { [model]: "seventy", "other:model": 100 } },
            },
          })
        );
        // The file itself loads (the sibling entry survives); only the corrupt entry is dropped.
        expect(
          config.loadConfigOrDefault().userPreferences?.ai?.autoCompactionThresholdByModel
        ).toEqual({ "other:model": 100 });
      }
      const appendResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user-1", "user", "Interrupted token-budget turn", {
          timestamp: Date.now(),
          retrySendOptions: pickStartupRetrySendOptions({
            model,
            agentId: "exec",
            experiments: { tokenBudget: true },
          }),
        })
      );
      expect(appendResult.success).toBe(true);
      const streamed = Promise.withResolvers<void>();
      const streamMessageMock = mock<AgentSessionAIService["streamMessage"]>(() => {
        streamed.resolve();
        return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
      });
      aiService.streamMessage = streamMessageMock;

      await session.ensureStartupAutoRetryCheck();
      await fireScheduledRetry(clock, events);
      await streamed.promise;

      // The resumed request's rollover gate reads the persisted per-model threshold directly;
      // no RPC could have pushed a slider value before recovery ran.
      expect(streamMessageMock).toHaveBeenCalledTimes(1);
      expect(streamMessageMock.mock.calls[0]?.[0].contextBudgetRolloverAvailable).toBe(
        rolloverAvailable
      );

      await session.dispose();
    }
  );

  test("startup auto-retry does not stamp workflow-result metadata on assistant streams", async () => {
    const workspaceId = "startup-retry-workflow-result-metadata";
    const clock = makeTestEffectRunner();
    const { session, historyService, aiService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);
    const workflowMetadata = {
      type: "workflow-result" as const,
      rawCommand: "/deep-research mux",
      runId: "wfr_1",
    };
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Use the workflow result", {
        timestamp: Date.now(),
        retrySendOptions: pickStartupRetrySendOptions({
          model: "openai:gpt-4o",
          agentId: "exec",
          muxMetadata: workflowMetadata,
        }),
        muxMetadata: workflowMetadata,
      })
    );
    expect(appendResult.success).toBe(true);
    const streamed = Promise.withResolvers<void>();
    const streamMessageMock = mock<AgentSessionAIService["streamMessage"]>(() => {
      streamed.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    aiService.streamMessage = streamMessageMock;

    await session.ensureStartupAutoRetryCheck();
    await fireScheduledRetry(clock, events);
    await streamed.promise;

    expect(streamMessageMock).toHaveBeenCalledTimes(1);
    expect(streamMessageMock.mock.calls[0]?.[0].muxMetadata).toBeUndefined();

    await session.dispose();
  });

  test("restores persisted retry send options for startup auto-retry", async () => {
    const workspaceId = "startup-retry-preserve-options";
    const clock = makeTestEffectRunner();
    const { session, historyService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted with custom send options", {
        timestamp: Date.now(),
        kind: GOAL_CONTINUATION_KIND,
        retrySendOptions: {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          thinkingLevel: "high",
          toolPolicy: [{ regex_match: "bash", action: "disable" }],
          additionalSystemInstructions: "Use one sentence.",
          maxOutputTokens: 2048,
          providerOptions: {
            anthropic: {
              use1MContext: true,
              use1MContextModels: ["anthropic:claude-sonnet-4-5"],
            },
          },
          allowAgentSetGoal: true,
          disableWorkspaceAgents: true,
        },
      })
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    // The scheduled retry resumes with every persisted option and the goal attribution.
    const resumeStream = spyOn(session, "resumeStream").mockResolvedValue(Ok({ started: true }));
    await fireScheduledRetry(clock, events);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    const [options, internal] = resumeStream.mock.calls[0];
    const retryOptions = { options, goalKind: internal?.goalKind };

    expect(retryOptions.options.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.options.agentId).toBe("exec");
    expect(retryOptions.options.thinkingLevel).toBe("high");
    expect(retryOptions.options.additionalSystemInstructions).toBe("Use one sentence.");
    expect(retryOptions.options.maxOutputTokens).toBe(2048);
    expect(retryOptions.options.toolPolicy).toEqual([{ regex_match: "bash", action: "disable" }]);
    expect(retryOptions.options.allowAgentSetGoal).toBe(true);
    expect(retryOptions.options.disableWorkspaceAgents).toBe(true);
    expect(retryOptions.goalKind).toBe(GOAL_CONTINUATION_KIND);

    expect(retryOptions.options.providerOptions?.anthropic?.use1MContext).toBe(true);

    await session.dispose();
  });

  test("startup auto-retry discards goal attribution when the persisted goal ID is malformed", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cQt3o): chat.jsonl is unchecked JSON. A
    // present-but-invalid goalId must not resume the turn as goal-driven with
    // untrustworthy identity — a later compaction would persist a missing-ID
    // follow-up that bypasses buildGoalRedispatchAdmission entirely.
    const workspaceId = "startup-retry-malformed-goal-id";
    const clock = makeTestEffectRunner();
    const { session, historyService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted goal turn", {
        timestamp: Date.now(),
        kind: GOAL_CONTINUATION_KIND,
        goalId: "" as unknown as string,
        retrySendOptions: {
          model: "anthropic:claude-sonnet-4-5",
          agentId: "exec",
          goalKind: GOAL_CONTINUATION_KIND,
        },
      })
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    // The retry still resumes the turn, but not as goal-driven.
    const resumeStream = spyOn(session, "resumeStream").mockResolvedValue(Ok({ started: true }));
    await fireScheduledRetry(clock, events);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    const internal = resumeStream.mock.calls[0][1];
    expect(internal?.goalKind).toBeUndefined();
    expect(internal?.goalId).toBeUndefined();

    await session.dispose();
  });

  test.each([
    undefined,
    "queued",
    "starting",
    "running",
    "awaiting_report",
    "interrupted",
    "reported",
  ] as const)("leaves child startup recovery to TaskService (status=%s)", async (taskStatus) => {
    const workspaceId = "startup-child-owned";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId, {
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: workspaceId,
            name: workspaceId,
            projectName: "project",
            projectPath: "/tmp/project",
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
            parentWorkspaceId: "parent",
            taskStatus,
          })
        )
      ),
    });
    cleanups.push(cleanup);
    const followUp = spyOn(
      session as unknown as { dispatchPendingFollowUp(): Promise<boolean> },
      "dispatchPendingFollowUp"
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Unfinished child turn")
    );
    try {
      await session.ensureStartupAutoRetryCheck();
      expect(followUp).not.toHaveBeenCalled();
      expect(session.hasPendingAutoRetry()).toBe(false);
      expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  test.each([
    { reason: "aborted", userMessageId: "user-1", stopped: true },
    { reason: "aborted", userMessageId: undefined, stopped: true },
    { reason: "aborted", userMessageId: "older-user", stopped: false },
    { reason: "context_exceeded", userMessageId: "user-1", stopped: false },
  ])("reads applicable durable user-stop evidence: %j", async (marker) => {
    const workspaceId = "startup-task-stop";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Current intent")
    );
    await fsPromises.writeFile(
      path.join(config.sessionsDir, workspaceId, "auto-retry-preference.json"),
      JSON.stringify({
        startupAutoRetryAbandon: { reason: marker.reason, userMessageId: marker.userMessageId },
      })
    );
    try {
      expect(await session.getStartupRecoveryState()).toBe(
        marker.stopped ? "stopped" : "interrupted"
      );
      const history = await historyService.getLastMessages(workspaceId, 20);
      expect(history.success && history.data.map((message) => message.id)).toEqual(["user-1"]);
    } finally {
      await session.dispose();
    }
  });

  test("preserves a scoped Stop until history proves a newer user intent", async () => {
    const workspaceId = "startup-long-stopped-task";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendManyToHistory(workspaceId, [
      createMuxMessage("stopped-user", "user", "Long-running task"),
      ...Array.from({ length: 21 }, (_, index) =>
        createMuxMessage(`assistant-${index}`, "assistant", "Work")
      ),
    ]);
    const preferencePath = path.join(config.sessionsDir, workspaceId, "auto-retry-preference.json");
    await fsPromises.writeFile(
      preferencePath,
      JSON.stringify({
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "stopped-user" },
      })
    );
    try {
      expect(await session.getStartupRecoveryState()).toBe("stopped");
      spyOn(historyService, "getLastMessages").mockRejectedValueOnce(new Error("unreadable"));
      expect(await session.getStartupRecoveryState()).toBe("stopped");
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("notice", "user", "Snapshot", { synthetic: true })
      );
      expect(await session.getStartupRecoveryState()).toBe("stopped");
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("guidance", "user", "Continue", {
          synthetic: true,
          retrySendOptions: { model: "openai:gpt-4o", agentId: "exec", agentInitiated: true },
        })
      );
      expect(await session.getStartupRecoveryState()).toBe("interrupted");
      expect(JSON.parse(await fsPromises.readFile(preferencePath, "utf-8"))).toMatchObject({
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "stopped-user" },
      });
    } finally {
      await session.dispose();
    }
  });

  test("blocks task recovery on a real partial-file read error but not a missing partial", async () => {
    const workspaceId = "startup-unreadable-partial";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user", "user", "Pending work")
    );
    const partialPath = path.join(config.sessionsDir, workspaceId, "partial.json");
    await fsPromises.mkdir(partialPath);
    const wait = spyOn(
      session as unknown as { waitForStartupReadRetry(delay: number): Promise<void> },
      "waitForStartupReadRetry"
    ).mockResolvedValue(undefined);
    try {
      expect(await session.getStartupRecoveryState()).toBe("blocked");
      expect(wait).toHaveBeenCalled();
      await fsPromises.rm(partialPath, { recursive: true });
      expect(await session.getStartupRecoveryState()).toBe("interrupted");
    } finally {
      wait.mockRestore();
      await session.dispose();
    }
  });

  test.each(['{"id":', "null", "{}", '{"id":"bad","role":"assistant","parts":null}'])(
    "does not strand a task behind corrupt partial JSON (%s)",
    async (corrupt) => {
      const workspaceId = "startup-corrupt-partial";
      const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
      cleanups.push(cleanup);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("user", "user", "Continue")
      );
      await fsPromises.writeFile(
        path.join(config.sessionsDir, workspaceId, "partial.json"),
        corrupt
      );
      // One partial read per probe attempt: a single read means no backoff retry happened.
      const readPartial = spyOn(historyService, "readPartial");
      try {
        expect(await session.getStartupRecoveryState()).toBe("interrupted");
        expect(readPartial).toHaveBeenCalledTimes(1);
      } finally {
        readPartial.mockRestore();
        await session.dispose();
      }
    }
  );

  test.each(["preference", "partial", "history"] as const)(
    "bounds a hung %s read without releasing its physical lease",
    async (kind) => {
      const { session, config, historyService, events, cleanup } = await createSessionBundle(
        `hung-${kind}`
      );
      cleanups.push(cleanup);
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const preferencePath = autoRetryPreferencePath(config, `hung-${kind}`);
      const readFile = fsPromises.readFile.bind(fsPromises);
      let preferenceReadHeld = false;
      const readPartial = historyService.readPartial.bind(historyService);
      const readHistory = historyService.getLastMessages.bind(historyService);
      const pause = async () => {
        entered.resolve();
        await gate.promise;
      };
      const preferenceSpy =
        kind === "preference"
          ? spyOn(fsPromises, "readFile").mockImplementation((async (
              ...args: Parameters<typeof fsPromises.readFile>
            ) => {
              if (args[0] === preferencePath && !preferenceReadHeld) {
                preferenceReadHeld = true;
                await pause();
              }
              return readFile(...args);
            }) as typeof fsPromises.readFile)
          : undefined;
      const partialSpy =
        kind === "partial"
          ? spyOn(historyService, "readPartial").mockImplementationOnce(async (...args) => {
              await pause();
              return readPartial(...args);
            })
          : undefined;
      const historySpy =
        kind === "history"
          ? spyOn(historyService, "getLastMessages").mockImplementationOnce(async (...args) => {
              await pause();
              return readHistory(...args);
            })
          : undefined;
      try {
        const probe = session.getStartupRecoveryState(25);
        await entered.promise;
        expect(await probe).toBe("blocked");
        let disposed = false;
        const disposal = session.dispose().then(() => {
          disposed = true;
        });
        await Promise.resolve();
        expect(disposed).toBe(false);
        gate.resolve();
        await disposal;
        expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
      } finally {
        gate.resolve();
        preferenceSpy?.mockRestore();
        partialSpy?.mockRestore();
        historySpy?.mockRestore();
        await session.dispose();
      }
    }
  );

  test.each([false, true])(
    "classifies completed versus interrupted assistant tails (%s)",
    async (partial) => {
      const workspaceId = "startup-tail-state";
      const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
      cleanups.push(cleanup);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("answer", "assistant", "Done", { partial })
      );
      try {
        expect(await session.getStartupRecoveryState()).toBe(partial ? "interrupted" : "idle");
      } finally {
        await session.dispose();
      }
    }
  );

  test("task read retries settle while a provider stream remains active", async () => {
    const workspaceId = "startup-busy-read-retry";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId, {
      isStreaming: mock(() => true),
    });
    cleanups.push(cleanup);
    await historyService.appendToHistory(workspaceId, createMuxMessage("user", "user", "Work"));
    const read = spyOn(historyService, "getLastMessages").mockRejectedValueOnce(
      new Error("busy disk")
    );
    try {
      expect(await session.getStartupRecoveryState()).toBe("interrupted");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await session.dispose();
    }
  });

  test("retries a transient task blocker read without restarting the app", async () => {
    const workspaceId = "startup-transient-partial";
    const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user", "user", "Pending work")
    );
    const partialPath = path.join(config.sessionsDir, workspaceId, "partial.json");
    await fsPromises.mkdir(partialPath);
    const wait = spyOn(
      session as unknown as { waitForStartupReadRetry(delay: number): Promise<void> },
      "waitForStartupReadRetry"
    ).mockImplementationOnce(() => fsPromises.rm(partialPath, { recursive: true }));
    try {
      expect(await session.getStartupRecoveryState()).toBe("interrupted");
      expect(wait).toHaveBeenCalledTimes(1);
    } finally {
      wait.mockRestore();
      await session.dispose();
    }
  });

  test.each(["assistant", "user"] as const)(
    "reuses known startup identity for a %s tail without rescanning",
    async (role) => {
      const workspaceId = "known-startup-identity";
      const { session, aiService, historyService, cleanup } =
        await createSessionBundle(workspaceId);
      cleanups.push(cleanup);
      await historyService.appendToHistory(workspaceId, createMuxMessage("tail", role, "Work"));
      const metadata = await aiService.getWorkspaceMetadata(workspaceId);
      if (!metadata.success) throw new Error("Missing fixture metadata");
      const scan = spyOn(aiService, "getWorkspaceMetadata");
      scan.mockClear();
      try {
        await session.runStartupRecovery(metadata.data);
        expect(scan).not.toHaveBeenCalled();
      } finally {
        scan.mockRestore();
        await session.dispose();
      }
    }
  );

  test("does not start recovery while workspace identity is unavailable", async () => {
    const { session, historyService, events, cleanup } = await createSessionBundle(
      "startup-unknown",
      {
        getWorkspaceMetadata: mock(() => Promise.resolve(Err("unavailable"))),
      }
    );
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      "startup-unknown",
      createMuxMessage("user-1", "user", "Unfinished")
    );
    const followUp = spyOn(
      session as unknown as { dispatchPendingFollowUp(): Promise<boolean> },
      "dispatchPendingFollowUp"
    );
    try {
      await session.runStartupRecovery();
      expect(followUp).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    } finally {
      await session.dispose();
    }
  });

  test("replays pending auto-retry schedule during reconnect catch-up", async () => {
    const workspaceId = "startup-retry-replay-snapshot";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before reconnect", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await session.ensureStartupAutoRetryCheck();

    const replayEvents: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => {
      replayEvents.push(message);
    });

    const scheduledIndex = replayEvents.findIndex((event) => event.type === "auto-retry-scheduled");
    const caughtUpIndex = replayEvents.findIndex((event) => event.type === "caught-up");

    expect(scheduledIndex).toBeGreaterThanOrEqual(0);
    expect(caughtUpIndex).toBeGreaterThanOrEqual(0);
    expect(scheduledIndex).toBeLessThan(caughtUpIndex);

    await session.dispose();
  });

  test.each(
    (["unrelated", "sibling"] as const).flatMap((relationship) =>
      [false, true].flatMap((correlated) =>
        [false, true].map((partial) => ({ relationship, correlated, partial }))
      )
    )
  )(
    "startup peer recovery keeps $relationship policy (correlated=$correlated, partial=$partial)",
    async ({ relationship, correlated, partial }) => {
      const workspaceId = "startup-peer-policy";
      const { session, config, historyService, aiService, events, cleanup } =
        await createSessionBundle(workspaceId);
      cleanups.push(cleanup);
      // Even current consent cannot reconstruct all of the original admission guards after a crash.
      await config.editConfig((cfg) => {
        cfg.projects.set("/tmp/project", {
          workspaces: [
            {
              id: workspaceId,
              name: workspaceId,
              path: `/tmp/project/${workspaceId}`,
              unrelatedWorkspaceConsent: "enabled",
            },
          ],
        });
        return cfg;
      });
      const attribution = { fromWorkspaceId: "peer-sender", relationship };
      const muxMetadata = correlated
        ? {
            type: "workspace-turn-task" as const,
            taskHandleId: "wst_peer",
            ownerWorkspaceId: "owner",
            turnId: "turn",
            agentPeerMessageTrigger: attribution,
          }
        : { type: "agent-peer-message" as const, ...attribution };
      for (const row of [
        createMuxMessage("earlier-user", "user", "Earlier request"),
        createMuxMessage("earlier-answer", "assistant", "Earlier answer"),
        createMuxMessage("peer-payload", "assistant", "Peer request", {
          synthetic: true,
          muxMetadata,
        }),
        createMuxMessage("peer-trigger", "user", "Agent message received.", {
          synthetic: true,
          uiVisible: true,
          muxMetadata,
          retrySendOptions: { model: "anthropic:claude-sonnet-4-5", agentId: "exec" },
        }),
      ]) {
        expect((await historyService.appendToHistory(workspaceId, row)).success).toBe(true);
      }
      if (partial) {
        const partialMessage = createMuxMessage("partial", "assistant", "Interrupted response", {
          partial: true,
        });
        // Real streams allocate the assistant row's sequence before writing the partial file.
        expect((await historyService.appendToHistory(workspaceId, partialMessage)).success).toBe(
          true
        );
        expect((await historyService.writePartial(workspaceId, partialMessage)).success).toBe(true);
      }
      const stream = spyOn(aiService, "streamMessage");
      try {
        await session.runStartupRecovery();
        expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(
          relationship === "sibling"
        );
        if (relationship === "unrelated") {
          expect(events.some((event) => event.type === "auto-retry-abandoned")).toBe(true);
          expect(stream).not.toHaveBeenCalled();
          // Do not fall back to an earlier user row with the refused payload still in context.
          expect(
            (session as unknown as RetryableSessionForTests).lastAutoRetryResumeRequest
          ).toBeUndefined();
        } else {
          await (session as unknown as RetryableSessionForTests).retryActiveStream();
          expect(stream).toHaveBeenCalledTimes(1);
        }
      } finally {
        stream.mockRestore();
        await session.dispose();
      }
    }
  );

  test.each([
    { type: "agent-peer-message", relationship: "unrelated" },
    { type: "agent-peer-message", fromWorkspaceId: "sender" },
    { type: "workspace-turn-task", agentPeerMessageTrigger: true },
    { type: "workspace-turn-task", agentPeerMessageTrigger: null },
  ])("fails closed on malformed startup peer metadata %j", async (muxMetadata) => {
    const workspaceId = "startup-peer-malformed";
    const { session, historyService, aiService, events, cleanup } =
      await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const trigger = createMuxMessage("trigger", "user", "Agent message received.", {
      synthetic: true,
      uiVisible: true,
    });
    // Persisted history is untyped; corrupt peer attribution must not become user authority.
    Object.assign(trigger.metadata!, { muxMetadata });
    expect((await historyService.appendToHistory(workspaceId, trigger)).success).toBe(true);
    const stream = spyOn(aiService, "streamMessage");
    try {
      await session.runStartupRecovery();
      expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
      expect(events.some((event) => event.type === "auto-retry-abandoned")).toBe(true);
      expect(stream).not.toHaveBeenCalled();
    } finally {
      stream.mockRestore();
      await session.dispose();
    }
  });

  test("does not recover an unrelated send refused after durable acceptance", async () => {
    const workspaceId = "startup-unrelated-refused";
    const {
      session,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const muxMetadata = {
      type: "agent-peer-message" as const,
      fromWorkspaceId: "unrelated-sender",
      relationship: "unrelated" as const,
    };
    let revoked = false;
    const stream = spyOn(aiService, "streamMessage");
    const result = await session.sendMessage(
      "Agent message received.",
      { model: "anthropic:claude-sonnet-4-5", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        admissionStale: () => revoked,
        preTurnMessages: [
          createMuxMessage("peer-payload", "assistant", "Untrusted request", {
            synthetic: true,
            uiVisible: true,
            muxMetadata,
          }),
        ],
        // The history rows are already durable, but the final session admission has not run.
        onAccepted: () => {
          revoked = true;
        },
      }
    );
    expect(revoked).toBe(true);
    expect(result.success).toBe(false);
    expect(stream).not.toHaveBeenCalled();
    const beforeRestart = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(beforeRestart.success && beforeRestart.data.map((row) => row.role)).toEqual([
      "assistant",
      "user",
    ]);
    await session.dispose();

    const recovered = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });
    cleanups.push(recovered.cleanup);
    try {
      await recovered.session.runStartupRecovery();
      expect(recovered.events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
      expect(recovered.events.some((event) => event.type === "auto-retry-abandoned")).toBe(true);
      expect(stream).not.toHaveBeenCalled();
      expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(beforeRestart);

      // An old peer payload in history must not prevent a new, explicit user turn.
      stream.mockImplementation(() =>
        Promise.resolve(Ok(createStartedTurnHandle(recovered.session.closingSignal)))
      );
      expect(
        (
          await recovered.session.sendMessage("I choose to continue", {
            model: "anthropic:claude-sonnet-4-5",
            agentId: "exec",
          })
        ).success
      ).toBe(true);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      stream.mockRestore();
      await recovered.session.dispose();
    }
  });

  test("respects persisted auto-retry opt-out across restart", async () => {
    const workspaceId = "startup-retry-opt-out";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before restart", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await firstSession.setAutoRetryEnabled(false);
    await firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    await secondSession.ensureStartupAutoRetryCheck();
    expect(await secondSession.getStartupRecoveryState()).toBe("stopped");

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await secondSession.dispose();
  });

  test("respects legacy auto-retry opt-out hint when backend preference is missing", async () => {
    const workspaceId = "startup-retry-legacy-opt-out";
    const { session, config, historyService, events, cleanup } =
      await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before migration", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    session.setLegacyAutoRetryEnabledHint(false);
    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      enabled?: unknown;
    };
    expect(persisted.enabled).toBe(false);

    await session.dispose();
  });

  test("does not persist temporary auto-retry enable across restart", async () => {
    const workspaceId = "startup-retry-temporary-enable";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before restart", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await firstSession.setAutoRetryEnabled(false);
    await firstSession.setAutoRetryEnabled(true, { persist: false });
    await firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    await secondSession.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await secondSession.dispose();
  });

  test("does not reschedule startup retries after persisted non-retryable failure", async () => {
    const workspaceId = "startup-retry-non-retryable";
    const {
      session: firstSession,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      cleanup,
    } = await createSessionBundle(workspaceId, {
      streamMessage: mock(() =>
        Promise.resolve(Err({ type: "runtime_not_ready" as const, message: "runtime not ready" }))
      ),
    });
    cleanups.push(cleanup);

    // A real non-retryable start failure persists the startup abandon marker for its user row.
    const sendResult = await firstSession.sendMessage("Interrupted prompt", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });
    expect(sendResult.success).toBe(false);
    const tail = await historyService.getLastMessages(workspaceId, 1);
    expect(tail.success && tail.data[0]?.role).toBe("user");

    await firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    await secondSession.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await secondSession.dispose();
  });

  test("clears persisted startup abandon state once retry resumes successfully", async () => {
    const workspaceId = "startup-retry-clear-abandon-on-resume";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    await privateSession.persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = spyOn(session, "resumeStream").mockResolvedValue(
      Ok({ started: true })
    );

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    await session.dispose();
  });

  test("provider config changes clear credential abandon state without starting a stream", async () => {
    const workspaceId = "startup-retry-clear-abandon-on-provider-config";
    // Virtual-time backoff: the retry the final recovery check schedules never fires here.
    const clock = makeTestEffectRunner();
    const { session, config, aiService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    await failTurnWith(session, aiService, "authentication");
    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    expect(await Bun.file(preferencePath).exists()).toBe(true);
    const streamMessageSpy = spyOn(aiService, "streamMessage");

    await session.handleProviderConfigChanged();

    expect(await Bun.file(preferencePath).exists()).toBe(false);
    expect(streamMessageSpy).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    // The live session dropped the marker too: recovery of the failed turn is unblocked.
    const abandonedBefore = events.filter((event) => event.type === "auto-retry-abandoned").length;
    await session.ensureStartupAutoRetryCheck();
    expect(events.filter((event) => event.type === "auto-retry-scheduled")).toHaveLength(1);
    expect(events.filter((event) => event.type === "auto-retry-abandoned")).toHaveLength(
      abandonedBefore
    );
    expect(streamMessageSpy).not.toHaveBeenCalled();
  });

  test("a marker recorded while an older clear is still unlinking is written after it and acknowledged once written", async () => {
    const workspaceId = "startup-retry-serialized-abandon-writes";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      clearStartupAutoRetryAbandon: () => Promise<void>;
    };
    const preferencePath = autoRetryPreferencePath(config, workspaceId);

    // An in-memory preference file whose unlink and marker write the test holds open, so the clear's
    // unlink and the Stop's marker write can be ordered exactly (real I/O would race them).
    let fileContent: string | null = null;
    let markerWrites = 0;
    let holdMarkerWrites = false;
    const unlinkEntered = Promise.withResolvers<void>();
    const releaseUnlink = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));
    const { unlink, mkdir, writeFile } = fsPromises;
    const spies = [
      spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
        if (target !== preferencePath) return unlink(target);
        unlinkEntered.resolve();
        await releaseUnlink.promise;
        fileContent = null;
      }),
      spyOn(fsPromises, "mkdir").mockImplementation(async (target, options) => {
        if (target !== path.dirname(preferencePath)) await mkdir(target, options);
      }),
      spyOn(fsPromises, "writeFile").mockImplementation(async (target, data, options) => {
        if (target !== preferencePath || typeof data !== "string") {
          return writeFile(target, data, options);
        }
        if (holdMarkerWrites) {
          markerWrites += 1;
          await releaseWrite.promise;
        }
        fileContent = data;
      }),
    ];
    try {
      await privateSession.persistStartupAutoRetryAbandon("authentication", "user-1");
      holdMarkerWrites = true;
      const clearing = privateSession.clearStartupAutoRetryAbandon();
      await unlinkEntered.promise;
      const recording = privateSession.persistStartupAutoRetryAbandon("aborted", "user-2");
      // A macrotask drains every microtask-resolved fake step the recording could have taken: the
      // marker write waits for the clear's unlink instead of racing it.
      await macrotask();
      expect(markerWrites).toBe(0);
      releaseUnlink.resolve();
      await clearing;

      // The clear's completion does not acknowledge the marker that is still being written.
      let acknowledged: boolean | undefined;
      const ack = session.recordPendingAutoRetryState().then((recorded) => {
        acknowledged = recorded;
        return recorded;
      });
      await macrotask();
      expect(acknowledged).toBeUndefined();
      releaseWrite.resolve();
      expect(await ack).toBe(true);
      await recording;
      expect(fileContent).not.toBeNull();
      const persisted = JSON.parse(fileContent!) as {
        startupAutoRetryAbandon?: { reason: string; userMessageId?: string };
      };
      expect(persisted.startupAutoRetryAbandon).toEqual({
        reason: "aborted",
        userMessageId: "user-2",
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test.each([false, true])(
    "preference EIO stays fail-closed and retries without poisoning the load cache (persistent=%s)",
    async (persistent) => {
      const workspaceId = "preference-read-fault";
      const { session, config, historyService, aiService, cleanup } =
        await createSessionBundle(workspaceId);
      cleanups.push(cleanup);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("intent", "user", "Unfinished work")
      );
      const preferencePath = path.join(
        config.sessionsDir,
        workspaceId,
        "auto-retry-preference.json"
      );
      await fsPromises.writeFile(preferencePath, JSON.stringify({ enabled: false }));
      const readFile = fsPromises.readFile.bind(fsPromises);
      let failing = true;
      let attempts = 0;
      const readSpy = spyOn(fsPromises, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fsPromises.readFile>
      ) => {
        if (args[0] === preferencePath) {
          attempts += 1;
          if (failing) {
            failing = persistent;
            throw Object.assign(new Error("Preference disk I/O failure"), { code: "EIO" });
          }
        }
        return readFile(...args);
      }) as typeof fsPromises.readFile);
      const wait = spyOn(
        session as unknown as { waitForStartupReadRetry: () => Promise<void> },
        "waitForStartupReadRetry"
      ).mockResolvedValue(undefined);
      const stream = spyOn(aiService, "streamMessage");
      try {
        expect(await session.getStartupRecoveryState()).toBe(persistent ? "blocked" : "stopped");
        expect(attempts).toBe(persistent ? STARTUP_RECOVERY_MAX_READ_ATTEMPTS : 2);
        expect(wait).toHaveBeenCalledTimes(persistent ? STARTUP_RECOVERY_MAX_READ_ATTEMPTS - 1 : 1);
        expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({ enabled: false });
        if (persistent) {
          const beforeRootRecovery = attempts;
          await session.ensureStartupAutoRetryCheck();
          expect(attempts - beforeRootRecovery).toBe(STARTUP_RECOVERY_MAX_READ_ATTEMPTS);
          expect(stream).not.toHaveBeenCalled();
          await (
            session as unknown as {
              persistStartupAutoRetryAbandon(reason: string, userMessageId: string): Promise<void>;
            }
          ).persistStartupAutoRetryAbandon("aborted", "new-stop");
          expect(await session.recordPendingAutoRetryState()).toBe(false);
          expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({ enabled: false });
        }
        failing = false;
        expect(await session.recordPendingAutoRetryState()).toBe(true);
        if (persistent) {
          expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({
            enabled: false,
            startupAutoRetryAbandon: { reason: "aborted", userMessageId: "new-stop" },
          });
        }
        expect(await session.getStartupRecoveryState()).toBe("stopped");
        const acceptedLoadAttempts = attempts;
        expect(await session.getStartupRecoveryState()).toBe("stopped");
        expect(attempts).toBe(acceptedLoadAttempts);
        await session.ensureStartupAutoRetryCheck();
        expect(stream).not.toHaveBeenCalled();
      } finally {
        stream.mockRestore();
        readSpy.mockRestore();
        wait.mockRestore();
        await session.dispose();
      }
    }
  );

  test.each([undefined, "{broken", "null", "[]"])(
    "missing or malformed preference compatibility (%s)",
    async (raw) => {
      const workspaceId = "preference-format-compatibility";
      const { session, config, historyService, cleanup } = await createSessionBundle(workspaceId);
      cleanups.push(cleanup);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("intent", "user", "Unfinished work")
      );
      if (raw != null)
        await fsPromises.writeFile(
          path.join(config.sessionsDir, workspaceId, "auto-retry-preference.json"),
          raw
        );
      try {
        expect(await session.getStartupRecoveryState()).toBe("interrupted");
      } finally {
        await session.dispose();
      }
    }
  );

  test("a marker recorded while the preference file is still loading survives the load and keeps the file's opt-out", async () => {
    const workspaceId = "startup-retry-marker-during-preference-load";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      loadAutoRetryEnabledPreference: () => Promise<boolean>;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };
    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    await fsPromises.mkdir(path.dirname(preferencePath), { recursive: true });
    await fsPromises.writeFile(preferencePath, JSON.stringify({ enabled: false }) + "\n", "utf-8");

    // The first preference read is held open, as in a fresh session whose startup check is still
    // reading the file when a Stop withdraws an accepted wake.
    const readEntered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const readFile = fsPromises.readFile.bind(fsPromises);
    const readSpy = spyOn(fsPromises, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fsPromises.readFile>
    ) => {
      const raw = await readFile(...args);
      if (args[0] !== preferencePath) return raw;
      readEntered.resolve();
      await releaseRead.promise;
      return raw;
    }) as typeof fsPromises.readFile);
    try {
      const loading = privateSession.loadAutoRetryEnabledPreference();
      await readEntered.promise;
      const recording = privateSession.persistStartupAutoRetryAbandon("aborted", "user-2");
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Nothing is written from unloaded state while the read is pending.
      expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({ enabled: false });
      releaseRead.resolve();
      expect(await loading).toBe(false);
      await recording;

      expect(privateSession.startupAutoRetryAbandon).toEqual({
        reason: "aborted",
        userMessageId: "user-2",
      });
      expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({
        enabled: false,
        startupAutoRetryAbandon: { reason: "aborted", userMessageId: "user-2" },
      });
      expect(await session.recordPendingAutoRetryState()).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("provider config changes preserve non-fixable abandon state without starting a stream", async () => {
    const workspaceId = "startup-retry-keep-abandon-on-provider-config";
    const clock = makeTestEffectRunner();
    const { session, config, aiService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    await failTurnWith(session, aiService, "context_exceeded");
    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    const streamMessageSpy = spyOn(aiService, "streamMessage");

    await session.handleProviderConfigChanged();

    expect(await Bun.file(preferencePath).exists()).toBe(true);
    expect(streamMessageSpy).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
    // The live session keeps the marker for the failed turn: recovery still abandons it.
    const abandonedBefore = events.filter((event) => event.type === "auto-retry-abandoned").length;
    await session.ensureStartupAutoRetryCheck();
    expect(
      events
        .slice()
        .filter(
          (event): event is Extract<WorkspaceChatMessage, { type: "auto-retry-abandoned" }> =>
            event.type === "auto-retry-abandoned"
        )
        .slice(abandonedBefore)
        .map((event) => event.reason)
    ).toEqual(["context_exceeded"]);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);
  });

  test("provider config sweep clears fixable markers for workspaces without live sessions", async () => {
    const workspaceId = "startup-retry-sweep-closed-workspace";
    const { session, config, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    await failTurnWith(session, aiService, "authentication");
    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    // Not in the skip set = no live session for this workspace.
    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set());

    expect(await Bun.file(preferencePath).exists()).toBe(false);
  });

  test("provider config sweep preserves non-fixable markers and skips live sessions", async () => {
    const workspaceId = "startup-retry-sweep-preserve";
    const { session, config, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const preferencePath = autoRetryPreferencePath(config, workspaceId);

    await failTurnWith(session, aiService, "context_exceeded");
    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set());
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    await failTurnWith(session, aiService, "authentication");
    const markerReason = async () =>
      (
        JSON.parse(await Bun.file(preferencePath).text()) as {
          startupAutoRetryAbandon?: { reason?: string };
        }
      ).startupAutoRetryAbandon?.reason;
    expect(await markerReason()).toBe("authentication");
    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set([workspaceId]));
    expect(await Bun.file(preferencePath).exists()).toBe(true);
    expect(await markerReason()).toBe("authentication");
  });

  test("an auto-retry opt-out whose write failed is not acknowledged as recorded until it is written", async () => {
    const workspaceId = "startup-retry-unrecorded-opt-out";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const preferencePath = autoRetryPreferencePath(config, workspaceId);

    let failWrites = true;
    const { writeFile } = fsPromises;
    const writeSpy = spyOn(fsPromises, "writeFile").mockImplementation(
      async (target, data, options) => {
        if (target === preferencePath && failWrites) throw new Error("EIO");
        return writeFile(target, data, options);
      }
    );
    try {
      // A RetryBarrier Stop with no active stream: the opt-out is the only state it relies on.
      await session.setAutoRetryEnabled(false);
      expect(await Bun.file(preferencePath).exists()).toBe(false);
      expect(await session.recordPendingAutoRetryState()).toBe(false);

      failWrites = false;
      expect(await session.recordPendingAutoRetryState()).toBe(true);
      expect(JSON.parse(await Bun.file(preferencePath).text())).toEqual({ enabled: false });
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("provider config sweep keeps a persisted auto-retry opt-out while clearing the marker", async () => {
    const workspaceId = "startup-retry-sweep-keep-opt-out";
    const { session, config, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    // A user send re-enables auto-retry, so the opt-out follows the failed turn.
    await failTurnWith(session, aiService, "quota");
    await session.setAutoRetryEnabled(false);
    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    expect(JSON.parse(await Bun.file(preferencePath).text())).toMatchObject({
      enabled: false,
      startupAutoRetryAbandon: { reason: "quota" },
    });

    await clearProviderConfigFixableAbandonMarkers(config.sessionsDir, new Set());

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      enabled?: boolean;
      startupAutoRetryAbandon?: unknown;
    };
    expect(persisted.enabled).toBe(false);
    expect(persisted.startupAutoRetryAbandon).toBeUndefined();
  });

  test("reschedules retry when resumeStream defers without starting a stream", async () => {
    const workspaceId = "startup-retry-resume-deferred";
    const clock = makeTestEffectRunner();
    const { session, events, cleanup } = await createSessionBundle(
      workspaceId,
      failingStreamStart(),
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    await sendIntoScheduledRetry(session, events);

    const resumeStreamMock = spyOn(session, "resumeStream").mockResolvedValue(
      Ok({ started: false })
    );

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await fireScheduledRetry(clock, events);
    await waitForCondition(
      () => events.filter((event) => event.type === "auto-retry-scheduled").length > scheduledBefore
    );

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    await session.dispose();
  });

  test("does not re-process retry failures already handled by resumeStream", async () => {
    const workspaceId = "startup-retry-no-double-process-failure";
    const clock = makeTestEffectRunner();
    const { session, events, cleanup } = await createSessionBundle(
      workspaceId,
      failingStreamStart(),
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    await sendIntoScheduledRetry(session, events);

    const resumeStreamMock = spyOn(session, "resumeStream").mockResolvedValue({
      success: false,
      error: { type: "runtime_start_failed", message: "runtime is still starting" },
      failureHandled: true,
    });

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await fireScheduledRetry(clock, events);
    // The fired retry settles (no longer pending) without arming another one.
    await waitForCondition(() => !session.hasPendingAutoRetry());

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore);

    await session.dispose();
  });

  test("handles unprocessed resume failures by scheduling the next retry", async () => {
    const workspaceId = "startup-retry-process-unhandled-failure";
    const clock = makeTestEffectRunner();
    const { session, events, cleanup } = await createSessionBundle(
      workspaceId,
      failingStreamStart(),
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    await sendIntoScheduledRetry(session, events);

    const resumeStreamMock = spyOn(session, "resumeStream").mockResolvedValue(
      Err({ type: "runtime_start_failed", message: "runtime is still starting" })
    );

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await fireScheduledRetry(clock, events);
    await waitForCondition(
      () => events.filter((event) => event.type === "auto-retry-scheduled").length > scheduledBefore
    );

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    await session.dispose();
  });

  test("startup compaction dispatch returns after persistence while provider work remains pending", async () => {
    const workspaceId = "startup-background-compaction";
    const { session, historyService, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary", "assistant", "Summary", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "Continue original work",
            model: "openai:gpt-4o",
            agentId: "exec",
          },
        },
      })
    );
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let streamFinished = false;
    // Provider work is held open at the provider boundary itself.
    const stream = spyOn(aiService, "streamMessage").mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      streamFinished = true;
      return Ok(createStartedTurnHandle(session.closingSignal));
    });
    const dispatch = session.dispatchPendingCompactionFollowUpIfNeeded(undefined, true);
    try {
      expect(await raceWithAbortAndTimeout(dispatch, { timeoutMs: 1000 })).toEqual({
        kind: "ok",
        value: true,
      });
      await started.promise;
      expect(streamFinished).toBe(false);
      const history = await historyService.getLastMessages(workspaceId, 1);
      expect(history.success && history.data[0].parts).toMatchObject([
        { type: "text", text: "Continue original work" },
      ]);
    } finally {
      finish.resolve();
      await dispatch;
      await session.dispose();
      stream.mockRestore();
    }
  });

  test("retryActiveStream resumes the reconstructed follow-up after compaction handoff send fails", async () => {
    const workspaceId = "startup-retry-follow-up-handoff";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-follow-up", "assistant", "Compaction summary", {
        muxMetadata: {
          type: "compaction-summary",
          pendingFollowUp: {
            text: "resume the original work",
            model: "openai:gpt-4o",
            agentId: "exec",
            thinkingLevel: "high",
          },
        },
      })
    );
    expect(appendResult.success).toBe(true);

    const privateSession = session as unknown as RetryableSessionForTests;

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "compact",
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
      },
      agentInitiated: true,
    };
    spyOn(session, "sendMessage").mockResolvedValue(
      Err({ type: "runtime_start_failed", message: "startup failed" })
    );

    let dispatchError: unknown;
    try {
      await session.dispatchPendingCompactionFollowUpIfNeeded();
    } catch (error) {
      dispatchError = error;
    }
    expect(dispatchError).toBeInstanceOf(Error);
    expect((dispatchError as Error).message).toContain("Failed to dispatch pending follow-up");

    const resumeStreamMock = spyOn(session, "resumeStream").mockResolvedValue(
      Ok({ started: true })
    );

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    const firstCall = resumeStreamMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [optionsArg, internalArg] = firstCall;
    expect(optionsArg).toEqual(
      expect.objectContaining({
        model: "openai:gpt-4o",
        agentId: "exec",
        thinkingLevel: "high",
      }) as SendMessageOptions
    );
    expect(optionsArg.toolPolicy).toBeUndefined();
    expect(internalArg?.agentInitiated).toBeUndefined();

    await session.dispose();
  });

  test("same-session auto-retry preserves ACP correlation fields", async () => {
    const workspaceId = "startup-retry-preserves-acp-fields";
    const clock = makeTestEffectRunner();
    const { session, aiService, events, cleanup } = await createSessionBundle(
      workspaceId,
      undefined,
      { clock }
    );
    cleanups.push(() => clock.dispose(), cleanup);

    const acpPromptId = "acp-prompt-123";
    const delegatedToolNames = ["bash", "task"];
    const muxMetadata = {
      source: "acp",
      promptCorrelationId: "fallback-prompt-456",
      delegatedToolNames: ["bash"],
    };

    let streamCallCount = 0;
    const retried = Promise.withResolvers<void>();
    const streamMessageMock = mock<AgentSessionAIService["streamMessage"]>(() => {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        return Promise.resolve({
          success: false as const,
          error: {
            type: "runtime_start_failed" as const,
            message: "startup failed",
          },
        });
      }

      retried.resolve();
      return Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)));
    });
    aiService.streamMessage = streamMessageMock;

    const sendResult = await session.sendMessage("Retry the ACP request", {
      model: "openai:gpt-4o",
      agentId: "exec",
      acpPromptId,
      delegatedToolNames,
      muxMetadata,
    });

    expect(sendResult.success).toBe(false);

    const resumeStream = spyOn(session, "resumeStream");
    await fireScheduledRetry(clock, events);
    await retried.promise;

    // Provider requests carry only workspace-turn muxMetadata, so the resumed options are where
    // the ACP metadata (the fallback source for the correlation fields) is observable.
    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(resumeStream.mock.calls[0][0].muxMetadata).toEqual(muxMetadata);

    // The correlation fields captured at the failed send reach the retried provider request.
    expect(streamMessageMock).toHaveBeenCalledTimes(2);
    const retryPayload = streamMessageMock.mock.calls[1]?.[0] as {
      acpPromptId?: string;
      delegatedToolNames?: string[];
    };
    expect(retryPayload.acpPromptId).toBe(acpPromptId);
    expect(retryPayload.delegatedToolNames).toEqual(delegatedToolNames);

    await session.dispose();
  });

  test("compaction retry failure preserves the adjusted 1M-context retry request", async () => {
    const workspaceId = "startup-retry-compaction-adjusted-request";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "compact",
    };
    const retriedOptions: SendMessageOptions = {
      ...baseOptions,
      providerOptions: {
        anthropic: {
          use1MContext: true,
          use1MContextModels: [baseOptions.model],
        },
      },
    };

    const privateSession = session as unknown as {
      maybeRetryCompactionOnContextExceeded: (data: {
        messageId: string;
        errorType?: string;
      }) => Promise<boolean>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      activeCompactionRequest?: {
        id: string;
        modelString: string;
        options?: SendMessageOptions;
        source?: "idle-compaction" | "auto-compaction";
      };
      activeStreamContext?: {
        modelString: string;
        options?: SendMessageOptions;
        agentInitiated?: boolean;
        openaiTruncationModeOverride?: "auto" | "disabled";
        providersConfig: unknown;
      };
      supports1MContextRetry: (modelString: string) => boolean;
      is1MContextEnabledForModel: (
        modelString: string,
        options?: SendMessageOptions,
        providersConfig?: unknown
      ) => boolean;
      withAnthropic1MContext: (
        modelString: string,
        options?: SendMessageOptions
      ) => SendMessageOptions | null;
      finalizeCompactionRetry: (messageId: string) => Promise<void>;
      streamWithHistory: (
        modelString: string,
        options?: SendMessageOptions,
        openaiTruncationModeOverride?: "auto" | "disabled",
        disablePostCompactionAttachments?: boolean,
        agentInitiated?: boolean
      ) => Promise<
        | { success: true; data: undefined }
        | {
            success: false;
            error: { type: "runtime_start_failed"; message: string };
            failureHandled?: true;
          }
      >;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "openai:gpt-4o-mini",
        agentId: "compact",
      },
      agentInitiated: true,
    };
    privateSession.activeCompactionRequest = {
      id: "compaction-request-1",
      modelString: baseOptions.model,
      options: baseOptions,
      source: "auto-compaction",
    };
    privateSession.activeStreamContext = {
      modelString: baseOptions.model,
      options: baseOptions,
      agentInitiated: true,
      providersConfig: null,
    };
    privateSession.supports1MContextRetry = mock(() => true);
    privateSession.is1MContextEnabledForModel = mock(() => false);
    privateSession.withAnthropic1MContext = mock(() => retriedOptions);
    privateSession.finalizeCompactionRetry = mock(() => Promise.resolve());
    const streamWithHistoryMock = mock(() =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "retry startup failed",
        },
      })
    );
    privateSession.streamWithHistory = streamWithHistoryMock;

    const retried = await privateSession.maybeRetryCompactionOnContextExceeded({
      messageId: "assistant-retry-failure",
      errorType: "context_exceeded",
    });

    expect(retried).toBe(false);
    expect(streamWithHistoryMock).toHaveBeenCalledTimes(1);
    expect(privateSession.lastAutoRetryResumeRequest?.options.model).toBe(baseOptions.model);
    expect(privateSession.lastAutoRetryResumeRequest?.options.agentId).toBe("compact");
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.providerOptions?.anthropic?.use1MContext
    ).toBe(true);
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.providerOptions?.anthropic
        ?.use1MContextModels
    ).toEqual([baseOptions.model]);
    expect(privateSession.lastAutoRetryResumeRequest?.agentInitiated).toBe(true);

    await session.dispose();
  });

  test("persists startup abandon marker for pre-stream user aborts", async () => {
    const workspaceId = "startup-retry-pre-stream-abort";
    const { historyService, config, cleanup } = await createTestHistoryService();
    cleanups.push(cleanup);

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceId,
      projectName: "project",
      projectPath: "/tmp/project",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      aiSettingsByAgent: {
        exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" },
      },
    };

    const aiEmitter = new EventEmitter();
    const aiService = createAgentSessionAIServiceFake({
      emitter: aiEmitter,
      overrides: {
        streamMessage: mock<AgentSessionAIService["streamMessage"]>(() =>
          Promise.resolve(Ok(createStartedTurnHandle(session.closingSignal)))
        ),
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      },
    });

    const initStateManager: InitStateManager = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const { session } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    // Reproducing the pre-stream window (a prepared turn with no provider stream yet) needs the
    // coordinator and the active user-message ID directly.
    const privateSession = session as unknown as {
      coordinator: TurnCoordinator;
      activeStreamUserMessageId?: string;
    };

    privateSession.activeStreamUserMessageId = "user-1";
    privateSession.coordinator.prepare({
      kind: "fresh",
      intent: "handoff",
      expectedTurnId: privateSession.coordinator.turnId,
    });

    void runSessionTerminalPolicy(session, aiEmitter, {
      type: "stream-abort",
      workspaceId,
      messageId: "assistant-1",
      abortReason: "user",
      metadata: {},
    });

    const preferencePath = autoRetryPreferencePath(config, workspaceId);
    const waitForPreferenceFile = async (timeoutMs = 2000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await Bun.file(preferencePath).exists()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    expect(await waitForPreferenceFile()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      startupAutoRetryAbandon?: { reason?: string; userMessageId?: string };
    };
    expect(persisted.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });
    // The live session honors the marker too: startup recovery reads this Stop as applicable.
    expect(await session.getStartupRecoveryState()).toBe("stopped");

    await session.dispose();
  });

  test("skips persisting startup abandon marker for non-user abort reasons", async () => {
    const workspaceId = "startup-retry-system-abort-skip";
    const { session, config, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      updateStartupAutoRetryAbandonFromAbort: (
        abortReason: "user" | "startup" | "system" | undefined,
        userMessageId?: string
      ) => Promise<void>;
    };

    const preferencePath = autoRetryPreferencePath(config, workspaceId);

    await privateSession.updateStartupAutoRetryAbandonFromAbort("system", "user-1");

    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    await privateSession.updateStartupAutoRetryAbandonFromAbort("user", "user-1");

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });
    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      startupAutoRetryAbandon?: { reason?: string; userMessageId?: string };
    };
    expect(persisted.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    await session.dispose();
  });

  test("does not schedule startup auto-retry while ask_user_question is waiting", async () => {
    const workspaceId = "startup-retry-ask-user";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const writePartialResult = await historyService.writePartial(
      workspaceId,
      createMuxMessage(
        "assistant-1",
        "assistant",
        "",
        {
          timestamp: Date.now(),
          model: "anthropic:claude-sonnet-4-5",
          partial: true,
          agentId: "exec",
        },
        [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "tool-1",
            toolName: "ask_user_question",
            input: { question: "Name?" },
          },
        ]
      )
    );
    expect(writePartialResult.success).toBe(true);
    expect(await session.getStartupRecoveryState()).toBe("question");

    await session.ensureStartupAutoRetryCheck();

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    await session.dispose();
  });
});
