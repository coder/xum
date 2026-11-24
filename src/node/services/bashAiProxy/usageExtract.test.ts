import { describe, expect, test } from "bun:test";

import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";

import { UsageTap, extractUsageFromJson, type BashAiProxyProvider } from "./usageExtract";

function sse(events: unknown[]): string {
  return events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** Feeds `text` in awkward slices so lines and UTF-8 sequences split across chunks. */
function tapAll(provider: BashAiProxyProvider, contentType: string, text: string) {
  const tap = new UsageTap(provider, contentType);
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += 7) tap.push(bytes.subarray(i, i + 7));
  return tap.finish();
}

// The invariant that matters: after pricing, every token bucket matches the vendor's own count
// once (no cache token is counted as plain input, no reasoning token as plain output).
function priced(provider: BashAiProxyProvider, text: string, contentType: string) {
  const extracted = tapAll(provider, contentType, text);
  expect(extracted).toBeDefined();
  const display = createDisplayUsage(
    extracted!.usage,
    `${provider}:${extracted!.model ?? "unknown"}`,
    extracted!.providerMetadata
  )!;
  return {
    model: extracted!.model,
    input: display.input.tokens,
    cached: display.cached.tokens,
    cacheCreate: display.cacheCreate.tokens,
    output: display.output.tokens,
    reasoning: display.reasoning.tokens,
  };
}

describe("UsageTap", () => {
  test("Anthropic SSE combines message_start with the cumulative message_delta", () => {
    const text = sse([
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-5-5",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 300,
            output_tokens: 1,
          },
        },
      },
      { type: "content_block_delta", delta: { text: "héllo ✓" } },
      { type: "message_delta", usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ]);
    expect(priced("anthropic", text, "text/event-stream; charset=utf-8")).toEqual({
      model: "claude-sonnet-5-5",
      input: 100,
      cached: 2000,
      cacheCreate: 300,
      output: 42,
      reasoning: 0,
    });
  });

  test("OpenAI Responses SSE reads response.completed", () => {
    const text = sse([
      { type: "response.created", response: { model: "gpt-6.1", usage: null } },
      {
        type: "response.completed",
        response: {
          model: "gpt-6.1",
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 600 },
            output_tokens: 250,
            output_tokens_details: { reasoning_tokens: 200 },
          },
        },
      },
    ]);
    expect(priced("openai", text, "text/event-stream")).toEqual({
      model: "gpt-6.1",
      input: 400,
      cached: 600,
      cacheCreate: 0,
      output: 50,
      reasoning: 200,
    });
  });

  test("OpenAI Chat Completions SSE reads the final usage chunk", () => {
    const text =
      sse([
        { model: "gpt-6.1-mini", choices: [{ delta: { content: "hi" } }], usage: null },
        {
          model: "gpt-6.1-mini",
          choices: [],
          usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: {} },
        },
      ]) + "data: [DONE]\n\n";
    expect(priced("openai", text, "text/event-stream")).toEqual({
      model: "gpt-6.1-mini",
      input: 30,
      cached: 0,
      cacheCreate: 0,
      output: 5,
      reasoning: 0,
    });
  });

  test("a JSON Anthropic body is priced like the SSE form", () => {
    const body = JSON.stringify({
      type: "message",
      model: "claude-opus-5-5",
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
    });
    expect(priced("anthropic", body, "application/json")).toEqual({
      model: "claude-opus-5-5",
      input: 10,
      cached: 5,
      cacheCreate: 0,
      output: 7,
      reasoning: 0,
    });
  });

  test("bodies without usage report nothing", () => {
    expect(tapAll("anthropic", "text/html", "<html>bad gateway</html>")).toBeUndefined();
    expect(tapAll("openai", "application/json", JSON.stringify({ data: [] }))).toBeUndefined();
    expect(tapAll("openai", "text/event-stream", "data: [DONE]\n\n")).toBeUndefined();
  });

  test("a stream cut before message_delta still reports the input it saw", () => {
    const text = sse([
      {
        type: "message_start",
        message: { model: "claude-sonnet-5-5", usage: { input_tokens: 9, output_tokens: 1 } },
      },
    ]).slice(0, -1); // no trailing newline: the last line arrives at finish()
    expect(tapAll("anthropic", "text/event-stream", text)?.usage).toEqual({
      inputTokens: 9,
      cachedInputTokens: 0,
      outputTokens: 1,
    });
  });
});

describe("extractUsageFromJson", () => {
  test("passes an OpenAI service tier to pricing metadata", () => {
    const extracted = extractUsageFromJson("openai", {
      model: "gpt-6.1",
      service_tier: "flex",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(extracted?.providerMetadata).toEqual({ openai: { serviceTier: "flex" } });
  });
});
