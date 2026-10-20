import { StreamProviderError } from "ai";

/**
 * Provider error types and codes that name a server-side, overload or rate-limit failure: an
 * HTTP status in all but name, so a stream error part that carries one stays transient.
 */
const STATUS_EQUIVALENT_PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  "api_error",
  "internal_server_error",
  "overloaded_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "server_error",
  "service_unavailable",
]);

/**
 * Whether identical repeats of this stream failure stop auto-retry (#4228). Only a provider
 * `error` stream part (the AI SDK's StreamProviderError) qualifies, and only when the SDK found
 * no HTTP status and no retryable flag for it and its type or code names no server-side error:
 * the deterministic gateway error of #4228 had that shape. Every other failure (HTTP statuses,
 * transport errors, thrown errors) keeps unbounded retry, because an outage repeats the same
 * text too.
 */
export function isRepeatCappedProviderError(error: unknown): boolean {
  if (!StreamProviderError.isInstance(error)) return false;
  if (error.statusCode != null || error.isRetryable) return false;
  return ![error.type, error.code].some(
    (value) => typeof value === "string" && STATUS_EQUIVALENT_PROVIDER_ERRORS.has(value)
  );
}
