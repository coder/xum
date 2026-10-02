import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { getXumPerfTapesDir } from "@/common/constants/paths";
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

const workspaceId = "ws-tape-test";

function experimentFlags(enabled: boolean) {
  return {
    isExperimentEnabled: (id: ExperimentId) => enabled && id === EXPERIMENT_IDS.SESSION_TAPES,
  };
}

async function readTapes(rootDir: string): Promise<Array<{ name: string; lines: unknown[] }>> {
  const dir = getXumPerfTapesDir(rootDir);
  const names = (await fs.readdir(dir)).sort();
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

  test("experiment on: one redacted tape per subscription, reconnects share the sessionId", async () => {
    const { rootDir, subscribeOnce } = await setup(true);
    const first = await subscribeOnce();
    const second = await subscribeOnce();

    const tapes = await readTapes(rootDir);
    expect(tapes).toHaveLength(2);
    const headers = tapes.map((tape) => SessionTapeHeaderSchema.parse(tape.lines[0]));
    expect(headers.map((header) => header.subscriptionSeq)).toEqual([1, 2]);
    expect(headers[1].sessionId).toBe(headers[0].sessionId);
    expect(headers[0].subscription).toEqual({ validateOutput: true });
    // Contract: every recorded workspaceId uses the header's hash (the raw id is checked below).
    const recordedWorkspaceIds = tapes[0].lines
      .slice(1, -1)
      .map((line) => SessionTapeEventLineSchema.parse(line).event as { workspaceId?: unknown })
      .map((event) => event.workspaceId)
      .filter((id) => id !== undefined);
    expect(recordedWorkspaceIds.length).toBeGreaterThan(0);
    expect(new Set(recordedWorkspaceIds)).toEqual(new Set([headers[0].workspaceIdHash]));

    for (const [index, delivered] of [first, second].entries()) {
      const lines = tapes[index].lines;
      const events = lines.slice(1, -1).map((line) => SessionTapeEventLineSchema.parse(line));
      expect(SessionTapeTrailerSchema.parse(lines.at(-1)).end).toEqual({
        reason: "closed",
        truncated: false,
        droppedEvents: 0,
      });
      expect(events.map((line) => line.event.type)).toEqual(delivered.map((event) => event.type));
      expect(events.map((line) => line.bytes)).toEqual(
        delivered.map((event) => Buffer.byteLength(JSON.stringify(event)))
      );
      for (let i = 1; i < events.length; i++) {
        expect(events[i].t).toBeGreaterThanOrEqual(events[i - 1].t);
      }
    }

    const text = JSON.stringify(tapes[0].lines);
    for (const secret of ["Hello", "secret", "notes", workspaceId]) {
      expect(text).not.toContain(secret);
    }
    const rows = tapes[0].lines
      .slice(1, -1)
      .map((line) => SessionTapeEventLineSchema.parse(line).event)
      .filter((event) => event.type === "message");
    expect(rows).toMatchObject([
      { id: "user-1", role: "user", parts: [{ type: "text", text: "xxxxx xxxxx 00" }] },
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { model: "openai:gpt-x" },
        parts: [
          { type: "text" },
          {
            type: "dynamic-tool",
            toolCallId: "call-1",
            toolName: "bash",
            state: "output-available",
            input: { id: "xxxxxx-xx", type: "xxxxxx-xxxx" },
          },
        ],
      },
    ]);
    const assistantRow = rows[1] as { metadata?: { historySequence?: unknown } };
    expect(assistantRow.metadata?.historySequence).toBeNumber();
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

  test("truncates at the first event over the memory cap and still delivers everything", async () => {
    using root = new DisposableTempDir("session-tape-overflow");
    // One 9 MiB delta exceeds the 8 MiB queue cap on its own.
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

  test("retention keeps the newest 20 tapes and never deletes a tape being written", async () => {
    using root = new DisposableTempDir("session-tape-retention");
    const dir = getXumPerfTapesDir(root.path);
    const session = fakeSession();
    const active = record(root.path, session, [delta("m-1", "a")]);
    await active.next(); // the tape is open; its subscription stays open below
    await fs.mkdir(dir, { recursive: true });
    // Newer than any tape this test opens, so the two real tapes fall past the count cap.
    const futureNames = Array.from(
      { length: 25 },
      (_, i) => `29990101T0000${String(i).padStart(2, "0")}000Z-old-x-1.jsonl`
    );
    for (const name of futureNames) await fs.writeFile(path.join(dir, name), "{}\n");

    await drain(record(root.path, session, [delta("m-2", "b")]));
    await flushSessionTapes();
    const names = await fs.readdir(dir);
    expect(names.filter((name) => name.startsWith("2999")).sort()).toEqual(
      futureNames.slice(5).sort()
    );
    expect(names.filter((name) => !name.startsWith("2999"))).toHaveLength(2);

    await active.return(undefined);
    await flushSessionTapes();
    const own = (await readTapes(root.path)).filter((tape) => !tape.name.startsWith("2999"));
    expect(own.map((tape) => SessionTapeHeaderSchema.parse(tape.lines[0]).subscriptionSeq)).toEqual(
      [1, 2]
    );
    expect(own.every((tape) => SessionTapeTrailerSchema.safeParse(tape.lines.at(-1)).success)).toBe(
      true
    );
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
      await fs.writeFile(path.join(dir, name), "");
      await fs.truncate(path.join(dir, name), size);
    }

    await drain(record(root.path, fakeSession(), [delta("m-1", "a")]));
    await flushSessionTapes();
    const names = (await fs.readdir(dir)).sort();
    expect(names.filter((name) => name.startsWith("2999"))).toEqual([sized[0][0]]);
    expect(names).toHaveLength(2);
  });
});
