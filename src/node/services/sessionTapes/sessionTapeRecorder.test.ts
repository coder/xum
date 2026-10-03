import { RPCJsonSerializer } from "@orpc/client";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import {
  SessionTapeEventLineSchema,
  SessionTapeHeaderSchema,
  SessionTapeTrailerSchema,
} from "@/common/types/sessionTape";
import type { ORPCContext } from "@/node/orpc/context";
import { subscribeWorkspaceChat } from "@/node/orpc/routerSubscriptions";
import type { AgentSession } from "@/node/services/agentSession";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
import { log } from "@/node/services/log";
import { DisposableTempDir } from "@/node/services/tempDir";
import { flushSessionTapes, maybeRecordWorkspaceChat } from "./sessionTapeRecorder";
import { syntheticChatEvents } from "./sessionTapes.testFixtures";

const workspaceId = "ws-tape-test";

function experimentFlags(enabled: boolean) {
  return {
    isExperimentEnabled: (id: ExperimentId) => enabled && id === EXPERIMENT_IDS.SESSION_TAPES,
  };
}

/** Published (closed) tapes only, as a loader sees them. */
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
 * nothing dropped by schema fallbacks, and an explicit trailer. Throws on any violation instead
 * of skipping lines.
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

/** Last modified long ago: retention must not rely on recent writes to spare an open tape. */
async function backdate(filePath: string) {
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await fs.utimes(filePath, longAgo, longAgo);
}

async function writeIdleTape(filePath: string) {
  await fs.writeFile(filePath, "{}\n");
  await backdate(filePath);
}

/** A process id that existed and has exited (only reused PIDs could make it live again). */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
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
          input: { id: "secret-id", type: "secret-type", script: "cat notes" },
          output: { result: "top secret" },
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
    expect(await fs.stat(path.join(rootDir, "perf")).catch(() => null)).toBeNull();
  });

  test("experiment on: one full-content tape per subscription, reconnects share the sessionId", async () => {
    const { rootDir, subscribeOnce } = await setup(true);
    const first = await subscribeOnce();
    const second = await subscribeOnce();

    const tapes = await readTapes(rootDir);
    expect(tapes).toHaveLength(2);
    const loaded = tapes.map((tape) => loadTapeStrictly(tape.lines));
    expect(loaded.map((tape) => tape.header.subscriptionSeq)).toEqual([1, 2]);
    expect(loaded[1].header.sessionId).toBe(loaded[0].header.sessionId);
    expect(loaded[0].header.masking).toBe("none");
    expect(loaded[0].header.subscription).toEqual({ validateOutput: true });

    for (const [index, delivered] of [first, second].entries()) {
      const tape = loaded[index];
      expect(tape.trailer.end).toEqual({ reason: "closed", truncated: false, droppedEvents: 0 });
      // The tape holds exactly the wire values, content included.
      expect(tape.events).toEqual(delivered);
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

describe("maybeRecordWorkspaceChat bounds", () => {
  async function* fromEvents(events: WorkspaceChatMessage[]) {
    for (const event of events) {
      // Settle each event on its own microtask, like a real subscription stream.
      await Promise.resolve();
      yield event;
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

  // The recorder only uses the session as a correlation key, so any object identity works.
  function fakeSession(): AgentSession {
    return {} as unknown as AgentSession;
  }

  function record(rootDir: string, session: AgentSession, events: WorkspaceChatMessage[]) {
    return maybeRecordWorkspaceChat(
      { aiService: experimentFlags(true), config: { rootDir } },
      session,
      { workspaceId, validateOutput: true },
      fromEvents(events)
    );
  }

  test("synthetic tapes of every covered event kind pass the replay-loader rules", async () => {
    using root = new DisposableTempDir("session-tape-synthetic");
    const session = fakeSession();
    const source = syntheticChatEvents();
    // Two subscriptions of one session: a reconnect.
    await drain(record(root.path, session, source));
    await drain(record(root.path, session, source));
    await flushSessionTapes();

    const tapes = (await readTapes(root.path)).map((tape) => loadTapeStrictly(tape.lines));
    expect(tapes.map((tape) => tape.header.subscriptionSeq)).toEqual([1, 2]);
    expect(tapes[1].header.sessionId).toBe(tapes[0].header.sessionId);
    for (const tape of tapes) {
      expect(tape.trailer.end).toEqual({ reason: "closed", truncated: false, droppedEvents: 0 });
      // Decoding restores the exact events: Dates, undefined usage counts and tool payloads.
      expect(tape.events).toStrictEqual(source);
    }
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
    await drain(
      maybeRecordWorkspaceChat(
        { aiService: experimentFlags(true), config: { rootDir: root.path } },
        fakeSession(),
        { workspaceId, validateOutput: true },
        mutatingProducer()
      )
    );
    await flushSessionTapes();

    const [tape] = await readTapes(root.path);
    expect(SessionTapeEventLineSchema.parse(tape.lines[1]).event).toMatchObject({
      result: { output: "abcd" },
    });
  });

  test("a burst over the queue cap truncates without gaps and still delivers everything", async () => {
    using root = new DisposableTempDir("session-tape-burst");
    // 1 MiB events back to back: the writer cannot drain between them, so the 8 MiB queue cap
    // is reached before the burst ends.
    const source = Array.from({ length: 12 }, (_, i) => delta(`m-${i}`, "d".repeat(1024 * 1024)));
    const delivered = await drain(record(root.path, fakeSession(), source));
    await flushSessionTapes();

    expect(delivered).toEqual(source);
    const [tape] = await readTapes(root.path);
    const recorded = tape.lines.slice(1, -1).map((line) => {
      const event = SessionTapeEventLineSchema.parse(line).event;
      return typeof event.messageId === "string" ? event.messageId : undefined;
    });
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded).toEqual(
      source
        .slice(0, recorded.length)
        .map((event) => (event.type === "stream-delta" ? event.messageId : undefined))
    );
    expect(SessionTapeTrailerSchema.parse(tape.lines.at(-1)).end).toEqual({
      reason: "truncated",
      truncated: true,
      droppedEvents: source.length - recorded.length,
    });
  });

  test("an event over the per-event cap truncates the tape and still delivers everything", async () => {
    using root = new DisposableTempDir("session-tape-overflow");
    // One 9 MiB delta exceeds the 4 MiB per-event cap on its own.
    const source = [
      delta("m-1", "a"),
      delta("m-2", "b".repeat(9 * 1024 * 1024)),
      delta("m-3", "c"),
    ];
    const delivered = await drain(record(root.path, fakeSession(), source));
    await flushSessionTapes();

    expect(delivered).toHaveLength(source.length);
    delivered.forEach((event, i) => expect(event).toBe(source[i]));
    const [tape] = await readTapes(root.path);
    expect(tape.lines).toHaveLength(3);
    expect(SessionTapeEventLineSchema.parse(tape.lines[1]).event).toMatchObject({
      messageId: "m-1",
    });
    expect(SessionTapeTrailerSchema.parse(tape.lines[2]).end).toEqual({
      reason: "truncated",
      truncated: true,
      droppedEvents: 2,
    });
  });

  test("retention keeps the newest 20 tapes and never deletes an open tape, even a truncated stale one", async () => {
    using root = new DisposableTempDir("session-tape-retention");
    const dir = getXumPerfTapesDir(root.path);
    const session = fakeSession();
    // The open tape is truncated by an oversized event and then stops writing.
    const active = record(root.path, session, [
      delta("m-1", "a"),
      delta("m-2", "b".repeat(5 * 1024 * 1024)),
      delta("m-3", "c"),
    ]);
    await active.next();
    await active.next(); // truncated now; its subscription stays open below
    const openName = async () => (await fs.readdir(dir)).find((name) => name.endsWith(".open"));
    let open = await openName();
    for (let i = 0; i < 50 && !open; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      open = await openName();
    }
    if (!open) throw new Error("the open tape was never created");
    await backdate(path.join(dir, open));
    // Newer than any tape this test opens, so the two real tapes fall past the count cap.
    const futureNames = Array.from(
      { length: 25 },
      (_, i) => `29990101T0000${String(i).padStart(2, "0")}000Z-old-x-1.jsonl`
    );
    for (const name of futureNames) await writeIdleTape(path.join(dir, name));

    await drain(record(root.path, session, [delta("m-4", "d")]));
    await flushSessionTapes();
    const names = await fs.readdir(dir);
    expect(names.filter((name) => name.startsWith("2999")).sort()).toEqual(
      futureNames.slice(5).sort()
    );
    // Past the cap: the closed seq-2 tape is pruned when it closes; the open seq-1 tape stays.
    expect(names.filter((name) => !name.startsWith("2999"))).toEqual([open]);

    await drain(active);
    await flushSessionTapes();
    // Once closed, the truncated tape is published (with its trailer) and pruned like any other.
    expect((await fs.readdir(dir)).filter((name) => !name.startsWith("2999"))).toEqual([]);
  });

  test("retention deletes everything older once the total size cap is reached", async () => {
    using root = new DisposableTempDir("session-tape-retention-size");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(dir, { recursive: true });
    // Sparse files: large logical sizes without writing the bytes. The new tape is older than
    // these by name, so it survives only because it is being written.
    const sized: Array<[string, number]> = [
      ["29990101T000003000Z-old-x-1.jsonl", 150 * 1024 * 1024],
      ["29990101T000002000Z-old-x-1.jsonl", 60 * 1024 * 1024],
      ["29990101T000001000Z-old-x-1.jsonl", 0],
    ];
    for (const [name, size] of sized) {
      await writeIdleTape(path.join(dir, name));
      await fs.truncate(path.join(dir, name), size);
      await backdate(path.join(dir, name));
    }

    await drain(record(root.path, fakeSession(), [delta("m-1", "a")]));
    await flushSessionTapes();
    const names = (await fs.readdir(dir)).sort();
    expect(names.filter((name) => name.startsWith("2999"))).toEqual([sized[0][0]]);
    expect(names).toHaveLength(2);
  });

  test("retention keeps deleting older tapes after one deletion fails", async () => {
    using root = new DisposableTempDir("session-tape-retention-rm-failure");
    const dir = getXumPerfTapesDir(root.path);
    await fs.mkdir(dir, { recursive: true });
    const stuck = path.join(dir, "29990101T000002000Z-old-x-1.jsonl");
    const older = path.join(dir, "29990101T000001000Z-old-x-1.jsonl");
    for (const [filePath, size] of [
      [path.join(dir, "29990101T000003000Z-old-x-1.jsonl"), 210 * 1024 * 1024],
      [stuck, 0],
      [older, 0],
    ] as const) {
      await writeIdleTape(filePath);
      await fs.truncate(filePath, size);
      await backdate(filePath);
    }
    const realRm = fs.rm;
    const rm = spyOn(fs, "rm").mockImplementation((target, options) =>
      target === stuck ? Promise.reject(new Error("EPERM")) : realRm(target, options)
    );
    try {
      await drain(record(root.path, fakeSession(), [delta("m-1", "a")]));
      await flushSessionTapes();
    } finally {
      rm.mockRestore();
    }
    const names = await fs.readdir(dir);
    expect(names).toContain(path.basename(stuck));
    expect(names).not.toContain(path.basename(older));
  });

  test("retention keeps other backends' open tapes and publishes this host's crash leftovers", async () => {
    using root = new DisposableTempDir("session-tape-retention-foreign");
    const dir = getXumPerfTapesDir(root.path);
    // A real recording reveals this host's tag in its published name.
    await drain(record(root.path, fakeSession(), [delta("m-1", "a")]));
    await flushSessionTapes();
    const [own] = await readTapes(root.path);
    const hostTag = /-([0-9a-f]{8})-p\d+\.jsonl$/.exec(own.name)?.[1] ?? "";
    expect(hostTag).toMatch(/^[0-9a-f]{8}$/);
    await fs.rm(path.join(dir, own.name));

    // Oldest by name, past the count cap, and stale: only ownership may protect them.
    const liveOther = `20000101T000000000Z-ws-s-000001-${hostTag}-p${process.ppid}.open`;
    const otherHost = `20000101T000001000Z-ws-s-000001-00000000-p${await exitedPid()}.open`;
    const crashed = `20000101T000002000Z-ws-s-000001-${hostTag}-p${await exitedPid()}`;
    const idleOld = "20000101T000003000Z-old-x-1.jsonl";
    for (const name of [liveOther, otherHost, crashed + ".open", idleOld]) {
      await writeIdleTape(path.join(dir, name));
    }
    for (let i = 0; i < 25; i++) {
      await writeIdleTape(
        path.join(dir, `29990101T0000${String(i).padStart(2, "0")}000Z-new-x-1.jsonl`)
      );
    }

    await drain(record(root.path, fakeSession(), [delta("m-2", "b")]));
    await flushSessionTapes();
    const names = await fs.readdir(dir);
    expect(names).toContain(liveOther);
    expect(names).toContain(otherHost);
    // The crash leftover was published as an incomplete tape, then pruned past the cap.
    expect(names.filter((name) => name.startsWith(crashed))).toEqual([]);
    expect(names).not.toContain(idleOld);
  });

  test("a crash leftover under the caps is published as an incomplete tape", async () => {
    using root = new DisposableTempDir("session-tape-retention-crash");
    await drain(record(root.path, fakeSession(), [delta("m-1", "a")]));
    await flushSessionTapes();
    const [own] = await readTapes(root.path);
    const leftover = own.name.replace(/-p\d+\.jsonl$/, `-p${await exitedPid()}`);
    const dir = getXumPerfTapesDir(root.path);
    await fs.copyFile(path.join(dir, own.name), path.join(dir, leftover + ".open"));

    await drain(record(root.path, fakeSession(), [delta("m-2", "b")]));
    await flushSessionTapes();
    const names = await fs.readdir(dir);
    expect(names).toContain(leftover + ".jsonl");
    expect(names.some((name) => name.endsWith(".open"))).toBe(false);
  });

  test("retention prunes a burst of closed tapes without waiting for another subscription", async () => {
    using root = new DisposableTempDir("session-tape-retention-burst");
    const session = fakeSession();
    for (let i = 0; i < 23; i++) await drain(record(root.path, session, [delta("m-1", "a")]));
    await flushSessionTapes();
    const seqs = (await readTapes(root.path)).map(
      (tape) => SessionTapeHeaderSchema.parse(tape.lines[0]).subscriptionSeq
    );
    expect(seqs.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 4));
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
    const delivered = await drain(record(root.path, fakeSession(), events));
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
