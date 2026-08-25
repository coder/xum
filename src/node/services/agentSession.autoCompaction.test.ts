import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";

import type {
  ProvidersConfigMap,
  SendMessageOptions,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import {
  createMuxMessage,
  type CompactionFollowUpRequest,
  type MuxMessage,
} from "@/common/types/message";
import { GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { Ok, Err } from "@/common/types/result";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { InitStateManager } from "@/node/services/initStateManager";
import { AgentSession } from "./agentSession";
import type { CompactionMonitor } from "./compactionMonitor";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";

describe("AgentSession on-send auto-compaction snapshot deferral", () => {
  let historyCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await historyCleanup?.();
  });

  async function createSessionHarness(args: {
    workspaceId: string;
    streamMessage?: AIService["streamMessage"];
    config?: Config;
    captureEvents?: boolean;
  }) {
    const harness = await createAgentSessionHarness({
      workspaceId: args.workspaceId,
      config: args.config,
      aiServiceOverrides: args.streamMessage ? { streamMessage: args.streamMessage } : undefined,
      captureEvents: args.captureEvents,
    });
    historyCleanup = harness.cleanup;
    return harness;
  }

  test("does not persist or emit snapshots before forced on-send compaction", async () => {
    const workspaceId = "ws-auto-compaction-snapshot-deferral";

    const streamMessage = mock((_history: MuxMessage[]) => Promise.resolve(Ok(undefined)));
    const { session, historyService, events } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
      captureEvents: true,
    });

    const syntheticSnapshot = createMuxMessage(
      "file-snapshot-1",
      "user",
      "<snapshot>@foo.ts</snapshot>",
      {
        timestamp: Date.now(),
        synthetic: true,
        fileAtMentionSnapshot: ["@foo.ts"],
      }
    );

    const internals = session as unknown as {
      materializeFileAtMentionsSnapshot: (
        text: string
      ) => Promise<{ snapshotMessage: MuxMessage; materializedTokens: string[] } | null>;
      compactionMonitor: CompactionMonitor;
    };

    internals.materializeFileAtMentionsSnapshot = mock((_text: string) =>
      Promise.resolve({
        snapshotMessage: syntheticSnapshot,
        materializedTokens: ["@foo.ts"],
      })
    );

    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("please inspect @foo.ts", {
      model: "openai:gpt-4o",
      agentId: "exec",
      disableWorkspaceAgents: true,
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedSnapshot = historyResult.data.some(
      (message) => message.metadata?.fileAtMentionSnapshot?.includes("@foo.ts") === true
    );
    expect(persistedSnapshot).toBe(false);

    const persistedCompactionMessage = historyResult.data.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionMessage).toBeDefined();
    expect(persistedCompactionMessage?.metadata?.disableWorkspaceAgents).toBe(true);

    const emittedSnapshot = events.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "id" in message &&
        message.id === "file-snapshot-1"
    );
    expect(emittedSnapshot).toBe(false);

    session.dispose();
  });

  test("tracks a compaction request when a synthetic snapshot follows it", async () => {
    const model = "openai:gpt-4o";
    const { session } = await createSessionHarness({
      workspaceId: "ws-auto-compaction-request-correlation",
    });
    const compactionMetadata = {
      type: "compaction-request" as const,
      rawCommand: "/compact",
      parsed: {},
      source: "auto-compaction" as const,
    };
    const compactionRequest = createMuxMessage(
      "compaction-request",
      "user",
      "Summarize the conversation",
      {
        synthetic: true,
        muxMetadata: compactionMetadata,
      }
    );
    const snapshot = createMuxMessage("file-change", "user", "<file-change />", {
      synthetic: true,
    });
    const internals = session as unknown as {
      resolveCompactionRequest: (
        history: MuxMessage[],
        modelString: string,
        options: SendMessageOptions
      ) => { id: string; source?: string } | undefined;
    };

    const request = internals.resolveCompactionRequest([compactionRequest, snapshot], model, {
      model,
      agentId: "compact",
      muxMetadata: compactionMetadata,
    });

    expect(request).toMatchObject({
      id: compactionRequest.id,
      source: "auto-compaction",
    });

    session.dispose();
  });

  test("does not materialize skill snapshots (or run their directives) on deferred on-send compaction turns", async () => {
    const workspaceId = "ws-auto-compaction-skill-snapshot-deferral";

    const streamMessage = mock((_history: MuxMessage[]) => Promise.resolve(Ok(undefined)));
    const { session } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const internals = session as unknown as {
      materializeAgentSkillSnapshots: (...args: unknown[]) => Promise<MuxMessage[]>;
      compactionMonitor: CompactionMonitor;
    };

    // Materialization can execute skill dynamic-context directives (side effects),
    // so a turn that defers to on-send compaction must not materialize at all —
    // the post-compaction follow-up re-enters sendMessage and materializes then.
    const materializeSkillSnapshots = mock(() => Promise.resolve([]));
    internals.materializeAgentSkillSnapshots = materializeSkillSnapshots;

    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 99,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("use my-skill", {
      model: "openai:gpt-4o",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/my-skill",
        skillName: "my-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);
    expect(materializeSkillSnapshots).not.toHaveBeenCalled();

    session.dispose();
  });

  test("stamps on-send auto-compaction requests with the RLM keep-recent tail only when RLM is on", async () => {
    const runCase = async (args: {
      workspaceId: string;
      experiments?: SendMessageOptions["experiments"];
    }) => {
      const streamMessage = mock((_history: MuxMessage[]) => Promise.resolve(Ok(undefined)));
      const { session, historyService } = await createSessionHarness({
        workspaceId: args.workspaceId,
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      });

      // Seed a prior turn so the keep-recent selector has a safe user boundary
      // (u1 @ seq 2) with a provider-eligible head (u0, a0) before it.
      for (const message of [
        createMuxMessage("u0", "user", "old question"),
        createMuxMessage("a0", "assistant", "old answer"),
        createMuxMessage("u1", "user", "recent question"),
        createMuxMessage("a1", "assistant", "recent answer"),
      ]) {
        const seedResult = await historyService.appendToHistory(args.workspaceId, message);
        if (!seedResult.success) throw new Error(seedResult.error);
      }

      const internals = session as unknown as { compactionMonitor: CompactionMonitor };
      internals.compactionMonitor = {
        checkBeforeSend: mock(() => ({
          shouldShowWarning: true,
          shouldForceCompact: true,
          usagePercentage: 99,
          thresholdPercentage: 85,
        })),
        checkMidStream: mock(() => false),
        resetForNewStream: mock(() => undefined),
        setThreshold: mock(() => undefined),
        getThreshold: mock(() => 0.85),
      } as unknown as CompactionMonitor;

      const result = await session.sendMessage("next question", {
        model: "openai:gpt-4o",
        agentId: "exec",
        ...(args.experiments ? { experiments: args.experiments } : {}),
      });
      expect(result.success).toBe(true);

      const historyResult = await historyService.getHistoryFromLatestBoundary(args.workspaceId);
      if (!historyResult.success) throw new Error(String(historyResult.error));
      const request = historyResult.data.find(
        (message) => message.metadata?.muxMetadata?.type === "compaction-request"
      );
      expect(request).toBeDefined();

      session.dispose();
      const muxMetadata = request?.metadata?.muxMetadata;
      return muxMetadata?.type === "compaction-request" ? muxMetadata.keepRecentTail : undefined;
    };

    // RLM on (sub-experiment of PTC): stamped with u1's historySequence.
    const stamped = await runCase({
      workspaceId: "ws-auto-compaction-rlm-stamp-on",
      experiments: { programmaticToolCalling: true, rlm: true },
    });
    expect(stamped).toEqual({ startHistorySequence: 2 });
    await historyCleanup?.();

    // RLM flag without a PTC parent flag stays inert.
    const inert = await runCase({
      workspaceId: "ws-auto-compaction-rlm-stamp-inert",
      experiments: { rlm: true },
    });
    expect(inert).toBeUndefined();
    await historyCleanup?.();

    // RLM off: byte-identical request metadata (no stamp).
    const unstamped = await runCase({ workspaceId: "ws-auto-compaction-rlm-stamp-off" });
    expect(unstamped).toBeUndefined();
  });

  test("preserves goal kind on auto-compaction follow-up requests", async () => {
    const { session } = await createSessionHarness({
      workspaceId: "ws-auto-compaction-goal-kind",
    });

    const followUp = (
      session as unknown as {
        buildAutoCompactionFollowUp: (params: {
          messageText: string;
          options: SendMessageOptions;
          modelForStream: string;
          goalKind?: typeof GOAL_CONTINUATION_KIND;
        }) => CompactionFollowUpRequest;
      }
    ).buildAutoCompactionFollowUp({
      messageText: "Continue goal",
      options: { model: "openai:gpt-4o", agentId: "exec" },
      modelForStream: "openai:gpt-4o",
      goalKind: GOAL_CONTINUATION_KIND,
    });

    expect(followUp.goalKind).toBe(GOAL_CONTINUATION_KIND);
    session.dispose();
  });

  test("triggers on-send compaction at threshold even before force buffer", async () => {
    const workspaceId = "ws-auto-compaction-on-send-threshold";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(undefined));
    });
    const { session } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: false,
        usagePercentage: 72,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(true);

    session.dispose();
  });

  test("uses preferred compaction model for on-send auto-compaction requests", async () => {
    const workspaceId = "ws-auto-compaction-preferred-model";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(undefined));
    });
    const compactionModel = "openai:gpt-4o-mini";
    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: { compact: { modelString: compactionModel } },
      }),
    } as unknown as Config;
    const { session } = await createSessionHarness({
      workspaceId,
      config,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: true,
        shouldForceCompact: true,
        usagePercentage: 95,
        thresholdPercentage: 70,
      })),
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.7),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const compactionRequestMessage = requestMessages.find(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );

    expect(compactionRequestMessage?.metadata?.muxMetadata?.requestedModel).toBe(compactionModel);

    session.dispose();
  });

  test("does not trigger compaction at 200K threshold when 1M context is preserved after agent routing", async () => {
    const workspaceId = "ws-auto-compaction-preserved-1m-routing";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(undefined));
    });
    const { session, historyService } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const appendSeedUsage = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-1m-routing-usage", "assistant", "existing context", {
        timestamp: Date.now() - 1_000,
        model: "anthropic:claude-sonnet-4-5",
        contextUsage: {
          inputTokens: 150_000,
          outputTokens: 0,
          totalTokens: 150_000,
        },
      })
    );
    expect(appendSeedUsage.success).toBe(true);

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-6",
      agentId: "exec",
      providerOptions: {
        anthropic: {
          // Keep the routed follow-up's 1M intent visible to the compaction check so
          // it uses the 1M limit instead of the default 200K Anthropic limit.
          use1MContext: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(false);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedCompactionRequest = historyResult.data.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionRequest).toBe(false);

    session.dispose();
  });

  test("does trigger compaction at the default beta Anthropic threshold when beta features disable 1M", async () => {
    const workspaceId = "ws-auto-compaction-disabled-beta-1m";

    const streamRequests: unknown[] = [];
    const streamMessage = mock((request: unknown) => {
      streamRequests.push(request);
      return Promise.resolve(Ok(undefined));
    });
    const { session, historyService } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const appendSeedUsage = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-disabled-beta-usage", "assistant", "existing context", {
        timestamp: Date.now() - 1_000,
        model: "anthropic:claude-sonnet-4-5",
        contextUsage: {
          inputTokens: 150_000,
          outputTokens: 0,
          totalTokens: 150_000,
        },
      })
    );
    expect(appendSeedUsage.success).toBe(true);

    const result = await session.sendMessage("hello", {
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      providerOptions: {
        anthropic: {
          use1MContext: true,
          disableBetaFeatures: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const firstRequest = streamRequests[0] as { messages?: MuxMessage[] } | undefined;
    const requestMessages = Array.isArray(firstRequest?.messages) ? firstRequest.messages : [];
    const hasCompactionRequest = requestMessages.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(hasCompactionRequest).toBe(true);

    const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`failed to load history: ${String(historyResult.error)}`);
    }

    const persistedCompactionRequest = historyResult.data.some(
      (message) => message.metadata?.muxMetadata?.type === "compaction-request"
    );
    expect(persistedCompactionRequest).toBe(true);

    session.dispose();
  });

  test("compaction model inherit uses caller-provided baseOptions.model when no preferred model configured", async () => {
    const workspaceId = "ws-auto-compaction-inherit-base-options-model";

    const streamMessage = mock((_request: unknown) => Promise.resolve(Ok(undefined)));
    const { session } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const inheritedModel = "anthropic:claude-sonnet-4-6";
    const baseOptions: SendMessageOptions = {
      model: inheritedModel,
      agentId: "exec",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: inheritedModel,
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
        metadata: {
          requestedModel?: string;
          parsed?: {
            model?: string;
          };
        };
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    expect(compactionRequest.sendOptions.model).toBe(inheritedModel);
    expect(compactionRequest.metadata.requestedModel).toBe(inheritedModel);
    expect(compactionRequest.metadata.parsed?.model).toBe(inheritedModel);

    session.dispose();
  });

  test("clears strictAgentResolution on the internal compact request", async () => {
    const workspaceId = "ws-auto-compaction-clears-strict";

    const streamMessage = mock((_request: unknown) => Promise.resolve(Ok(undefined)));
    const { session } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    // A strict explicit-agent workspace turn hitting auto-compaction: the internal
    // request intentionally runs the hidden compact agent, so the strict gate must not
    // apply to it (it would reject compact as not selectable and break compaction).
    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-sonnet-4-6",
      agentId: "plan",
      strictAgentResolution: true,
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: baseOptions.model,
      agentId: "plan",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => { sendOptions: SendMessageOptions };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    expect(compactionRequest.sendOptions.agentId).toBe("compact");
    expect(compactionRequest.sendOptions.strictAgentResolution).toBeUndefined();

    session.dispose();
  });

  test("compaction model explicit override takes priority over baseOptions.model", async () => {
    const workspaceId = "ws-auto-compaction-explicit-model-overrides-base-model";

    const streamMessage = mock((_request: unknown) => Promise.resolve(Ok(undefined)));
    const compactionModel = "openai:gpt-5.5";
    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: { compact: { modelString: compactionModel } },
      }),
    } as unknown as Config;
    const { session } = await createSessionHarness({
      workspaceId,
      config,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: "anthropic:claude-sonnet-4-6",
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
        metadata: {
          requestedModel?: string;
          parsed?: {
            model?: string;
          };
        };
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    expect(compactionRequest.sendOptions.model).toBe(compactionModel);
    expect(compactionRequest.metadata.requestedModel).toBe(compactionModel);
    expect(compactionRequest.metadata.parsed?.model).toBe(compactionModel);

    session.dispose();
  });

  test("compaction thinking level prefers compact agent default over baseOptions", async () => {
    const workspaceId = "ws-auto-compaction-compact-thinking-default";

    const streamMessage = mock((_request: unknown) => Promise.resolve(Ok(undefined)));
    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
      loadConfigOrDefault: () => ({
        agentAiDefaults: {
          compact: { modelString: "openai:gpt-5.5", thinkingLevel: "high" },
        },
      }),
    } as unknown as Config;
    const { session } = await createSessionHarness({
      workspaceId,
      config,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      thinkingLevel: "low",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "mid-stream",
    });

    // The compact agent's configured thinking level wins over the active stream's,
    // matching desktop /compact (applyCompactionOverrides).
    expect(compactionRequest.sendOptions.thinkingLevel).toBe("high");

    session.dispose();
  });

  test("compaction thinking level falls back to baseOptions when compact default is unset", async () => {
    const workspaceId = "ws-auto-compaction-base-thinking-fallback";

    const streamMessage = mock((_request: unknown) => Promise.resolve(Ok(undefined)));
    const { session } = await createSessionHarness({
      workspaceId,
      streamMessage: streamMessage as unknown as AIService["streamMessage"],
    });

    const baseOptions: SendMessageOptions = {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      thinkingLevel: "medium",
    };
    const followUpContent: CompactionFollowUpRequest = {
      text: "Continue",
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
    };

    const internals = session as unknown as {
      buildAutoCompactionRequest: (params: {
        followUpContent: CompactionFollowUpRequest;
        baseOptions: SendMessageOptions;
        reason: "on-send" | "mid-stream";
      }) => {
        sendOptions: SendMessageOptions;
      };
    };

    const compactionRequest = internals.buildAutoCompactionRequest({
      followUpContent,
      baseOptions,
      reason: "on-send",
    });

    expect(compactionRequest.sendOptions.thinkingLevel).toBe("medium");

    session.dispose();
  });

  test("threads providers config into pre-send and mid-stream compaction checks", async () => {
    const workspaceId = "ws-auto-compaction-providers-config";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const providersConfig = {
      openai: {
        models: [
          {
            id: "openai:gpt-4o",
            contextWindow: 222_222,
          },
        ],
      },
    } as unknown as ProvidersConfigMap;

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => {
      const usage = {
        inputTokens: 42,
        outputTokens: 1,
        totalTokens: 43,
      };

      aiEmitter.emit("usage-delta", {
        type: "usage-delta",
        workspaceId,
        messageId: "assistant-providers-config",
        usage,
      });

      aiEmitter.emit("stream-end", {
        type: "stream-end",
        workspaceId,
        messageId: "assistant-providers-config",
        parts: [],
        metadata: {
          model: "openai:gpt-4o",
          contextUsage: usage,
          providerMetadata: {},
        },
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
      loadProvidersConfig: () => providersConfig,
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const checkBeforeSend = mock((_params: unknown) => ({
      shouldShowWarning: false,
      shouldForceCompact: false,
      usagePercentage: 0,
      thresholdPercentage: 85,
    }));
    const checkMidStream = mock((_params: unknown) => false);

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend,
      checkMidStream,
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(checkBeforeSend).toHaveBeenCalledTimes(1);
    expect(checkBeforeSend.mock.calls[0]?.[0]).toMatchObject({
      providersConfig,
    });

    expect(checkMidStream).toHaveBeenCalledTimes(1);
    expect(checkMidStream.mock.calls[0]?.[0]).toMatchObject({
      providersConfig,
    });

    session.dispose();
  });

  test("seeds on-send compaction usage from the active compaction epoch only", async () => {
    const workspaceId = "ws-auto-compaction-seed-active-epoch";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const oldUsage = {
      inputTokens: 95_000,
      outputTokens: 100,
      totalTokens: 95_100,
    };

    const appendOldUser = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-old-before-boundary", "user", "old prompt", {
        timestamp: Date.now() - 4_000,
      })
    );
    expect(appendOldUser.success).toBe(true);

    const appendOldAssistant = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-old-before-boundary", "assistant", "old reply", {
        timestamp: Date.now() - 3_000,
        model: "openai:gpt-4o",
        contextUsage: oldUsage,
      })
    );
    expect(appendOldAssistant.success).toBe(true);

    const appendBoundary = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-compaction-boundary", "assistant", "compacted summary", {
        timestamp: Date.now() - 2_000,
        compacted: "user",
        compactionBoundary: true,
        compactionEpoch: 7,
      })
    );
    expect(appendBoundary.success).toBe(true);

    const appendCurrentEpochUser = await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-after-boundary", "user", "fresh prompt after compaction", {
        timestamp: Date.now() - 1_000,
      })
    );
    expect(appendCurrentEpochUser.success).toBe(true);

    const aiEmitter = new EventEmitter();
    const streamMessage = mock((_history: MuxMessage[]) => Promise.resolve(Ok(undefined)));
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream: mock((_workspaceId: string) => Promise.resolve(Ok(undefined))),
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const checkBeforeSend = mock((params: unknown) => {
      expect((params as { usage?: unknown }).usage).toBeUndefined();
      return {
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      };
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend,
      checkMidStream: mock(() => false),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const result = await session.sendMessage("new prompt after restart", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(checkBeforeSend).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  test("surfaces nested dispatch failures after mid-stream compaction interrupt", async () => {
    const workspaceId = "ws-auto-compaction-mid-stream-dispatch-failure";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    let streamCallCount = 0;
    const streamMessage = mock((_request: unknown) => {
      streamCallCount += 1;
      if (streamCallCount === 1) {
        const usage = {
          inputTokens: 42,
          outputTokens: 1,
          totalTokens: 43,
        };

        aiEmitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId: "assistant-mid-stream",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: Date.now(),
        });

        aiEmitter.emit("usage-delta", {
          type: "usage-delta",
          workspaceId,
          messageId: "assistant-mid-stream",
          usage,
          cumulativeUsage: usage,
        });
      }

      return Promise.resolve(Ok(undefined));
    });

    const stopStream = mock((_workspaceId: string) => {
      aiEmitter.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "assistant-mid-stream",
        abortReason: "system",
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream,
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    const internals = session as unknown as {
      compactionMonitor: CompactionMonitor;
      sendMessage: AgentSession["sendMessage"];
    };

    let midStreamChecks = 0;
    internals.compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      })),
      checkMidStream: mock((_params: unknown) => {
        midStreamChecks += 1;
        return midStreamChecks === 1;
      }),
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const originalSendMessage = session.sendMessage.bind(session);
    let sendCallCount = 0;
    internals.sendMessage = (async (...args: Parameters<AgentSession["sendMessage"]>) => {
      sendCallCount += 1;
      if (sendCallCount === 1) {
        return originalSendMessage(...args);
      }

      return Err({ type: "unknown", raw: "mid-stream compaction dispatch failed" });
    }) as AgentSession["sendMessage"];

    const events: WorkspaceChatMessage[] = [];
    session.onChatEvent(({ message }) => {
      events.push(message);
    });

    const result = await internals.sendMessage("hello", {
      model: "openai:gpt-4o",
      agentId: "exec",
    });

    expect(result.success).toBe(true);

    const deadline = Date.now() + 1500;
    while (!events.some((event) => event.type === "stream-error") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const streamError = events.find(
      (event): event is Extract<WorkspaceChatMessage, { type: "stream-error" }> =>
        event.type === "stream-error"
    );
    expect(streamError).toBeDefined();
    expect(streamError?.error).toContain("mid-stream compaction dispatch failed");
    expect(stopStream).toHaveBeenCalledTimes(1);

    session.dispose();
  });

  test("hides default follow-up sentinel in mid-stream auto-compaction prompts", async () => {
    const workspaceId = "ws-auto-compaction-mid-stream-sentinel";

    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;

    const aiEmitter = new EventEmitter();
    const streamHistories: MuxMessage[][] = [];
    let streamCallCount = 0;
    const streamMessage = mock((request: unknown) => {
      const requestMessages =
        typeof request === "object" && request !== null && "messages" in request
          ? (request as { messages?: unknown }).messages
          : undefined;
      streamHistories.push(Array.isArray(requestMessages) ? (requestMessages as MuxMessage[]) : []);
      streamCallCount += 1;

      if (streamCallCount === 1) {
        const usage = {
          inputTokens: 42,
          outputTokens: 1,
          totalTokens: 43,
        };

        aiEmitter.emit("stream-start", {
          type: "stream-start",
          workspaceId,
          messageId: "assistant-mid-stream",
          model: "openai:gpt-4o",
          historySequence: 1,
          startTime: Date.now(),
        });

        aiEmitter.emit("usage-delta", {
          type: "usage-delta",
          workspaceId,
          messageId: "assistant-mid-stream",
          usage,
          cumulativeUsage: usage,
        });
      }

      return Promise.resolve(Ok(undefined));
    });

    const stopStream = mock((_workspaceId: string) => {
      aiEmitter.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "assistant-mid-stream",
        abortReason: "system",
      });

      return Promise.resolve(Ok(undefined));
    });

    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock((_workspaceId: string) => false),
      stopStream,
      streamMessage: streamMessage as unknown as (
        ...args: Parameters<AIService["streamMessage"]>
      ) => Promise<unknown>,
    }) as unknown as AIService;

    const initStateManager = new EventEmitter() as unknown as InitStateManager;

    const backgroundProcessManager = {
      cleanup: mock((_workspaceId: string) => Promise.resolve()),
      setMessageQueued: mock((_workspaceId: string, _queued: boolean) => {
        void _queued;
      }),
    } as unknown as BackgroundProcessManager;

    const config = {
      srcDir: "/tmp",
      getSessionDir: (_workspaceId: string) => "/tmp",
    } as unknown as Config;

    const session = new AgentSession({
      workspaceId,
      config,
      historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });

    let midStreamChecks = 0;
    const checkMidStream = mock((_params: unknown) => {
      midStreamChecks += 1;
      return midStreamChecks === 1;
    });

    (session as unknown as { compactionMonitor: CompactionMonitor }).compactionMonitor = {
      checkBeforeSend: mock(() => ({
        shouldShowWarning: false,
        shouldForceCompact: false,
        usagePercentage: 0,
        thresholdPercentage: 85,
      })),
      checkMidStream,
      resetForNewStream: mock(() => undefined),
      setThreshold: mock(() => undefined),
      getThreshold: mock(() => 0.85),
    } as unknown as CompactionMonitor;

    const workspaceTurnMetadata = {
      type: "workspace-turn-task",
      taskHandleId: "wst_mid_stream_compaction",
      ownerWorkspaceId: "parent-mid-stream-compaction",
      turnId: "turn-mid-stream-compaction",
    } as const;
    const result = await session.sendMessage(
      "hello",
      {
        model: "openai:gpt-4o",
        agentId: "exec",
        muxMetadata: workspaceTurnMetadata,
      },
      { agentInitiated: true }
    );

    expect(result.success).toBe(true);

    const deadline = Date.now() + 1500;
    while (streamHistories.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(streamHistories.length).toBeGreaterThanOrEqual(2);
    const compactionHistory = streamHistories[1];
    const compactionRequestMessage = [...compactionHistory]
      .reverse()
      .find((message) => message.metadata?.muxMetadata?.type === "compaction-request");

    expect(compactionRequestMessage).toBeDefined();

    const compactionRequestMetadata = compactionRequestMessage?.metadata?.muxMetadata;
    expect(compactionRequestMetadata?.type).toBe("compaction-request");
    if (compactionRequestMetadata?.type !== "compaction-request") {
      throw new Error("Expected a persisted mid-stream compaction request");
    }
    expect(compactionRequestMetadata.parsed.followUpContent?.muxMetadata).toEqual(
      workspaceTurnMetadata
    );
    expect(compactionRequestMetadata.parsed.followUpContent?.agentInitiated).toBe(true);

    const compactionRequestText =
      compactionRequestMessage?.parts.find((part) => part.type === "text")?.text ?? "";
    expect(compactionRequestText).not.toContain("The user wants to continue with:");
    expect(compactionRequestText).not.toContain("[CONTINUE]");
    expect(stopStream).toHaveBeenCalledTimes(1);

    session.dispose();
  });
});
