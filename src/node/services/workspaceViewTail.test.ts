import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { HistoryService } from "./historyService";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { createTestHistoryService } from "./testHistoryService";
import type { Config } from "@/node/config";
import * as fsPromises from "fs/promises";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { readWorkspaceViewTail, WORKSPACE_VIEW_TAIL_CAPS } from "./workspaceViewTail";
import type { RowTreeClient, RowTreeRow } from "@/node/orpc/staticWorkspaceView/rowTreeClient";
import type { StaticNode } from "@/common/staticWorkspaceView/tree";

const ID = "view-tail-ws";
const INFO: FrontendWorkspaceMetadata = {
  ...{ id: ID, name: "seed", projectName: "demo-app", projectPath: "/p", namedWorkspacePath: "/p" },
  runtimeConfig: { type: "local" },
};
const STOP = { model: "anthropic:claude-sonnet-4-5", finishReason: "stop" } as const;
const { maxRows, maxBytes } = WORKSPACE_VIEW_TAIL_CAPS;

let historyService: HistoryService;
let config: Config;
let cleanup: () => Promise<void>;
let streaming = false;
beforeEach(async () => {
  ({ historyService, config, cleanup } = await createTestHistoryService());
  streaming = false;
});
afterEach(() => cleanup());

const lookup = mock((_id: string, _options?: object) => Promise.resolve<typeof INFO | null>(INFO));
const read = (info: FrontendWorkspaceMetadata | null = INFO) => {
  lookup.mockImplementation(() => Promise.resolve(info));
  const deps = { aiService: { isStreaming: () => streaming }, historyService };
  return readWorkspaceViewTail({ ...deps, config: { getWorkspaceMetadataById: lookup } }, ID);
};
const msg = (id: string, role: "user" | "assistant", text: string, meta = {}, parts = []) =>
  createMuxMessage(
    id,
    role,
    text,
    { timestamp: 1, ...(role === "assistant" ? STOP : {}), ...meta },
    parts
  );
/** Alternating user/assistant turns. */
const turns = (count: number, text = (i: number) => `text ${i}`) =>
  Array.from({ length: count }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", text(i)));
async function append(messages: MuxMessage[]) {
  expect((await historyService.appendManyToHistory(ID, messages)).success).toBe(true);
}

describe("readWorkspaceViewTail", () => {
  test("an unknown or multi-project workspace returns null before any history read", async () => {
    const window = spyOn(historyService, "getHistoryWindowFromLatestBoundary");
    expect(await read(null)).toBeNull();
    const projects = [INFO, INFO].map((p) => ({ projectPath: p.projectPath, projectName: "x" }));
    expect(await read({ ...INFO, projects })).toBeNull();
    expect(window).not.toHaveBeenCalled();
    // Registry only: a checkout probe can stall on a slow mount.
    expect(lookup).toHaveBeenCalledWith(ID, { probeCheckouts: false, persistMigrations: false });
  });

  test("a stream in flight gives no view", async () => {
    await append(turns(2));
    streaming = true;
    expect(await read()).toBeNull();
    streaming = false;
    expect(await read()).not.toBeNull();
  });

  test("keeps within the row cap, newest last; one row over the byte cap gives no view", async () => {
    await append(turns(maxRows + 1));
    const tail = (await read())!;
    expect(tail.rows.length).toBeLessThanOrEqual(maxRows);
    expect(tail.rows.at(-1)?.id).toBe(`m${maxRows}`);
    await append([msg("big", "user", "y".repeat(maxBytes + 1))]);
    expect(await read()).toBeNull();
  });

  test("draws rows as the send and stream paths persist them today", async () => {
    // The keys AgentSession.sendMessage and the StreamManager stream-end write today.
    const muxMetadata = { type: "normal", requestedModel: "x" };
    const send = {
      retrySendOptions: {},
      autoModelRouting: { requestedFallbackModel: "x" },
      muxMetadata,
    };
    const numbers = { requestHistorySequence: 0, systemMessageTokens: 9, duration: 9, ttftMs: 5 };
    const objects = {
      usage: {},
      contextUsage: {},
      providerMetadata: {},
      contextProviderMetadata: {},
    };
    const stream = {
      ...numbers,
      ...objects,
      agentId: "exec",
      thinkingLevel: "high",
      metadataModel: "x",
    };
    Object.assign(stream, { routedThroughGateway: false, stopCause: { kind: "required-tool" } });
    const textPart = (text: string) => [{ type: "text", text, timestamp: 7 }] as never;
    await append([
      msg("u", "user", "hello", send),
      msg("u2", "user", "bare", { muxMetadata: { type: "normal" } }),
      msg("a", "assistant", "", stream, textPart("direct")),
      msg("g", "assistant", "", { ...stream, routeProvider: "mux-gateway" }, textPart("routed")),
      msg("bad", "assistant", "damaged", { model: 7, timestamp: "x" }),
      msg("proto", "assistant", "", { ...stream, routeProvider: "constructor" }, textPart("odd")),
      msg("ok", "assistant", "after", { finishReason: undefined }),
    ]);
    const { rows, ...tail } = (await read())!;
    expect(tail).toEqual({ title: "seed", project: "demo-app" });
    const model = { label: "Sonnet 4.5", provider: "anthropic", via: null };
    expect(rows[2]).toEqual({
      id: "a",
      role: "assistant",
      text: "direct",
      timestamp: 7,
      model,
      tree: null,
    });
    expect(rows.map((row) => [row.id, row.text, row.timestamp, row.model?.via])).toEqual([
      ["u", "hello", 1, undefined],
      ["u2", "bare", 1, undefined],
      ["a", "direct", 7, null],
      ["g", "routed", 7, PROVIDER_DEFINITIONS["mux-gateway"].displayName],
      ["bad", null, null, undefined],
      ["proto", "odd", 7, "constructor"],
      ["ok", "after", 1, null],
    ]);
  });

  test("rows the live transcript draws differently carry no text", async () => {
    const tool = { type: "dynamic-tool", toolName: "bash", toolCallId: "t", input: {} };
    await append([
      msg("plain", "user", "hi"),
      msg("tool", "assistant", "running", {}, [{ ...tool, state: "input-available" }] as never),
      msg("reasoning", "assistant", "", {}, [{ type: "reasoning", text: "hmm" }] as never),
      msg("synthetic", "user", "[CONTINUE]", { synthetic: true }),
      msg("command", "user", "/compact", { muxMetadata: { type: "compaction-request" } }),
      msg("cut", "assistant", "partial answ", { finishReason: "length" }),
      msg("skill", "user", "use it", { muxMetadata: { type: "normal", agentSkillRefs: [] } }),
      msg("last", "assistant", "fine"),
    ]);
    const texts = Object.fromEntries((await read())!.rows.map((row) => [row.id, row.text]));
    expect(texts).toEqual({
      plain: "hi",
      ...{ tool: null, reasoning: null, synthetic: null, command: null, cut: null, skill: null },
      last: "fine",
    });
  });
});

describe("row trees", () => {
  const readWith = (rowTreeClient?: Pick<RowTreeClient, "render">) => {
    lookup.mockImplementation(() => Promise.resolve(INFO));
    const deps = { aiService: { isStreaming: () => streaming }, historyService, rowTreeClient };
    return readWorkspaceViewTail({ ...deps, config: { getWorkspaceMetadataById: lookup } }, ID);
  };
  const echo = mock((_id: string, rows: RowTreeRow[]) =>
    Promise.resolve(rows.map((row): StaticNode => ["p", {}, row.text]))
  );
  const treesOf = async (client?: Pick<RowTreeClient, "render">) =>
    (await readWith(client))!.rows.map((row) => [row.id, row.tree]);

  test("drawable rows go to the worker as text and role, and each gets its own tree", async () => {
    await append([
      msg("u", "user", "hi"),
      msg("synthetic", "user", "[CONTINUE]", { synthetic: true }), // not drawable: never sent
      msg("a", "assistant", "yo"),
    ]);
    echo.mockClear();
    expect(await treesOf({ render: echo })).toEqual([
      ["u", ["p", {}, "hi"]],
      ["synthetic", null],
      ["a", ["p", {}, "yo"]],
    ]);
    expect(echo).toHaveBeenCalledWith(ID, [
      { text: "hi", isUser: true },
      { text: "yo", isUser: false },
    ]);
  });

  test("a failed or cold worker, or no client at all, gives tree: null", async () => {
    await append(turns(2));
    const nulls = [
      ["m0", null],
      ["m1", null],
    ];
    expect(await treesOf({ render: () => Promise.reject(new Error("crashed")) })).toEqual(nulls);
    expect(await treesOf({ render: (_id, rows) => Promise.resolve(rows.map(() => null)) })).toEqual(
      nulls
    );
    expect(await treesOf(undefined)).toEqual(nulls);
  });

  test("a tail with nothing to draw never wakes the worker", async () => {
    await append([msg("synthetic", "user", "[CONTINUE]", { synthetic: true })]);
    echo.mockClear();
    expect(await treesOf({ render: echo })).toEqual([["synthetic", null]]);
    expect(echo).not.toHaveBeenCalled();
  });
});

describe("an interrupted stream's partial.json (#6832)", () => {
  const partialFile = () => path.join(config.sessionsDir, ID, "partial.json");
  const longer = [{ type: "text", text: " and more" }] as never;
  const owning = () => msg("m1", "assistant", "text 1", { historySequence: 1 }, longer);
  test.each([
    ["owns the last row", owning],
    ["is newer than the tail", () => msg("m2", "assistant", "next", { historySequence: 2 })],
    // The replay drops every row with the partial's historySequence, whatever its id.
    ["reuses a row's sequence", () => msg("gone", "assistant", "old", { historySequence: 1 })],
  ])("a readable partial that %s gives no view: the live replay shows it", async (_, partial) => {
    await append(turns(2));
    expect((await historyService.writePartial(ID, partial())).success).toBe(true);
    expect(await read()).toBeNull();
  });

  test("a malformed partial keeps the view, as readPartial ignores it in the replay", async () => {
    await append(turns(2));
    await writeFile(partialFile(), "{ not json");
    expect((await read())?.rows).toHaveLength(2);
  });

  test("a partial over the byte cap gives no view without being parsed", async () => {
    await append(turns(2));
    // Malformed, so parsing it would keep the view: only the size check can hide it.
    await writeFile(partialFile(), `{ not json${"x".repeat(maxBytes)}`);
    expect(await read()).toBeNull();
  });

  test("short reads are joined until EOF, so a readable partial still hides the view", async () => {
    await append(turns(2));
    expect((await historyService.writePartial(ID, owning())).success).toBe(true);
    const open = fsPromises.open;
    const spy = spyOn(fsPromises, "open").mockImplementation(
      async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[0] !== partialFile()) return handle;
        const read = handle.read.bind(handle) as (
          ...a: unknown[]
        ) => ReturnType<typeof handle.read>;
        return Object.assign(handle, {
          // At most 7 bytes per read, as some network filesystems answer.
          read: (buffer: Buffer, offset: number, length: number, position: number) =>
            read(buffer, offset, Math.min(length, 7), position),
        });
      }
    );
    try {
      expect(await read()).toBeNull();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore(); // a module spy outlives the test otherwise
    }
  });

  test("the partial is read before the window: a commit between them serves no stale tail", async () => {
    await append(turns(2));
    expect((await historyService.writePartial(ID, owning())).success).toBe(true);
    const readWindow = historyService.getHistoryWindowFromLatestBoundary.bind(historyService);
    spyOn(historyService, "getHistoryWindowFromLatestBoundary").mockImplementation(
      async (...args) => {
        const window = await readWindow(...args);
        expect((await historyService.commitPartial(ID)).success).toBe(true);
        return window;
      }
    );
    expect(await read()).toBeNull();
  });

  test("a read during concurrent partial writes gives the old or the new state, never a throw", async () => {
    await append(turns(2));
    const owningWith = (i: number) =>
      msg("m1", "assistant", "text 1", { historySequence: 1 }, [
        { type: "text", text: `${i}` },
      ] as never);
    const writes = Promise.all(
      Array.from({ length: 20 }, (_, i) => historyService.writePartial(ID, owningWith(i)))
    );
    const reads = await Promise.all(Array.from({ length: 20 }, () => read()));
    await writes;
    // Before the first write lands the view shows; after it, the owning partial hides it.
    for (const tail of reads) expect(tail === null || tail.rows.length === 2).toBe(true);
    expect(await read()).toBeNull();
  });
});
