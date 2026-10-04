/**
 * Session tape replay mode (XUM_REPLAY_TAPES): the onChat replay source behind the real router
 * entry point, and the process-wide read-only gates (WorkspaceService write funnels, provider
 * model creation). Synthetic tapes only.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { createMuxMessage } from "@/common/types/message";
import { isNonRetryableSendError } from "@/common/utils/messages/retryEligibility";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { loadSessionTape } from "@/common/utils/sessionTapes/sessionTapeLoader";
import {
  isSessionTapeReplayRefusal,
  SESSION_TAPE_REPLAY_REFUSAL_DATA,
} from "@/common/utils/sessionTapes/sessionTapeReplay";
import type { ORPCContext } from "@/node/orpc/context";
import { subscribeWorkspaceChat } from "@/node/orpc/routerSubscriptions";
import { Config } from "@/node/config";
import { ProvidersConfigStore } from "@/node/config/providersConfigStore";
import { disposeAppRuntime, makeAppRuntime } from "@/node/services/di/appRuntime";
import { createEvaluationModel } from "@/node/services/evaluationModelFactory";
import { ProviderModelFactory } from "@/node/services/providerModelFactory";
import { ProviderService } from "@/node/services/providerService";
import { DisposableTempDir } from "@/node/services/tempDir";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { createWorkspaceServiceForTest } from "@/node/services/workspaceService.testHarness";
import {
  markSessionTapeReplayEgressBlocked,
  SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE,
} from "./sessionTapeReplaySource";
import type * as ReplaySourceModule from "./sessionTapeReplaySource";
import { buildSyntheticSessionTape, syntheticReplayTranscript } from "./sessionTapes.testFixtures";

const ENV_KEYS = ["XUM_REPLAY_TAPES", "MUX_REPLAY_TAPES"] as const;
const savedEnv = new Map<string, string | undefined>();

function setReplayTapes(value: string | undefined): void {
  if (value === undefined) delete process.env.XUM_REPLAY_TAPES;
  else process.env.XUM_REPLAY_TAPES = value;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A router context with no services: replay must never reach the workspace's session. */
function createContext(app: { context: unknown }) {
  const sessionRequests: string[] = [];
  const context = {
    "effect/context": app.context,
    workspaceService: {
      getOrCreateSession: (workspaceId: string) => {
        sessionRequests.push(workspaceId);
        throw new Error("live session requested");
      },
    },
  } as unknown as ORPCContext;
  return { context, sessionRequests };
}

/** Whether `promise` settles within `ms` of real time. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}

describe("onChat replay source", () => {
  const workspaceId = "ws-replay";
  const events = syntheticReplayTranscript(workspaceId);
  // A TestClock keeps the transport heartbeat out of the delivered sequence.
  const createApp = () => makeAppRuntime(TestClock.layer());
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    // Desktop main does this after installing the renderer egress block.
    markSessionTapeReplayEgressBlocked();
  });
  beforeEach(() => {
    app = createApp();
  });
  afterEach(async () => {
    await disposeAppRuntime(app.managed);
  });

  async function writeTape(dir: DisposableTempDir, text: string): Promise<string> {
    const tapePath = path.join(dir.path, `${randomUUID()}.jsonl`);
    await fs.writeFile(tapePath, text);
    return tapePath;
  }

  test("plays a mapped workspace's tape in recorded order without the session, then stays open", async () => {
    using dir = new DisposableTempDir("session-tape-replay-source");
    // A windowed recording: its caught-up says older history exists.
    const windowed = events.map((event) =>
      event.type === "caught-up" ? { ...event, hasOlderHistory: true } : event
    );
    const tapePath = await writeTape(
      dir,
      buildSyntheticSessionTape(windowed, { workspaceId, offsetMs: (index) => index * 5 })
    );
    setReplayTapes(JSON.stringify({ [workspaceId]: tapePath }));
    const { context, sessionRequests } = createContext(app);
    const controller = new AbortController();
    // A padded id resolves to the same workspace, as the session layer would.
    const iterator = subscribeWorkspaceChat(
      context,
      { workspaceId: ` ${workspaceId} `, mode: { type: "full" } },
      controller.signal,
      { validateOutput: true }
    );
    try {
      const delivered: WorkspaceChatMessage[] = [];
      while (delivered.length < events.length) {
        const next = await iterator.next();
        if (next.done) throw new Error("replay ended before the last event");
        delivered.push(next.value);
      }
      const loaded = loadSessionTape(await fs.readFile(tapePath, "utf-8"));
      if (loaded.status !== "ok") throw new Error(`fixture tape is ${loaded.status}`);
      // Recorded events verbatim, except that paging older rows in (from the live history,
      // not the tape) is turned off.
      expect(delivered).toEqual(
        loaded.events.map(({ event }) =>
          event.type === "caught-up" ? { ...event, hasOlderHistory: false } : event
        )
      );
      expect(delivered.some((event) => event.type === "caught-up")).toBe(true);
      // Still open after the last event: the renderer must not resubscribe and replay again.
      const after = iterator.next();
      expect(await settlesWithin(after, 50)).toBe(false);
      controller.abort();
      expect((await after).done).toBe(true);
      expect(sessionRequests).toEqual([]);
    } finally {
      controller.abort();
      await iterator.return(undefined);
    }
  });

  const tapeFor = (id: string, options: Parameters<typeof buildSyntheticSessionTape>[1] = {}) =>
    buildSyntheticSessionTape(syntheticReplayTranscript(id), { workspaceId: id, ...options });

  test.each<
    [string, (dir: DisposableTempDir) => Promise<{ map: string; mode?: "since" | "live" }>, RegExp]
  >([
    ["an unparseable map", () => Promise.resolve({ map: "{not json" }), /not valid JSON/],
    [
      "a relative tape path",
      () => Promise.resolve({ map: JSON.stringify({ [workspaceId]: "tape.jsonl" }) }),
      /must be absolute/,
    ],
    [
      "a tape recorded for another workspace",
      async (dir) => ({
        map: JSON.stringify({ [workspaceId]: await writeTape(dir, tapeFor("ws-other")) }),
      }),
      /recorded for another workspace/,
    ],
    [
      "a truncated tape",
      async (dir) => ({
        map: JSON.stringify({
          [workspaceId]: await writeTape(
            dir,
            tapeFor(workspaceId, { end: { reason: "closed", truncated: true, droppedEvents: 1 } })
          ),
        }),
      }),
      /is truncated/,
    ],
    [
      "a stopped tape",
      async (dir) => ({
        map: JSON.stringify({
          [workspaceId]: await writeTape(dir, tapeFor(workspaceId, { end: { reason: "stopped" } })),
        }),
      }),
      /is stopped/,
    ],
    [
      "a since subscription",
      async (dir) => ({
        map: JSON.stringify({ [workspaceId]: await writeTape(dir, tapeFor(workspaceId)) }),
        mode: "since",
      }),
      /reload to replay/,
    ],
    [
      "a live subscription",
      async (dir) => ({
        map: JSON.stringify({ [workspaceId]: await writeTape(dir, tapeFor(workspaceId)) }),
        mode: "live",
      }),
      /reload to replay/,
    ],
  ])(
    "refuses %s with a terminal refusal, never the live session",
    async (_name, setup, message) => {
      using dir = new DisposableTempDir("session-tape-replay-refusal");
      const { map, mode } = await setup(dir);
      setReplayTapes(map);
      const { context, sessionRequests } = createContext(app);
      const controller = new AbortController();
      const iterator = subscribeWorkspaceChat(
        context,
        {
          workspaceId,
          mode:
            mode === "since"
              ? { type: "since", cursor: { history: { messageId: "m", historySequence: 1 } } }
              : mode === "live"
                ? { type: "live" }
                : undefined,
        },
        controller.signal,
        { validateOutput: true }
      );
      try {
        const error: unknown = await iterator.next().then(
          () => undefined,
          (rejection: unknown) => rejection
        );
        expect(isSessionTapeReplayRefusal(error)).toBe(true);
        expect((error as { data?: unknown }).data).toEqual(SESSION_TAPE_REPLAY_REFUSAL_DATA);
        expect((error as Error).message).toMatch(message);
        expect(sessionRequests).toEqual([]);
      } finally {
        controller.abort();
        await iterator.return(undefined).catch(() => undefined);
      }
    }
  );

  test("refuses to serve a tape before desktop main blocked renderer egress", async () => {
    using dir = new DisposableTempDir("session-tape-replay-no-egress-block");
    setReplayTapes(JSON.stringify({ [workspaceId]: await writeTape(dir, tapeFor(workspaceId)) }));
    // A fresh module instance: no egress block was installed in it (as in `xum server`).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require(
      `./sessionTapeReplaySource?fresh=${randomUUID()}`
    ) as typeof ReplaySourceModule;
    const replay = fresh.getSessionTapeReplay({ workspaceId });
    if (!replay) throw new Error("the mapped workspace must get a replay");
    const pushed: WorkspaceChatMessage[] = [];
    const error: unknown = await replay
      .play((event) => pushed.push(event))
      .then(
        () => undefined,
        (rejection: unknown) => rejection
      );
    expect(isSessionTapeReplayRefusal(error)).toBe(true);
    expect((error as Error).message).toMatch(/egress block/);
    expect(pushed).toEqual([]);
  });

  test.each<[string, string | undefined]>([
    ["XUM_REPLAY_TAPES is unset", undefined],
    ["XUM_REPLAY_TAPES is blank", "  "],
    ["the workspace is not mapped", JSON.stringify({ "ws-other": "/tapes/other.jsonl" })],
  ])("takes the live session path when %s", (_name, value) => {
    setReplayTapes(value);
    const { context, sessionRequests } = createContext(app);
    expect(() => subscribeWorkspaceChat(context, { workspaceId }, undefined)).toThrow(
      "live session requested"
    );
    expect(sessionRequests).toEqual([workspaceId]);
  });
});

describe("replay mode is read-only", () => {
  test("every WorkspaceService write funnel refuses and history stays untouched", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "replay-read-only";
    try {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "kept", { historySequence: 0, timestamp: 1 })
      );
      const service = createWorkspaceServiceForTest({ config, historyService });
      // Any non-blank value, even for other workspaces, puts the whole process in replay mode.
      setReplayTapes(JSON.stringify({ "ws-other": "/tapes/other.jsonl" }));
      const refusal = {
        type: "session_tape_replay",
        message: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE,
      } as const;
      const sendOptions = { model: "anthropic:claude-haiku-4-5", agentId: "exec" };
      const results = {
        send: await service.sendMessage(workspaceId, "hello", sendOptions),
        resume: await service.resumeStream(workspaceId, sendOptions),
        truncate: await service.truncateHistory(workspaceId),
        reset: await service.resetContext(workspaceId),
        replace: await service.replaceHistory(
          workspaceId,
          createMuxMessage("s1", "assistant", "summary", { compacted: "user" })
        ),
        answer: await service.answerAskUserQuestion(workspaceId, "tool-1", { q: "a" }),
      };
      expect(results).toEqual({
        send: { success: false, error: refusal },
        resume: { success: false, error: refusal },
        truncate: { success: false, error: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE },
        reset: { success: false, error: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE },
        replace: { success: false, error: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE },
        answer: { success: false, error: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE },
      });
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data.map((message) => message.id)).toEqual(["u1"]);
    } finally {
      await cleanup();
    }
  });

  test("provider model creation refuses in replay mode, in both factories", async () => {
    using root = new DisposableTempDir("session-tape-replay-models");
    const providersConfigStore = new ProvidersConfigStore(root.path);
    providersConfigStore.saveProvidersConfig({
      anthropic: { apiKey: "sk-test" },
    } as Parameters<ProvidersConfigStore["saveProvidersConfig"]>[0]);
    const config = new Config(root.path);
    const factory = new ProviderModelFactory(
      config,
      new ProviderService(config, providersConfigStore),
      {},
      undefined,
      providersConfigStore
    );
    const evaluationDeps = { providersConfigStore, env: {} };
    const model = "anthropic:claude-haiku-4-5";
    // Control: the same configuration creates models outside replay mode.
    expect((await factory.createModel(model)).success).toBe(true);
    expect((await Effect.runPromise(createEvaluationModel(model, evaluationDeps))).success).toBe(
      true
    );

    setReplayTapes(JSON.stringify({ "ws-other": "/tapes/other.jsonl" }));
    const refused = await factory.createModel(model);
    expect(refused).toEqual({
      success: false,
      error: { type: "session_tape_replay", message: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE },
    });
    // Background retries (startup recovery, RetryManager) must not loop on this refusal.
    if (refused.success) throw new Error("expected a refusal");
    expect(isNonRetryableSendError(refused.error)).toBe(true);
    expect(await Effect.runPromise(createEvaluationModel(model, evaluationDeps))).toEqual({
      success: false,
      error: { code: "provider_disabled", message: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE },
    });
    const configReads = spyOn(providersConfigStore, "loadProvidersConfig");
    try {
      expect(await factory.createEvaluationModel(model)).toEqual({
        success: false,
        error: { reason: "unsupported-route" },
      });
      expect(configReads).not.toHaveBeenCalled();
    } finally {
      configReads.mockRestore();
    }
  });
});
