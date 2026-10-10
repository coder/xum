import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText, tool, type ModelMessage } from "ai";
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { checkRequest, Ledger, MAX_BODY_BYTES, MAX_OUTPUT_TOKENS, usageCost } from "./proxyPolicy";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const asset = (rel: string) => fs.readFileSync(path.join(import.meta.dir, "../../..", rel));
const screenshot = asset("src/browser/stories/assets/notion-mcp.png");
const icon = asset("public/icon-512.png");
const job = { models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] };

/** Runs one AI SDK call against a loopback server and returns the request it sent. */
async function capture(model: string, stream: boolean, maxOutputTokens?: number) {
  const seen: { rawHeaders: string[]; body: Uint8Array }[] = [];
  using server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // Bun gives no raw header list; Headers would join duplicates, and the SDK sends none.
      seen.push({ rawHeaders: [...req.headers].flat(), body: await req.bytes() });
      return new Response("{}", { status: 400 });
    },
  });
  const options = {
    model: createAnthropic({ baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "k" })(model),
    system: "You test a desktop app.",
    messages,
    tools: {
      click: tool({
        description: "Click an element by ref",
        inputSchema: z.object({ ref: z.string() }),
      }),
    },
    maxRetries: 0,
    maxOutputTokens,
    providerOptions: model === "claude-haiku-4-5" ? undefined : { anthropic: { effort: "low" } },
  };
  if (!stream) await generateText(options).catch(() => undefined);
  else for await (const _ of streamText({ ...options, onError: () => undefined }).fullStream);
  expect(seen).toHaveLength(1);
  return checkRequest(job, seen[0].rawHeaders, seen[0].body);
}

/** A screenshot in a user turn and an image inside a tool result, as the explorer sends them. */
const messages: ModelMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Describe both images in one short sentence." },
      { type: "file", data: screenshot, mediaType: "image/png" },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "toolu_01", toolName: "click", input: { ref: "e1" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "toolu_01",
        toolName: "click",
        output: {
          type: "content",
          value: [
            { type: "text", text: "clicked" },
            { type: "file", data: { type: "data", data: icon }, mediaType: "image/png" },
          ],
        },
      },
    ],
  },
];

const bodyOf = (result: ReturnType<typeof checkRequest>) => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return JSON.parse(result.body) as Record<string, unknown>;
};

/** Usage that the gateway reported on 2026-10-10 for these requests with maxOutputTokens 200. */
const recorded = {
  "claude-opus-5-5": { input_tokens: 866, output_tokens: 103, cache_read_input_tokens: 0 },
  "claude-sonnet-5-5": { input_tokens: 866, output_tokens: 57, cache_read_input_tokens: 0 },
  "claude-haiku-4-5": { input_tokens: 1057, output_tokens: 48, cache_read_input_tokens: 0 },
};

test.each(job.models)(
  "real AI SDK requests for %s pass, clamped, and bound the cost",
  async (model) => {
    for (const stream of [false, true]) {
      // The SDK sends the model maximum as max_tokens (128,000 or 64,000).
      const result = await capture(model, stream);
      expect(bodyOf(result).max_tokens).toBe(MAX_OUTPUT_TOKENS);
      expect(result.ok && result.headers).toEqual({
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "structured-outputs-2025-11-13",
      });
    }
    const result = await capture(model, false, 200);
    const cost = usageCost(model, recorded[model as keyof typeof recorded]);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThanOrEqual(result.ok ? result.maxCostNanoUsd : 0);
  }
);

const headers = ["content-type", "application/json", "anthropic-version", "2023-06-01"];
const minimal = {
  model: "claude-sonnet-5-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
};
const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const check = (body: unknown, raw = headers) => checkRequest(job, raw, encode(body));
const content = (...blocks: unknown[]) => ({
  ...minimal,
  messages: [{ role: "user", content: blocks }],
});
const image = (source: unknown) => ({ type: "image", source });
const png = { type: "base64", media_type: "image/png", data: icon.toString("base64") };
const beta = "structured-outputs-2025-11-13";

/** Each refused body, by the reason it must give. */
const refusedBodies: Record<string, unknown[]> = {
  "tools: type": [
    "web_search_20260209",
    "web_fetch_20250910",
    "code_execution_20250825",
    "bash_20250124",
  ].map((type) => ({ ...minimal, tools: [{ type, name: "t" }] })),
  "body: key": ["mcp_servers", "container", "service_tier", "speed", "new_feature"].map((key) => ({
    ...minimal,
    [key]: "x",
  })),
  "content: image source": [
    content(image({ type: "url", url: "https://x/a.png" })),
    content(image({ type: "file", file_id: "file_1" })),
    content({
      type: "tool_result",
      tool_use_id: "t",
      content: [image({ type: "url", url: "https://x" })],
    }),
  ],
  "content: image data": [content(image({ ...png, data: "not base64!" }))],
  "content: block type": [
    content({ type: "document", source: { type: "url", url: "https://x" } }),
    content({ type: "server_tool_use", id: "s", name: "web_search" }),
    content({ type: "tool_result", tool_use_id: "t", content: [{ type: "tool_result" }] }),
    { ...minimal, system: [{ type: "document", source: { type: "url", url: "https://x" } }] },
  ],
  "model: not allowed": [
    { ...minimal, model: "claude-fable-5-1" },
    { ...minimal, model: "constructor" },
  ],
  "max_tokens: not a positive integer": [{ ...minimal, max_tokens: undefined }],
  "thinking: budget_tokens does not fit": [
    {
      ...minimal,
      max_tokens: 64_000,
      thinking: { type: "enabled", budget_tokens: MAX_OUTPUT_TOKENS },
    },
  ],
};
test.each(
  Object.entries(refusedBodies).flatMap(([reason, bodies]) => bodies.map((body) => [reason, body]))
)("refuses with %s: %j", (reason, body) => {
  const result = check(body);
  expect(!result.ok && result.reason).toStartWith(reason);
});

/** Each refused raw header list, by the reason it must give. */
const refusedHeaders: [string, string[]][] = [
  ["header: anthropic-beta", [...headers, "anthropic-beta", `${beta},fast-mode-2026-02-01`]],
  [
    "header: anthropic-version",
    ["content-type", "application/json", "anthropic-version", "2023-01-01"],
  ],
  ["header: anthropic-version", ["content-type", "application/json"]],
  ["header: content-type", ["content-type", "text/plain", "anthropic-version", "2023-06-01"]],
  [
    "header: duplicate anthropic-beta",
    [...headers, "anthropic-beta", beta, "Anthropic-Beta", beta],
  ],
  ["header: duplicate anthropic-version", [...headers, "anthropic-version", "2023-06-01"]],
  ["header: duplicate content-length", [...headers, "content-length", "1", "content-length", "1"]],
  ["header: transfer-encoding", [...headers, "transfer-encoding", "gzip, chunked"]],
  [
    "header: transfer-encoding with",
    [...headers, "transfer-encoding", "chunked", "content-length", "9"],
  ],
  ["header: odd raw header list", [...headers, "x-dangling"]],
];
test.each(refusedHeaders)("refuses with %s: %j", (reason, raw) => {
  const result = check(minimal, raw);
  expect(!result.ok && result.reason).toStartWith(reason);
});

test("refuses a priced model that is not on the job's list (P3)", () => {
  const haikuOnly = { models: ["claude-haiku-4-5"] };
  expect(
    checkRequest(haikuOnly, headers, encode({ ...minimal, model: "claude-haiku-4-5" })).ok
  ).toBe(true);
  const result = checkRequest(haikuOnly, headers, encode(minimal)); // claude-sonnet-5-5
  expect(!result.ok && result.reason).toBe("model: not allowed");
});

test("forwards only the allowed headers, and passes thinking that fits and chunked bodies", () => {
  const raw = [
    ...headers,
    "x-api-key",
    "container-key",
    "Authorization",
    "x",
    "Transfer-Encoding",
    "chunked",
  ];
  const thinking = { type: "enabled", budget_tokens: 8000 };
  const result = check({ ...minimal, max_tokens: 64_000, thinking }, raw);
  expect(result.ok && result.headers).toEqual({
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });
  expect(bodyOf(result).max_tokens).toBe(MAX_OUTPUT_TOKENS);
  expect(check({ ...minimal, thinking: { type: "adaptive" } }).ok).toBe(true);
});

test("refuses bodies over the size limit and bodies that are not a JSON object", () => {
  const big = encode(content("x".repeat(MAX_BODY_BYTES - JSON.stringify(content("")).length + 1)));
  expect(big.byteLength).toBe(MAX_BODY_BYTES + 1);
  expect(checkRequest(job, headers, big)).toEqual({ ok: false, reason: "body: too large" });
  expect(checkRequest(job, headers, new Uint8Array([0x7b, 0xff, 0x7d])).ok).toBe(false);
  expect(checkRequest(job, headers, encode([minimal])).ok).toBe(false);
});

test("refuses a request whose input bound is above 200k tokens", () => {
  expect(check(content({ type: "text", text: "x".repeat(150_000) })).ok).toBe(true);
  expect(check(content({ type: "text", text: "x".repeat(200_000) })).ok).toBe(false);
  // Each image counts 2 x 4,784 tokens whatever its size, so 21 of them exceed 200k.
  expect(check(content(...Array.from({ length: 20 }, () => image(png)))).ok).toBe(true);
  expect(check(content(...Array.from({ length: 21 }, () => image(png)))).ok).toBe(false);
});

test("forwards its own serialization, so duplicate JSON keys cannot be read differently upstream", () => {
  const raw = `{"model":"claude-fable-5-1","model":"claude-sonnet-5-5","max_tokens":5,"messages":[]}`;
  const result = checkRequest(job, headers, new TextEncoder().encode(raw));
  expect(result.ok && result.body).toBe(
    `{"model":"claude-sonnet-5-5","max_tokens":5,"messages":[]}`
  );
});

test("ledger: a reservation that does not fit refuses, and keep counts it in full", () => {
  const ledger = new Ledger(0.01); // 10,000,000 nano-dollars
  const id = ledger.reserve("claude-haiku-4-5", 6_000_000)!;
  expect(ledger.reserve("claude-haiku-4-5", 5_000_000)).toBeUndefined();
  ledger.keep(id);
  expect(ledger.totals()).toMatchObject({
    spentNanoUsd: 6_000_000,
    reservedNanoUsd: 0,
    calls: 1,
    refused: 1,
  });
  expect(() => ledger.keep(id)).toThrow();
});

test("ledger: settle counts the usage cost, and unreadable usage keeps the reservation", () => {
  const ledger = new Ledger(1);
  const [a, b, c] = [50_000_000, 50_000_000, 1].map(
    (nanoUsd) => ledger.reserve("claude-opus-5-5", nanoUsd)!
  );
  const usage = {
    input_tokens: 1000,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 10_000,
    output_tokens: 50,
  };
  ledger.settle(a, usage);
  // 1000 x 4000 + 100 x 8000 + 10,000 x 200 + 50 x 20,000 nano-dollars
  expect(ledger.totals().spentNanoUsd).toBe(7_800_000);
  ledger.settle(b, { input_tokens: 5 }); // no output_tokens
  expect(ledger.totals()).toMatchObject({ spentNanoUsd: 57_800_000, boundExceeded: 0 });
  ledger.settle(c, { input_tokens: 1, output_tokens: 0 }); // costs 4,000, more than its bound
  expect(ledger.totals().boundExceeded).toBe(1);
  expect(ledger.totals().tokens["claude-opus-5-5"]).toEqual({
    input: 1001,
    cacheWrite: 100,
    cacheRead: 10_000,
    output: 50,
  });
});

test("ledger: concurrent reservations never exceed the cap", async () => {
  const ledger = new Ledger(1);
  const reserve = async () => (
    await Promise.resolve(),
    ledger.reserve("claude-sonnet-5-5", 30_000_000)
  );
  const ids = await Promise.all(Array.from({ length: 50 }, reserve));
  expect(ids.filter((id) => id !== undefined)).toHaveLength(33);
  const totals = ledger.totals();
  expect(totals.spentNanoUsd + totals.reservedNanoUsd).toBeLessThanOrEqual(totals.capNanoUsd);
});
