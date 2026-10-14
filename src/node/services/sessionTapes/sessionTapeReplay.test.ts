/**
 * Read side of session tapes: the loader's accept/reject contract (sessionTape.ts), the replay
 * driver's pacing, transcript equivalence through the real reducer, and that replayed content
 * stays data. Synthetic tapes only.
 */
import { MAX_TIMER_DELAY_MS } from "@/constants/timers";
import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { applyWorkspaceChatEventToAggregator } from "@/browser/utils/messages/applyWorkspaceChatEventToAggregator";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  loadSessionTape,
  type LoadedSessionTape,
  type SessionTapeLoadResult,
} from "@/common/utils/sessionTapes/sessionTapeLoader";
import { replaySessionTape } from "@/common/utils/sessionTapes/sessionTapeReplay";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  flushSessionTapes,
  hashSessionTapeWorkspaceId,
  maybeRecordWorkspaceChat,
  SESSION_TAPE_CAP_BYTES,
} from "./sessionTapeRecorder";
import { readSessionTapeFile } from "./sessionTapeFile";
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

  test("a trailer that reports dropped events without truncation is rejected", () => {
    const incomplete = buildSyntheticSessionTape(events, { end: { droppedEvents: 2 } });
    expect(loadSessionTape(incomplete)).toMatchObject({
      status: "rejected",
      reason: "trailer reports dropped events without truncation",
    });
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
      "an event line not in the recorder's encoding",
      (lines) => (lines[2] = lines[2].replace('"event":', '"event": ')),
      "event line is not in the recorder's encoding",
      3,
      true,
    ],
    [
      // Parses, but validating or re-encoding it overflows the stack (RangeError), which must
      // reject the tape instead of throwing to the caller.
      "an event nested too deep to validate",
      (lines) => {
        const depth = 200_000;
        const deep = "[".repeat(depth) + "]".repeat(depth);
        lines[2] = `{"t":20,"bytes":1,"event":{"type":"stream-delta","nested":${deep}}}`;
      },
      "event could not be validated",
      3,
      true,
    ],
    [
      "a header nested too deep to validate",
      (lines) => {
        const depth = 200_000;
        lines[0] = `{"tape":${"[".repeat(depth) + "]".repeat(depth)}}`;
      },
      "tape is nested too deeply to validate",
      undefined,
      false,
    ],
    [
      "offset going backwards",
      (lines) => patchLine(lines, 3, (line) => (line.t = 0)),
      "event offset goes backwards",
      4,
      true,
    ],
    [
      "trailer offset going backwards",
      (lines) => patchLine(lines, -1, (trailer) => (trailer.t = 0)),
      "trailer offset goes backwards",
      lastEventLine + 2,
      true,
    ],
  ])("rejects a tape with %s", (_name, edit, reason, line, headerKept) => {
    const result = loadSessionTape(editTape(tape, edit));
    expect(result).toMatchObject({ status: "rejected", reason });
    if (result.status !== "rejected") return;
    expect(result.line).toBe(line);
    expect(result.header?.tapeId).toBe(headerKept ? loadedHeader.tapeId : undefined);
  });

  test("the recorder hashes the trimmed workspace id, as replay looks it up", async () => {
    using root = new DisposableTempDir("session-tape-padded-id");
    async function* source() {
      await Promise.resolve();
      yield events[0];
    }
    const recorded = maybeRecordWorkspaceChat(
      { aiService: { isExperimentEnabled: () => true }, config: { rootDir: root.path } },
      { workspaceId: "  ws-1\n", validateOutput: true },
      source()
    );
    for await (const _event of recorded) {
      // drain
    }
    await flushSessionTapes();
    const dir = path.join(root.path, "perf", "tapes");
    const [name] = await fs.readdir(dir);
    const result = expectLoaded(await readSessionTapeFile(path.join(dir, name)));
    expect(result.header.workspaceIdHash).toBe(
      createHash("sha256").update("ws-1").digest("hex").slice(0, 16)
    );
    expect(hashSessionTapeWorkspaceId(" ws-1 ")).toBe(result.header.workspaceIdHash);
  });

  test("the file reader refuses a FIFO without blocking on it", async () => {
    using dir = new DisposableTempDir("session-tape-fifo");
    const fifoPath = path.join(dir.path, "tape.jsonl");
    // Reading a FIFO with no writer blocks forever; the reader must stat first.
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
    expect(await readSessionTapeFile(fifoPath)).toMatchObject({
      status: "rejected",
      reason: "not a regular file",
    });
  });

  test("the file reader refuses files larger than the recorder's tape cap unread", async () => {
    using dir = new DisposableTempDir("session-tape-oversized");
    const bigPath = path.join(dir.path, "tape.jsonl");
    await fs.writeFile(bigPath, tape);
    // Sparse: grows the file past the cap without writing the bytes.
    await fs.truncate(bigPath, SESSION_TAPE_CAP_BYTES + 1);
    const readSpy = spyOn(fs, "readFile");
    try {
      const result = await readSessionTapeFile(bigPath);
      expect(result).toMatchObject({ status: "rejected" });
      expect(result.status === "rejected" && result.reason).toContain("tape cap");
      expect(readSpy.mock.calls.some(([file]) => file === bigPath)).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("the file reader refuses malformed UTF-8 instead of decoding it to replacement characters", async () => {
    using dir = new DisposableTempDir("session-tape-utf8");
    const delta = WorkspaceChatMessageSchema.parse({
      type: "stream-delta",
      workspaceId: "ws-1",
      messageId: "msg-1",
      delta: "a\uFFFDb",
      tokens: 1,
      timestamp: 1,
    });
    const bytes = Buffer.from(buildSyntheticSessionTape([delta]));
    // U+FFFD (EF BF BD) -> a truncated 4-byte sequence (F0 9F 98): a lenient decoder turns it
    // back into exactly one U+FFFD, so the edited file would load as the original tape.
    const at = bytes.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    expect(at).toBeGreaterThan(0);
    bytes.set([0xf0, 0x9f, 0x98], at);
    const filePath = path.join(dir.path, "tape.jsonl");
    await fs.writeFile(filePath, bytes);
    const result = await readSessionTapeFile(filePath);
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.status === "rejected" && result.reason).toContain("unreadable");
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

  test("recorded pacing waits longer than the timer limit in chunks, against the deadline", async () => {
    // setTimeout fires at once for delays above MAX_TIMER_DELAY_MS.
    const maxDelayMs = MAX_TIMER_DELAY_MS;
    const farOffsetMs = maxDelayMs + 5_000;
    const farTape = expectLoaded(
      loadSessionTape(
        buildSyntheticSessionTape(events.slice(0, 2), {
          offsetMs: (index) => (index === 0 ? 0 : farOffsetMs),
        })
      )
    );
    jest.useFakeTimers();
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number
    ) => {
      delays.push(ms ?? 0);
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout);
    try {
      const replay = replaySessionTape(farTape, { pacing: "recorded" });
      await replay.next();
      const far = replay.next();
      expect(await settles(far)).toBe(false);
      fakeTimers.advanceTimersByTime(maxDelayMs);
      expect(await settles(far)).toBe(false);
      fakeTimers.advanceTimersByTime(5_000);
      expect(await settles(far)).toBe(true);
      expect((await far).value).toEqual(events[1]);
      expect(delays.length).toBeGreaterThan(1);
      expect(delays.every((ms) => ms <= maxDelayMs)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("fast pacing yields every event in order without waiting", async () => {
    // Fake timers never advance here, so any wait leaves a pull pending. Checking each pull with
    // `settles` makes that a failure: awaiting it would hang the whole run (bun's test timeout
    // does not fire under fake timers).
    jest.useFakeTimers();
    const replay = replaySessionTape(tape, { pacing: "fast" });
    const delivered: WorkspaceChatMessage[] = [];
    for (;;) {
      const next = replay.next();
      expect(await settles(next)).toBe(true);
      const result = await next;
      if (result.done) break;
      delivered.push(result.value);
    }
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
    expect(await settles(waiting)).toBe(true);
    expect(await waiting).toEqual({ done: true, value: undefined });
  });
});

describe("replayed tapes stay data", () => {
  function displayedAfter(events: WorkspaceChatMessage[], workspaceId: string) {
    const aggregator = new StreamingMessageAggregator(new Date(0).toISOString(), workspaceId);
    for (const event of events) {
      const rows = event.type === "message-batch" ? event.messages : [event];
      for (const row of rows) applyWorkspaceChatEventToAggregator(aggregator, row);
    }
    return aggregator.getDisplayedMessages();
  }

  test("a replayed tape builds the same transcript as the recorded events, through the real reducer", async () => {
    const workspaceId = "ws-replay";
    const events = syntheticReplayTranscript(workspaceId);
    const tape = expectLoaded(
      loadSessionTape(buildSyntheticSessionTape(events, { offsetMs: () => 0 }))
    );
    const replayed: WorkspaceChatMessage[] = [];
    for await (const event of replaySessionTape(tape, { pacing: "recorded" })) {
      replayed.push(event);
    }
    const expected = displayedAfter(events, workspaceId);
    expect(expected.length).toBeGreaterThan(0);
    expect(displayedAfter(replayed, workspaceId)).toEqual(expected);
  });

  test("legacy advisor events remain replayable without changing the displayed transcript", async () => {
    const workspaceId = "ws-legacy-advisor";
    const events = syntheticReplayTranscript(workspaceId);
    const legacyBase = { workspaceId, toolCallId: "advisor-call", timestamp: 1 };
    const legacyEvents: WorkspaceChatMessage[] = [
      { ...legacyBase, type: "advisor-output", text: "Old advice" },
      { ...legacyBase, type: "advisor-reasoning-output", text: "Old reasoning" },
      { ...legacyBase, type: "advisor-phase", phase: "finalizing_result" },
    ];
    const recorded = [...events.slice(0, 2), ...legacyEvents, ...events.slice(2)];
    const tape = expectLoaded(
      loadSessionTape(buildSyntheticSessionTape(recorded, { offsetMs: () => 0 }))
    );
    const replayed: WorkspaceChatMessage[] = [];
    for await (const event of replaySessionTape(tape, { pacing: "recorded" })) {
      replayed.push(event);
    }
    expect(replayed).toEqual(recorded);
    expect(displayedAfter(replayed, workspaceId)).toEqual(displayedAfter(events, workspaceId));
  });

  test("hostile recorded content is only yielded as data: no network, no process, no file changes", async () => {
    // Recorded remote URLs (an image file part, a markdown image, an MCP origin), tool calls and
    // events that trigger renderer effects live (gateway-expired error, skill completion, input
    // restore) must come out of load + replay unchanged and in order, and nothing may act on
    // them: the read side never contacts an endpoint, spawns a tool or writes workspace state.
    const workspaceId = "ws-hostile";
    const hostileRows: unknown[] = [
      {
        type: "message",
        id: "msg-remote-image",
        role: "user",
        createdAt: new Date("2026-05-29T00:00:00.000Z"),
        parts: [
          { type: "text", text: "See ![remote](https://images.example.invalid/tracker.png)" },
          { type: "file", url: "https://images.example.invalid/photo.png", mediaType: "image/png" },
        ],
        metadata: { historySequence: 1, timestamp: 1 },
      },
      {
        type: "stream-error",
        messageId: "msg-gateway",
        error: MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
        errorType: "authentication",
      },
    ];
    const events = [
      ...hostileRows.map((row) => WorkspaceChatMessageSchema.parse(row)),
      ...syntheticChatEvents(),
      ...syntheticReplayTranscript(workspaceId),
    ];
    using workspaceDir = new DisposableTempDir("session-tape-hostile");
    const seeded = path.join(workspaceDir.path, "chat.jsonl");
    await fs.writeFile(seeded, '{"seeded":true}\n');
    const tapePath = path.join(workspaceDir.path, "hostile.jsonl");
    await fs.writeFile(tapePath, buildSyntheticSessionTape(events, { offsetMs: () => 0 }));
    const before = await snapshotDir(workspaceDir.path);

    const attempts: string[] = [];
    const block = (label: string) => () => {
      attempts.push(label);
      throw new Error(`${label} blocked in test`);
    };
    // Under bun, every node:child_process API (spawn, exec, execFile, fork and the sync forms)
    // starts its process through Bun.spawn or Bun.spawnSync, so those two spies catch them all; a
    // spy on child_process.spawn alone misses exec and execFile. The socket spy also catches
    // tls.connect.
    const spies = [
      spyOn(globalThis, "fetch").mockImplementation(((input: unknown) => {
        attempts.push(`fetch ${String(input)}`);
        return Promise.reject(new Error("network blocked in test"));
      }) as typeof fetch),
      spyOn(net.Socket.prototype, "connect").mockImplementation(block("net.Socket.connect")),
      spyOn(http, "request").mockImplementation(block("http.request")),
      spyOn(http, "get").mockImplementation(block("http.get")),
      spyOn(https, "request").mockImplementation(block("https.request")),
      spyOn(https, "get").mockImplementation(block("https.get")),
      spyOn(Bun, "spawn").mockImplementation(block("Bun.spawn")),
      spyOn(Bun, "spawnSync").mockImplementation(block("Bun.spawnSync")),
    ];
    try {
      const loaded = await readSessionTapeFile(tapePath);
      const replayed: WorkspaceChatMessage[] = [];
      for await (const event of replaySessionTape(expectLoaded(loaded), { pacing: "fast" })) {
        replayed.push(event);
      }
      expect(replayed).toEqual(events);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(attempts).toEqual([]);
    expect(await snapshotDir(workspaceDir.path)).toEqual(before);
  });
});

async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const entries = await fs.readdir(dir);
  const snapshot: Record<string, string> = {};
  for (const name of entries.sort()) {
    snapshot[name] = createHash("sha256")
      .update(await fs.readFile(path.join(dir, name)))
      .digest("hex");
  }
  return snapshot;
}
