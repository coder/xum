import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import assert from "@/common/utils/assert";
import { createHash, hash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { getAvailableTools, getToolSchemas } from "@/common/utils/tools/toolDefinitions";
import type { CountTokensBatchInput, EncodingName } from "./tokenizer.worker";
import { models, type ModelName } from "ai-tokenizer";
import { run } from "./workerPool";
import { TOKENIZER_MODEL_OVERRIDES, DEFAULT_WARM_MODELS } from "@/common/constants/knownModels";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { log } from "@/node/services/log";
import { safeStringifyForCounting } from "@/common/utils/tokens/safeStringifyForCounting";

/**
 * Public tokenizer interface exposed to callers.
 * countTokens is async because the heavy lifting happens in a worker thread.
 */
export interface Tokenizer {
  encoding: string;
  countTokens: (text: string) => Promise<number>;
}

const APPROX_ENCODING = "approx-4";

function shouldUseApproxTokenizer(): boolean {
  // XUM_FORCE_REAL_TOKENIZER=1 overrides approx mode (for tests that need real tokenization)
  // XUM_APPROX_TOKENIZER=1 enables fast approximate mode (default in Jest)
  if (resolveXumEnvironmentValue("FORCE_REAL_TOKENIZER", process.env) === "1") {
    return false;
  }
  return resolveXumEnvironmentValue("APPROX_TOKENIZER", process.env) === "1";
}

function approximateCount(text: string): number {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function getApproxTokenizer(): Tokenizer {
  return {
    encoding: APPROX_ENCODING,
    countTokens: (input: string) => Promise.resolve(approximateCount(input)),
  };
}

const encodingPromises = new Map<ModelName, Promise<string>>();
const inFlightCounts = new Map<string, Promise<number>>();
const tokenCountCache = new LRUCache<string, number>({
  maxSize: 250_000,
  sizeCalculation: () => 1,
});

// Track which models we've already warned about to avoid log spam
const warnedModels = new Set<string>();

function normalizeModelKey(modelName: string): ModelName | null {
  assert(
    typeof modelName === "string" && modelName.length > 0,
    "Model name must be a non-empty string"
  );

  const override = TOKENIZER_MODEL_OVERRIDES[modelName];
  const normalized =
    override ?? (modelName.includes(":") ? modelName.replace(":", "/") : modelName);

  if (!(normalized in models)) {
    // Return null for unknown models - caller can decide to fallback or error
    return null;
  }
  return normalized as ModelName;
}

/**
 * Resolves a model string to a ModelName, falling back to a similar model if unknown.
 * Optionally logs a warning when falling back.
 */
function resolveModelName(modelString: string): ModelName {
  const normalized = normalizeToCanonical(modelString);
  let modelName = normalizeModelKey(normalized);

  if (!modelName) {
    const provider = normalized.split(":")[0] || "anthropic";

    // GitHub Copilot hosts models from multiple providers.
    // Infer the tokenizer family from the model name prefix.
    let effectiveProvider = provider;
    if (provider === "github-copilot") {
      const modelId = normalized.split(":")[1] || "";
      if (modelId.startsWith("claude-")) {
        effectiveProvider = "anthropic";
      } else if (modelId.startsWith("gemini-")) {
        effectiveProvider = "google";
      } else {
        // gpt-*, grok-*, and unknown models use OpenAI tokenizer
        effectiveProvider = "openai";
      }
    }

    const fallbackModel =
      effectiveProvider === "anthropic"
        ? "anthropic/claude-sonnet-4.5"
        : effectiveProvider === "google"
          ? "google/gemini-2.5-pro"
          : "openai/gpt-5";

    // Only warn once per unknown model to avoid log spam
    if (!warnedModels.has(modelString)) {
      warnedModels.add(modelString);
      log.warn(
        `Unknown model '${modelString}', using ${fallbackModel} tokenizer for approximate token counting`
      );
    }

    modelName = fallbackModel as ModelName;
  }

  return modelName;
}

// Each encoding has its own worker, so requests are routed by the model's encoding.
function encodingOf(modelName: ModelName): EncodingName {
  const model = models[modelName];
  assert(model, `Unknown tokenizer model '${modelName}'`);
  return model.encoding;
}

/** The encoding counting uses for a model id (same overrides and provider fallbacks). */
export function encodingForModel(modelString: string): EncodingName {
  return encodingOf(resolveModelName(modelString));
}

function resolveEncoding(modelName: ModelName): Promise<string> {
  let promise = encodingPromises.get(modelName);
  if (!promise) {
    // run() spawns the encoding's worker on first use; "ready" answers once the encoding is loaded.
    promise = run<string>(encodingOf(modelName), "ready", modelName)
      .then((result: unknown) => {
        assert(
          typeof result === "string" && result.length > 0,
          "Token encoding name must be a non-empty string"
        );
        return result;
      })
      .catch((error) => {
        encodingPromises.delete(modelName);
        throw error;
      });
    encodingPromises.set(modelName, promise);
  }
  return promise;
}

// ES2024 String method; the repo's TS lib (ES2023) does not declare it, but Node and Bun ship it.
type MaybeWellFormedString = string & { isWellFormed(): boolean };

// One-shot crypto.hash was measured faster than CRC32 (#4654) but only exists from Node 20.12;
// the headless CLI still accepts any Node 20, so fall back to the streaming API there.
const sha256Base64: (data: string | Buffer) => string =
  typeof hash === "function"
    ? (data) => hash("sha256", data, "base64")
    : (data) => createHash("sha256").update(data).digest("base64");

function buildCacheKey(modelName: ModelName, text: string): string {
  // The old `CRC32:length` key collided for distinct texts of equal length (17 in a 1.24M-row
  // chat), so a text could reuse another text's count, and which one won depended on timing
  // (#4654). A SHA-256 digest is collision-resistant, keeps each of the 250k LRU keys at a
  // fixed 44 chars (keying by the text itself would retain whole chat contents), and the
  // native one-shot hash measured faster than the JS CRC32 on that chat.
  // crypto.hash UTF-8-encodes strings, which maps every lone surrogate to U+FFFD. Hash the
  // raw UTF-16 code units for such (rare) texts so they cannot share a key with other texts.
  const digest = (text as MaybeWellFormedString).isWellFormed()
    ? sha256Base64(text)
    : `u16:${sha256Base64(Buffer.from(text, "utf16le"))}`;
  return `${modelName}:${digest}`;
}

// Uncached texts are sent to the worker in batches, because one message per text cost a
// postMessage round trip plus a reply handler each, which dominated counting on a 1.24M-row chat
// (#4653). A batch flushes at 64 texts or 64K chars, or at the next microtask so a lone count is
// not delayed. A 512-text cap lost worker pipelining on ordinary chats (+11/+19 ms at p50/p90 of
// real sessions); 64 texts / 64K chars kept those at the noise floor and was as fast on the huge
// chat, since the worker starts counting the first batch while later ones are still being built.
const MAX_BATCH_TEXTS = 64;
const MAX_BATCH_CHARS = 64 * 1024;

interface OpenBatch {
  modelName: ModelName;
  inputs: string[];
  pending: Array<{ key: string; resolve: (count: number) => void; reject: (e: unknown) => void }>;
  chars: number;
}

let openBatch: OpenBatch | null = null;

function flushOpenBatch(): void {
  const batch = openBatch;
  assert(batch !== null && batch.inputs.length > 0, "flushOpenBatch requires a non-empty batch");
  openBatch = null;

  const payload: CountTokensBatchInput = { modelName: batch.modelName, inputs: batch.inputs };
  // The chain ends in a handler that settles every text, so it can never reject unhandled.
  run<number[]>(encodingOf(batch.modelName), "countTokensBatch", payload)
    .then((counts: unknown) => {
      // Validate every count before settling any, so a bad reply rejects the whole batch.
      assert(
        Array.isArray(counts) && counts.length === batch.pending.length,
        "Tokenizer worker must return one count per batched input"
      );
      for (const count of counts) {
        assert(
          typeof count === "number" && Number.isInteger(count) && count >= 0,
          "Tokenizer must return a non-negative integer token count"
        );
      }
      batch.pending.forEach((entry, index) => {
        const count = counts[index] as number;
        tokenCountCache.set(entry.key, count);
        inFlightCounts.delete(entry.key);
        entry.resolve(count);
      });
    })
    .catch((error: unknown) => {
      // Drop in-flight entries so a failed batch does not poison later counts of the same text.
      for (const entry of batch.pending) {
        inFlightCounts.delete(entry.key);
        entry.reject(error);
      }
    });
}

function enqueueCount(modelName: ModelName, key: string, text: string): Promise<number> {
  if (openBatch !== null && openBatch.modelName !== modelName) {
    flushOpenBatch();
  }
  if (openBatch === null) {
    const batch: OpenBatch = { modelName, inputs: [], pending: [], chars: 0 };
    openBatch = batch;
    queueMicrotask(() => {
      if (openBatch === batch) {
        flushOpenBatch();
      }
    });
  }
  const batch = openBatch;
  const promise = new Promise<number>((resolve, reject) => {
    batch.pending.push({ key, resolve, reject });
  });
  batch.inputs.push(text);
  batch.chars += text.length;
  if (batch.inputs.length >= MAX_BATCH_TEXTS || batch.chars >= MAX_BATCH_CHARS) {
    flushOpenBatch();
  }
  return promise;
}

async function countTokensInternal(modelName: ModelName, text: string): Promise<number> {
  assert(typeof text === "string", "Tokenizer countTokens expects string input");
  if (text.length === 0) {
    return 0;
  }

  const key = buildCacheKey(modelName, text);
  const cached = tokenCountCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  let pending = inFlightCounts.get(key);
  if (!pending) {
    pending = enqueueCount(modelName, key, text);
    inFlightCounts.set(key, pending);
  }
  return pending;
}

export async function loadTokenizerModules(
  modelsToWarm: string[] = Array.from(DEFAULT_WARM_MODELS)
): Promise<Array<PromiseSettledResult<string>>> {
  const startTime = Date.now();
  // Same resolution as counting (overrides, provider fallbacks), so warm-up builds exactly the
  // tokenizer the first real count will use. Distinct encodings load in parallel workers.
  // The async wrapper turns a synchronous resolution assertion (e.g. an empty id) into a
  // rejection of that entry only.
  const results = await Promise.allSettled(
    modelsToWarm.map(async (model) => (await getTokenizerForModel(model)).encoding)
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      log.warn(`Failed to warm tokenizer for '${modelsToWarm[index]}':`, result.reason);
    }
  });
  log.debug(`Warmed ${modelsToWarm.length} tokenizer model(s) in ${Date.now() - startTime}ms`);
  return results;
}

export async function getTokenizerForModel(
  modelString: string,
  metadataModelOverride?: string,
  // Bypass only the performance approximation; provider-family fallback encodings still apply.
  options?: { requireRealEncoding?: boolean }
): Promise<Tokenizer> {
  if (!options?.requireRealEncoding && shouldUseApproxTokenizer()) {
    return getApproxTokenizer();
  }

  const resolvedModel = metadataModelOverride ?? modelString;
  const modelName = resolveModelName(resolvedModel);
  const encodingName = await resolveEncoding(modelName);

  return {
    encoding: encodingName,
    countTokens: (input: string) => countTokensInternal(modelName, input),
  };
}

export function countTokens(modelString: string, text: string): Promise<number> {
  if (shouldUseApproxTokenizer()) {
    return Promise.resolve(approximateCount(text));
  }

  const modelName = resolveModelName(modelString);
  return countTokensInternal(modelName, text);
}

export function countTokensBatch(modelString: string, texts: string[]): Promise<number[]> {
  assert(Array.isArray(texts), "Batch token counting expects an array of strings");

  if (shouldUseApproxTokenizer()) {
    return Promise.resolve(texts.map((text) => approximateCount(text)));
  }

  const modelName = resolveModelName(modelString);
  return Promise.all(texts.map((text) => countTokensInternal(modelName, text)));
}

export function countTokensForData(data: unknown, tokenizer: Tokenizer): Promise<number> {
  const serialized = safeStringifyForCounting(data);
  return tokenizer.countTokens(serialized);
}

const TOOL_DEFINITION_FALLBACK_TOKENS: Record<string, number> = {
  bash: 65,
  file_read: 45,
  file_edit_replace_string: 70,
  file_edit_replace_lines: 80,
  file_edit_insert: 50,
  web_search: 50,
  google_search: 50,
  url_context: 50,
};

export async function getToolDefinitionTokens(
  toolName: string,
  modelString: string,
  metadataModelOverride: string | undefined,
  availableToolsOptions: Parameters<typeof getAvailableTools>[1]
): Promise<number> {
  try {
    // Tool availability is runtime-model specific (provider + model used for the request),
    // but tokenization should follow metadata-model overrides when configured.
    const availableTools = getAvailableTools(modelString, availableToolsOptions);
    if (!availableTools.includes(toolName)) {
      return 0;
    }

    const toolSchemas = getToolSchemas();
    const toolSchema = toolSchemas[toolName];
    if (!toolSchema) {
      return TOOL_DEFINITION_FALLBACK_TOKENS[toolName] ?? 40;
    }

    const tokenizerModel = metadataModelOverride ?? modelString;
    return countTokens(tokenizerModel, JSON.stringify(toolSchema));
  } catch {
    return TOOL_DEFINITION_FALLBACK_TOKENS[toolName] ?? 40;
  }
}

export function __resetTokenizerForTests(): void {
  encodingPromises.clear();
  tokenCountCache.clear();
  inFlightCounts.clear();
}
