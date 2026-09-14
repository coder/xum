import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import * as path from "node:path";

import type { Config } from "@/node/config";

import type { AIService } from "./aiService";
import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";
import { Ok } from "@/common/types/result";

/**
 * A send queued behind a busy session answers { queued: true } to the service,
 * whose fork auto-title then waits for the delivery report. The queue drain is
 * the only party that knows when such an entry actually streams.
 */

const WORKSPACE_ID = "workspace-queued-delivery-test";

describe("AgentSession queued delivery", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let session: AgentSession | undefined;

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  async function createSession(): Promise<AgentSession> {
    const created = await createTestHistoryService();
    cleanup = created.cleanup;
    const aiEmitter = new EventEmitter();
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.on(String(eventName), listener);
        return this;
      },
      off(eventName: string | symbol, listener: (...args: unknown[]) => void) {
        aiEmitter.off(String(eventName), listener);
        return this;
      },
      stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
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
      setMessageQueued: mock(() => undefined),
      cleanup: mock(() => Promise.resolve()),
    } as unknown as BackgroundProcessManager;
    const config: Config = {
      rootDir: created.config.rootDir,
      sessionsDir: created.config.sessionsDir,
      srcDir: path.join(created.config.rootDir, "src"),
      loadConfigOrDefault: mock(() => ({})),
    } as unknown as Config;
    session = new AgentSession({
      workspaceId: WORKSPACE_ID,
      config,
      historyService: created.historyService,
      aiService,
      initStateManager,
      backgroundProcessManager,
    });
    return session;
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("condition not met in time");
  }

  test("a busy-queued send reports its delivery when it streams, not when it defers again", async () => {
    const agentSession = await createSession();
    const delivered = mock((_text: string) => undefined);
    (
      agentSession as unknown as { onDeferredSendDelivered?: (text: string) => void }
    ).onDeferredSendDelivered = delivered;
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const sendMessage = spyOn(agentSession, "sendMessage")
      // First dispatch defers again (on-send compaction): its follow-up reports.
      .mockResolvedValueOnce(Ok({ queued: true }))
      // Second dispatch streams: the drain reports the delivery.
      .mockResolvedValueOnce(Ok(undefined));

    agentSession.queueMessage("deferred again", sendOptions);
    agentSession.sendQueuedMessages("terminal");
    await waitFor(() => sendMessage.mock.calls.length === 1);
    expect(delivered).not.toHaveBeenCalled();

    agentSession.queueMessage("streams now", sendOptions);
    agentSession.sendQueuedMessages("terminal");
    await waitFor(() => sendMessage.mock.calls.length === 2);
    await waitFor(() => delivered.mock.calls.length === 1);
    expect(delivered).toHaveBeenCalledWith("streams now");
  });
});
