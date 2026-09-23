import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import path from "path";

import { Ok } from "@/common/types/result";
import type { AIService } from "./aiService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { InitStateManager } from "./initStateManager";
import type { TurnCompletion } from "./streamManager";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import type { TaskTurnAdmission, TurnAdmissionToken } from "./taskWorkspaceSeam";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceService } from "./workspaceService";

/**
 * The task-attempt fence at WorkspaceService's session handoff: a send into a workspace the task
 * integration recognizes acquires exactly one obligation (unless the caller minted one), threads
 * it to the session or the queue, and disposes it itself only when neither took it.
 */
interface RecordedToken extends TurnAdmissionToken {
  readonly events: string[];
  stale: boolean;
}
function recordingToken(): RecordedToken {
  const token: RecordedToken = {
    events: [],
    stale: false,
    admissionStale: () => token.stale,
    onEnqueued: () => {
      token.events.push("enqueued");
    },
    onAdmitted: () => {
      token.events.push("admitted");
    },
    onDisposed: (kind) => {
      // Contract: ignored once admitted (the turn owns the obligation from then on).
      if (token.events.includes("admitted")) return;
      token.events.push(`disposed:${kind}`);
    },
  };
  return token;
}

const streamCalls = (aiService: unknown): number =>
  (aiService as { streamMessage: ReturnType<typeof mock> }).streamMessage.mock.calls.length;

describe("WorkspaceService task-attempt admission fence", () => {
  const workspaceId = "fenced-task-workspace";
  const model = "anthropic:claude-sonnet-4-5";
  let cleanup: (() => Promise<void>) | undefined;
  let session: AgentSession | undefined;
  const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];

  afterEach(async () => {
    for (const completion of completions) {
      completion.resolve({ status: "aborted", abortReason: "user" });
    }
    completions.length = 0;
    await session?.dispose();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  async function createFixture() {
    const testHistory = await createTestHistoryService();
    cleanup = testHistory.cleanup;
    const { config, historyService } = testHistory;
    await config.addWorkspace("/tmp/fenced-project", {
      id: workspaceId,
      name: workspaceId,
      projectName: "fenced-project",
      projectPath: "/tmp/fenced-project",
      runtimeConfig: { type: "local" },
    });
    const backgroundProcessManager = Object.assign(new EventEmitter(), {
      cleanup: mock(() => Promise.resolve()),
      hasRunningBackgroundProcesses: mock(() => false),
      hasOrphanedRunningBackgroundProcesses: mock(() => Promise.resolve(false)),
      setMessageQueued: mock(() => undefined),
    }) as unknown as BackgroundProcessManager;
    const aiEmitter = new EventEmitter();
    let streaming = false;
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      backgroundProcessManager,
      aiEmitter,
      aiServiceOverrides: {
        isStreaming: () => streaming,
        streamMessage: mock(() => {
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          streaming = true;
          const messageId = `assistant-${completions.length}`;
          aiEmitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
      },
    });
    session = harness.session;
    const initStateManager = {
      on: mock(() => undefined),
      off: mock(() => undefined),
      getInitState: mock(() => undefined),
      waitForInit: mock(() => Promise.resolve()),
      clearInMemoryState: mock(() => undefined),
    } as unknown as InitStateManager;
    const aiService = harness.aiService as unknown as AIService;
    const service = new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      initStateManager,
      new ExtensionMetadataService(path.join(config.rootDir, "fence-extension-metadata.json")),
      backgroundProcessManager
    );
    (service as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      workspaceId,
      harness.session
    );
    return { service, session: harness.session, aiService };
  }

  function integration(
    admit: (workspaceId: string, options: { acceptanceOrigin: string }) => TaskTurnAdmission
  ) {
    const admitTaskWorkspaceTurn = mock(admit);
    return {
      admitTaskWorkspaceTurn,
      fake: makeAgentTaskIntegrationFake({ admitTaskWorkspaceTurn }),
    };
  }

  test("a refused admission returns the fence's message before any row or turn", async () => {
    const { service, aiService } = await createFixture();
    const { admitTaskWorkspaceTurn, fake } = integration(() => ({
      kind: "refused",
      message: "attempt settled",
    }));
    service.setAgentTaskIntegration(fake);
    const result = await service.sendMessage(workspaceId, "continue", { model, agentId: "exec" });
    expect(result).toEqual({ success: false, error: { type: "unknown", raw: "attempt settled" } });
    expect(admitTaskWorkspaceTurn).toHaveBeenCalledWith(workspaceId, {
      acceptanceOrigin: "manual",
    });
    expect(streamCalls(aiService)).toBe(0);
  });

  test("an admitted direct send threads the token to the session, which reports admission", async () => {
    const { service } = await createFixture();
    const token = recordingToken();
    const { admitTaskWorkspaceTurn, fake } = integration(() => ({ kind: "admitted", token }));
    service.setAgentTaskIntegration(fake);
    expect(await service.sendMessage(workspaceId, "hello", { model, agentId: "exec" })).toEqual(
      Ok(undefined)
    );
    expect(admitTaskWorkspaceTurn).toHaveBeenCalledTimes(1);
    expect(token.events).toEqual(["admitted"]);
  });

  test("a caller-minted token is used as is (no second obligation) and its staleness gates the send", async () => {
    const { service, aiService } = await createFixture();
    const minted = recordingToken();
    const { admitTaskWorkspaceTurn, fake } = integration(() => {
      throw new Error("the fence must not mint a second obligation");
    });
    service.setAgentTaskIntegration(fake);
    expect(
      await service.sendMessage(
        workspaceId,
        "launch",
        { model, agentId: "exec" },
        { acceptanceOrigin: "automatic", turnAdmission: minted }
      )
    ).toEqual(Ok(undefined));
    expect(admitTaskWorkspaceTurn).not.toHaveBeenCalled();
    expect(minted.events).toEqual(["admitted"]);

    // A second, stale caller token never reaches the session: refused and disposed by the host.
    const stale = recordingToken();
    stale.stale = true;
    const refused = await service.sendMessage(
      workspaceId,
      "stale",
      { model, agentId: "exec" },
      { acceptanceOrigin: "automatic", turnAdmission: stale }
    );
    expect(refused.success).toBe(false);
    expect(stale.events).toEqual(["disposed:refused"]);
    expect(streamCalls(aiService)).toBe(1);
  });

  test("a send that queues hands the token to the queue (enqueued, not disposed); a deduped one has no work", async () => {
    const { service } = await createFixture();
    const tokens: RecordedToken[] = [];
    const { fake } = integration(() => {
      const token = recordingToken();
      tokens.push(token);
      return { kind: "admitted", token };
    });
    service.setAgentTaskIntegration(fake);
    expect(await service.sendMessage(workspaceId, "first", { model, agentId: "exec" })).toEqual(
      Ok(undefined)
    );
    expect(tokens[0].events).toEqual(["admitted"]);
    // Busy: the second send queues; the queue owns its token from insertion.
    expect(
      await service.sendMessage(
        workspaceId,
        "second",
        { model, agentId: "exec" },
        { acceptanceOrigin: "automatic", queueDedupeKey: "dedupe-key" }
      )
    ).toEqual(Ok(undefined));
    expect(tokens[1].events).toEqual(["enqueued"]);
    // Same dedupe key: coalesced into the pending entry before the fence — no obligation is
    // minted for a send that never enters, and the pending entry keeps its own token.
    expect(
      await service.sendMessage(
        workspaceId,
        "second again",
        { model, agentId: "exec" },
        { acceptanceOrigin: "automatic", queueDedupeKey: "dedupe-key" }
      )
    ).toEqual(Ok(undefined));
    expect(tokens).toHaveLength(2);
    expect(tokens[1].events).toEqual(["enqueued"]);
    // A queue-clearing Stop cancels the enqueued token exactly once.
    expect(service.clearQueue(workspaceId).success).toBe(true);
    expect(tokens[1].events).toEqual(["enqueued", "disposed:canceled-before-admission"]);
  });

  test.each(["sendMessage", "resumeStream"] as const)(
    "%s refuses when its reawaken lost the race and binds a won reawaken to exactly its attempt",
    async (operation) => {
      const { service } = await createFixture();
      const admitTaskWorkspaceTurn = mock(
        (_workspaceId: string, _options: { expectedAttemptId?: string }) =>
          ({ kind: "admitted", token: recordingToken() }) as const
      );
      const outcomes = [
        { kind: "refused", message: "lost the reawaken" } as const,
        { kind: "reawakened", attemptId: "att_00000000000000e1", statusChanged: true } as const,
      ];
      service.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          reawakenInterruptedTask: mock(() => Promise.resolve(outcomes.shift()!)),
          admitTaskWorkspaceTurn,
        })
      );
      const run = () =>
        operation === "sendMessage"
          ? service.sendMessage(workspaceId, "hello", { model, agentId: "exec" })
          : service.resumeStream(workspaceId, { model, agentId: "exec" });
      const lost = await run();
      expect(lost.success).toBe(false);
      if (!lost.success) expect(lost.error).toEqual({ type: "unknown", raw: "lost the reawaken" });
      // The losing caller never reaches the fence: it cannot adopt the winner's attempt.
      expect(admitTaskWorkspaceTurn).not.toHaveBeenCalled();
      await run();
      expect(admitTaskWorkspaceTurn).toHaveBeenCalledTimes(1);
      expect(admitTaskWorkspaceTurn.mock.calls[0]?.[1]).toMatchObject({
        expectedAttemptId: "att_00000000000000e1",
      });
    }
  );

  test("workspaces the integration does not recognize carry no obligation", async () => {
    const { service } = await createFixture();
    const { admitTaskWorkspaceTurn, fake } = integration(() => ({ kind: "not-a-task" }));
    service.setAgentTaskIntegration(fake);
    expect(await service.sendMessage(workspaceId, "hello", { model, agentId: "exec" })).toEqual(
      Ok(undefined)
    );
    expect(admitTaskWorkspaceTurn).toHaveBeenCalledTimes(1);
  });

  test("resumeStream acquires the obligation after the interrupted-task rescue; an admitted turn that fails to start keeps it admitted", async () => {
    const { service } = await createFixture();
    const order: string[] = [];
    const token = recordingToken();
    const fake = makeAgentTaskIntegrationFake({
      markInterruptedTaskRunning: mock(() => {
        order.push("rescue");
        return Promise.resolve(false);
      }),
      admitTaskWorkspaceTurn: mock(() => {
        order.push("fence");
        return { kind: "admitted" as const, token };
      }),
    });
    service.setAgentTaskIntegration(fake);
    // Nothing to resume (empty history): the coordinator admits the resume turn and its
    // preparation then fails. That is an ADMITTED obligation whose turn settles through the
    // preparation-failure path — never "never admitted" — so the host's disposal is ignored.
    const result = await service.resumeStream(workspaceId, { model, agentId: "exec" });
    expect(result.success).toBe(false);
    expect(order).toEqual(["rescue", "fence"]);
    expect(token.events).toEqual(["admitted"]);
  });
});
