/**
 * Reads token usage out of provider responses that the bash AI proxy forwards.
 *
 * The proxy sees raw wire responses (not AI SDK results), so this module maps each vendor's
 * usage block to the flat AI SDK v6 shape that `createDisplayUsage` prices: `inputTokens`
 * INCLUDES cache reads and cache writes, `outputTokens` INCLUDES reasoning. Cache writes travel
 * in `providerMetadata.anthropic.cacheCreationInputTokens`, as for chat streams.
 *
 * Supported shapes (JSON bodies and SSE streams):
 * - Anthropic Messages: `usage` on the message; SSE gives it in `message_start` and the
 *   cumulative totals in `message_delta`.
 * - OpenAI Responses: `usage` on the response; SSE gives it in `response.completed`
 *   (also `response.incomplete` / `response.failed`).
 * - OpenAI Chat Completions: `usage` on the body or on the last SSE chunk (the proxy forces
 *   `stream_options.include_usage` so streams carry it).
 */
import assert from "node:assert/strict";

import type { AiSdkUsageLike } from "@/common/utils/tokens/usageHelpers";

export type BashAiProxyProvider = "anthropic" | "openai";

export interface ExtractedUsage {
  /** Model id as the provider reported it, without the provider prefix. */
  model: string | undefined;
  usage: AiSdkUsageLike;
  providerMetadata?: Record<string, unknown>;
}

/** A JSON body larger than this is forwarded but not parsed for usage (logged as uncounted). */
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function anthropicUsage(raw: JsonRecord, model: string | undefined): ExtractedUsage {
  const input = num(raw.input_tokens) ?? 0;
  const cacheRead = num(raw.cache_read_input_tokens) ?? 0;
  const cacheWrite = num(raw.cache_creation_input_tokens) ?? 0;
  return {
    model,
    // Anthropic's input_tokens excludes both cache buckets; the v6 shape includes them.
    usage: {
      inputTokens: input + cacheRead + cacheWrite,
      cachedInputTokens: cacheRead,
      outputTokens: num(raw.output_tokens) ?? 0,
    },
    providerMetadata: {
      // `usage` lets service-tier pricing read `speed`, as it does for chat streams.
      anthropic: {
        usage: raw,
        ...(cacheWrite > 0 ? { cacheCreationInputTokens: cacheWrite } : {}),
      },
    },
  };
}

function openAiUsage(
  raw: JsonRecord,
  model: string | undefined,
  serviceTier: unknown
): ExtractedUsage {
  const inputDetails = isRecord(raw.input_tokens_details)
    ? raw.input_tokens_details
    : isRecord(raw.prompt_tokens_details)
      ? raw.prompt_tokens_details
      : undefined;
  const outputDetails = isRecord(raw.output_tokens_details)
    ? raw.output_tokens_details
    : isRecord(raw.completion_tokens_details)
      ? raw.completion_tokens_details
      : undefined;
  const tier = str(serviceTier);
  return {
    model,
    // OpenAI already reports input inclusive of cached tokens and output inclusive of reasoning.
    usage: {
      inputTokens: num(raw.input_tokens) ?? num(raw.prompt_tokens) ?? 0,
      cachedInputTokens: num(inputDetails?.cached_tokens) ?? 0,
      outputTokens: num(raw.output_tokens) ?? num(raw.completion_tokens) ?? 0,
      reasoningTokens: num(outputDetails?.reasoning_tokens) ?? 0,
    },
    ...(tier ? { providerMetadata: { openai: { serviceTier: tier } } } : {}),
  };
}

/** Usage from one complete JSON response body, or undefined if it carries none. */
export function extractUsageFromJson(
  provider: BashAiProxyProvider,
  body: unknown
): ExtractedUsage | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const model = str(body.model);
  return provider === "anthropic"
    ? anthropicUsage(body.usage, model)
    : openAiUsage(body.usage, model, body.service_tier);
}

/**
 * Observes a response body chunk by chunk while the proxy streams it to the client, then reports
 * the usage it found. One instance per upstream response, so each response is recorded once.
 */
export class UsageTap {
  private readonly decoder = new TextDecoder();
  private readonly isSse: boolean;
  private sseBuffer = "";
  private readonly jsonChunks: Uint8Array[] = [];
  private jsonBytes = 0;
  private jsonOverflow = false;
  private finished = false;

  // SSE state. Anthropic splits usage across message_start and message_delta.
  private model: string | undefined;
  private anthropicRaw: JsonRecord | undefined;
  private openAiResult: ExtractedUsage | undefined;

  constructor(
    private readonly provider: BashAiProxyProvider,
    contentType: string | undefined
  ) {
    this.isSse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  }

  push(chunk: Uint8Array): void {
    assert(!this.finished, "UsageTap.push after finish");
    if (!this.isSse) {
      this.jsonBytes += chunk.byteLength;
      if (this.jsonBytes > MAX_JSON_BODY_BYTES) {
        this.jsonOverflow = true;
        this.jsonChunks.length = 0;
      } else if (!this.jsonOverflow) {
        this.jsonChunks.push(chunk);
      }
      return;
    }
    this.sseBuffer += this.decoder.decode(chunk, { stream: true });
    let newline = this.sseBuffer.indexOf("\n");
    while (newline !== -1) {
      this.observeSseLine(this.sseBuffer.slice(0, newline));
      this.sseBuffer = this.sseBuffer.slice(newline + 1);
      newline = this.sseBuffer.indexOf("\n");
    }
  }

  /** The usage seen so far; a stream cut short still reports what it carried. */
  finish(): ExtractedUsage | undefined {
    assert(!this.finished, "UsageTap.finish called twice");
    this.finished = true;
    if (!this.isSse) {
      if (this.jsonOverflow || this.jsonChunks.length === 0) return undefined;
      try {
        return extractUsageFromJson(
          this.provider,
          JSON.parse(Buffer.concat(this.jsonChunks).toString("utf8"))
        );
      } catch {
        return undefined; // Not JSON (an HTML error page, say): nothing to count.
      }
    }
    this.sseBuffer += this.decoder.decode();
    if (this.sseBuffer.length > 0) this.observeSseLine(this.sseBuffer);
    this.sseBuffer = "";
    if (this.provider === "anthropic") {
      return this.anthropicRaw ? anthropicUsage(this.anthropicRaw, this.model) : undefined;
    }
    return this.openAiResult;
  }

  private observeSseLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (this.provider === "anthropic") {
      this.observeAnthropicEvent(event);
    } else {
      this.observeOpenAiEvent(event);
    }
  }

  private observeAnthropicEvent(event: JsonRecord): void {
    if (event.type === "message_start" && isRecord(event.message)) {
      this.model = str(event.message.model) ?? this.model;
      if (isRecord(event.message.usage)) this.anthropicRaw = { ...event.message.usage };
      return;
    }
    // message_delta usage is cumulative: each field present replaces the earlier value.
    if (event.type === "message_delta" && isRecord(event.usage)) {
      const merged: JsonRecord = { ...(this.anthropicRaw ?? {}) };
      for (const [key, value] of Object.entries(event.usage)) {
        if (value !== null && value !== undefined) merged[key] = value;
      }
      this.anthropicRaw = merged;
    }
  }

  private observeOpenAiEvent(event: JsonRecord): void {
    // Responses API: response.completed / .incomplete / .failed carry the final usage.
    if (isRecord(event.response) && isRecord(event.response.usage)) {
      this.openAiResult = extractUsageFromJson("openai", event.response);
      return;
    }
    // Chat Completions: the final chunk has `usage` (null on the others).
    if (isRecord(event.usage)) {
      this.openAiResult = extractUsageFromJson("openai", event);
    }
  }
}
