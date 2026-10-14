/**
 * Stream error recovery ("no amnesia") integration test.
 *
 * When a provider stream fails mid-response, the text streamed so far must survive
 * the error and be sent back to the provider on resume, so the model continues
 * instead of starting over. This drives the real IPC → AgentSession → StreamManager
 * → provider path against a loopback Anthropic Messages fixture: the first request
 * streams numbered markers and then drops the connection, which exercises
 * StreamManager's genuine failure handling (no debug hooks). The resumed request is
 * captured to prove the pre-error text was replayed, and history is read back to
 * prove the final message keeps the prefix and appends the continuation.
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { setupProviders, setupWorkspaceWithoutProvider, shouldRunIntegrationTests } from "../setup";
import { createStreamCollector, readChatHistory, resolveOrpcClient } from "../helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const MODEL = "anthropic:claude-haiku-4-5";
const EVENT_TIMEOUT_MS = 30_000;
const PREFIX_MARKERS = 5;
const NONCE = "sr7q2";

function marker(n: number): string {
  return `${NONCE}-${n}: line ${n}\n`;
}

const PREFIX_TEXT = Array.from({ length: PREFIX_MARKERS }, (_, i) => marker(i + 1)).join("");
const CONTINUATION_TEXT = marker(PREFIX_MARKERS + 1) + marker(PREFIX_MARKERS + 2);

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
}

function textBlock(texts: string[]): string {
  return (
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    texts
      .map((text) =>
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })
      )
      .join("")
  );
}

function messageEnd(): string {
  return (
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 20 },
    }) +
    sseEvent("message_stop", { type: "message_stop" })
  );
}

interface CapturedRequest {
  messages: { role: string; content: unknown }[];
}

/**
 * Loopback Anthropic Messages endpoint. The first request streams the prefix and then
 * destroys the socket mid-response; every later request streams the continuation.
 */
async function startDroppingFixture() {
  const requests: CapturedRequest[] = [];
  let firstResponse: http.ServerResponse | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        res.write(messageStart() + textBlock(PREFIX_TEXT.match(/[^\n]*\n/g) ?? []));
        // Held open until the test has observed every prefix delta; see dropFirstResponse.
        firstResponse = res;
        return;
      }
      res.end(messageStart() + textBlock([CONTINUATION_TEXT]) + messageEnd());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    /** Fails the first stream mid-response by destroying its socket. */
    dropFirstResponse: () => {
      if (!firstResponse) throw new Error("first provider request has not arrived yet");
      firstResponse.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : ""
    )
    .join("");
}

describeIntegration("Stream Error Recovery (No Amnesia)", () => {
  test("replays the pre-error text on resume and keeps it in the final message", async () => {
    const fixture = await startDroppingFixture();
    try {
      // No-provider setup clears inherited Anthropic env auth/base URL; the fixture is the only route.
      const { env, workspaceId, cleanup } = await setupWorkspaceWithoutProvider("stream-recovery");
      try {
        await setupProviders(env, {
          anthropic: { apiKey: "fixture-key", baseUrl: fixture.baseUrl },
        });
        const client = resolveOrpcClient(env);
        const toolPolicy = [{ regex_match: ".*", action: "disable" as const }];

        const collector = createStreamCollector(env.orpc, workspaceId);
        collector.start();
        try {
          await collector.waitForSubscription(5_000);
          const sendResult = await client.workspace.sendMessage({
            workspaceId,
            message: "Count with numbered markers.",
            options: { model: MODEL, thinkingLevel: "off", agentId: "exec", toolPolicy },
          });
          expect(sendResult.success).toBe(true);

          // Fail the stream only after the backend has delivered every prefix delta, so the
          // error path has the whole prefix to persist (no grace timer).
          const lastPrefixMarker = `${NONCE}-${PREFIX_MARKERS}:`;
          const deadline = Date.now() + EVENT_TIMEOUT_MS;
          while (!collector.getStreamContent().includes(lastPrefixMarker)) {
            if (Date.now() > deadline) throw new Error("prefix deltas never arrived");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          fixture.dropFirstResponse();

          const terminal = await Promise.race([
            collector.waitForEvent("stream-end", EVENT_TIMEOUT_MS),
            collector.waitForEvent("stream-error", EVENT_TIMEOUT_MS),
          ]);
          expect(terminal?.type).toBe("stream-error");
        } finally {
          collector.stop();
        }

        const resumeCollector = createStreamCollector(env.orpc, workspaceId);
        resumeCollector.start();
        try {
          // Finish replay first so the earlier stream-error is not read as the resume outcome.
          await resumeCollector.waitForSubscription(5_000);
          resumeCollector.clear();
          const resumeResult = await client.workspace.resumeStream({
            workspaceId,
            options: { model: MODEL, agentId: "exec", toolPolicy },
          });
          expect(resumeResult.success).toBe(true);
          expect(await resumeCollector.waitForEvent("stream-end", EVENT_TIMEOUT_MS)).not.toBeNull();
          expect(resumeCollector.hasError()).toBe(false);
        } finally {
          resumeCollector.stop();
        }

        // The resumed provider request carries the interrupted assistant text.
        expect(fixture.requests.length).toBeGreaterThanOrEqual(2);
        const resumed = fixture.requests.at(-1)!;
        const replayedAssistantText = resumed.messages
          .filter((message) => message.role === "assistant")
          .map((message) => textOf(message.content))
          .join("");
        expect(replayedAssistantText).toContain(PREFIX_TEXT.trim());

        // History keeps the prefix and appends the continuation.
        const history = await readChatHistory(env.tempDir, workspaceId);
        const finalText = history
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text")
          .map((part) => (part as { text?: string }).text ?? "")
          .join("");
        expect(finalText.startsWith(PREFIX_TEXT.trim())).toBe(true);
        expect(finalText).toContain(`${NONCE}-${PREFIX_MARKERS + 1}`);
      } finally {
        await cleanup();
      }
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
