import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { HistoryService } from "./historyService";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { createTestHistoryService } from "./testHistoryService";
import { readWorkspaceViewTail, WORKSPACE_VIEW_TAIL_CAPS } from "./workspaceViewTail";

const ID = "view-tail-ws";
const INFO: FrontendWorkspaceMetadata = {
  ...{ id: ID, name: "seed", projectName: "demo-app", projectPath: "/p", namedWorkspacePath: "/p" },
  runtimeConfig: { type: "local" },
};
const STOP = { model: "anthropic:claude-sonnet-4-5", finishReason: "stop" } as const;
const { maxRows, maxBytes } = WORKSPACE_VIEW_TAIL_CAPS;

let historyService: HistoryService;
let cleanup: () => Promise<void>;
let streaming = false;
beforeEach(async () => {
  ({ historyService, cleanup } = await createTestHistoryService());
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
    expect(rows[2]).toEqual({ id: "a", role: "assistant", text: "direct", timestamp: 7, model });
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
