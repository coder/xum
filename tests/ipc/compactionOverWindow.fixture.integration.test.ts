/**
 * Integration test (#2359): a /compact whose own history is larger than the model's context
 * window still succeeds on a model that cannot switch to 1M context.
 *
 * The reporter saw "compaction suggested, compaction fails" because the compaction request sent
 * the whole over-window history. This drives the real IPC → AgentSession → provider path against
 * a loopback Anthropic Messages fixture that refuses, like the real API, any request whose body
 * is larger than the model's window. trimCompactionInput must fit the first attempt into the
 * window, so it succeeds without the context_exceeded retry. No live key and no spend.
 * The 1M-retry branch is covered by compaction1MRetry.fixture.integration.test.ts.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { setupProviders, setupWorkspaceWithoutProvider, shouldRunIntegrationTests } from "./setup";
import { createStreamCollector, resolveOrpcClient } from "./helpers";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";
import { getAnthropic1MContextMode, supports1MContext } from "../../src/common/utils/ai/models";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** A model with a 200k window and no 1M switch, so only the input trim can help. */
const MODEL = "anthropic:claude-haiku-4-5";
const WINDOW_TOKENS = 200_000;
/**
 * The fixture's stand-in for "prompt is too long": a body larger than the window at about four
 * characters per token. The seeded history is about 2.4 MB, three times this.
 */
const OVERFLOW_BODY_BYTES = WINDOW_TOKENS * 4;
const EVENT_TIMEOUT_MS = 60_000;

const WORDS = [
  "deploy",
  "rollback",
  "service",
  "latency",
  "budget",
  "cache",
  "queue",
  "worker",
  "region",
  "replica",
  "migration",
  "schema",
  "index",
  "timeout",
  "retry",
  "metric",
  "alert",
  "shard",
];

/** About `chars` characters of varied prose, so the tokenizer sees ordinary text. */
function prose(seed: number, chars: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const word = `${WORDS[(seed * 7 + i * 13) % WORDS.length]}${(seed + i) % 97}`;
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ");
}

function sse(events: [string, unknown][]): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const SUMMARY_STREAM = sse([
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 1 },
      },
    },
  ],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Summary of the conversation." },
    },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]);

const OVERFLOW_RESPONSE = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "prompt is too long: 600000 tokens > 200000 maximum",
  },
});

/** Loopback Anthropic Messages endpoint that refuses a body larger than the window. */
async function startAnthropicFixture() {
  const bodyBytes: number[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) {
        res.writeHead(404).end();
        return;
      }
      const size = Buffer.concat(chunks).length;
      bodyBytes.push(size);
      if (size > OVERFLOW_BODY_BYTES) {
        res.writeHead(400, { "content-type": "application/json" }).end(OVERFLOW_RESPONSE);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(SUMMARY_STREAM);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodyBytes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describeIntegration("compaction of an over-window history (loopback fixture, #2359)", () => {
  test("pins a model that cannot switch to 1M context", () => {
    expect(supports1MContext(MODEL)).toBe(false);
    expect(getAnthropic1MContextMode(MODEL)).toBe("none");
  });

  test("trims the first attempt into the window and completes without a retry", async () => {
    const fixture = await startAnthropicFixture();
    try {
      const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("compactover");
      try {
        await setupProviders(env, {
          anthropic: { apiKey: "fixture-key", baseUrl: fixture.baseUrl },
        });
        const historyService = new HistoryService(env.config);
        let historyBytes = 0;
        for (let i = 0; i < 60; i++) {
          for (const role of ["user", "assistant"] as const) {
            const text = role === "user" ? `Step ${i}: ${prose(i, 400)}` : prose(i + 1000, 40_000);
            historyBytes += text.length;
            const appended = await historyService.appendToHistory(
              workspaceId,
              createMuxMessage(`seed-${role}-${i}`, role, text, {})
            );
            expect(appended.success).toBe(true);
          }
        }
        expect(historyBytes).toBeGreaterThan(3 * OVERFLOW_BODY_BYTES);

        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        let terminal: Awaited<ReturnType<typeof collector.waitForEvent>> = null;
        try {
          await collector.waitForSubscription(5_000);
          const sent = await resolveOrpcClient(env).workspace.sendMessage({
            workspaceId,
            message: "Please provide a detailed summary of this conversation.",
            options: {
              model: MODEL,
              thinkingLevel: "off",
              agentId: "compact",
              toolPolicy: [{ regex_match: ".*", action: "disable" }],
              muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
            },
          });
          expect(sent.success).toBe(true);
          terminal = await Promise.race([
            collector.waitForEvent("stream-end", EVENT_TIMEOUT_MS),
            collector.waitForEvent("stream-error", EVENT_TIMEOUT_MS),
          ]);
        } finally {
          await collector.waitForStop();
        }

        expect(terminal?.type).toBe("stream-end");
        // One request, already inside the window: the trim fit it, no retry was needed.
        expect(fixture.bodyBytes).toHaveLength(1);
        expect(fixture.bodyBytes[0]).toBeLessThanOrEqual(OVERFLOW_BODY_BYTES);
      } finally {
        await cleanup();
      }
    } finally {
      await fixture.close();
    }
  }, 120_000);
});
