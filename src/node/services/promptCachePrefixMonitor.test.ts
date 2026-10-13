import { describe, expect, test } from "bun:test";
import { TimelineEventDraftSchema, type TimelineEventDraft } from "@/common/orpc/schemas/timeline";
import { wrapFetchWithAnthropicCacheControl } from "./providerModelFactory";
import {
  PromptCachePrefixMonitor,
  type PromptCacheRouteIdentity,
  type PromptCacheTurnScope,
} from "./promptCachePrefixMonitor";

const SECRET_OUTPUT = "SECRET-FILE-CONTENTS ".repeat(800);
const ANTHROPIC = { route: "anthropic", modelString: "anthropic:claude-sonnet-5-5" };

function recorderFor(events: TimelineEventDraft[]) {
  return {
    record: (_workspaceId: string, draft: TimelineEventDraft) => void events.push(draft),
    closeWorkspace: () => Promise.resolve(),
    reopenWorkspace: () => undefined,
  };
}

function requestBody(toolOutput: string, extraMessages: unknown[] = []): string {
  return JSON.stringify({
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
    system: [{ type: "text", text: "You are Xum." }],
    messages: [
      { role: "user", content: "Read README.md" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "README.md" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: toolOutput }] },
      ...extraMessages,
    ],
  });
}

interface SentRequest {
  scope: PromptCacheTurnScope;
  body: string;
  identity?: PromptCacheRouteIdentity;
  /** "reject": the dispatch fails before reaching Anthropic (auth refresh, connection error). */
  outcome?: "reject" | 529;
  /** False when prompt caching is off (disableBetaFeatures): markers are stripped. */
  injectCacheControl?: boolean;
  /** The TTL the wire wrapper writes into the cache markers. */
  cacheTtl?: "1h";
}

/** Sends each request through its own wrapped fetch, like the requests of one workspace. */
async function send(monitor: PromptCachePrefixMonitor, requests: SentRequest[]): Promise<void> {
  for (const request of requests) {
    const baseFetch = () =>
      request.outcome === "reject"
        ? Promise.reject(new Error("connect ECONNREFUSED"))
        : Promise.resolve(new Response("{}", { status: request.outcome ?? 200 }));
    const fetchImpl = wrapFetchWithAnthropicCacheControl(
      Object.assign(baseFetch, fetch) as typeof fetch,
      request.cacheTtl ?? null,
      {
        injectCacheControl: request.injectCacheControl ?? true,
        observeFinalBody: (b) => monitor.observe(request.scope, request.identity ?? ANTHROPIC, b),
      }
    );
    const sent = fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: request.body,
    });
    const outcome = await sent.then(
      () => "sent",
      (error: unknown) => (error instanceof Error ? error.message : "rejected")
    );
    expect(outcome).toBe(request.outcome === "reject" ? "connect ECONNREFUSED" : "sent");
  }
}

describe("PromptCachePrefixMonitor through the Anthropic wire wrapper", () => {
  test("records one content-free event when the next turn truncates a tool result", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    await send(monitor, [
      { scope: scope(), body: requestBody(SECRET_OUTPUT) },
      { scope: scope(), body: requestBody(SECRET_OUTPUT.slice(0, 12_000)) },
    ]);

    expect(events).toHaveLength(1);
    expect(TimelineEventDraftSchema.safeParse(events[0]).success).toBe(true);
    expect(events[0]).toMatchObject({
      kind: "cache.prefix_break",
      source: { system: "chat" },
      data: {
        model: ANTHROPIC.modelString,
        promptCacheBreak: {
          section: "messages",
          boundary: "turn",
          // 1 tool, the system sentinel, 1 system block, the messages sentinel, 3 message blocks.
          blockIndex: 6,
          previousBlockCount: 7,
          nextBlockCount: 7,
          previous: { role: "user", type: "tool_result", toolName: "read_file" },
          next: { role: "user", type: "tool_result", toolName: "read_file" },
        },
      },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/SECRET|README/);
  });

  test("an extending step, a compaction request and a route change record nothing", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    const turn = scope();
    const compaction = scope();
    compaction.markCompaction();
    const nextStep = [{ role: "assistant", content: [{ type: "text", text: "Done." }] }];
    await send(monitor, [
      { scope: turn, body: requestBody("short") },
      { scope: turn, body: requestBody("short", nextStep) },
      // Compaction sends another prompt and drops the baseline, so the first
      // post-compaction request has nothing to compare with.
      { scope: compaction, body: requestBody("compaction prompt") },
      { scope: scope(), body: requestBody("summary") },
      {
        scope: scope(),
        body: requestBody("other model"),
        identity: { route: "coder:anthropic", modelString: "coder:anthropic/claude-opus-5-5" },
      },
    ]);
    expect(events).toEqual([]);
  });

  test("a compaction on another provider still clears the Anthropic baseline", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    await send(monitor, [{ scope: scope(), body: requestBody("before compaction") }]);
    // An OpenAI compaction sends no Anthropic request, so nothing is observed.
    scope().markCompaction();
    await send(monitor, [{ scope: scope(), body: requestBody("summary") }]);
    expect(events).toEqual([]);
  });

  test("a new context or an expired cache entry starts a new baseline without an event", async () => {
    const events: TimelineEventDraft[] = [];
    let now = 0;
    const monitor = new PromptCachePrefixMonitor(() => now);
    const scope = (epoch: string) => {
      const turn = monitor.createTurnScope("ws-1", recorderFor(events));
      turn.setContextEpoch(epoch);
      return turn;
    };
    // `/clear` or "start here": the next turn is built from another first row.
    await send(monitor, [
      { scope: scope("row-1"), body: requestBody(SECRET_OUTPUT) },
      { scope: scope("row-9"), body: requestBody("cleared") },
    ]);
    expect(events).toEqual([]);
    // Past the 5-minute TTL the old entry is gone: a later difference is expiry, not a break.
    now = 6 * 60 * 1000;
    await send(monitor, [{ scope: scope("row-9"), body: requestBody("changed after expiry") }]);
    expect(events).toEqual([]);
    // Within the TTL and in the same context, the same difference is still reported.
    now += 60 * 1000;
    await send(monitor, [{ scope: scope("row-9"), body: requestBody("changed again") }]);
    expect(events).toHaveLength(1);
  });

  test("the TTL comes from cache markers, not from a ttl field in a tool schema", async () => {
    const events: TimelineEventDraft[] = [];
    let now = 0;
    const monitor = new PromptCachePrefixMonitor(() => now);
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    const withSchemaTtl = (toolOutput: string) => {
      const parsed = JSON.parse(requestBody(toolOutput)) as {
        tools: Array<Record<string, unknown>>;
      };
      parsed.tools[0].input_schema = {
        type: "object",
        properties: { retention: { type: "object", default: { ttl: "1h" } } },
      };
      return JSON.stringify(parsed);
    };
    // The markers keep the 5-minute default, so 6 minutes later the entry has expired.
    await send(monitor, [{ scope: scope(), body: withSchemaTtl(SECRET_OUTPUT) }]);
    now = 6 * 60 * 1000;
    await send(monitor, [{ scope: scope(), body: withSchemaTtl("changed after expiry") }]);
    expect(events).toEqual([]);
    // A real 1h marker keeps the entry: the same gap still reports the difference.
    const hourMonitor = new PromptCachePrefixMonitor(() => now);
    const hourScope = () => hourMonitor.createTurnScope("ws-1", recorderFor(events));
    await send(hourMonitor, [
      { scope: hourScope(), body: requestBody(SECRET_OUTPUT), cacheTtl: "1h" },
    ]);
    now += 6 * 60 * 1000;
    await send(hourMonitor, [{ scope: hourScope(), body: requestBody("changed"), cacheTtl: "1h" }]);
    expect(events).toHaveLength(1);
  });

  test("a context-editing request records nothing and replaces the baseline", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    const editing = (toolOutput: string) =>
      JSON.stringify({
        ...(JSON.parse(requestBody(toolOutput)) as object),
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      });
    await send(monitor, [
      { scope: scope(), body: requestBody(SECRET_OUTPUT) },
      { scope: scope(), body: editing("cleared by the server") },
      // Compared with the editing request, not with the first one.
      { scope: scope(), body: requestBody("after editing") },
    ]);
    expect(events).toEqual([]);
    // The baseline is a supported request again, so a difference is reported.
    await send(monitor, [{ scope: scope(), body: requestBody("changed") }]);
    expect(events).toHaveLength(1);
  });

  test("each route and model keeps its own baseline; a compaction clears all of them", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    const opus = { route: "anthropic", modelString: "anthropic:claude-opus-5-5" };
    // Sonnet -> Opus -> Sonnet: the second Sonnet request compares with the first.
    await send(monitor, [
      { scope: scope(), body: requestBody(SECRET_OUTPUT) },
      { scope: scope(), body: requestBody("opus"), identity: opus },
      { scope: scope(), body: requestBody("changed") },
    ]);
    expect(events).toMatchObject([{ data: { model: ANTHROPIC.modelString } }]);
    // A compaction replaced the history every identity holds: neither reports afterwards.
    scope().markCompaction();
    await send(monitor, [
      { scope: scope(), body: requestBody("summary") },
      { scope: scope(), body: requestBody("summary on opus"), identity: opus },
    ]);
    expect(events).toHaveLength(1);
  });

  test("a rejected or refused dispatch records nothing and keeps the baseline", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    const baseline = requestBody(SECRET_OUTPUT);
    await send(monitor, [
      { scope: scope(), body: baseline },
      { scope: scope(), body: requestBody("never sent"), outcome: "reject" },
      { scope: scope(), body: requestBody("overloaded"), outcome: 529 },
      // Extends the baseline; it would break against the rejected body.
      { scope: scope(), body: baseline },
    ]);
    expect(events).toEqual([]);
  });

  test("with prompt caching off, requests are not observed", async () => {
    const events: TimelineEventDraft[] = [];
    const monitor = new PromptCachePrefixMonitor();
    const scope = () => monitor.createTurnScope("ws-1", recorderFor(events));
    await send(monitor, [
      { scope: scope(), body: requestBody(SECRET_OUTPUT), injectCacheControl: false },
      { scope: scope(), body: requestBody("rewritten"), injectCacheControl: false },
    ]);
    expect(events).toEqual([]);
  });

  test("a failing detector still sends the cache-marked body", async () => {
    let sentBody: unknown;
    const baseFetch = (_input: unknown, init?: RequestInit) => {
      sentBody = init?.body;
      return Promise.resolve(new Response("ok"));
    };
    const fetchImpl = wrapFetchWithAnthropicCacheControl(
      Object.assign(baseFetch, fetch) as typeof fetch,
      null,
      {
        observeFinalBody: () => {
          throw new Error("detector bug");
        },
      }
    );
    await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: requestBody("x"),
    });
    expect(String(sentBody)).toContain("cache_control");
  });
});
