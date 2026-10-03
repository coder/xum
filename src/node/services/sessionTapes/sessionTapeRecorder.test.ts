import { RPCJsonSerializer } from "@orpc/client";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import {
  SessionTapeEventLineSchema,
  SessionTapeHeaderSchema,
  SessionTapeTrailerSchema,
} from "@/common/types/sessionTape";
import type { ORPCContext } from "@/node/orpc/context";
import { subscribeWorkspaceChat } from "@/node/orpc/routerSubscriptions";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
import { log } from "@/node/services/log";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  flushSessionTapes,
  maybeRecordWorkspaceChat,
  stopSessionTapeCaptures,
} from "./sessionTapeRecorder";
import { syntheticChatEvents } from "./sessionTapes.testFixtures";

const workspaceId = "ws-tape-test";
const MiB = 1024 * 1024;

function experimentFlags(enabled: boolean) {
  const flags = {
    enabled,
    isExperimentEnabled: (id: ExperimentId) => flags.enabled && id === EXPERIMENT_IDS.SESSION_TAPES,
  };
  return flags;
}

/** Finalized tapes only, as a loader sees them (temp files end in `.jsonl.<hex>`). */
async function readTapes(rootDir: string): Promise<Array<{ name: string; lines: unknown[] }>> {
  const dir = getXumPerfTapesDir(rootDir);
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
  return Promise.all(
    names.map(async (name) => {
      const text = await fs.readFile(path.join(dir, name), "utf-8");
      expect(text.endsWith("\n")).toBe(true);
      return {
        name,
        lines: text
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      };
    })
  );
}

/**
 * The replay-loader rules from the tape contract (sessionTape.ts): header first, every line
 * schema-valid, every event decoded from its RPC JSON encoding and a valid onChat event with
 * nothing dropped by schema fallbacks, and a trailer last. Throws on any violation instead of
 * skipping lines.
 */
function loadTapeStrictly(lines: unknown[]) {
  const header = SessionTapeHeaderSchema.parse(lines[0]);
  const trailer = SessionTapeTrailerSchema.parse(lines.at(-1));
  const events = lines.slice(1, -1).map((line) => {
    const eventLine = SessionTapeEventLineSchema.parse(line);
    expect(eventLine.bytes).toBe(Buffer.byteLength(JSON.stringify(eventLine.event)));
    const decoded: unknown = new RPCJsonSerializer().deserialize({
      json: eventLine.event,
      meta: eventLine.meta as never,
    });
    const parsed = WorkspaceChatMessageSchema.parse(decoded);
    expect(parsed).toEqual(decoded as WorkspaceChatMessage);
    return parsed;
  });
  return { header, events, trailer };
}

/** Sets the file's mtime `ageMs` in the past (negative: in the future). */
async function setAge(filePath: string, ageMs: number) {
  const then = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, then, then);
}

async function writeIdleFile(filePath: string, ageMs = 24 * 60 * 60 * 1000) {
  await fs.writeFile(filePath, "{}\n");
  await setAge(filePath, ageMs);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false
  );
}

describe("session tapes through workspace.onChat", () => {
  let cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
  });

  async function setup(enabled: boolean) {
    const h = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: { getStreamInfo: () => undefined, replayStream: () => Promise.resolve() },
      initStateManagerOverrides: { replayInit: () => Promise.resolve() },
    });
    cleanups.push(async () => {
      await h.session.dispose();
      await h.cleanup();
    });
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-1", "user", "Hello world 42")
    );
    await h.historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-1", "assistant", "Sure, here it is.", { model: "openai:gpt-x" }, [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "bash",
          state: "output-available",
          input: { script: "cat notes" },
          output: { result: "notes" },
        },
      ])
    );
    const context = {
      workspaceService: { getOrCreateSession: () => h.session },
      aiService: experimentFlags(enabled),
      config: h.config,
    } as unknown as ORPCContext;
    // One full replay, read through caught-up, then closed like a client disconnect.
    const subscribeOnce = async () => {
      const iterator = subscribeWorkspaceChat(context, { workspaceId }, undefined, {
        validateOutput: true,
      });
      const delivered: WorkspaceChatMessage[] = [];
      for (;;) {
        const result = await iterator.next();
        if (result.done) break;
        delivered.push(result.value);
        if (result.value.type === "caught-up") break;
      }
      await iterator.return(undefined);
      await flushSessionTapes();
      return delivered;
    };
    return { rootDir: h.config.rootDir, subscribeOnce };
  }

  test("experiment off: events flow and nothing is written", async () => {
    const { rootDir, subscribeOnce } = await setup(false);
    const delivered = await subscribeOnce();
    expect(delivered.some((event) => event.type === "caught-up")).toBe(true);
    expect(await exists(path.join(rootDir, "perf"))).toBe(false);
  });

  test("experiment on: one standalone full-content tape per subscription", async () => {
    const { rootDir, subscribeOnce } = await setup(true);
    const first = await subscribeOnce();
    const second = await subscribeOnce();

    const tapes = await readTapes(rootDir);
    expect(tapes).toHaveLength(2);
    const loaded = tapes.map((tape) => loadTapeStrictly(tape.lines));
    expect(loaded[1].header.tapeId).not.toBe(loaded[0].header.tapeId);
    // The flags the replay actually used: both are gated on validateOutput.
    expect(loaded[0].header.subscription).toEqual({
      batchReplay: false,
      replayWindow: false,
      validateOutput: true,
    });
    // Each subscription is a full replay, so each tape holds the whole history on its own.
    // Names start with the start time, so the sorted tapes are in subscription order.
    for (const [index, delivered] of [first, second].entries()) {
      expect(loaded[index].trailer.end).toEqual({
        reason: "closed",
        truncated: false,
        droppedEvents: 0,
      });
      expect(loaded[index].events).toEqual(delivered);
      const offsets = tapes[index].lines
        .slice(1, -1)
        .map((line) => SessionTapeEventLineSchema.parse(line).t);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
      }
    }
  });

  test("tapes are owner-only, even in a pre-existing looser directory", async () => {
    const { rootDir, subscribeOnce } = await setup(true);
    const tapesDir = getXumPerfTapesDir(rootDir);
    await fs.mkdir(tapesDir, { recursive: true });
    await fs.chmod(tapesDir, 0o755);
    await subscribeOnce();

    expect((await fs.stat(tapesDir)).mode & 0o777).toBe(0o700);
    const [tape] = await readTapes(rootDir);
    expect((await fs.stat(path.join(tapesDir, tape.name))).mode & 0o777).toBe(0o600);
  });

  test("an unwritable tapes dir never breaks the subscription and warns once", async () => {
    const { rootDir, subscribeOnce } = await setup(true);
    const tapesDir = getXumPerfTapesDir(rootDir);
    await fs.mkdir(path.dirname(tapesDir), { recursive: true });
    await fs.writeFile(tapesDir, "not a directory");
    const warn = spyOn(log, "warn");
    try {
      const delivered = await subscribeOnce();
      expect(delivered.filter((event) => event.type === "message")).toHaveLength(2);
      expect(delivered.at(-1)?.type).toBe("caught-up");
      const tapeWarnings = warn.mock.calls.filter((args) =>
        String(args[0]).startsWith("Session tape")
      );
      expect(tapeWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("maybeRecordWorkspaceChat captures", () => {
  async function* fromEvents(events: WorkspaceChatMessage[]) {
    for (const event of events) {
      // Settle each event on its own microtask, like a real subscription stream.
      await Promise.resolve();
      yield event;
    }
  }

  /** A live subscription that never ends by itself: yields one delta per read. */
  async function* endless(prefix: string, size = 1) {
    for (let i = 0; ; i++) {
      await Promise.resolve();
      yield delta(`${prefix}-${i}`, "x".repeat(size));
    }
  }

  async function drain(iterator: AsyncGenerator<WorkspaceChatMessage>) {
    const delivered: WorkspaceChatMessage[] = [];
    for await (const event of iterator) delivered.push(event);
    return delivered;
  }

  function delta(messageId: string, text: string): WorkspaceChatMessage {
    return {
      type: "stream-delta",
      workspaceId,
      messageId,
      delta: text,
      tokens: 1,
      timestamp: 1,
    };
  }

  function record(
    rootDir: string,
    events: AsyncGenerator<WorkspaceChatMessage> | WorkspaceChatMessage[],
    flags = experimentFlags(true)
  ) {
    return maybeRecordWorkspaceChat(
      { aiService: flags, config: { rootDir } },
      { workspaceId, validateOutput: true },
      Array.isArray(events) ? fromEvents(events) : events
    );
  }

  afterEach(async () => {
    // A failed test must not leave captures that count against the next test's global cap.
    await stopSessionTapeCaptures();
  });

  test("synthetic tapes of every covered event kind pass the replay-loader rules", async () => {
    using root = new DisposableTempDir("session-tape-synthetic");
    const source = syntheticChatEvents();
    await drain(record(root.path, source));
    await flushSessionTapes();

    const [tape] = (await readTapes(root.path)).map((candidate) =>
      loadTapeStrictly(candidate.lines)
    );
    expect(tape.trailer.end).toEqual({ reason: "closed", truncated: false, droppedEvents: 0 });
    // Decoding restores the exact events: Dates, undefined usage counts and tool payloads.
    expect(tape.events).toStrictEqual(source);
  });

  test("since and live subscriptions are passed through untouched and never recorded", async () => {
    using root = new DisposableTempDir("session-tape-modes");
    const modes: OnChatMode[] = [
      { type: "live" },
      { type: "since", cursor: { history: { messageId: "m-0", historySequence: 1 } } },
    ];
    for (const mode of modes) {
      const events = fromEvents([delta("m-1", "a")]);
      const result = maybeRecordWorkspaceChat(
        { aiService: experimentFlags(true), config: { rootDir: root.path } },
        { workspaceId, mode, validateOutput: true },
        events
      );
      expect(result).toBe(events);
      await drain(result);
    }
    await stopSessionTapeCaptures();
    expect(await exists(getXumPerfTapesDir(root.path))).toBe(false);
  });

  test("capture starts at the first read and touches no disk before it ends", async () => {
    using root = new DisposableTempDir("session-tape-lazy");
    const dir = getXumPerfTapesDir(root.path);
    // Created but never read, then dropped: no capture, nothing to stop or write.
    const unread = record(root.path, [delta("m-0", "z")]);
    await unread.return(undefined);
    await stopSessionTapeCaptures();
    expect(await exists(dir)).toBe(false);

    const iterator = record(root.path, [delta("m-1", "a"), delta("m-2", "b")]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await iterator.next();
    await iterator.next();
    expect(await exists(dir)).toBe(false);
    await drain(iterator);
    await flushSessionTapes();

    const [tape] = await readTapes(root.path);
    const first = SessionTapeEventLineSchema.parse(tape.lines[1]);
    // Offsets start at the first read, not at iterator creation 150 ms earlier.
    expect(first.t).toBeLessThan(100);
  });

  test("an explicit stop finalizes a live capture while the subscription keeps flowing", async () => {
    using root = new DisposableTempDir("session-tape-stop");
    const iterator = record(root.path, endless("m"));
    for (let i = 0; i < 3; i++) await iterator.next();
    await stopSessionTapeCaptures();

    const [tape] = await readTapes(root.path);
    const loaded = loadTapeStrictly(tape.lines);
    expect(loaded.events).toHaveLength(3);
    expect(loaded.trailer.end).toEqual({ reason: "stopped", truncated: false, droppedEvents: 0 });
    // Delivery goes on, unrecorded; ending the subscription later writes nothing new.
    expect((await iterator.next()).done).toBe(false);
    await iterator.return(undefined);
    await flushSessionTapes();
    expect(await readTapes(root.path)).toHaveLength(1);
  });

  test("turning the experiment off finalizes the capture at the next event", async () => {
    using root = new DisposableTempDir("session-tape-toggle");
    const flags = experimentFlags(true);
    const iterator = record(root.path, endless("m"), flags);
    await iterator.next();
    await iterator.next();
    flags.enabled = false;
    expect((await iterator.next()).done).toBe(false);
    await flushSessionTapes();

    const [tape] = await readTapes(root.path);
    const loaded = loadTapeStrictly(tape.lines);
    expect(
      loaded.events.map((event) => (event.type === "stream-delta" ? event.messageId : ""))
    ).toEqual(["m-0", "m-1"]);
    expect(loaded.trailer.end.reason).toBe("stopped");
    await iterator.return(undefined);
  });

  test("records the value captured at delivery even if the producer mutates it later", async () => {
    using root = new DisposableTempDir("session-tape-snapshot");
    const result = { output: "abcd" };
    async function* mutatingProducer(): AsyncGenerator<WorkspaceChatMessage> {
      await Promise.resolve();
      yield {
        type: "tool-call-end",
        workspaceId,
        messageId: "m-1",
        toolCallId: "call-1",
        toolName: "bash",
        result,
        timestamp: 1,
      };
      // The consumer already has the event; a tool that keeps its result object changes it.
      result.output = "changed after delivery";
      yield delta("m-2", "b");
    }
    await drain(record(root.path, mutatingProducer()));
    await flushSessionTapes();

    const [tape] = await readTapes(root.path);
    expect(SessionTapeEventLineSchema.parse(tape.lines[1]).event).toMatchObject({
      result: { output: "abcd" },
    });
  });

  test("a tape over its size cap truncates without gaps and still delivers everything", async () => {
    using root = new DisposableTempDir("session-tape-tape-cap");
    // 40 × 1 MiB passes the per-tape cap; every event fits the per-event cap on its own.
    const source = Array.from({ length: 40 }, (_, i) => delta(`m-${i}`, "d".repeat(MiB)));
    const delivered = await drain(record(root.path, source));
    await flushSessionTapes();

    expect(delivered).toEqual(source);
    const [tape] = await readTapes(root.path);
    const loaded = loadTapeStrictly(tape.lines);
    expect(loaded.events.length).toBeGreaterThan(0);
    expect(loaded.events).toEqual(source.slice(0, loaded.events.length));
    expect(loaded.trailer.end).toEqual({
      reason: "closed",
      truncated: true,
      droppedEvents: source.length - loaded.events.length,
    });
  });

  test("an event over the per-event cap truncates the tape and still delivers everything", async () => {
    using root = new DisposableTempDir("session-tape-event-cap");
    // One 9 MiB delta exceeds the 4 MiB per-event cap on its own.
    const source = [delta("m-1", "a"), delta("m-2", "b".repeat(9 * MiB)), delta("m-3", "c")];
    const delivered = await drain(record(root.path, source));
    await flushSessionTapes();

    expect(delivered).toHaveLength(source.length);
    delivered.forEach((event, i) => expect(event).toBe(source[i]));
    const [tape] = await readTapes(root.path);
    const loaded = loadTapeStrictly(tape.lines);
    expect(loaded.events).toEqual([source[0]]);
    expect(loaded.trailer.end).toEqual({ reason: "closed", truncated: true, droppedEvents: 2 });
  });

  test("the memory cap is shared by all open captures", async () => {
    using root = new DisposableTempDir("session-tape-global-cap");
    // Two open captures hold 2 × 30 MiB (each under the per-tape cap), so a third capture
    // cannot hold even 6 MiB more before the global cap truncates it.
    const holders = [record(root.path, endless("a", MiB)), record(root.path, endless("b", MiB))];
    for (const holder of holders) for (let i = 0; i < 30; i++) await holder.next();
    const third = await drain(
      record(
        root.path,
        Array.from({ length: 6 }, (_, i) => delta(`c-${i}`, "c".repeat(MiB)))
      )
    );
    expect(third).toHaveLength(6);
    await flushSessionTapes();
    const [thirdTape] = (await readTapes(root.path)).map((tape) => loadTapeStrictly(tape.lines));
    expect(thirdTape.trailer.end.truncated).toBe(true);
    expect(thirdTape.events.length).toBeLessThan(6);

    // Writing the holders releases their memory: a new capture fits again.
    await stopSessionTapeCaptures();
    await drain(record(root.path, [delta("d-0", "d".repeat(MiB))]));
    await flushSessionTapes();
    const ends = (await readTapes(root.path)).map(
      (tape) => loadTapeStrictly(tape.lines).trailer.end
    );
    expect(ends.filter((end) => !end.truncated)).toHaveLength(3);
  });

  test("retention keeps the newest 20 tapes and removes stale temp files only", async () => {
    using root = new DisposableTempDir("session-tape-retention");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(dir, { recursive: true });
    const staleTemp = "20000101T000000000Z-old-x.jsonl.0123456789ab";
    const freshTemp = "20000101T000000000Z-new-x.jsonl.ba9876543210";
    await writeIdleFile(path.join(dir, staleTemp));
    await writeIdleFile(path.join(dir, freshTemp), 1000);
    for (let i = 0; i < 23; i++) await drain(record(root.path, [delta(`m-${i}`, "a")]));
    await flushSessionTapes();

    const names = await fs.readdir(dir);
    expect(names.filter((name) => name.endsWith(".jsonl"))).toHaveLength(20);
    expect(names).not.toContain(staleTemp);
    // A recent temp file may belong to a write in progress.
    expect(names).toContain(freshTemp);
    // Loaders never read temp files.
    expect((await readTapes(root.path)).map((tape) => tape.name)).not.toContain(freshTemp);
  });

  test("retention ranks tapes by write time, so a long capture outlives shorter later ones", async () => {
    using root = new DisposableTempDir("session-tape-retention-write-time");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(dir, { recursive: true });
    // Twenty tapes that started later (newer names) but were written an hour ago.
    const shorter = Array.from(
      { length: 20 },
      (_, i) => `29990101T0000${String(i).padStart(2, "0")}000Z-short-x.jsonl`
    );
    for (const name of shorter) await writeIdleFile(path.join(dir, name), 60 * 60 * 1000);

    await drain(record(root.path, [delta("m-1", "a")]));
    await flushSessionTapes();
    const names = await fs.readdir(dir);
    expect(names.filter((name) => !name.startsWith("2999"))).toHaveLength(1);
    // The just-written tape counts as the newest; one of the older-written tapes goes.
    expect(names.filter((name) => name.startsWith("2999"))).toHaveLength(19);
  });

  test("retention deletes everything older once the total size cap is reached", async () => {
    using root = new DisposableTempDir("session-tape-retention-size");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(dir, { recursive: true });
    // Sparse files: large logical sizes without writing the bytes. Written "later" than the
    // tape this test writes (future mtimes), so the new tape falls past the size cap too.
    const sized: Array<[string, number, number]> = [
      ["29990101T000003000Z-old-x.jsonl", 150 * MiB, -180_000],
      ["29990101T000002000Z-old-x.jsonl", 60 * MiB, -120_000],
      ["29990101T000001000Z-old-x.jsonl", 0, -60_000],
    ];
    for (const [name, size, ageMs] of sized) {
      await fs.writeFile(path.join(dir, name), "");
      await fs.truncate(path.join(dir, name), size);
      await setAge(path.join(dir, name), ageMs);
    }

    await drain(record(root.path, [delta("m-1", "a")]));
    await flushSessionTapes();
    expect(await fs.readdir(dir)).toEqual([sized[0][0]]);
  });

  test("retention keeps deleting older tapes after one deletion fails", async () => {
    using root = new DisposableTempDir("session-tape-retention-rm-failure");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(dir, { recursive: true });
    const stuck = path.join(dir, "29990101T000002000Z-old-x.jsonl");
    const older = path.join(dir, "29990101T000001000Z-old-x.jsonl");
    for (const [filePath, size, ageMs] of [
      [path.join(dir, "29990101T000003000Z-old-x.jsonl"), 210 * MiB, -180_000],
      [stuck, 0, -120_000],
      [older, 0, -60_000],
    ] as const) {
      await fs.writeFile(filePath, "");
      await fs.truncate(filePath, size);
      await setAge(filePath, ageMs);
    }
    const realRm = fs.rm;
    const rm = spyOn(fs, "rm").mockImplementation((target, options) =>
      target === stuck ? Promise.reject(new Error("EPERM")) : realRm(target, options)
    );
    try {
      await drain(record(root.path, [delta("m-1", "a")]));
      await flushSessionTapes();
    } finally {
      rm.mockRestore();
    }
    const names = await fs.readdir(dir);
    expect(names).toContain(path.basename(stuck));
    expect(names).not.toContain(path.basename(older));
  });

  test("ends the tape with an error trailer when an event cannot be captured", async () => {
    using root = new DisposableTempDir("session-tape-capture-error");
    const warn = spyOn(log, "warn");
    // A tool result whose getter throws: the recorder must stop, never record a partial event.
    const result = {
      get output(): string {
        throw new Error("unreadable");
      },
    };
    const broken: WorkspaceChatMessage = {
      type: "tool-call-end",
      workspaceId,
      messageId: "m-2",
      toolCallId: "call-1",
      toolName: "bash",
      result,
      timestamp: 1,
    };
    const events = [delta("m-1", "a"), broken, delta("m-3", "c")];
    const delivered = await drain(record(root.path, events));
    await flushSessionTapes();
    const warnings = warn.mock.calls.filter((args) => String(args[0]).startsWith("Session tape"));
    warn.mockRestore();

    expect(delivered).toEqual(events);
    const [tape] = await readTapes(root.path);
    expect(tape.lines).toHaveLength(3);
    expect(SessionTapeEventLineSchema.parse(tape.lines[1]).event).toMatchObject({
      messageId: "m-1",
    });
    expect(SessionTapeTrailerSchema.parse(tape.lines[2]).end).toEqual({
      reason: "error",
      truncated: false,
      droppedEvents: 2,
    });
    expect(warnings).toHaveLength(1);
  });
});
