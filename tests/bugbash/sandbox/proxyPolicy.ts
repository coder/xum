/**
 * Request policy and spend ledger for the bug-bash provider proxy (#5714, plan PR A1). Nothing
 * imports it yet: PR A2 adds the proxy, which runs in the launcher on the host and is the
 * container's only way to a model. Every byte the container sends is untrusted, so each request
 * passes `checkRequest` before it is forwarded, and every forwarded call is paid for from one
 * run-wide `Ledger`. P2 to P7 name claims of the plan's threat model. Money is counted in
 * integer nano-dollars (1e-9 USD), so ledger sums are exact.
 */

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * `max_tokens` is clamped to this. The AI SDK always sends the model maximum (128,000 on Opus
 * 5.5), which would reserve $2.56 of output per call. Explorer steps are tool calls, and 16,384
 * tokens leave room for medium-effort thinking.
 */
export const MAX_OUTPUT_TOKENS = 16_384;
/** A larger input bound refuses, so long-context pricing never applies. */
const MAX_INPUT_TOKENS = 200_000;
/** Per-call input overhead: over 10x the tool-use system prompt (286 tokens on Opus 5.5). */
const OVERHEAD_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";
/**
 * The AI SDK sends `structured-outputs-2025-11-13` on every call. Add a beta only after checking
 * that it enables no provider-executed capability and no other price (`fast-mode-*` costs 2x).
 */
const ALLOWED_BETAS = new Set(["structured-outputs-2025-11-13"]);
/** P4: so `mcp_servers`, `container`, `service_tier`, `speed` and every new key refuse. */
const TOP_LEVEL_KEYS = new Set(
  "model messages system max_tokens tools tool_choice thinking output_config temperature top_p top_k stop_sequences stream metadata cache_control".split(
    " "
  )
);
/** Forwarded headers, and framing headers that must appear at most once (P2). */
const SINGLE_HEADERS = new Set(
  "content-type anthropic-version anthropic-beta content-length transfer-encoding".split(" ")
);

/**
 * Nano-dollars per token at list price, checked 2026-10-10 against
 * https://platform.claude.com/docs/en/about-claude/pricing: Opus 5.5 $4 / $20 per million
 * (cache read $0.20), Sonnet 5.5 $2 / $10 ($0.10), Haiku 4.5 $1 / $5 ($0.10). A cache write costs
 * 2x input (the 1-hour rate, the higher one). The vision docs
 * (https://platform.claude.com/docs/en/build-with-claude/vision) cap one image at 4,784 visual
 * tokens on the high-resolution tier (Opus 4.7 and later) and 1,568 on other models, after
 * scaling it down. The bound uses 4,784 for every model, so it holds in either tier.
 */
const PRICES = new Map([
  ["claude-opus-5-5", { input: 4000, output: 20_000, cacheRead: 200 }],
  ["claude-sonnet-5-5", { input: 2000, output: 10_000, cacheRead: 100 }],
  ["claude-haiku-4-5", { input: 1000, output: 5000, cacheRead: 100 }],
]);
const VISUAL_TOKENS = 4784;

/** Whether the proxy can price (and so bound) a call of this model. */
export const priced = (model: string) => PRICES.has(model);

export interface JobPolicy {
  /** Model IDs this job may call: its explorer model and the app model (P3). */
  models: readonly string[];
}

export type CheckResult =
  | {
      ok: true;
      model: string;
      /** The body to forward: our own serialization (no duplicate keys), `max_tokens` clamped. */
      body: string;
      /** The only headers to forward. The proxy adds `x-api-key` itself. */
      headers: Record<string, string>;
      /** Upper bound of the call's list-price cost, reserved before dispatch (P7). */
      maxCostNanoUsd: number;
    }
  | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Reasons quote untrusted names, cut short, and never a value (P9). */
const quote = (name: unknown) => JSON.stringify(String(name).slice(0, 64));

/**
 * P2. `rawHeaders` are name/value pairs as received (Node's `req.rawHeaders`), so duplicates
 * stay visible. Every header outside SINGLE_HEADERS is dropped.
 */
function checkHeaders(rawHeaders: readonly string[]): Record<string, string> | string {
  if (rawHeaders.length % 2 !== 0) return "header: odd raw header list";
  const seen = new Map<string, string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (!SINGLE_HEADERS.has(name)) continue;
    if (seen.has(name)) return `header: duplicate ${name}`;
    seen.set(name, rawHeaders[i + 1]);
  }
  const transferEncoding = seen.get("transfer-encoding");
  if (transferEncoding !== undefined && transferEncoding.toLowerCase() !== "chunked") {
    return "header: transfer-encoding";
  }
  if (transferEncoding !== undefined && seen.has("content-length")) {
    return "header: transfer-encoding with content-length";
  }
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(seen.get("content-type") ?? "")) {
    return "header: content-type";
  }
  if (seen.get("anthropic-version") !== ANTHROPIC_VERSION) return "header: anthropic-version";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const beta = seen.get("anthropic-beta");
  if (beta === undefined) return headers;
  const betas = beta.split(",").map((value) => value.trim());
  if (!betas.every((value) => ALLOWED_BETAS.has(value))) return "header: anthropic-beta";
  return { ...headers, "anthropic-beta": [...new Set(betas)].join(",") };
}

const BLOCKS = new Set("text image tool_use tool_result thinking redacted_thinking".split(" "));
const TOOL_RESULT_BLOCKS = new Set(["text", "image"]);

/**
 * P5: only blocks that the provider resolves without fetching anything. Counts the images and
 * their base64 bytes, which are priced per image instead of per byte.
 */
function checkContent(
  content: unknown,
  images: { count: number; bytes: number },
  allowed = BLOCKS
): string | undefined {
  if (content === undefined || typeof content === "string") return undefined;
  if (!Array.isArray(content)) return "content: not a list";
  for (const block of content) {
    if (!isObject(block)) return "content: block";
    if (!allowed.has(String(block.type))) return `content: block type ${quote(block.type)}`;
    if (block.type === "tool_result") {
      const reason = checkContent(block.content, images, TOOL_RESULT_BLOCKS);
      if (reason) return reason;
    }
    if (block.type !== "image") continue;
    const source = block.source;
    if (!isObject(source) || source.type !== "base64") return "content: image source";
    if (typeof source.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
      return "content: image data";
    }
    images.count += 1;
    images.bytes += source.data.length;
  }
  return undefined;
}

/** Checks one container request: the body and headers to forward, or a reason safe to log. */
export function checkRequest(
  job: JobPolicy,
  rawHeaders: readonly string[],
  bodyBytes: Uint8Array
): CheckResult {
  const refuse = (reason: string): CheckResult => ({ ok: false, reason });
  const headers = checkHeaders(rawHeaders);
  if (typeof headers === "string") return refuse(headers);
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return refuse("body: too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch {
    return refuse("body: not UTF-8 JSON");
  }
  if (!isObject(parsed)) return refuse("body: not an object");
  const extra = Object.keys(parsed).find((key) => !TOP_LEVEL_KEYS.has(key));
  if (extra !== undefined) return refuse(`body: key ${quote(extra)}`);

  const model = parsed.model;
  const price = typeof model === "string" ? PRICES.get(model) : undefined;
  if (typeof model !== "string" || !job.models.includes(model) || !price) {
    return refuse("model: not allowed");
  }
  const tools = parsed.tools ?? [];
  if (!Array.isArray(tools) || !tools.every(isObject)) return refuse("tools: not a list");
  // P4: a typed tool is provider-defined (web_search_*, code_execution_*, bash_*, ...).
  const typed = tools.find((tool) => tool.type !== undefined && tool.type !== "custom");
  if (typed) return refuse(`tools: type ${quote(typed.type)}`);

  const images = { count: 0, bytes: 0 };
  if (!Array.isArray(parsed.messages) || !parsed.messages.every(isObject)) {
    return refuse("messages: not a list");
  }
  for (const content of [parsed.system, ...parsed.messages.map((message) => message.content)]) {
    const reason = checkContent(content, images);
    if (reason) return refuse(reason);
  }

  const maxTokens = parsed.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || Number(maxTokens) < 1) {
    return refuse("max_tokens: not a positive integer");
  }
  const outputTokens = Math.min(Number(maxTokens), MAX_OUTPUT_TOKENS);
  // The API needs budget_tokens < max_tokens. Refusing a budget that the clamp breaks keeps the
  // clamp a plain rewrite.
  const budget = isObject(parsed.thinking) ? parsed.thinking.budget_tokens : undefined;
  if (parsed.thinking !== undefined && !isObject(parsed.thinking)) return refuse("thinking: type");
  if (budget !== undefined && !(Number.isSafeInteger(budget) && Number(budget) < outputTokens)) {
    return refuse("thinking: budget_tokens does not fit max_tokens");
  }
  parsed.max_tokens = outputTokens;
  const body = JSON.stringify(parsed);

  // A BPE token holds at least one byte, so text tokens never exceed the body bytes outside
  // base64 image data. Each image counts twice its documented limit, and every input token is
  // priced as a cache write, the most an input token can cost.
  const inputTokens =
    Buffer.byteLength(body) - images.bytes + images.count * 2 * VISUAL_TOKENS + OVERHEAD_TOKENS;
  if (inputTokens > MAX_INPUT_TOKENS) return refuse("body: input bound above 200k tokens");
  const maxCostNanoUsd = inputTokens * 2 * price.input + outputTokens * price.output;
  return { ok: true, model, body, headers, maxCostNanoUsd };
}

export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Reads an Anthropic `usage` record; undefined when a count is missing or invalid. */
function readUsage(usage: unknown): Usage | undefined {
  if (!isObject(usage)) return undefined;
  const count = (value: unknown, optional = false) =>
    optional && value == null
      ? 0
      : Number.isSafeInteger(value) && Number(value) >= 0
        ? Number(value)
        : NaN;
  const read = {
    input: count(usage.input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens, true),
    cacheRead: count(usage.cache_read_input_tokens, true),
    output: count(usage.output_tokens),
  };
  return Object.values(read).some(Number.isNaN) ? undefined : read;
}

/** List-price cost of an Anthropic usage record in nano-dollars, or undefined if unreadable. */
export function usageCost(model: string, usage: unknown): number | undefined {
  const price = PRICES.get(model);
  const read = readUsage(usage);
  if (!price || !read) return undefined;
  const input = read.input + 2 * read.cacheWrite;
  return input * price.input + read.cacheRead * price.cacheRead + read.output * price.output;
}

/**
 * The run-wide budget (P7), shared by every job of a run. A dispatched call ends with `settle`
 * (a complete response with usage) or `keep` (anything else). There is no release: no
 * documented no-charge outcome is relied on.
 */
export class Ledger {
  readonly #cap: number;
  readonly #open = new Map<number, { model: string; nanoUsd: number }>();
  #nextId = 1;
  #spent = 0;
  #reserved = 0;
  #calls = 0;
  #refused = 0;
  /** Settled calls that cost more than their bound. Nonzero means the bound is wrong. */
  #boundExceeded = 0;
  readonly #tokens: Record<string, Usage> = {};

  constructor(capUsd: number) {
    if (!(capUsd > 0 && Number.isFinite(capUsd))) throw new Error("Ledger: cap must be > 0");
    this.#cap = Math.floor(capUsd * 1e9);
  }

  /** Reserves a call's bound: its ID, or undefined when it does not fit the remaining budget. */
  reserve(model: string, nanoUsd: number): number | undefined {
    if (!(Number.isSafeInteger(nanoUsd) && nanoUsd > 0)) throw new Error("Ledger: bad amount");
    if (this.#spent + this.#reserved + nanoUsd > this.#cap) {
      this.#refused += 1;
      return undefined;
    }
    this.#open.set(this.#nextId, { model, nanoUsd });
    this.#reserved += nanoUsd;
    this.#calls += 1;
    return this.#nextId++;
  }

  /** Settles a complete call to its reported usage. Unreadable usage keeps the reservation. */
  settle(id: number, usage: unknown): void {
    const call = this.#take(id);
    const cost = usageCost(call.model, usage);
    const read = readUsage(usage);
    if (cost === undefined || !read) {
      this.#spent += call.nanoUsd;
      return;
    }
    if (cost > call.nanoUsd) this.#boundExceeded += 1;
    this.#spent += cost;
    const tokens = (this.#tokens[call.model] ??= {
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });
    for (const key of Object.keys(tokens) as (keyof Usage)[]) tokens[key] += read[key];
  }

  /** Counts the full reservation as spent: error, cancel, deadline, cut stream, close. */
  keep(id: number): void {
    this.#spent += this.#take(id).nanoUsd;
  }

  totals() {
    return {
      capNanoUsd: this.#cap,
      /** Settled costs plus kept reservations. */
      spentNanoUsd: this.#spent,
      /** Reservations of calls in flight. */
      reservedNanoUsd: this.#reserved,
      calls: this.#calls,
      refused: this.#refused,
      boundExceeded: this.#boundExceeded,
      tokens: structuredClone(this.#tokens),
    };
  }

  #take(id: number) {
    const call = this.#open.get(id);
    // A second settle or keep of one call is a proxy bug: fail loudly instead of miscounting.
    if (!call) throw new Error(`Ledger: call ${id} is not open`);
    this.#open.delete(id);
    this.#reserved -= call.nanoUsd;
    return call;
  }
}
