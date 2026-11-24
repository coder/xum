import { afterEach, describe, expect, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { ProvidersConfigStore } from "@/node/config/providersConfigStore";
import { AIService } from "./aiService";
import { InitStateManager } from "./initStateManager";
import { ProviderService } from "./providerService";
import { StreamManager } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";
import { createWorkspaceServiceForTest } from "./workspaceService.testHarness";

// Each live AgentSession adds one listener per forwarded event to the process-wide AIService and
// InitStateManager. The live server logged MaxListenersExceededWarning for both once enough
// workspaces and sub-agents had sessions; this pins that the count tracks live sessions (no
// leak) and that live sessions alone never trip the warning.
const SESSION_COUNT = 60;

function totalListeners(emitter: EventEmitter): number {
  return emitter.eventNames().reduce((total, name) => total + emitter.listenerCount(name), 0);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("WorkspaceService session listeners on shared emitters", () => {
  test("many live sessions trip no leak warning and disposal removes all their listeners", async () => {
    const history = await createTestHistoryService();
    cleanups.push(history.cleanup);
    const { config, historyService } = history;
    const initStateManager = new InitStateManager(config);
    const providerService = new ProviderService(config, new ProvidersConfigStore(config.rootDir));
    // Production DI hands one StreamManager to both services; so does this test.
    const streamManager = new StreamManager(historyService, undefined, () =>
      providerService.getConfig()
    );
    const aiService = new AIService(
      config,
      historyService,
      initStateManager,
      providerService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamManager
    );
    const service = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService,
      initStateManager,
      streamManager,
    });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message);
    };
    process.on("warning", onWarning);
    cleanups.push(() => {
      process.off("warning", onWarning);
      return Promise.resolve();
    });

    const aiBaseline = totalListeners(aiService);
    const initBaseline = totalListeners(initStateManager);
    const ids = Array.from({ length: SESSION_COUNT }, (_, index) => `ws-${index}`);
    cleanups.push(async () => {
      await Promise.all(ids.map((id) => service.disposeSession(id)));
    });

    for (const id of ids) service.getOrCreateSession(id);
    // Node reports the warning on a later tick.
    await new Promise((resolve) => setImmediate(resolve));

    // One listener per session per event: the count scales with live sessions.
    const aiPerSession = (totalListeners(aiService) - aiBaseline) / SESSION_COUNT;
    const initPerSession = (totalListeners(initStateManager) - initBaseline) / SESSION_COUNT;
    expect(aiPerSession).toBeGreaterThan(0);
    expect(Number.isInteger(aiPerSession)).toBe(true);
    expect(initPerSession).toBeGreaterThan(0);
    expect(Number.isInteger(initPerSession)).toBe(true);
    expect(aiService.listenerCount("tool-call-execution-start")).toBeGreaterThan(SESSION_COUNT - 1);
    expect(warnings).toEqual([]);

    // disposeSession is the path archive, removal and shutdown use.
    await Promise.all(ids.map((id) => service.disposeSession(id)));
    expect(totalListeners(aiService)).toBe(aiBaseline);
    expect(totalListeners(initStateManager)).toBe(initBaseline);
  });
});
