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

function scope(events: TimelineEventDraft[], skip = false): PromptCacheTurnScope {
  const recorder = {
    record: (_workspaceId: string, draft: TimelineEventDraft) => void events.push(draft),
    closeWorkspace: () => Promise.resolve(),
    reopenWorkspace: () => undefined,
  };
  return { workspaceId: "ws-1", recorder, skip };
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

/** Sends each request through its own wrapped fetch, like the requests of one workspace. */
async function send(
  monitor: PromptCachePrefixMonitor,
  requests: Array<{
    scope: PromptCacheTurnScope;
    body: string;
    identity?: PromptCacheRouteIdentity;
  }>
): Promise<void> {
  for (const request of requests) {
    const fetchImpl = wrapFetchWithAnthropicCacheControl(
      Object.assign(() => Promise.resolve(new Response("{}")), fetch) as typeof fetch,
      null,
      { observeFinalBody: (b) => monitor.observe(request.scope, request.identity ?? ANTHROPIC, b) }
    );
    await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: request.body,
    });
  }
}

describe("PromptCachePrefixMonitor through the Anthropic wire wrapper", () => {
  test("records one content-free event when the next turn truncates a tool result", async () => {
    const events: TimelineEventDraft[] = [];
    await send(new PromptCachePrefixMonitor(), [
      { scope: scope(events), body: requestBody(SECRET_OUTPUT) },
      { scope: scope(events), body: requestBody(SECRET_OUTPUT.slice(0, 12_000)) },
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
          blockIndex: 4,
          previousBlockCount: 5,
          nextBlockCount: 5,
          previous: { role: "user", type: "tool_result", toolName: "read_file" },
          next: { role: "user", type: "tool_result", toolName: "read_file" },
        },
      },
    });
    expect(JSON.stringify(events[0])).not.toMatch(/SECRET|README/);
  });

  test("an extending step, a compaction request and a route change record nothing", async () => {
    const events: TimelineEventDraft[] = [];
    const turn = scope(events);
    const nextStep = [{ role: "assistant", content: [{ type: "text", text: "Done." }] }];
    await send(new PromptCachePrefixMonitor(), [
      { scope: turn, body: requestBody("short") },
      { scope: turn, body: requestBody("short", nextStep) },
      // Compaction sends another prompt and drops the baseline, so the first
      // post-compaction request has nothing to compare with.
      { scope: scope(events, true), body: requestBody("compaction prompt") },
      { scope: scope(events), body: requestBody("summary") },
      {
        scope: scope(events),
        body: requestBody("other model"),
        identity: { route: "mux-gateway", modelString: "mux-gateway:anthropic/claude-opus-5-5" },
      },
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
