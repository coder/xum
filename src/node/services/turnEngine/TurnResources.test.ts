import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { Effect, Exit, Scope } from "effect";

import type { Runtime } from "@/node/runtime/Runtime";
import { defaultEffectRunner } from "@/node/services/di/effectRunner";
import { attachLanguageModelCleanup } from "@/node/services/languageModelCleanup";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { StreamToken, WorkspaceId } from "@/node/services/turnEngine/types";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
import type { ExecutionScope } from "@/node/services/toolCallDisplayRegistry";

import { TurnResources } from "./TurnResources";

const WS = "turn-resources-ws" as WorkspaceId;
const TOKEN = "abcd1234" as StreamToken;
const runtimeStub: Partial<Runtime> = {};
const RUNTIME = runtimeStub as Runtime;

/** A TurnResources whose temp-dir, journal, registry and MCP calls are recorded. */
function createResources() {
  const calls: string[] = [];
  let mcp: Pick<MCPServerManager, "acquireLease" | "releaseLease"> | undefined;
  const resources = new TurnResources({
    effectRunner: defaultEffectRunner,
    toolCallDisplayRegistry: { close: (scope) => void calls.push(`close-scope:${scope.token}`) },
    partialJournal: {
      retire: () => void calls.push("retire"),
      interruptScheduled: () => void calls.push("interrupt"),
      awaitPending: () => {
        calls.push("await-pending");
        return Promise.resolve();
      },
    },
    mcpServerManager: () => mcp as MCPServerManager | undefined,
    createTempDirForStream: (token) => {
      calls.push(`create:${token}`);
      return Promise.resolve(`/home/u/.xum-tmp/${token}`);
    },
    cleanupStreamTempDir: (_runtime, dir) => void calls.push(`cleanup:${dir}`),
  });
  return {
    resources,
    calls,
    setMcp: (next: typeof mcp) => {
      mcp = next;
    },
  };
}

function modelWithCleanup(calls: string[]): LanguageModel {
  const model = { specificationVersion: "v2", provider: "test", modelId: "m" };
  const languageModel = model as unknown as LanguageModel;
  attachLanguageModelCleanup(languageModel, () => void calls.push("model-cleanup"));
  return languageModel;
}

function closeScope(scope: Scope.Closeable): Promise<void> {
  return Effect.runPromise(Scope.close(scope, Exit.void));
}

describe("TurnResources", () => {
  test("a start that never registers aborts its request and releases what it acquired", async () => {
    const { resources, calls } = createResources();
    const caller = new AbortController();
    const startup = resources.openStartup(caller.signal);
    const dir = await resources.acquireTempDir(startup.resourceScope, TOKEN, RUNTIME, undefined);

    await resources.releaseStartup(startup, modelWithCleanup(calls), undefined);

    expect(dir).toBe("/home/u/.xum-tmp/abcd1234");
    expect(startup.abortController.signal.aborted).toBe(true);
    expect(startup.abortController.signal.reason).toBeInstanceOf(Error);
    expect(calls).toEqual([
      "create:abcd1234",
      "model-cleanup",
      "cleanup:/home/u/.xum-tmp/abcd1234",
    ]);
  });

  test("the caller's abort reaches a start only until the start is released", async () => {
    const { resources, calls } = createResources();
    const caller = new AbortController();
    const released = resources.openStartup(caller.signal);
    await resources.releaseStartup(released, modelWithCleanup(calls), undefined);
    const open = resources.openStartup(caller.signal);
    const abortReasonBefore: unknown = released.abortController.signal.reason;

    caller.abort("user");

    expect(open.abortController.signal.aborted).toBe(true);
    expect(released.abortController.signal.reason).toBe(abortReasonBefore);
  });

  test("an already-aborted start keeps its abort reason when released", async () => {
    const { resources, calls } = createResources();
    const startup = resources.openStartup(undefined);
    startup.abortController.abort("startup");

    await resources.releaseStartup(startup, modelWithCleanup(calls), undefined);

    expect(startup.abortController.signal.reason).toBe("startup");
  });

  test("a registered stream owns the start's resources, so release tears the stream down", async () => {
    const { resources, calls } = createResources();
    const startup = resources.openStartup(undefined);
    const stream: Partial<WorkspaceStreamInfo> = { resourceCleanup: Promise.resolve() };

    await resources.releaseStartup(startup, modelWithCleanup(calls), stream as WorkspaceStreamInfo);

    expect(startup.abortController.signal.aborted).toBe(true);
    // The model and the scope belong to the stream's own teardown now.
    expect(calls).toEqual([]);
  });

  test("a provided temp dir is not created again, and an empty one is not cleaned up", async () => {
    const { resources, calls } = createResources();
    const provided = Scope.makeUnsafe();
    const empty = Scope.makeUnsafe();

    expect(await resources.acquireTempDir(provided, TOKEN, RUNTIME, "/pre/made")).toBe("/pre/made");
    expect(await resources.acquireTempDir(empty, TOKEN, RUNTIME, "")).toBe("");
    await closeScope(provided);
    await closeScope(provided);
    await closeScope(empty);

    expect(calls).toEqual(["cleanup:/pre/made"]);
  });

  test("a failed temp dir rejects with its own error and leaves nothing to clean up", async () => {
    const failure = new Error("disk full");
    const calls: string[] = [];
    const resources = new TurnResources({
      effectRunner: defaultEffectRunner,
      toolCallDisplayRegistry: { close: () => undefined },
      partialJournal: {
        retire: () => undefined,
        interruptScheduled: () => undefined,
        awaitPending: () => Promise.resolve(),
      },
      mcpServerManager: () => undefined,
      createTempDirForStream: () => Promise.reject(failure),
      cleanupStreamTempDir: (_runtime, dir) => void calls.push(dir),
    });
    const scope = Scope.makeUnsafe();

    let caught: unknown;
    try {
      await resources.acquireTempDir(scope, TOKEN, RUNTIME, undefined);
    } catch (error) {
      caught = error;
    }
    await closeScope(scope);

    expect(caught).toBe(failure);
    expect(calls).toEqual([]);
  });

  test("stream teardown runs once, in order, and every call closes the execution scope", async () => {
    const { resources, calls } = createResources();
    const scope = Scope.makeUnsafe();
    await resources.acquireTempDir(scope, TOKEN, RUNTIME, "/tmp/turn");
    const unlinks: string[] = [];
    const executionScope: ExecutionScope = { workspaceId: WS, messageId: "msg-1", token: "exec-1" };
    const stream: Partial<WorkspaceStreamInfo> = {
      executionScope,
      resourceScope: scope,
      unlinkAbortSignal: () => void unlinks.push("unlink"),
    };
    const info = stream as WorkspaceStreamInfo;

    const first = resources.closeStreamResources(info);
    await first;
    const second = resources.closeStreamResources(info);

    expect(second).toBe(first);
    expect(calls).toEqual([
      "close-scope:exec-1",
      "retire",
      "cleanup:/tmp/turn",
      "interrupt",
      "await-pending",
      "close-scope:exec-1",
    ]);
    expect(unlinks).toEqual(["unlink"]);
    expect(info.unlinkAbortSignal).toBeUndefined();
  });

  test("the MCP lease goes to the manager set when the turn runs", () => {
    const { resources, setMcp } = createResources();
    const leases: string[] = [];
    resources.acquireMcpLease(WS);

    setMcp({
      acquireLease: (id) => void leases.push(`acquire:${id}`),
      releaseLease: (id) => void leases.push(`release:${id}`),
    });
    resources.acquireMcpLease(WS);
    resources.releaseMcpLease(WS);

    expect(leases).toEqual([`acquire:${WS}`, `release:${WS}`]);
  });
});
