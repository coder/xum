/**
 * Read side of session tapes: the loader's accept/reject contract (sessionTape.ts), the replay
 * driver's pacing, and the onChat replay source behind XUM_REPLAY_TAPES. Synthetic tapes only.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import {
  loadSessionTape,
  type LoadedSessionTape,
  type SessionTapeLoadResult,
} from "@/common/utils/sessionTapes/sessionTapeLoader";
import {
  isSessionTapeReplayRefusal,
  replaySessionTape,
} from "@/common/utils/sessionTapes/sessionTapeReplay";
import type { ORPCContext } from "@/node/orpc/context";
import { subscribeWorkspaceChat } from "@/node/orpc/routerSubscriptions";
import { DisposableTempDir } from "@/node/services/tempDir";
import { createWorkspaceServiceHarness } from "@/node/services/workspaceService.testHarness";
import { flushSessionTapes, maybeRecordWorkspaceChat } from "./sessionTapeRecorder";
import {
  isSessionTapeReplayWorkspace,
  readSessionTapeFile,
  SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE,
} from "./sessionTapeReplaySource";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/constants/orpcSubscriptions";
import {
  buildSyntheticSessionTape,
  syntheticChatEvents,
  syntheticReplayTranscript,
} from "./sessionTapes.testFixtures";

const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

function expectLoaded(result: SessionTapeLoadResult): LoadedSessionTape {
  if (result.status === "rejected") throw new Error(`tape rejected: ${result.reason}`);
  return result;
}

/** Tape text as lines (without the final newline), edited by a test, and joined back. */
function editTape(text: string, edit: (lines: string[]) => void): string {
  const lines = text.trimEnd().split("\n");
  edit(lines);
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function patchLine(lines: string[], index: number, patch: (line: Record<string, unknown>) => void) {
  const line = JSON.parse(lines.at(index)!) as Record<string, unknown>;
  patch(line);
  lines[index < 0 ? lines.length + index : index] = JSON.stringify(line);
}

describe("loadSessionTape", () => {
  const events = syntheticChatEvents();
  const tape = buildSyntheticSessionTape(events);
  const loadedHeader = expectLoaded(loadSessionTape(tape)).header;

  test("a closed tape is ok and decodes every event exactly (Dates, undefined values)", () => {
    const result = loadSessionTape(tape);
    expect(result.status).toBe("ok");
    expect(expectLoaded(result).events.map((entry) => entry.event)).toStrictEqual(events);
  });

  test("the recorder's own tapes load with every event intact", async () => {
    using root = new DisposableTempDir("session-tape-roundtrip");
    async function* source() {
      for (const event of events) {
        await Promise.resolve();
        yield event;
      }
    }
    const recorded = maybeRecordWorkspaceChat(
      { aiService: { isExperimentEnabled: () => true }, config: { rootDir: root.path } },
      { workspaceId: "ws-1", validateOutput: true },
      source()
    );
    for await (const _event of recorded) {
      // drain
    }
    await flushSessionTapes();
    const dir = path.join(root.path, "perf", "tapes");
    const [name] = await fs.readdir(dir);

    const result = await readSessionTapeFile(path.join(dir, name));
    expect(result.status).toBe("ok");
    expect(expectLoaded(result).events.map((entry) => entry.event)).toStrictEqual(events);
  });

  test("a stopped tape is accepted but flagged as stopped", () => {
    expect(
      loadSessionTape(buildSyntheticSessionTape(events, { end: { reason: "stopped" } })).status
    ).toBe("stopped");
  });

  test("a truncated tape is rejected unless the caller opts in, then flagged", () => {
    const truncated = buildSyntheticSessionTape(events, {
      end: { reason: "stopped", truncated: true, droppedEvents: 3 },
    });
    expect(loadSessionTape(truncated)).toMatchObject({
      status: "rejected",
      reason: "tape is truncated (size cap hit)",
    });
    const flagged = loadSessionTape(truncated, { allowTruncated: true });
    expect(flagged).toMatchObject({
      status: "truncated",
      endReason: "stopped",
      trailer: { end: { droppedEvents: 3 } },
    });
    expect(expectLoaded(flagged).events).toHaveLength(events.length);
  });

  test("an error tape is rejected, even when truncation is allowed", () => {
    const errored = buildSyntheticSessionTape(events, {
      end: { reason: "error", truncated: true, droppedEvents: 1 },
    });
    for (const options of [{}, { allowTruncated: true }]) {
      expect(loadSessionTape(errored, options)).toMatchObject({
        status: "rejected",
        reason: "tape ended with an error",
      });
    }
  });

  const lastEventLine = events.length; // line index of the last event (header is index 0)
  // Last column: whether the rejection still carries the (valid) header, so tapeInfo can
  // describe the tape. Only rejections of line 1 itself have none.
  test.each<[string, (lines: string[]) => void, string, number | undefined, boolean]>([
    ["empty file", (lines) => lines.splice(0), "empty tape", undefined, false],
    [
      "missing trailer",
      (lines) => lines.pop(),
      "missing trailer (unfinished tape)",
      undefined,
      true,
    ],
    [
      "trailer before the last event",
      (lines) => lines.splice(lastEventLine, 0, lines.pop()!),
      "trailer is not the last line",
      lastEventLine + 1,
      true,
    ],
    [
      "unsupported version",
      (lines) => patchLine(lines, 0, (header) => (header.tape = 4)),
      "unsupported tape version 4",
      1,
      false,
    ],
    [
      "unsupported masking",
      (lines) => patchLine(lines, 0, (header) => (header.masking = "redacted")),
      'unsupported masking "redacted"',
      1,
      false,
    ],
    ["malformed JSON line", (lines) => (lines[2] = '{"t":'), "malformed JSON line", 3, true],
    [
      "event failing the onChat schema",
      (lines) =>
        patchLine(lines, 2, (line) => {
          line.event = { type: "stream-delta" };
          delete line.meta;
        }),
      "event fails the onChat schema",
      3,
      true,
    ],
    [
      "an event byte count that does not match the stored event",
      (lines) => patchLine(lines, 2, (line) => (line.bytes = Number(line.bytes) + 1)),
      "event byte count does not match the stored event",
      3,
      true,
    ],
    [
      "offset going backwards",
      (lines) => patchLine(lines, 3, (line) => (line.t = 0)),
      "event offset goes backwards",
      4,
      true,
    ],
  ])("rejects a tape with %s", (_name, edit, reason, line, headerKept) => {
    const result = loadSessionTape(editTape(tape, edit));
    expect(result).toMatchObject({ status: "rejected", reason });
    if (result.status !== "rejected") return;
    expect(result.line).toBe(line);
    expect(result.header?.tapeId).toBe(headerKept ? loadedHeader.tapeId : undefined);
  });

  test("the file reader refuses unfinished temp files even when their content is valid", async () => {
    using dir = new DisposableTempDir("session-tape-temp-name");
    const tempPath = path.join(dir.path, "tape.jsonl.0123456789ab");
    await fs.writeFile(tempPath, tape);
    expect(await readSessionTapeFile(tempPath)).toMatchObject({ status: "rejected" });
    const finalPath = path.join(dir.path, "tape.jsonl");
    await fs.writeFile(finalPath, tape);
    expect((await readSessionTapeFile(finalPath)).status).toBe("ok");
  });
});

describe("replaySessionTape", () => {
  const events = syntheticChatEvents().slice(0, 3);
  const offsets = [0, 100, 250];
  const tape = expectLoaded(
    loadSessionTape(buildSyntheticSessionTape(events, { offsetMs: (index) => offsets[index] }))
  );

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Whether `promise` settled after letting pending microtasks run (fake timers stay put). */
  async function settles(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(() => (settled = true));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return settled;
  }

  test("recorded pacing keeps absolute deadlines, so a slow consumer adds no drift", async () => {
    jest.useFakeTimers();
    const replay = replaySessionTape(tape, { pacing: "recorded" });
    expect((await replay.next()).value).toEqual(events[0]);

    // The consumer is busy past the second deadline (100 ms): that event is due at once.
    fakeTimers.advanceTimersByTime(150);
    const second = replay.next();
    expect(await settles(second)).toBe(true);
    expect((await second).value).toEqual(events[1]);

    // The third stays due at start + 250 ms, not 150 ms after the late second pull.
    const third = replay.next();
    fakeTimers.advanceTimersByTime(99);
    expect(await settles(third)).toBe(false);
    fakeTimers.advanceTimersByTime(1);
    expect(await settles(third)).toBe(true);
    expect((await third).value).toEqual(events[2]);
    expect((await replay.next()).done).toBe(true);
  });

  test("fast pacing yields every event in order without waiting", async () => {
    jest.useFakeTimers(); // a timer would never fire: any wait would hang this test
    const delivered: WorkspaceChatMessage[] = [];
    for await (const event of replaySessionTape(tape, { pacing: "fast" })) delivered.push(event);
    expect(delivered).toEqual(events);
  });

  test("abort ends playback, also while waiting for the next event", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const replay = replaySessionTape(tape, { pacing: "recorded", signal: controller.signal });
    await replay.next();
    const waiting = replay.next();
    expect(await settles(waiting)).toBe(false);
    controller.abort();
    expect(await waiting).toEqual({ done: true, value: undefined });
  });
});

describe("onChat session tape replay (XUM_REPLAY_TAPES)", () => {
  const workspaceId = "ws-replay";
  const envKeys = ["XUM_REPLAY_TAPES", "MUX_REPLAY_TAPES", "XUM_MOCK_AI", "MUX_MOCK_AI"] as const;
  let savedEnv: Record<string, string | undefined> = {};
  let tempDir: DisposableTempDir;

  /**
   * A context that throws when anything beyond the subscription plumbing is touched: a mapped
   * workspace must never reach the session, AI, tool or provider services.
   */
  const guardedContext = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === "symbol" || key === "effect/context" || key === "perfFlightRecorder") {
          return undefined;
        }
        throw new Error(`context.${key} touched`);
      },
    }
  ) as ORPCContext;

  async function writeTape(name: string, text: string): Promise<string> {
    const filePath = path.join(tempDir.path, name);
    await fs.writeFile(filePath, text);
    return filePath;
  }

  function mapTapes(map: Record<string, string>, mockAi = true) {
    process.env.XUM_REPLAY_TAPES = JSON.stringify(map);
    if (mockAi) process.env.XUM_MOCK_AI = "1";
  }

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    tempDir = new DisposableTempDir("session-tape-replay-source");
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    tempDir[Symbol.dispose]();
  });

  test.each<[string, { mode?: OnChatMode }]>([
    ["a default", {}],
    ["an explicit full", { mode: { type: "full" } }],
  ])(
    "serves %s subscription the tape's events in order, then stays open until abort",
    async (_name, input) => {
      const events = syntheticReplayTranscript(workspaceId);
      mapTapes({
        [workspaceId]: await writeTape(
          "tape.jsonl",
          buildSyntheticSessionTape(events, { offsetMs: () => 0 })
        ),
      });
      const controller = new AbortController();
      const chat = subscribeWorkspaceChat(
        guardedContext,
        { workspaceId, ...input },
        controller.signal,
        { validateOutput: true }
      );
      const delivered: WorkspaceChatMessage[] = [];
      while (delivered.length < events.length) {
        const result = await chat.next();
        if (result.done) throw new Error("the replay ended before its last event");
        if (result.value.type !== "heartbeat") delivered.push(result.value);
      }
      expect(delivered).toStrictEqual(events);

      // No end after the last event: an ended onChat would make the renderer resubscribe and
      // replay the tape again.
      const afterLast = chat.next();
      const idle = await Promise.race([
        afterLast.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("open"), 50)),
      ]);
      expect(idle).toBe("open");
      controller.abort();
      expect((await afterLast).done).toBe(true);
    }
  );

  test("plays the tape at its recorded offsets and adds no events of its own", async () => {
    // Perf numbers from a replay are only meaningful if the source keeps the recorded pacing
    // and sequence. The gap spans one transport heartbeat interval: no heartbeat may be
    // injected between recorded events (the tape carries its own).
    const events = syntheticReplayTranscript(workspaceId).slice(0, 2);
    const gapMs = SUBSCRIPTION_HEARTBEAT_INTERVAL_MS + 300;
    const tape = buildSyntheticSessionTape(events, { offsetMs: (index) => index * gapMs });
    mapTapes({ [workspaceId]: await writeTape("tape.jsonl", tape) });
    const controller = new AbortController();
    const chat = subscribeWorkspaceChat(guardedContext, { workspaceId }, controller.signal, {
      validateOutput: true,
    });
    try {
      const startedAt = performance.now();
      expect((await chat.next()).value).toStrictEqual(events[0]);
      expect((await chat.next()).value).toStrictEqual(events[1]);
      // Margin only for timer granularity.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(gapMs - 50);
    } finally {
      controller.abort();
      await chat.return(undefined);
    }
  }, 15_000);

  test("a padded workspace id still resolves to its tape, never to the live session", async () => {
    const events = syntheticReplayTranscript(workspaceId);
    mapTapes({
      [workspaceId]: await writeTape(
        "tape.jsonl",
        buildSyntheticSessionTape(events, { offsetMs: () => 0 })
      ),
    });
    expect(isSessionTapeReplayWorkspace(` ${workspaceId} `)).toBe(true);
    const controller = new AbortController();
    const chat = subscribeWorkspaceChat(
      guardedContext,
      { workspaceId: ` ${workspaceId} ` },
      controller.signal,
      { validateOutput: true }
    );
    try {
      expect((await chat.next()).value).toStrictEqual(events[0]);
    } finally {
      controller.abort();
      await chat.return(undefined);
    }
  });

  test("an unmapped workspace takes the normal live path", async () => {
    mapTapes({ [workspaceId]: await writeTape("tape.jsonl", buildSyntheticSessionTape()) });
    expect(() => subscribeWorkspaceChat(guardedContext, { workspaceId: "ws-other" })).toThrow(
      "context.workspaceService touched"
    );
  });

  test("an invalid entry leaves the other workspaces live", () => {
    mapTapes({ [workspaceId]: "relative/tape.jsonl" });
    expect(() => subscribeWorkspaceChat(guardedContext, { workspaceId: "ws-other" })).toThrow(
      "context.workspaceService touched"
    );
  });

  type Service = Awaited<ReturnType<typeof createWorkspaceServiceHarness>>["service"];
  const sendOptions = { model: "test-model", agentId: "exec" };
  const sendRefusal = { type: "unknown", raw: SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE };
  test.each<[string, (service: Service) => Promise<{ success: boolean }>, unknown]>([
    ["sendMessage", (s) => s.sendMessage(workspaceId, "hello", sendOptions), sendRefusal],
    ["resumeStream", (s) => s.resumeStream(workspaceId, sendOptions), sendRefusal],
    // /clear
    ["truncateHistory", (s) => s.truncateHistory(workspaceId, 1), undefined],
    ["resetContext", (s) => s.resetContext(workspaceId), undefined],
    [
      // Start Here: a compaction replace, which skips the context-mutation admission guard.
      "replaceHistory",
      (s) =>
        s.replaceHistory(
          workspaceId,
          createMuxMessage("start-here", "assistant", "summary", { compacted: "user" }),
          { mode: "append-compaction-boundary" }
        ),
      undefined,
    ],
    [
      "answerAskUserQuestion",
      (s) => s.answerAskUserQuestion(workspaceId, "tool-1", { question: "answer" }),
      undefined,
    ],
  ])(
    "%s is refused for a mapped workspace and leaves its chat history untouched",
    async (_method, call, error) => {
      // Mapped without XUM_MOCK_AI and to a missing tape: a claimed workspace never runs live
      // and never rewrites its real history, whatever the state of its replay.
      mapTapes({ [workspaceId]: path.join(tempDir.path, "missing.jsonl") }, false);
      await using harness = await createWorkspaceServiceHarness();
      const seeded = createMuxMessage("seeded-user", "user", "recorded prompt");
      await harness.historyService.appendToHistory(workspaceId, seeded);
      expect(await call(harness.service)).toMatchObject({
        success: false,
        error: error ?? SESSION_TAPE_REPLAY_READ_ONLY_MESSAGE,
      });
      const history = await harness.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data.map((message) => message.id)).toEqual(["seeded-user"]);
    }
  );

  test.each<[string, () => Promise<{ input: { mode?: unknown } }>, RegExp]>([
    [
      "a live subscription",
      async () => {
        mapTapes({ [workspaceId]: await writeTape("tape.jsonl", buildSyntheticSessionTape()) });
        return { input: { mode: { type: "live" } } };
      },
      /serves only fresh full subscriptions \(got "live"\)/,
    ],
    [
      // How the renderer resubscribes when the user re-enters the workspace.
      "a since subscription",
      async () => {
        mapTapes({ [workspaceId]: await writeTape("tape.jsonl", buildSyntheticSessionTape()) });
        return {
          input: {
            mode: { type: "since", cursor: { history: { messageId: "m", historySequence: 1 } } },
          },
        };
      },
      /serves only fresh full subscriptions \(got "since"\); reload/,
    ],
    [
      "XUM_MOCK_AI unset",
      async () => {
        mapTapes(
          { [workspaceId]: await writeTape("tape.jsonl", buildSyntheticSessionTape()) },
          false
        );
        return { input: {} };
      },
      /requires XUM_MOCK_AI=1/,
    ],
    [
      "an unparseable XUM_REPLAY_TAPES",
      () => {
        process.env.XUM_REPLAY_TAPES = "{not json";
        process.env.XUM_MOCK_AI = "1";
        return Promise.resolve({ input: {} });
      },
      /XUM_REPLAY_TAPES is not valid JSON/,
    ],
    [
      "a truncated tape",
      async () => {
        const truncated = buildSyntheticSessionTape(undefined, { end: { truncated: true } });
        mapTapes({ [workspaceId]: await writeTape("tape.jsonl", truncated) });
        return { input: {} };
      },
      /is truncated \(size cap hit\): replay serves only complete tapes/,
    ],
    [
      "a relative tape path",
      () => {
        mapTapes({ [workspaceId]: "relative/tape.jsonl" });
        return Promise.resolve({ input: {} });
      },
      /the tape path for ws-replay must be absolute/,
    ],
    [
      "a missing tape file",
      async () => {
        mapTapes({ [workspaceId]: path.join(tempDir.path, "missing.jsonl") });
        return Promise.resolve({ input: {} });
      },
      /rejected: unreadable/,
    ],
  ])("fails the subscription for %s, without a live fallback", async (_name, arrange, message) => {
    const { input } = await arrange();
    const chat = subscribeWorkspaceChat(guardedContext, {
      workspaceId,
      ...(input as { mode?: undefined }),
    });
    const error = await chat.next().then(
      () => undefined,
      (rejection: unknown) => rejection
    );
    // The marker lets the renderer show this terminal refusal instead of retrying.
    expect(isSessionTapeReplayRefusal(error)).toBe(true);
    expect(String(error)).toMatch(message);
  });
});
