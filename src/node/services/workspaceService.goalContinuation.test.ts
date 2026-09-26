import { afterEach, describe, expect, test, mock } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { ProjectsConfig } from "@/common/types/project";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { SendMessageOptions } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { waitForCondition } from "./testDispatchHelpers";
import {
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";

// Regression: persisted completed init state must not defer goal continuations as initializing.
describe("WorkspaceService.getGoalContinuationRuntimeState", () => {
  const harnesses: WorkspaceServiceHarness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  /** Real-dependency service; each test seeds only the state it reads. */
  async function makeHarness(): Promise<WorkspaceServiceHarness> {
    const harness = await createWorkspaceServiceHarness();
    harnesses.push(harness);
    return harness;
  }

  /** Drives the real InitStateManager to the requested init phase for `workspaceId`. */
  async function makeService(
    initStatus: "running" | "success" | undefined,
    workspaceId = "ws-1"
  ): Promise<WorkspaceService> {
    const { service, initStateManager } = await makeHarness();
    if (initStatus !== undefined) {
      initStateManager.startInit(workspaceId, "/tmp/proj");
      if (initStatus === "success") {
        await initStateManager.endInit(workspaceId, 0);
      }
    }
    return service;
  }

  test("isInitializing is false when init has finished successfully", async () => {
    const service = await makeService("success");
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(false);
  });

  test("isInitializing is false when no init state has ever existed", async () => {
    const service = await makeService(undefined);
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(false);
  });

  test("isInitializing is true only while init is actively running", async () => {
    const service = await makeService("running");
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(true);
  });

  test("in-preflight direct sends report the workspace busy for goal continuations", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cECpR): a direct send does not set PREPARING
    // until late in AgentSession.sendMessage, so a kickoff candidate restored
    // while the send is mid-preflight (manual row already durable, session
    // still phase-idle) could otherwise be consumed by goal-continuation
    // eligibility and dispatched ahead of the user's turn. The runtime busy
    // predicate must include sendMessage's preflight counter.
    const service = await makeService(undefined);
    expect(service.getGoalContinuationRuntimeState("ws-1").isBusy).toBe(false);

    const counts = (service as unknown as { preflightSendCounts: Map<string, number> })
      .preflightSendCounts;
    counts.set("ws-1", 1);
    expect(service.getGoalContinuationRuntimeState("ws-1").isBusy).toBe(true);
    counts.delete("ws-1");
    expect(service.getGoalContinuationRuntimeState("ws-1").isBusy).toBe(false);
  });

  test("kickoff continuation fires on a freshly-init'd workspace", async () => {
    const workspaceId = "kickoff-after-init";
    const service = await makeService("success", workspaceId);

    const { historyService, config, cleanup } = await createTestHistoryService();
    try {
      await config.addWorkspace("/tmp/kickoff-proj", {
        id: workspaceId,
        name: workspaceId,
        projectName: "kickoff-proj",
        projectPath: "/tmp/kickoff-proj",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        `${config.rootDir}/kickoff-extension-metadata.json`
      );
      const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);

      const dispatcher = new IdleDispatcher();
      const execute = mock(() => Promise.resolve(true));
      goalService.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: (id) => service.getGoalContinuationRuntimeState(id),
        executeGoalContinuation: execute,
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      const result = await goalService.setGoal({ workspaceId, objective: "Ship the kickoff fix" });
      expect(result.success).toBe(true);

      // Wait for the kickoff continuation dispatch via the shared
      // `waitForCondition` helper instead of an inline `Date.now()` loop —
      // the dispatcher worker is microtask + setTimeout-driven so we poll
      // until it lands (Coder-agents-review nit DEREM-50).
      await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    } finally {
      await cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // getDelegatedTurnContinuationSendOptions — bash-monitor wake continuations
  // --------------------------------------------------------------------------

  describe("delegated-turn continuation send options", () => {
    async function makeServiceWithHistory(): Promise<{
      service: WorkspaceService;
      historyService: HistoryService;
    }> {
      const { service, historyService } = await makeHarness();
      return { service, historyService };
    }

    interface DelegatedContinuationInternals {
      getDelegatedTurnContinuationSendOptions: (
        workspaceId: string
      ) => Promise<SendMessageOptions | null>;
    }

    const delegatedTurnCorrelation = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: "owner-ws",
      turnId: "turn-1",
    };

    const delegatedTurnMessage = (id: string) =>
      createMuxMessage(id, "user", "Delegated prompt", {
        timestamp: Date.now(),
        muxMetadata: delegatedTurnCorrelation,
        retrySendOptions: {
          model: "anthropic:claude-opus-4-6",
          agentId: "plan",
          strictAgentResolution: true,
          agentInitiated: true,
        },
      });

    /** Correlated assistant response; "tool-calls" is the queue-dispatch cut that leaves the turn open. */
    const delegatedAssistantMessage = (id: string, finishReason: "tool-calls" | "stop") =>
      createMuxMessage(id, "assistant", "Working…", {
        timestamp: Date.now(),
        partial: false,
        finishReason,
        muxMetadata: delegatedTurnCorrelation,
      });

    test("continues a still-open delegated turn under its own per-turn options", async () => {
      const workspaceId = "ws-delegated-continuation";
      const { service, historyService } = await makeServiceWithHistory();
      await historyService.appendToHistory(workspaceId, delegatedTurnMessage("delegated-1"));
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-cut", "tool-calls")
      );
      // A previous wake continuation must not hide the delegated turn's options.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("wake-1", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: { type: "bash-monitor-wake" as const, records: [] },
        })
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      const options = await internals.getDelegatedTurnContinuationSendOptions(workspaceId);

      expect(options).not.toBeNull();
      // Per-turn overrides (agent, strictness) continue the turn; they never become
      // workspace defaults, and internal-only fields are not forwarded.
      expect(options).toMatchObject({
        model: "anthropic:claude-opus-4-6",
        agentId: "plan",
        strictAgentResolution: true,
        skipAiSettingsPersistence: true,
      });
      expect(options && "agentInitiated" in options).toBe(false);
      expect(options?.muxMetadata).toBeUndefined();
    });

    test("recovers options from a wake row after on-send compaction hid the delegated row", async () => {
      const workspaceId = "ws-delegated-post-compaction";
      const { service, historyService } = await makeServiceWithHistory();
      // On-send compaction consumed a wake continuation: the original delegated row is
      // behind the boundary; the compaction summary proves the turn is still open and
      // the follow-up wake-typed row is the remaining carrier of the turn's options.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary-1", "assistant", "Summary", {
          timestamp: Date.now(),
          muxMetadata: {
            type: "compaction-summary" as const,
            pendingFollowUp: {
              text: "Continue",
              model: "anthropic:claude-opus-4-6",
              agentId: "plan",
              workspaceTurnMetadata: delegatedTurnCorrelation,
            },
          },
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("wake-followup", "user", "Monitor matched", {
          timestamp: Date.now(),
          muxMetadata: { type: "bash-monitor-wake" as const, records: [] },
          retrySendOptions: {
            model: "anthropic:claude-opus-4-6",
            agentId: "plan",
            strictAgentResolution: { expectedScope: "built-in" },
          },
        })
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      const options = await internals.getDelegatedTurnContinuationSendOptions(workspaceId);
      expect(options).toMatchObject({
        model: "anthropic:claude-opus-4-6",
        agentId: "plan",
        strictAgentResolution: { expectedScope: "built-in" },
        skipAiSettingsPersistence: true,
      });
    });

    test("sanitizes persisted options through the canonical whitelist", async () => {
      const workspaceId = "ws-delegated-sanitized";
      const { service, historyService } = await makeServiceWithHistory();
      const tamperedRetrySendOptions: Record<string, unknown> = {
        model: "anthropic:claude-opus-4-6",
        agentId: "plan",
        editMessageId: "innocent-message",
        muxMetadata: { type: "workspace-turn-task" },
      };
      const malformedRetrySendOptions: Record<string, unknown> = { agentId: "plan" }; // model missing
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("delegated-tampered", "user", "Delegated prompt", {
          timestamp: Date.now(),
          muxMetadata: delegatedTurnCorrelation,
          // History is untrusted at rest: injected fields outside the whitelist
          // (editMessageId would flip the send into the edit/truncation flow) must
          // never reach the internal continuation send.
          retrySendOptions: tamperedRetrySendOptions as never,
        })
      );
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-cut-3", "tool-calls")
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      const options = await internals.getDelegatedTurnContinuationSendOptions(workspaceId);
      expect(options).toMatchObject({ agentId: "plan", skipAiSettingsPersistence: true });
      expect(options && "editMessageId" in options && options.editMessageId).toBeFalsy();
      expect(options?.muxMetadata).toBeUndefined();

      // A row whose options fail schema validation entirely yields nothing.
      const malformedWorkspaceId = "ws-delegated-malformed";
      await historyService.appendToHistory(
        malformedWorkspaceId,
        createMuxMessage("delegated-malformed", "user", "Delegated prompt", {
          timestamp: Date.now(),
          muxMetadata: delegatedTurnCorrelation,
          retrySendOptions: malformedRetrySendOptions as never,
        })
      );
      await historyService.appendToHistory(
        malformedWorkspaceId,
        delegatedAssistantMessage("assistant-cut-4", "tool-calls")
      );
      expect(
        await internals.getDelegatedTurnContinuationSendOptions(malformedWorkspaceId)
      ).toBeNull();
    });

    test("yields nothing after a terminal assistant response closed the delegated turn", async () => {
      const workspaceId = "ws-delegated-closed";
      const { service, historyService } = await makeServiceWithHistory();
      await historyService.appendToHistory(workspaceId, delegatedTurnMessage("delegated-2"));
      // finishReason "stop" ends the delegated turn: a later monitor match is a NEW
      // synthetic turn and must resolve from persisted defaults, not stale overrides.
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-final", "stop")
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      expect(await internals.getDelegatedTurnContinuationSendOptions(workspaceId)).toBeNull();
    });

    test("yields nothing once another user send follows the delegated prompt", async () => {
      const workspaceId = "ws-delegated-superseded";
      const { service, historyService } = await makeServiceWithHistory();
      await historyService.appendToHistory(workspaceId, delegatedTurnMessage("delegated-3"));
      await historyService.appendToHistory(
        workspaceId,
        delegatedAssistantMessage("assistant-cut-2", "tool-calls")
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-1", "user", "Manual user message", { timestamp: Date.now() })
      );

      const internals = service as unknown as DelegatedContinuationInternals;
      expect(await internals.getDelegatedTurnContinuationSendOptions(workspaceId)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // getGoalContinuationKickoffSendOptions — model-resolution cascade
  // --------------------------------------------------------------------------

  describe("model-resolution cascade", () => {
    /** Seeds the real Config (round-tripped through config.json) the cascade reads. */
    async function makeServiceWithConfig(
      seed: Partial<ProjectsConfig> = {}
    ): Promise<WorkspaceService> {
      const { service, config } = await makeHarness();
      await config.editConfig((cfg) => ({ ...cfg, ...seed }));
      return service;
    }

    test("returns null when the workspace is not found in config", async () => {
      const service = await makeServiceWithConfig();
      expect(await service.getGoalContinuationKickoffSendOptions("ws-unknown")).toBeNull();
    });

    test("prefers per-workspace agent model over workspace default and globals", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettingsByAgent: {
                  exec: { model: "anthropic:claude-haiku-4-5", thinkingLevel: "off" as const },
                },
                aiSettings: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        projects,
        agentAiDefaults: { exec: { modelString: "google:gemini-2.5-pro" } },
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toContain("haiku");
      expect(result?.agentId).toBe("exec");
    });

    test("uses the persisted selected agent for initial goal kickoff options", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-selected-agent";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                agentId: "review",
                aiSettingsByAgent: {
                  review: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "off" as const },
                  exec: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({ projects });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      expect(result).toEqual({
        model: "anthropic:claude-sonnet-4-6",
        agentId: "review",
        thinkingLevel: "off",
        // The bucket owns the reasoning choice; absent resolves to explicit standard.
        reasoningMode: "standard",
      });
    });

    test("carries the persisted thinking level with the winning model candidate", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-thinking";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettingsByAgent: {
                  exec: { model: "anthropic:claude-fable-5", thinkingLevel: "medium" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({ projects });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      // Regression: continuations previously dropped the persisted thinking
      // level, streaming with an implicit "off" that Fable/Mythos-class
      // Anthropic models reject ("thinking.type.disabled" unsupported).
      expect(result).toEqual({
        model: "anthropic:claude-fable-5",
        agentId: "exec",
        thinkingLevel: "medium",
        reasoningMode: "standard",
      });
    });

    test("falls back to exec when the selected agent cannot run goal continuations", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-plan-agent";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                agentId: "plan",
                aiSettingsByAgent: {
                  plan: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "off" as const },
                  exec: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({ projects });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      expect(result).toEqual({
        model: "openai:gpt-4o",
        agentId: "exec",
        thinkingLevel: "off",
        reasoningMode: "standard",
      });
    });

    test("falls through to workspace default model when per-agent is missing", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettings: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({ projects });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBe("openai:gpt-4o");
    });

    test("falls through to global agent default when workspace has no model", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        projects,
        agentAiDefaults: { exec: { modelString: "anthropic:claude-sonnet-4-6" } },
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toContain("sonnet");
    });

    test("model-less reasoning-only agent default still contributes its fields", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        projects,
        // "Inherit" model in settings persists entries with only thinking
        // fields; the model must fall through while these fields apply.
        agentAiDefaults: {
          exec: { thinkingLevel: "high" as const, reasoningMode: "pro" as const },
        },
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBeTruthy();
      expect(result?.thinkingLevel).toBe("high");
      expect(result?.reasoningMode).toBe("pro");
    });

    test("resolves defaults through the selected agent's declared base chain", async () => {
      // A custom agent declaring base: plan must inherit Plan's configured
      // defaults, not fall through to the Exec approximation (mirrors
      // Settings/ACP/task-spawn resolution).
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-goal-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "researcher.md"),
          `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            {
              // getInfo reads this real entry, so the checkout root is the fixture directory
              // holding the agent definition.
              workspaces: [
                {
                  id: workspaceId,
                  path: projectPath,
                  runtimeConfig: { type: "local" as const },
                  agentId: "researcher",
                },
              ],
            },
          ],
        ]);
        const service = await makeServiceWithConfig({
          projects,
          agentAiDefaults: {
            plan: { thinkingLevel: "high" as const, reasoningMode: "pro" as const },
            exec: { thinkingLevel: "low" as const, reasoningMode: "standard" as const },
          },
        });

        const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
        expect(result?.thinkingLevel).toBe("high");
        expect(result?.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("a project-scoped exec override with base: plan inherits Plan's defaults", async () => {
      // Every agent's declaration must be inspected, including one named
      // "exec": a project exec.md with base: plan must resolve Plan's pro
      // default, matching ACP/task/desktop resolution.
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-exec-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "exec.md"),
          `---\nname: Exec\ndescription: Project exec override for tests\nbase: plan\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            {
              // Real entry read by getInfo, like the researcher test above.
              workspaces: [
                {
                  id: workspaceId,
                  path: projectPath,
                  runtimeConfig: { type: "local" as const },
                  agentId: "exec",
                },
              ],
            },
          ],
        ]);
        const service = await makeServiceWithConfig({
          projects,
          agentAiDefaults: {
            plan: { reasoningMode: "pro" as const },
          },
        });

        const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
        expect(result?.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("idle compaction inherits reasoning through compact's configured base chain", async () => {
      // Same class as the /compact frontend fix: exec's configured pro must
      // reach backend compaction even with no workspace-level overrides.
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        projects,
        agentAiDefaults: {
          exec: { reasoningMode: "pro" as const },
        },
      });

      const result = await (
        service as unknown as {
          buildIdleCompactionSendOptions(id: string): Promise<{ reasoningMode?: string }>;
        }
      ).buildIdleCompactionSendOptions(workspaceId);
      expect(result.reasoningMode).toBe("pro");
    });

    test("heartbeat reasoning resolves through the selected agent's declared base chain", async () => {
      // Same parity requirement as goal kickoffs: a base: plan custom agent
      // must inherit Plan's configured Pro default, not the Exec fallback.
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-hb-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "researcher.md"),
          `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            {
              // getInfo reads this real entry, so the checkout root is the fixture directory
              // holding the agent definition.
              workspaces: [
                {
                  id: workspaceId,
                  path: projectPath,
                  runtimeConfig: { type: "local" as const },
                  agentId: "researcher",
                },
              ],
            },
          ],
        ]);
        const service = await makeServiceWithConfig({
          projects,
          agentAiDefaults: {
            plan: {
              modelString: "openai:gpt-5.6-sol",
              thinkingLevel: "high" as const,
              reasoningMode: "pro" as const,
            },
            exec: {
              modelString: "anthropic:claude-sonnet-4-6",
              thinkingLevel: "low" as const,
              reasoningMode: "standard" as const,
            },
          },
        });

        // Model, thinking, and reasoning must ALL resolve through the chain:
        // inheriting pro beside exec's Anthropic model would gate pro out.
        const result = await (
          service as unknown as {
            buildHeartbeatSendOptions(id: string): Promise<{
              sendOptions: { model: string; thinkingLevel?: string; reasoningMode?: string };
            }>;
          }
        ).buildHeartbeatSendOptions(workspaceId);
        expect(result.sendOptions.model).toBe("openai:gpt-5.6-sol");
        expect(result.sendOptions.thinkingLevel).toBe("high");
        expect(result.sendOptions.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("falls through to DEFAULT_MODEL as the final fallback", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({ projects });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBeTruthy();
      expect(result?.agentId).toBe("exec");
    });

    test("skips invalid candidate strings and tries the next fallback", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettings: { model: "   ", thinkingLevel: "off" as const }, // whitespace-only -> skipped
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        projects,
        agentAiDefaults: { exec: { modelString: "openai:gpt-4o" } },
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBe("openai:gpt-4o");
    });
  });
});
