/**
 * A loopback fake of Anthropic's Messages API for the bug-bash provider proxy (#5714): the proxy
 * tests, the sandbox self-check and the zero-cost dogfood run against it, so nothing is billed.
 * Every answer reports FAKE_USAGE. A marker in the request picks a misbehavior:
 * `[fake:redirect]` (a 307 to /redirected), `[fake:529]` (overloaded), `[fake:cut]` (the
 * connection drops before message_stop), `[fake:nostop]` (the stream ends cleanly without it), `[fake:hang]` (the stream starts and never ends), `[fake:slow]` (the stream pauses 300 ms after
 * message_start), `[fake:stall]`
 * (no answer at all), `[fake:overbill]` (a JSON answer whose usage exceeds any small bound), `[fake:huge]` (a stream above the proxy's response cap). Otherwise a
 * `stream: true` request gets a complete SSE stream and any other request a JSON message.
 * `mode` applies a misbehavior to requests without a marker (the proxy's probe sends none).
 * `[fake:cut]` on a JSON request sends the headers and part of the body, then drops.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_USAGE = {
  input_tokens: 1234,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 100,
  output_tokens: 56,
};

export interface FakeRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const sse = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export async function startFakeUpstream() {
  const requests: FakeRequest[] = [];
  const state: { mode?: string } = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const mode = /\[fake:(\w+)\]/.exec(body)?.[1] ?? state.mode;
      const parsed = JSON.parse(body || "{}") as { model?: string; stream?: boolean };
      const model = parsed.model ?? "claude-haiku-4-5";
      const headers = { "request-id": "req_fake", "x-fake-internal": "dropped by the proxy" };
      if (mode === "stall") return;
      if (mode === "redirect") return res.writeHead(307, { location: "/redirected" }).end();
      if (mode === "529") {
        const error = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
        return res
          .writeHead(529, { ...headers, "content-type": "application/json" })
          .end(JSON.stringify(error));
      }
      const message = { id: "msg_fake", type: "message", role: "assistant", model };
      if (parsed.stream !== true && mode === "cut") {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        return res.write('{"id":"msg_fake"', () => res.destroy());
      }
      if (parsed.stream !== true) {
        const reply = {
          ...message,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: mode === "overbill" ? { ...FAKE_USAGE, input_tokens: 1_000_000 } : FAKE_USAGE,
        };
        return res
          .writeHead(200, { ...headers, "content-type": "application/json" })
          .end(JSON.stringify(reply));
      }
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      res.write(
        sse("message_start", {
          message: { ...message, content: [], usage: { ...FAKE_USAGE, output_tokens: 1 } },
        })
      );
      if (mode === "hang") return;
      if (mode === "slow") return void setTimeout(() => finish(res, mode), 300);
      finish(res, mode);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setMode: (mode?: string) => (state.mode = mode),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function finish(res: http.ServerResponse, mode: string | undefined) {
  if (mode === "huge") {
    // SSE comment lines, which clients ignore, up to just above 32 MiB.
    const comment = `: ${"x".repeat(1024 * 1024 - 3)}\n`;
    for (let i = 0; i < 33; i++) res.write(comment);
  }
  res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
  res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }));
  res.write(sse("content_block_stop", { index: 0 }));
  res.write(
    sse("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: FAKE_USAGE.output_tokens },
    })
  );
  if (mode === "cut") return res.destroy();
  if (mode === "nostop") return res.end();
  res.end(sse("message_stop", {}));
}
