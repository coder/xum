import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import path from "path";

import { Err, Ok } from "@/common/types/result";
import type { AIService } from "./aiService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { InitStateManager } from "./initStateManager";
import type { TurnCompletion } from "./streamManager";
import type { TaskCheckoutAuthorization } from "./taskCheckoutAuthorization";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import type { TurnAdmissionToken } from "./taskWorkspaceSeam";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceService } from "./workspaceService";

/**
 * The checkout-preparation preflight at WorkspaceService's stream-starting entry points: a send
 * or resume into an agent-task workspace runs the integration's async preflight BEFORE the
 * synchronous fence and hands the captured authority to the fence (and to the manual rescue).
 * A refused preflight ends the send before any obligation, rescue, row or turn. Roots (no parent)
 * never preflight; caller-minted tokens already carry their admission.
 */
describe("WorkspaceService checkout-preparation preflight", () => {
  const rootId = "prep-root";
  const taskId = "prep-task-child";
  const projectPath = "/tmp/prep-gate-project";
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

  function token(): TurnAdmissionToken & { events: string[] } {
    const t = {
      events: [] as string[],
      admissionStale: () => false,
      onEnqueued: () => {
        t.events.push("enqueued");
      },
      onAdmitted: () => {
        t.events.push("admitted");
      },
      onDisposed: (kind: string) => {
        if (!t.events.includes("admitted")) t.events.push(`disposed:${kind}`);
      },
    };
    return t;
  }

  async function createFixture(workspaceId: string) {
    const testHistory = await createTestHistoryService();
    cleanup = testHistory.cleanup;
    const { config, historyService } = testHistory;
    await config.addWorkspace(projectPath, {
      id: rootId,
      name: rootId,
      projectName: "prep-gate-project",
      projectPath,
      runtimeConfig: { type: "local" },
    });
    await config.addWorkspace(projectPath, {
      id: taskId,
      name: taskId,
      projectName: "prep-gate-project",
      projectPath,
      runtimeConfig: { type: "local" },
      parentWorkspaceId: rootId,
      taskIsolation: "none",
      taskStatus: "running",
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
      new ExtensionMetadataService(path.join(config.rootDir, "prep-extension-metadata.json")),
      backgroundProcessManager
    );
    (service as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      workspaceId,
      harness.session
    );
    const streamCalls = () =>
      (aiService as unknown as { streamMessage: ReturnType<typeof mock> }).streamMessage.mock.calls
        .length;
    return { service, streamCalls };
  }

  /** The captured authority is opaque to WorkspaceService: only its identity is threaded. */
  const authority = { captured: "authorization" } as unknown as TaskCheckoutAuthorization;

  test("a refused preflight ends a task send before the fence, the rescue and any turn", async () => {
    const { service, streamCalls } = await createFixture(taskId);
    const preflight = mock(() => Promise.resolve(Err("checkout preparation refused")));
    const admit = mock(() => ({ kind: "admitted" as const, token: token() }));
    const rescue = mock(() => Promise.resolve(false));
    service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        preflightTaskWorkspacePreparation: preflight,
        admitTaskWorkspaceTurn: admit,
        markInterruptedTaskRunning: rescue,
      })
    );
    const result = await service.sendMessage(taskId, "go", { model, agentId: "exec" });
    expect(result).toEqual({
      success: false,
      error: { type: "unknown", raw: "checkout preparation refused" },
    });
    expect(preflight).toHaveBeenCalledWith(taskId);
    expect(admit).not.toHaveBeenCalled();
    expect(rescue).not.toHaveBeenCalled();
    expect(streamCalls()).toBe(0);
  });

  test("a successful preflight hands the captured authority to the rescue and the fence of a direct send", async () => {
    const { service, streamCalls } = await createFixture(taskId);
    const minted = token();
    const preflight = mock(() => Promise.resolve(Ok(authority)));
    const admit = mock(() => ({ kind: "admitted" as const, token: minted }));
    const rescue = mock(() => Promise.resolve(false));
    service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        preflightTaskWorkspacePreparation: preflight,
        admitTaskWorkspaceTurn: admit,
        markInterruptedTaskRunning: rescue,
      })
    );
    expect(await service.sendMessage(taskId, "go", { model, agentId: "exec" })).toEqual(
      Ok(undefined)
    );
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(rescue).toHaveBeenCalledWith(taskId, { preparation: authority });
    expect(admit).toHaveBeenCalledWith(taskId, {
      acceptanceOrigin: "manual",
      preparation: authority,
    });
    expect(minted.events).toEqual(["admitted"]);
    expect(streamCalls()).toBe(1);
  });

  test("a resume preflights before the rescue and threads the same authority to both", async () => {
    const { service } = await createFixture(taskId);
    const order: string[] = [];
    const preflight = mock(() => {
      order.push("preflight");
      return Promise.resolve(Ok(authority));
    });
    const rescue = mock(() => {
      order.push("rescue");
      return Promise.resolve(false);
    });
    const admit = mock(() => {
      order.push("fence");
      return { kind: "admitted" as const, token: token() };
    });
    service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        preflightTaskWorkspacePreparation: preflight,
        admitTaskWorkspaceTurn: admit,
        markInterruptedTaskRunning: rescue,
      })
    );
    // Empty history: the admitted resume turn fails in preparation; the ordering is what matters.
    await service.resumeStream(taskId, { model, agentId: "exec" });
    expect(order).toEqual(["preflight", "rescue", "fence"]);
    expect(rescue).toHaveBeenCalledWith(taskId, { preparation: authority });
    expect(admit).toHaveBeenCalledWith(taskId, {
      acceptanceOrigin: "manual",
      preparation: authority,
    });
  });

  test("a refused preflight ends a resume before the rescue", async () => {
    const { service } = await createFixture(taskId);
    const rescue = mock(() => Promise.resolve(false));
    const admit = mock(() => ({ kind: "admitted" as const, token: token() }));
    service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        preflightTaskWorkspacePreparation: () => Promise.resolve(Err("refused")),
        admitTaskWorkspaceTurn: admit,
        markInterruptedTaskRunning: rescue,
      })
    );
    const result = await service.resumeStream(taskId, { model, agentId: "exec" });
    expect(result).toEqual({ success: false, error: { type: "unknown", raw: "refused" } });
    expect(rescue).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  test("roots never preflight and caller-minted tokens skip it", async () => {
    const { service } = await createFixture(rootId);
    const preflight = mock(() => Promise.resolve(Err("must not be called")));
    const admit = mock(() => ({ kind: "not-a-task" as const }));
    service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        preflightTaskWorkspacePreparation: preflight,
        admitTaskWorkspaceTurn: admit,
      })
    );
    expect(await service.sendMessage(rootId, "hello", { model, agentId: "exec" })).toEqual(
      Ok(undefined)
    );
    expect(preflight).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledWith(rootId, { acceptanceOrigin: "manual" });
  });

  test("a launch send carrying its own token does not preflight again", async () => {
    const { service } = await createFixture(taskId);
    const preflight = mock(() => Promise.resolve(Err("must not be called")));
    const minted = token();
    service.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        preflightTaskWorkspacePreparation: preflight,
        admitTaskWorkspaceTurn: () => {
          throw new Error("the fence must not mint a second obligation");
        },
      })
    );
    expect(
      await service.sendMessage(
        taskId,
        "launch",
        { model, agentId: "exec" },
        { acceptanceOrigin: "automatic", turnAdmission: minted }
      )
    ).toEqual(Ok(undefined));
    expect(preflight).not.toHaveBeenCalled();
    expect(minted.events).toEqual(["admitted"]);
  });
});
