/**
 * Integration test: Compaction 1M context retry.
 *
 * When a /compact request overflows the default context of a model that needs
 * Anthropic's 1M *beta* (not native 1M), the backend retries exactly once with the
 * `anthropic-beta: context-1m-*` header. This drives the real IPC → AgentSession →
 * provider path against a loopback Anthropic Messages fixture, so it proves the retry
 * branch deterministically without a live key or spend. It does not prove Anthropic's
 * real token limits: the fixture answers by header, not by prompt size.
 *
 * The sibling live test (compaction1MRetry.integration.test.ts) pins claude-sonnet-4-6,
 * which has been native 1M since #2970, so it shows a large native request is accepted
 * but never reaches this retry branch (#4398). This file covers the branch itself.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { setupProviders, setupWorkspaceWithoutProvider, shouldRunIntegrationTests } from "./setup";
import { createStreamCollector, resolveOrpcClient } from "./helpers";
import { HistoryService } from "../../src/node/services/historyService";
import { createMuxMessage } from "../../src/common/types/message";
import { hasNative1MContext, supports1MContext } from "../../src/common/utils/ai/models";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

/** Beta-1M model: overflow triggers the retry (native-1M models never retry). */
const BETA_1M_MODEL = "anthropic:claude-sonnet-4-5";
const EVENT_TIMEOUT_MS = 60_000;
/**
 * Anthropic's documented 1M-context beta value, written out rather than imported from
 * production so a stale or mistyped product constant cannot validate itself here.
 */
const ANTHROPIC_1M_BETA = "context-1m-2025-08-07";

/** What the fixture returns for a request that carries the 1M beta header. */
type RetryResponse = "success" | "refusal" | "overflow";

function sse(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

function messageStream(stopReason: "end_turn" | "refusal"): string {
  return sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
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
        delta: {
          type: "text_delta",
          text: stopReason === "refusal" ? "" : "Summary of the conversation.",
        },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 8 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

const OVERFLOW_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "prompt is too long: 262144 tokens > 200000 maximum",
  },
});

/**
 * Loopback Anthropic Messages endpoint. It answers by the 1M beta header, not by
 * request order: without the header every request overflows.
 */
async function startAnthropicFixture(retryResponse: RetryResponse) {
  const requests: Array<{ has1MHeader: boolean }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) {
        res.writeHead(404).end();
        return;
      }
      const has1MHeader = String(req.headers["anthropic-beta"] ?? "").includes(ANTHROPIC_1M_BETA);
      requests.push({ has1MHeader });
      if (!has1MHeader || retryResponse === "overflow") {
        res.writeHead(400, { "content-type": "application/json" }).end(OVERFLOW_BODY);
        return;
      }
      res
        .writeHead(200, { "content-type": "text/event-stream" })
        .end(messageStream(retryResponse === "refusal" ? "refusal" : "end_turn"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runCompaction(retryResponse: RetryResponse) {
  const fixture = await startAnthropicFixture(retryResponse);
  try {
    // No-provider setup clears inherited Anthropic env auth/base URL; the fixture is the only route.
    const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("compact1m");
    try {
      await setupProviders(env, { anthropic: { apiKey: "fixture-key", baseUrl: fixture.baseUrl } });
      const historyService = new HistoryService(env.config);
      for (let i = 0; i < 3; i++) {
        for (const role of ["user", "assistant"] as const) {
          const result = await historyService.appendToHistory(
            workspaceId,
            createMuxMessage(
              `seed-${role}-${i}`,
              role,
              `Seed ${role} message ${i} about the deploy plan.`,
              {}
            )
          );
          expect(result.success).toBe(true);
        }
      }

      // Record each provider attempt's 1M intent (pass-through) as supporting evidence.
      const attempts1M: boolean[] = [];
      const aiService = env.services.aiService;
      const realStreamMessage = aiService.streamMessage.bind(aiService);
      const streamSpy = jest
        .spyOn(aiService, "streamMessage")
        .mockImplementation((opts, prepared) => {
          if (opts.workspaceId === workspaceId) {
            attempts1M.push(opts.muxProviderOptions?.anthropic?.use1MContext === true);
          }
          return realStreamMessage(opts, prepared);
        });

      const collector = createStreamCollector(env.orpc, workspaceId);
      collector.start();
      let terminal: Awaited<ReturnType<typeof collector.waitForEvent>> = null;
      try {
        await collector.waitForSubscription(5_000);
        const sendResult = await resolveOrpcClient(env).workspace.sendMessage({
          workspaceId,
          message: "Please provide a detailed summary of this conversation.",
          options: {
            model: BETA_1M_MODEL,
            thinkingLevel: "off",
            agentId: "compact",
            // No providerOptions.anthropic.use1MContext here — the retry must inject it.
            toolPolicy: [{ regex_match: ".*", action: "disable" }],
            muxMetadata: { type: "compaction-request", rawCommand: "/compact", parsed: {} },
          },
        });
        expect(sendResult.success).toBe(true);
        // Observed: the recoverable first overflow is not published to subscribers, so the
        // first end/error is this compaction's outcome. Extra provider work after it is
        // caught by the request trace, which callers read after cleanup.
        terminal = await Promise.race([
          collector.waitForEvent("stream-end", EVENT_TIMEOUT_MS),
          collector.waitForEvent("stream-error", EVENT_TIMEOUT_MS),
        ]);
      } finally {
        await collector.waitForStop();
        streamSpy.mockRestore();
      }
      // Callers read the request trace after cleanup, so a late extra request is still recorded.
      return { terminal, requests: fixture.requests, attempts1M };
    } finally {
      await cleanup();
    }
  } finally {
    await fixture.close();
  }
}

describeIntegration("compaction 1M context retry (loopback fixture)", () => {
  test("pins a beta-1M model so the retry branch is reachable", () => {
    expect(supports1MContext(BETA_1M_MODEL)).toBe(true);
    expect(hasNative1MContext(BETA_1M_MODEL)).toBe(false);
  });

  test("retries an overflowing compaction exactly once with the 1M beta header", async () => {
    const run = await runCompaction("success");
    expect(run.terminal?.type).toBe("stream-end");
    expect(run.requests.map((r) => r.has1MHeader)).toEqual([false, true]);
    expect(run.attempts1M).toEqual([false, true]);
  }, 120_000);

  test.each([
    ["refusal", "model_refusal"],
    ["overflow", "context_exceeded"],
  ] as const)(
    "fails terminally without a second retry when the 1M retry returns %s",
    async (retryResponse, errorType) => {
      const run = await runCompaction(retryResponse);
      expect(run.terminal).toMatchObject({ type: "stream-error", errorType });
      expect(run.requests.map((r) => r.has1MHeader)).toEqual([false, true]);
      expect(run.attempts1M).toEqual([false, true]);
    },
    120_000
  );
});
