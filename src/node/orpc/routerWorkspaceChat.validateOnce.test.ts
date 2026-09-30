/**
 * onChat validates each replayed row once (#4868). The session's self-healing wire-schema check
 * already parses every replay row, so the onChat procedure disables oRPC's output validation and
 * validates only the events the session did not. These tests pin, through the real oRPC procedure,
 * that the bytes on the wire are identical to the old double-validated pipeline (computed here
 * with oRPC's own eventIterator schema), that non-replay events still get oRPC's transform and
 * error, and that replay rows are no longer parsed a second time.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRouterClient, eventIterator, ORPCError } from "@orpc/server";
import { z } from "zod";
import { CHAT_FILE_NAME } from "@/common/constants/paths";
import { ChatMuxMessageSchema, WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { CaughtUpMessage, OnChatMode, WorkspaceChatMessage } from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";
import { WorkspaceService } from "@/node/services/workspaceService";
import {
  createAgentSessionHarness,
  type AgentSessionHarness,
} from "@/node/services/agentSession.testHarness";
import type { ORPCContext } from "./context";
import { router } from "./router";

const workspaceId = "ws-validate-once";
const SKIP_WARNING = "onChat replay: skipping persisted row that fails the wire schema";

function deepValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = { nested: value };
  return value;
}

// Raw chat.jsonl rows covering every transform the wire schema applies: unknown keys (stripped),
// `.catch(undefined)` metadata fallbacks, legacy metadata, bounded deep tool payloads, a row the
// self-healing check must skip (a string historySequence) and rows the history read already drops
// (an output-available tool part without output, a line that is not JSON).
const corpus: string[] = [
  JSON.stringify({
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "hi", state: "done", unknownPartKey: 1 }],
    metadata: { historySequence: 0, timestamp: 1_000, unknownMetadataKey: "x" },
    unknownTopLevelKey: { a: 1 },
  }),
  JSON.stringify({
    id: "assistant-tool",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "thinking", timestamp: 1_100 },
      {
        type: "dynamic-tool",
        toolCallId: "call-1",
        toolName: "bash",
        input: { script: "ls" },
        state: "output-available",
        output: { stdout: "a\nb", exitCode: 0 },
        unknownToolKey: true,
      },
      { type: "text", text: "done", timestamp: 1_200 },
    ],
    metadata: {
      historySequence: 1,
      timestamp: 1_100,
      model: "anthropic:claude-test",
      stepStartPartIndices: "bad",
      agentSkillSnapshot: 42,
      agentId: { not: "an id" },
    },
  }),
  JSON.stringify({
    id: "legacy-metadata",
    role: "assistant",
    parts: [{ type: "text", text: "summary" }],
    metadata: {
      historySequence: 2,
      timestamp: 1_300,
      compacted: true,
      idleCompacted: true,
      cmuxMetadata: { type: "normal" },
    },
  }),
  JSON.stringify({
    id: "string-sequence",
    role: "user",
    parts: [{ type: "text", text: "corrupt sequence" }],
    metadata: { historySequence: "3", timestamp: 1_400 },
  }),
  JSON.stringify({
    id: "deep-tool",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: "call-deep",
        toolName: "bash",
        input: deepValue(300),
        state: "output-available",
        output: { ok: true },
      },
    ],
    metadata: { historySequence: 4, timestamp: 1_500 },
  }),
  JSON.stringify({
    id: "corrupt-tool",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: "call-corrupt",
        toolName: "bash",
        input: { script: "true" },
        state: "output-available",
      },
    ],
    metadata: { historySequence: 5, timestamp: 1_600 },
  }),
  "{ this line is not json",
  JSON.stringify({
    id: "assistant-last",
    role: "assistant",
    parts: [{ type: "text", text: "last", timestamp: 1_700 }],
    metadata: { historySequence: 6, timestamp: 1_700, unknownMetadataKey: 2 },
  }),
];

const partial = {
  id: "assistant-partial",
  role: "assistant",
  parts: [{ type: "text", text: "streaming…", state: "streaming" }],
  // Sequence 7 is left for the row the since case appends below the partial.
  metadata: { historySequence: 8, timestamp: 1_800, partial: true, stepStartPartIndices: "bad" },
} as unknown as MuxMessage;

async function createHarness(): Promise<AgentSessionHarness> {
  const harness = await createAgentSessionHarness({
    workspaceId,
    aiServiceOverrides: {
      getStreamInfo: mock((_workspaceId: string) => undefined),
      replayStream: mock((_workspaceId: string, _opts?: { afterTimestamp?: number }) =>
        Promise.resolve()
      ),
    },
    initStateManagerOverrides: { replayInit: mock((_workspaceId: string) => Promise.resolve()) },
  });
  const sessionDir = path.join(harness.config.sessionsDir, workspaceId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, CHAT_FILE_NAME), corpus.join("\n") + "\n");
  expect((await harness.historyService.writePartial(workspaceId, partial)).success).toBe(true);
  return harness;
}

function createClient(harness: AgentSessionHarness) {
  const getOrCreateSession = () => harness.session;
  const context = {
    workspaceService: {
      getOrCreateSession,
      getFullReplay: (id: string) =>
        WorkspaceService.prototype.getFullReplay.call(
          { getOrCreateSession } as unknown as WorkspaceService,
          id
        ),
    },
  } as unknown as ORPCContext;
  return createRouterClient(router(), { context });
}

/** The pre-#4868 wire rows: self-healing filter, then oRPC's own output validation. */
async function oracleRows(
  harness: AgentSessionHarness,
  keep: (row: MuxMessage) => boolean = () => true
): Promise<{ wire: unknown[]; rejectedIds: string[] }> {
  const history = await harness.historyService.getHistoryFromLatestBoundary(workspaceId);
  if (!history.success) throw new Error(history.error);
  const stored = await harness.historyService.readPartial(workspaceId);
  const rows = [...history.data, ...(stored ? [stored] : [])].filter(keep);
  const rejectedIds: string[] = [];
  const accepted = rows
    .map((row) => ({ ...row, type: "message" as const }))
    .filter((row) => {
      if (ChatMuxMessageSchema.safeParse(row).success) return true;
      rejectedIds.push(row.id);
      return false;
    });
  const result = await eventIterator(WorkspaceChatMessageSchema)["~standard"].validate(
    // eslint-disable-next-line @typescript-eslint/require-await -- a plain async iterator source
    (async function* () {
      yield* accepted;
    })()
  );
  if (result.issues) throw new Error("oracle input is not an async iterator");
  const wire: unknown[] = [];
  for await (const event of result.value) wire.push(event);
  return { wire, rejectedIds };
}

/** Replay rows in wire order; `batchReplay` batches are flattened and counted. */
async function collectReplay(
  client: ReturnType<typeof createClient>,
  mode?: OnChatMode,
  batchReplay?: boolean
): Promise<{ rows: WorkspaceChatMessage[]; caughtUp: CaughtUpMessage; batches: number }> {
  const iterator = await client.workspace.onChat({ workspaceId, mode, batchReplay });
  const rows: WorkspaceChatMessage[] = [];
  let batches = 0;
  for await (const event of iterator) {
    if (event.type === "caught-up") {
      await iterator.return?.(undefined);
      return { rows, caughtUp: event, batches };
    }
    if (event.type === "message") rows.push(event);
    if (event.type === "message-batch") {
      batches += 1;
      rows.push(...event.messages);
    }
  }
  throw new Error("onChat ended before caught-up");
}

function skippedIds(warn: { mock: { calls: unknown[][] } }): Array<string | undefined> {
  return warn.mock.calls
    .filter((call) => call[0] === SKIP_WARNING)
    .map((call) => (call[1] as { messageId?: string }).messageId);
}

describe("onChat validates replay rows once (#4868)", () => {
  let harness: AgentSessionHarness | undefined;
  afterEach(async () => {
    mock.restore();
    await harness?.session.dispose();
    await harness?.cleanup();
    harness = undefined;
  });

  test("full and since replays put the same bytes on the wire as double validation", async () => {
    harness = await createHarness();
    const client = createClient(harness);
    const full = await oracleRows(harness);
    // The corpus must exercise a self-healing skip and several accepted rows.
    expect(full.rejectedIds).toEqual(["string-sequence"]);
    expect(full.wire.length).toBe(6);

    const warn = spyOn(log, "warn");
    const replay = await collectReplay(client);
    expect(replay.rows.map((row) => JSON.stringify(row))).toEqual(
      full.wire.map((row) => JSON.stringify(row))
    );
    expect(skippedIds(warn)).toEqual(full.rejectedIds);
    expect(replay.caughtUp.historyReplayStatus).toBe("complete");

    const cursor = replay.caughtUp.cursor?.history;
    if (!cursor) throw new Error("full replay must return a history cursor");
    // Rows appended after the cursor: a valid one carrying unknown keys and a `.catch` fallback.
    const appended = {
      id: "user-after-cursor",
      role: "user",
      parts: [{ type: "text", text: "next", state: "done" }],
      metadata: { timestamp: 2_000, stepStartPartIndices: "bad", unknownMetadataKey: 3 },
    } as unknown as MuxMessage;
    expect((await harness.historyService.appendToHistory(workspaceId, appended)).success).toBe(
      true
    );

    const since = await oracleRows(
      harness,
      (row) => (row.metadata?.historySequence ?? -1) >= cursor.historySequence
    );
    const sinceReplay = await collectReplay(client, {
      type: "since",
      cursor: { history: cursor },
    });
    expect(sinceReplay.caughtUp.replay).toBe("since");
    expect(sinceReplay.caughtUp.historyReplayStatus).toBe("complete");
    expect(sinceReplay.rows.map((row) => JSON.stringify(row))).toEqual(
      since.wire.map((row) => JSON.stringify(row))
    );
    expect(sinceReplay.rows.map((row) => ("id" in row ? row.id : undefined))).toEqual([
      cursor.messageId,
      appended.id,
      partial.id,
    ]);
  });

  test("getFullReplay returns the same rows as before", async () => {
    harness = await createHarness();
    const client = createClient(harness);
    // Before #4868 the session emitted raw rows and the procedure's array schema parsed them.
    const raw: WorkspaceChatMessage[] = [];
    const history = await harness.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!history.success) throw new Error(history.error);
    const stored = await harness.historyService.readPartial(workspaceId);
    for (const row of [...history.data, ...(stored ? [stored] : [])]) {
      const message = { ...row, type: "message" as const };
      if (ChatMuxMessageSchema.safeParse(message).success) raw.push(message);
    }
    const events = await client.workspace.getFullReplay({ workspaceId });
    const expectedRows = z.array(WorkspaceChatMessageSchema).parse(raw);
    expect(
      events.filter((event) => event.type === "message").map((e) => JSON.stringify(e))
    ).toEqual(expectedRows.map((row) => JSON.stringify(row)));
  });

  test("live events get oRPC's transform, and an invalid one fails the stream with its error", async () => {
    harness = await createHarness();
    const client = createClient(harness);
    const iterator = await client.workspace.onChat({ workspaceId });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("onChat ended before caught-up");
      if (next.value.type === "caught-up") break;
    }
    // A valid live event goes out as the schema's parse output (unknown keys stripped), exactly
    // as oRPC's output validation sent it, not as the emitted object.
    const valid = {
      type: "stream-delta",
      workspaceId,
      messageId: "live",
      delta: "text",
      tokens: 1,
      timestamp: 2_900,
      unknownLiveKey: true,
    } as unknown as WorkspaceChatMessage;
    harness.session.emitChatEvent(valid);
    const delivered = await iterator.next();
    expect(JSON.stringify(delivered.value)).toBe(
      JSON.stringify(WorkspaceChatMessageSchema.parse(valid))
    );
    expect(delivered.value).not.toHaveProperty("unknownLiveKey");
    // A stream-delta without its required token count.
    harness.session.emitChatEvent({
      type: "stream-delta",
      workspaceId,
      messageId: "live",
      delta: "text",
      timestamp: 3_000,
    } as unknown as WorkspaceChatMessage);
    let failure: unknown;
    await iterator.next().catch((error: unknown) => (failure = error));
    expect(failure).toBeInstanceOf(ORPCError);
    expect((failure as ORPCError<string, unknown>).code).toBe(
      "ASYNC_ITERATOR_OBJECT_VALIDATION_FAILED"
    );
  });

  test("replay rows are not parsed by the wire schema a second time", async () => {
    harness = await createHarness();
    const client = createClient(harness);
    const validate = spyOn(WorkspaceChatMessageSchema["~standard"], "validate");
    const replay = await collectReplay(client);
    expect(replay.rows.length).toBe(6);
    const validatedTypes = validate.mock.calls.map(
      (call: unknown[]) => (call[0] as { type?: string }).type
    );
    // Non-replay events are still validated; replayed rows are not.
    expect(validatedTypes).toContain("caught-up");
    expect(validatedTypes).not.toContain("message");
  });

  test("batchReplay batches flatten to the single-row bytes; other subscribers keep single rows", async () => {
    harness = await createHarness();
    const client = createClient(harness);
    // The corpus alternates text and tool rows; give it consecutive text rows so batches form.
    // The partial goes first: its sequence would otherwise be taken by an appended row.
    await harness.historyService.deletePartial(workspaceId);
    const textRow = (id: string) =>
      ({
        id,
        role: "user",
        parts: [{ type: "text", text: id, state: "done" }],
        metadata: { timestamp: 2_000, stepStartPartIndices: "bad", unknownMetadataKey: 3 },
      }) as unknown as MuxMessage;
    for (const id of ["text-a", "text-b", "text-c"]) {
      expect((await harness.historyService.appendToHistory(workspaceId, textRow(id))).success).toBe(
        true
      );
    }

    const full = await oracleRows(harness);
    const validate = spyOn(WorkspaceChatMessageSchema["~standard"], "validate");
    // Concurrent subscribers: one opted in, one (an ACP/VS Code/older client) not.
    const [batched, single] = await Promise.all([
      collectReplay(client, undefined, true),
      collectReplay(client),
    ]);
    // Batches carry rows the session already parsed: neither they nor their rows are revalidated.
    const validatedTypes = validate.mock.calls.map(
      (call: unknown[]) => (call[0] as { type?: string }).type
    );
    validate.mockRestore();
    expect(validatedTypes).toContain("caught-up");
    expect(validatedTypes).not.toContain("message");
    expect(validatedTypes).not.toContain("message-batch");
    expect(batched.batches).toBeGreaterThan(0);
    expect(single.batches).toBe(0);
    expect(single.rows.map((row) => JSON.stringify(row))).toEqual(
      full.wire.map((row) => JSON.stringify(row))
    );
    expect(batched.rows.map((row) => JSON.stringify(row))).toEqual(
      full.wire.map((row) => JSON.stringify(row))
    );

    const cursor = single.caughtUp.cursor?.history;
    if (!cursor) throw new Error("full replay must return a history cursor");
    for (const id of ["text-d", "text-e"]) {
      expect((await harness.historyService.appendToHistory(workspaceId, textRow(id))).success).toBe(
        true
      );
    }
    const since = await oracleRows(
      harness,
      (row) => (row.metadata?.historySequence ?? -1) >= cursor.historySequence
    );
    const sinceBatched = await collectReplay(
      client,
      { type: "since", cursor: { history: cursor } },
      true
    );
    expect(sinceBatched.caughtUp.replay).toBe("since");
    expect(sinceBatched.batches).toBe(1);
    expect(sinceBatched.rows.map((row) => JSON.stringify(row))).toEqual(
      since.wire.map((row) => JSON.stringify(row))
    );
    expect(sinceBatched.rows.map((row) => ("id" in row ? row.id : undefined))).toEqual([
      "text-c",
      "text-d",
      "text-e",
    ]);
  });
});
