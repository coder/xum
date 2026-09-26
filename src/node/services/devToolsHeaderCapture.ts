import assert from "@/common/utils/assert";

/**
 * Correlates DevTools middleware steps with HTTP request headers.
 *
 * The middleware injects a synthetic header (x-mux-devtools-step-id) into
 * AI SDK call params. The default fetch function calls captureAndStripDevToolsHeader()
 * after building final headers (including the Xum user-agent), which captures
 * all real request headers (and a redacted copy of the JSON body) keyed by step ID
 * and strips the synthetic header before the request is sent.
 */
export const DEVTOOLS_STEP_ID_HEADER = "x-mux-devtools-step-id";
export const DEVTOOLS_RUN_METADATA_ID_HEADER = "x-mux-devtools-run-metadata-id";

/** Captured request headers keyed by step ID. */
const capturedRequestHeaders = new Map<string, Record<string, string>>();

/**
 * Serialized request bodies keyed by step ID. A provider that rejects a request before
 * responding (e.g. HTTP 400) gives the middleware no `result.request.body`, so this is the
 * only raw-body evidence for failed steps (#4343). Bodies are kept raw and redacted only
 * when a failed step reads them, so successful requests pay no parse cost; the raw string
 * never leaves this module.
 */
const capturedRequestBodies = new Map<string, string>();

/**
 * Header names (lowercased) whose values must be redacted before persistence.
 * Matches common auth/credential headers across AI providers.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
]);

/**
 * Response headers can still carry credentials under custom names (for example
 * from provider proxies), so we keep broad token/secret redaction enabled in
 * both directions. To avoid over-redacting operational metadata, explicitly
 * allowlist known non-sensitive rate-limit response headers.
 */
const SAFE_RESPONSE_TOKEN_HEADER_PREFIXES = [
  "anthropic-ratelimit-",
  "x-ratelimit-",
  "ratelimit-",
] as const;

function isKnownSafeResponseTokenHeader(name: string): boolean {
  return SAFE_RESPONSE_TOKEN_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Prefix-match for bearer/token patterns that may appear under custom names. */
function isSensitiveHeaderName(name: string, direction: "request" | "response"): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower) || lower.includes("cookie")) {
    return true;
  }

  const containsTokenLikeSecret = lower.includes("secret") || lower.includes("token");
  if (!containsTokenLikeSecret) {
    return false;
  }

  if (direction === "response" && isKnownSafeResponseTokenHeader(lower)) {
    return false;
  }

  return true;
}

export function redactHeaders(
  headers: Record<string, string>,
  direction: "request" | "response" = "request"
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = isSensitiveHeaderName(key, direction) ? "[REDACTED]" : value;
  }
  return redacted;
}

/**
 * Body keys (lowercased, non-alphanumerics removed) that hold credentials. Exact matches only:
 * substring rules would also hide operational fields such as `max_output_tokens`.
 */
const CREDENTIAL_BODY_KEYS = new Set([
  "apikey",
  "xapikey",
  "authorization",
  "proxyauthorization",
  "cookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "bearertoken",
  "secret",
  "clientsecret",
  "password",
]);

/**
 * Body keys that carry provider-encrypted reasoning: OpenAI Responses `encrypted_content`,
 * Anthropic thinking `signature`, Gemini `thoughtSignature`. Only the length is kept, which
 * is enough to spot an empty or truncated blob without persisting its contents.
 */
const ENCRYPTED_REASONING_BODY_KEYS = new Set([
  "encryptedcontent",
  "signature",
  "thoughtsignature",
]);

function normalizeBodyKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactEncrypted(value: unknown): unknown {
  return typeof value === "string" ? `[REDACTED ${value.length} chars]` : "[REDACTED]";
}

function redactBodyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactBodyValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const normalized = normalizeBodyKey(key);
    if (CREDENTIAL_BODY_KEYS.has(normalized)) {
      redacted[key] = "[REDACTED]";
    } else if (
      ENCRYPTED_REASONING_BODY_KEYS.has(normalized) ||
      // Anthropic redacted_thinking blocks carry their encrypted payload in `data`.
      (normalized === "data" && record.type === "redacted_thinking")
    ) {
      redacted[key] = redactEncrypted(child);
    } else {
      redacted[key] = redactBodyValue(child);
    }
  }
  return redacted;
}

/**
 * Parses a serialized JSON request body and redacts credentials and encrypted reasoning.
 * Returns null for anything that is not a JSON string: an unparsed body cannot be redacted,
 * so it is never persisted (fail closed).
 */
export function redactRequestBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return null;
  }
  try {
    return redactBodyValue(JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Called by the middleware on a failed step: returns the redacted request body (or null)
 * and cleans it up. Every other outcome must call discardCapturedRequestBody instead.
 */
export function consumeRedactedRequestBody(stepId: string): unknown {
  assert(stepId.trim().length > 0, "consumeRedactedRequestBody requires a stepId");

  const body = capturedRequestBodies.get(stepId);
  capturedRequestBodies.delete(stepId);
  return redactRequestBody(body);
}

/** Drops a captured body the step does not need (its result carries the SDK's own body). */
export function discardCapturedRequestBody(stepId: string): void {
  capturedRequestBodies.delete(stepId);
}

/** Called by the middleware to retrieve (and clean up) captured headers for a step. */
export function consumeCapturedRequestHeaders(stepId: string): Record<string, string> | null {
  assert(stepId.trim().length > 0, "consumeCapturedRequestHeaders requires a stepId");

  const headers = capturedRequestHeaders.get(stepId) ?? null;
  capturedRequestHeaders.delete(stepId);
  return headers;
}

/**
 * Inspects a Headers object for the synthetic DevTools step ID header.
 * If present, captures all remaining headers into the shared map and
 * strips the synthetic header. Mutates the Headers object in place.
 *
 * Called inside defaultFetchWithUnlimitedTimeout after buildAIProviderRequestHeaders
 * so captured headers include the Xum user-agent and all provider-added headers.
 * No-op when the synthetic header is absent (i.e., devtools middleware is not active).
 */
export function captureAndStripDevToolsHeader(headers: Headers, body?: unknown): void {
  const rawStepId = headers.get(DEVTOOLS_STEP_ID_HEADER);

  // Strip synthetic headers — they must never reach the provider API.
  // Run-metadata IDs correlate queued DevTools run metadata with the request
  // that actually reaches middleware.
  headers.delete(DEVTOOLS_STEP_ID_HEADER);
  headers.delete(DEVTOOLS_RUN_METADATA_ID_HEADER);

  if (rawStepId == null) {
    return;
  }

  const stepId = rawStepId.trim();
  if (stepId.length > 0) {
    capturedRequestHeaders.set(stepId, redactHeaders(Object.fromEntries(headers.entries())));
    if (typeof body === "string") {
      capturedRequestBodies.set(stepId, body);
    }
  }
}
