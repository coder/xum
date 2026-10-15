import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { HistoryService } from "./historyService";
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

const read = (info: FrontendWorkspaceMetadata | null = INFO) =>
  readWorkspaceViewTail(
    {
      workspaceService: { getInfo: () => Promise.resolve(info) },
      aiService: { isStreaming: () => streaming },
      historyService,
    },
    ID
  );
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
  test("shapes the rows for the static view", async () => {
    await append([msg("u0", "user", "Add a helper."), msg("a1", "assistant", "```ts\nx\n```")]);
    expect(await read()).toEqual({
      title: "seed",
      project: "demo-app",
      hasOlder: false,
      rows: [
        { id: "u0", role: "user", text: "Add a helper.", timestamp: 1, model: null },
        {
          id: "a1",
          role: "assistant",
          text: "```ts\nx\n```",
          timestamp: 1,
          model: { label: "Sonnet 4.5", provider: "anthropic" },
        },
      ],
    });
  });

  test("an unknown workspace returns null before any history read", async () => {
    const window = spyOn(historyService, "getHistoryWindowFromLatestBoundary");
    const partial = spyOn(historyService, "hasPartial");
    expect(await read(null)).toBeNull();
    expect(window).not.toHaveBeenCalled();
    expect(partial).not.toHaveBeenCalled();
  });

  test("a stream in flight or an interrupted partial gives no view", async () => {
    await append(turns(2));
    streaming = true;
    expect(await read()).toBeNull();
    streaming = false;
    const partial = msg("a2", "assistant", "half a repl");
    expect((await historyService.writePartial(ID, partial)).success).toBe(true);
    expect(await historyService.hasPartial(ID)).toBe(true);
    expect(await read()).toBeNull();
    expect((await historyService.deletePartial(ID)).success).toBe(true);
    expect(await historyService.hasPartial(ID)).toBe(false);
    expect(await read()).not.toBeNull();
  });

  test("keeps within the row cap, newest last; one row over the byte cap gives no view", async () => {
    await append(turns(maxRows + 1));
    const tail = (await read())!;
    expect(tail.rows.length).toBeLessThanOrEqual(maxRows);
    expect([tail.hasOlder, tail.rows.at(-1)?.id]).toEqual([true, `m${maxRows}`]);
    await append([msg("big", "user", "y".repeat(maxBytes + 1))]);
    expect(await read()).toBeNull();
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
      msg("routed", "assistant", "via a gateway", { routeProvider: "mux-gateway" }),
      msg("last", "assistant", "fine"),
    ]);
    const texts = Object.fromEntries((await read())!.rows.map((row) => [row.id, row.text]));
    expect(texts).toEqual({
      plain: "hi",
      ...{ tool: null, reasoning: null, synthetic: null, command: null, cut: null, routed: null },
      last: "fine",
    });
  });
});
