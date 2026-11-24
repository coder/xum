import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { HistoryService } from "./historyService";
import type { Config } from "@/node/config";
import type { InitStateManager } from "./initStateManager";
import type { WorkspaceChatMessage, SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Ok } from "@/common/types/result";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

interface AutoRetryResumeRequest {
  options: SendMessageOptions;
  agentInitiated?: boolean;
  goalKind?: typeof GOAL_CONTINUATION_KIND;
}

interface SessionBundle {
  session: AgentSession;
  config: Config;
  historyService: HistoryService;
  aiService: AIService;
  initStateManager: InitStateManager;
  backgroundProcessManager: BackgroundProcessManager;
  events: WorkspaceChatMessage[];
  cleanup: () => Promise<void>;
}

async function createSessionBundle(workspaceId: string): Promise<SessionBundle> {
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
    },
    initStateManagerOverrides: {
      replayInit: mock(() => Promise.resolve()),
    },
    captureEvents: true,
  });
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
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

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

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const scheduledEvent = events.find((event) => event.type === "auto-retry-scheduled");
    expect(scheduledEvent).toBeDefined();

    const retryOptions = (
      session as unknown as {
        lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      }
    ).lastAutoRetryResumeRequest;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup auto-retry options to be captured");
    }
    expect(retryOptions.options.model).toBe("anthropic:claude-sonnet-4-5");
    expect(retryOptions.options.agentId).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(retryOptions.options.toolPolicy).toEqual([{ regex_match: ".*", action: "disable" }]);
    expect(retryOptions.options.disableWorkspaceAgents).toBe(true);

    session.dispose();
  });

  test("startup auto-retry reuses workspace-turn metadata from the retry user message", async () => {
    const workspaceId = "startup-retry-workspace-turn-metadata";
    const { session, historyService, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
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
    const streamMessageMock = mock((_payload: Parameters<AIService["streamMessage"]>[0]) =>
      Promise.resolve(Ok(undefined))
    );
    aiService.streamMessage = streamMessageMock as unknown as AIService["streamMessage"];
    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      startupAutoRetryCheckPromise: Promise<void> | null;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
    };

    session.ensureStartupAutoRetryCheck();
    await privateSession.startupAutoRetryCheckPromise;
    expect(privateSession.lastAutoRetryResumeRequest?.options.muxMetadata).toBeUndefined();

    await privateSession.retryActiveStream();

    expect(streamMessageMock).toHaveBeenCalledTimes(1);
    expect(streamMessageMock.mock.calls[0]?.[0]).toMatchObject({ muxMetadata });

    session.dispose();
  });

  test("startup auto-retry does not stamp workflow-result metadata on assistant streams", async () => {
    const workspaceId = "startup-retry-workflow-result-metadata";
    const { session, historyService, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);
    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Use the workflow result", {
        timestamp: Date.now(),
        retrySendOptions: { model: "openai:gpt-4o", agentId: "exec" },
        muxMetadata: {
          type: "workflow-result",
          rawCommand: "/deep-research mux",
          runId: "wfr_1",
        },
      })
    );
    expect(appendResult.success).toBe(true);
    const streamMessageMock = mock((_payload: Parameters<AIService["streamMessage"]>[0]) =>
      Promise.resolve(Ok(undefined))
    );
    aiService.streamMessage = streamMessageMock as unknown as AIService["streamMessage"];
    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      startupAutoRetryCheckPromise: Promise<void> | null;
    };

    session.ensureStartupAutoRetryCheck();
    await privateSession.startupAutoRetryCheckPromise;
    await privateSession.retryActiveStream();

    expect(streamMessageMock).toHaveBeenCalledTimes(1);
    expect(streamMessageMock.mock.calls[0]?.[0].muxMetadata).toBeUndefined();

    session.dispose();
  });

  test("re-runs startup auto-retry check after busy startup state clears", async () => {
    const workspaceId = "startup-retry-busy-rerun";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while startup was busy", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    const privateSession = session as unknown as {
      setTurnPhase: (phase: "idle" | "preparing" | "streaming" | "completing") => void;
      startupAutoRetryCheckPromise: Promise<void> | null;
      startupAutoRetryCheckScheduled: boolean;
    };

    privateSession.setTurnPhase("preparing");
    session.ensureStartupAutoRetryCheck();

    const firstCheckPromise = privateSession.startupAutoRetryCheckPromise;
    await firstCheckPromise;

    expect(privateSession.startupAutoRetryCheckScheduled).toBe(false);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    privateSession.setTurnPhase("idle");

    const deadline = Date.now() + 1500;
    while (
      !events.some((event) => event.type === "auto-retry-scheduled") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("re-runs startup auto-retry check after transient history read failures", async () => {
    const workspaceId = "startup-retry-history-read-rerun";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while history read failed", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    const originalGetLastMessages = historyService.getLastMessages.bind(historyService);
    let getLastMessagesCalls = 0;
    historyService.getLastMessages = mock((id: string, count: number) => {
      getLastMessagesCalls += 1;
      if (getLastMessagesCalls === 1) {
        return Promise.resolve({
          success: false as const,
          error: "temporary history read failure",
        });
      }

      return originalGetLastMessages(id, count);
    }) as unknown as HistoryService["getLastMessages"];

    const privateSession = session as unknown as {
      startupAutoRetryCheckPromise: Promise<void> | null;
      startupAutoRetryCheckScheduled: boolean;
    };

    session.ensureStartupAutoRetryCheck();

    const firstCheckPromise = privateSession.startupAutoRetryCheckPromise;
    await firstCheckPromise;

    expect(getLastMessagesCalls).toBeGreaterThanOrEqual(1);

    const deadline = Date.now() + 3000;
    while (
      !events.some((event) => event.type === "auto-retry-scheduled") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(getLastMessagesCalls).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(true);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("backs off reruns after repeated startup history read failures", async () => {
    const workspaceId = "startup-retry-history-read-backoff";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while history is unavailable", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    let getLastMessagesCalls = 0;
    historyService.getLastMessages = mock(() => {
      getLastMessagesCalls += 1;
      return Promise.resolve({
        success: false as const,
        error: "persistent history read failure",
      });
    }) as unknown as HistoryService["getLastMessages"];

    const privateSession = session as unknown as {
      startupAutoRetryCheckPromise: Promise<void> | null;
    };

    session.ensureStartupAutoRetryCheck();
    await privateSession.startupAutoRetryCheckPromise;

    expect(getLastMessagesCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getLastMessagesCalls).toBe(1);

    const deadline = Date.now() + 2500;
    while (getLastMessagesCalls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(getLastMessagesCalls).toBeGreaterThanOrEqual(2);

    session.dispose();
  });

  test("runStartupRecovery gives up after repeated deferred history-read failures", async () => {
    const workspaceId = "startup-recovery-deferred-cap";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted while history keeps failing", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    let getLastMessagesCalls = 0;
    historyService.getLastMessages = mock(() => {
      getLastMessagesCalls += 1;
      return Promise.resolve({
        success: false as const,
        error: "persistent history read failure",
      });
    }) as unknown as HistoryService["getLastMessages"];

    const privateSession = session as unknown as {
      runStartupRecovery: () => Promise<void>;
      waitForStartupAutoRetryRerunWindow: (retryDelayMs?: number) => Promise<void>;
      startupRecoveryScheduled: boolean;
      startupAutoRetryCheckScheduled: boolean;
    };
    const waitSpy = spyOn(privateSession, "waitForStartupAutoRetryRerunWindow").mockResolvedValue(
      undefined
    );

    await privateSession.runStartupRecovery();

    expect(getLastMessagesCalls).toBe(5);
    expect(waitSpy).toHaveBeenCalledTimes(3);
    expect(privateSession.startupRecoveryScheduled).toBe(false);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("waits for AI streaming to settle before rerunning deferred startup checks", async () => {
    const workspaceId = "startup-retry-wait-stream-settle";
    let aiStreaming = true;
    const { session, cleanup, aiEmitter } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        isStreaming: mock((_workspaceId: string) => aiStreaming),
      },
    });
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      scheduleStartupAutoRetryIfNeeded: () => Promise<"completed" | "deferred">;
      startupAutoRetryCheckPromise: Promise<void> | null;
      startupAutoRetryCheckScheduled: boolean;
    };

    let scheduleCalls = 0;
    privateSession.scheduleStartupAutoRetryIfNeeded = mock(() => {
      scheduleCalls += 1;
      const outcome: "completed" | "deferred" = scheduleCalls === 1 ? "deferred" : "completed";
      return Promise.resolve(outcome);
    });

    session.ensureStartupAutoRetryCheck();

    const firstCheckPromise = privateSession.startupAutoRetryCheckPromise;
    await firstCheckPromise;

    expect(scheduleCalls).toBe(1);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(scheduleCalls).toBe(1);

    aiStreaming = false;
    aiEmitter.emit("stream-abort", {
      type: "stream-abort",
      workspaceId,
      messageId: "assistant-1",
      abortReason: "system",
    });

    const deadline = Date.now() + 1000;
    while (scheduleCalls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(scheduleCalls).toBe(2);
    expect(privateSession.startupAutoRetryCheckScheduled).toBe(true);

    session.dispose();
  });

  test("restores persisted retry send options for startup auto-retry", async () => {
    const workspaceId = "startup-retry-preserve-options";
    const { session, historyService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

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

    const startupRetryModelHint = await session.getStartupAutoRetryModelHint();
    expect(startupRetryModelHint).toBe("anthropic:claude-sonnet-4-5");

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const retryOptions = (
      session as unknown as {
        lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      }
    ).lastAutoRetryResumeRequest;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup retry options");
    }

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

    session.dispose();
  });

  test("startup auto-retry prefers child workspace agent settings over stale retry metadata", async () => {
    const workspaceId = "startup-retry-child-stale-agent";
    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: workspaceId,
      projectName: "project",
      projectPath: "/tmp/project",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      parentWorkspaceId: "parent-workspace",
      agentId: "exec",
      agentType: "explore",
      aiSettingsByAgent: {
        exec: { model: "openai:gpt-5.5", thinkingLevel: "high" },
        explore: { model: "openai:gpt-5.5-low", thinkingLevel: "low" },
      },
    };
    const { session, historyService, cleanup } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      },
    });
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted child task turn", {
        timestamp: Date.now(),
        retrySendOptions: {
          model: "openai:gpt-5.5",
          agentId: "exec",
          thinkingLevel: "high",
        },
      })
    );
    expect(appendResult.success).toBe(true);

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const retryOptions = (
      session as unknown as {
        lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      }
    ).lastAutoRetryResumeRequest;
    expect(retryOptions).toBeDefined();
    if (!retryOptions) {
      throw new Error("Expected startup retry options");
    }

    expect(retryOptions.options.agentId).toBe("explore");
    expect(retryOptions.options.model).toBe("openai:gpt-5.5-low");
    expect(retryOptions.options.thinkingLevel).toBe("low");

    session.dispose();
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

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    const replayEvents: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => {
      replayEvents.push(message);
    });

    const scheduledIndex = replayEvents.findIndex((event) => event.type === "auto-retry-scheduled");
    const caughtUpIndex = replayEvents.findIndex((event) => event.type === "caught-up");

    expect(scheduledIndex).toBeGreaterThanOrEqual(0);
    expect(caughtUpIndex).toBeGreaterThanOrEqual(0);
    expect(scheduledIndex).toBeLessThan(caughtUpIndex);

    session.dispose();
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
    firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    secondSession.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      secondSession as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    secondSession.dispose();
  });

  test("respects legacy auto-retry opt-out hint when backend preference is missing", async () => {
    const workspaceId = "startup-retry-legacy-opt-out";
    const { session, historyService, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted before migration", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    session.setLegacyAutoRetryEnabledHint(false);
    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    const preferencePath = (
      session as unknown as {
        getAutoRetryPreferencePath: () => string;
      }
    ).getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    const persisted = JSON.parse(await Bun.file(preferencePath).text()) as {
      enabled?: unknown;
    };
    expect(persisted.enabled).toBe(false);

    session.dispose();
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
    firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    secondSession.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      secondSession as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    secondSession.dispose();
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
    } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const appendResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Interrupted prompt", {
        timestamp: Date.now(),
      })
    );
    expect(appendResult.success).toBe(true);

    await (
      firstSession as unknown as {
        persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      }
    ).persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    firstSession.dispose();

    const { session: secondSession, events } = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
      captureEvents: true,
    });

    secondSession.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      secondSession as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    secondSession.dispose();
  });

  test("reports auto-retry as pending while retry resume is starting", async () => {
    const workspaceId = "startup-retry-starting-pending";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    let resolveResume!: (result: { success: true; data: { started: boolean } }) => void;
    privateSession.resumeStream = mock(
      (_options: SendMessageOptions) =>
        new Promise<{ success: true; data: { started: boolean } }>((resolve) => {
          resolveResume = resolve;
        })
    );

    const retryPromise = privateSession.retryActiveStream();

    expect(session.hasPendingAutoRetry()).toBe(true);

    resolveResume({ success: true, data: { started: true } });
    await retryPromise;

    expect(session.hasPendingAutoRetry()).toBe(false);

    session.dispose();
  });

  test("clears persisted startup abandon state once retry resumes successfully", async () => {
    const workspaceId = "startup-retry-clear-abandon-on-resume";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      persistStartupAutoRetryAbandon: (reason: string, userMessageId?: string) => Promise<void>;
      retryActiveStream: () => Promise<void>;
      getAutoRetryPreferencePath: () => string;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    await privateSession.persistStartupAutoRetryAbandon("runtime_not_ready", "user-1");

    const preferencePath = privateSession.getAutoRetryPreferencePath();
    expect(await Bun.file(preferencePath).exists()).toBe(true);

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({ success: true as const, data: { started: true } })
    );
    privateSession.resumeStream = resumeStreamMock;

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(privateSession.startupAutoRetryAbandon).toBeNull();
    expect(await Bun.file(preferencePath).exists()).toBe(false);

    session.dispose();
  });

  test("reschedules retry when resumeStream defers without starting a stream", async () => {
    const workspaceId = "startup-retry-resume-deferred";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<{ success: true; data: { started: boolean } }>;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: true as const,
        data: { started: false },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    session.dispose();
  });

  test("does not re-process retry failures already handled by resumeStream", async () => {
    const workspaceId = "startup-retry-no-double-process-failure";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      activeStreamFailureHandled: boolean;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<
        | { success: true; data: { started: boolean } }
        | { success: false; error: { type: "runtime_start_failed"; message: string } }
      >;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    privateSession.activeStreamFailureHandled = true;
    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "runtime is still starting",
        },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore);

    session.dispose();
  });

  test("handles unprocessed resume failures by scheduling the next retry", async () => {
    const workspaceId = "startup-retry-process-unhandled-failure";
    const { session, events, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      activeStreamFailureHandled: boolean;
      resumeStream: (
        options: SendMessageOptions
      ) => Promise<
        | { success: true; data: { started: boolean } }
        | { success: false; error: { type: "runtime_start_failed"; message: string } }
      >;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
      },
    };

    privateSession.activeStreamFailureHandled = false;
    const resumeStreamMock = mock((_options: SendMessageOptions) =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "runtime is still starting",
        },
      })
    );
    privateSession.resumeStream = resumeStreamMock;

    const scheduledBefore = events.filter((event) => event.type === "auto-retry-scheduled").length;

    await privateSession.retryActiveStream();

    const scheduledAfter = events.filter((event) => event.type === "auto-retry-scheduled").length;
    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    expect(scheduledAfter).toBe(scheduledBefore + 1);

    session.dispose();
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

    const privateSession = session as unknown as {
      dispatchPendingFollowUp: () => Promise<boolean>;
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      sendMessage: (
        message: string,
        options?: SendMessageOptions,
        internal?: { synthetic?: boolean }
      ) => Promise<
        { success: true } | { success: false; error: { type: string; message?: string } }
      >;
      resumeStream: (
        options: SendMessageOptions,
        internal?: { agentInitiated?: boolean }
      ) => Promise<{ success: true; data: { started: boolean } }>;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "anthropic:claude-sonnet-4-5",
        agentId: "compact",
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
      },
      agentInitiated: true,
    };
    privateSession.sendMessage = mock(() =>
      Promise.resolve({
        success: false as const,
        error: { type: "runtime_start_failed", message: "startup failed" },
      })
    );

    let dispatchError: unknown;
    try {
      await privateSession.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }
    expect(dispatchError).toBeInstanceOf(Error);
    expect((dispatchError as Error).message).toContain("Failed to dispatch pending follow-up");

    const resumeStreamMock = mock(
      (_options: SendMessageOptions, _internal?: { agentInitiated?: boolean }) =>
        Promise.resolve({ success: true as const, data: { started: true } })
    );
    privateSession.resumeStream = resumeStreamMock;

    await privateSession.retryActiveStream();

    expect(resumeStreamMock).toHaveBeenCalledTimes(1);
    const firstCall = resumeStreamMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [optionsArg, internalArg] = firstCall as unknown as [
      SendMessageOptions,
      { agentInitiated?: boolean } | undefined,
    ];
    expect(optionsArg).toEqual(
      expect.objectContaining({
        model: "openai:gpt-4o",
        agentId: "exec",
        thinkingLevel: "high",
      }) as SendMessageOptions
    );
    expect(optionsArg.toolPolicy).toBeUndefined();
    expect(internalArg?.agentInitiated).toBeUndefined();

    session.dispose();
  });

  test("same-session auto-retry preserves ACP correlation fields", async () => {
    const workspaceId = "startup-retry-preserves-acp-fields";
    const { session, aiService, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const acpPromptId = "acp-prompt-123";
    const delegatedToolNames = ["bash", "task"];
    const muxMetadata = {
      source: "acp",
      promptCorrelationId: "fallback-prompt-456",
      delegatedToolNames: ["bash"],
    };

    let streamCallCount = 0;
    const streamMessageMock = mock((_payload: Record<string, unknown>) => {
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

      return Promise.resolve(Ok(undefined));
    });
    aiService.streamMessage = streamMessageMock as unknown as AIService["streamMessage"];

    const privateSession = session as unknown as {
      retryActiveStream: () => Promise<void>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
    };

    const sendResult = await session.sendMessage("Retry the ACP request", {
      model: "openai:gpt-4o",
      agentId: "exec",
      acpPromptId,
      delegatedToolNames,
      muxMetadata,
    });

    expect(sendResult.success).toBe(false);
    expect(privateSession.lastAutoRetryResumeRequest?.options.acpPromptId).toBe(acpPromptId);
    expect(privateSession.lastAutoRetryResumeRequest?.options.delegatedToolNames).toEqual(
      delegatedToolNames
    );
    expect(privateSession.lastAutoRetryResumeRequest?.options.muxMetadata).toEqual(muxMetadata);

    await privateSession.retryActiveStream();

    expect(streamMessageMock).toHaveBeenCalledTimes(2);
    const retryPayload = streamMessageMock.mock.calls[1]?.[0] as {
      acpPromptId?: string;
      delegatedToolNames?: string[];
    };
    expect(retryPayload.acpPromptId).toBe(acpPromptId);
    expect(retryPayload.delegatedToolNames).toEqual(delegatedToolNames);

    session.dispose();
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
        | { success: false; error: { type: "runtime_start_failed"; message: string } }
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

    session.dispose();
  });

  test("exec-subagent hard-restart retry failure preserves the rebuilt continuation request", async () => {
    const workspaceId = "startup-retry-hard-restart-request";
    const { historyService, config, cleanup } = await createTestHistoryService();
    cleanups.push(cleanup);

    const appendSnapshotResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("snapshot-1", "user", "<snapshot>", {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["token"],
      })
    );
    expect(appendSnapshotResult.success).toBe(true);

    const appendPromptResult = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Do the thing", {
        timestamp: Date.now(),
      })
    );
    expect(appendPromptResult.success).toBe(true);

    const parentWorkspaceId = "startup-retry-hard-restart-parent";
    const childWorkspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "child",
      projectName: "project",
      projectPath: "/tmp/project",
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      aiSettingsByAgent: {
        [WORKSPACE_DEFAULTS.agentId]: {
          model: "openai:gpt-4o",
          thinkingLevel: "medium",
        },
      },
      parentWorkspaceId,
      agentId: "exec",
    };
    const parentWorkspaceMetadata: WorkspaceMetadata = {
      ...childWorkspaceMetadata,
      id: parentWorkspaceId,
      name: "parent",
      parentWorkspaceId: undefined,
    };

    const aiService: AIService = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock((id: string) => {
        if (id === workspaceId) {
          return Promise.resolve(Ok(childWorkspaceMetadata));
        }

        if (id === parentWorkspaceId) {
          return Promise.resolve(Ok(parentWorkspaceMetadata));
        }

        return Promise.resolve({ success: false as const, error: "unknown workspace" });
      }),
    } as unknown as AIService;

    const initStateManager: InitStateManager = {
      on() {
        return this;
      },
      off() {
        return this;
      },
    } as unknown as InitStateManager;

    const backgroundProcessManager: BackgroundProcessManager = {
      cleanup: mock(() => Promise.resolve()),
      setMessageQueued: mock(() => undefined),
    } as unknown as BackgroundProcessManager;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const baseOptions: SendMessageOptions = {
      model: "openai:gpt-4o",
      agentId: "exec",
      additionalSystemInstructions: "Follow the existing plan.",
      experiments: {
        execSubagentHardRestart: true,
      },
    };

    const privateSession = session as unknown as {
      maybeHardRestartExecSubagentOnContextExceeded: (data: {
        messageId: string;
        errorType?: string;
      }) => Promise<boolean>;
      lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
      activeStreamContext?: {
        modelString: string;
        options?: SendMessageOptions;
        agentInitiated?: boolean;
        openaiTruncationModeOverride?: "auto" | "disabled";
        providersConfig: unknown;
      };
      activeStreamUserMessageId?: string;
      streamWithHistory: (
        modelString: string,
        options?: SendMessageOptions,
        openaiTruncationModeOverride?: "auto" | "disabled",
        disablePostCompactionAttachments?: boolean,
        agentInitiated?: boolean
      ) => Promise<
        | { success: true; data: undefined }
        | { success: false; error: { type: "runtime_start_failed"; message: string } }
      >;
    };

    privateSession.lastAutoRetryResumeRequest = {
      options: {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      },
      agentInitiated: true,
    };
    privateSession.activeStreamContext = {
      modelString: baseOptions.model,
      options: baseOptions,
      agentInitiated: true,
      providersConfig: null,
    };
    privateSession.activeStreamUserMessageId = "user-1";
    const streamWithHistoryMock = mock(() =>
      Promise.resolve({
        success: false as const,
        error: {
          type: "runtime_start_failed" as const,
          message: "hard restart startup failed",
        },
      })
    );
    privateSession.streamWithHistory = streamWithHistoryMock;

    const retried = await privateSession.maybeHardRestartExecSubagentOnContextExceeded({
      messageId: "assistant-hard-restart-failure",
      errorType: "context_exceeded",
    });

    expect(retried).toBe(false);
    expect(streamWithHistoryMock).toHaveBeenCalledTimes(1);
    expect(privateSession.lastAutoRetryResumeRequest?.options.model).toBe(baseOptions.model);
    expect(privateSession.lastAutoRetryResumeRequest?.options.agentId).toBe("exec");
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.experiments?.execSubagentHardRestart
    ).toBe(true);
    expect(privateSession.lastAutoRetryResumeRequest?.agentInitiated).toBe(true);
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.additionalSystemInstructions
    ).toContain("Context limit reached");
    expect(
      privateSession.lastAutoRetryResumeRequest?.options.additionalSystemInstructions
    ).toContain("Follow the existing plan.");

    session.dispose();
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
    const aiService = Object.assign(aiEmitter, {
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      isStreaming: mock(() => false),
      streamMessage: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
    }) as unknown as AIService;

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

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const privateSession = session as unknown as {
      setTurnPhase: (phase: "idle" | "preparing" | "streaming" | "completing") => void;
      activeStreamUserMessageId?: string;
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
    };

    privateSession.activeStreamUserMessageId = "user-1";
    privateSession.setTurnPhase("preparing");

    aiEmitter.emit("stream-abort", {
      type: "stream-abort",
      workspaceId,
      messageId: "assistant-1",
      abortReason: "user",
      metadata: {},
    });

    const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<boolean> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (condition()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };

    const abandonPersisted = await waitUntil(() => privateSession.startupAutoRetryAbandon !== null);
    expect(abandonPersisted).toBe(true);

    expect(privateSession.startupAutoRetryAbandon).toEqual({
      reason: "aborted",
      userMessageId: "user-1",
    });

    const preferencePath = privateSession.getAutoRetryPreferencePath();
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

    session.dispose();
  });

  test("skips persisting startup abandon marker for non-user abort reasons", async () => {
    const workspaceId = "startup-retry-system-abort-skip";
    const { session, cleanup } = await createSessionBundle(workspaceId);
    cleanups.push(cleanup);

    const privateSession = session as unknown as {
      getAutoRetryPreferencePath: () => string;
      startupAutoRetryAbandon: { reason: string; userMessageId?: string } | null;
      updateStartupAutoRetryAbandonFromAbort: (
        abortReason: "user" | "startup" | "system" | undefined,
        userMessageId?: string
      ) => Promise<void>;
    };

    const preferencePath = privateSession.getAutoRetryPreferencePath();

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

    session.dispose();
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

    session.ensureStartupAutoRetryCheck();

    const startupCheckPromise = (
      session as unknown as { startupAutoRetryCheckPromise: Promise<void> | null }
    ).startupAutoRetryCheckPromise;
    await startupCheckPromise;

    expect(events.some((event) => event.type === "auto-retry-scheduled")).toBe(false);

    session.dispose();
  });
});
