import assert from "node:assert";

/**
 * Live-provider capacity rule (#4925): a provider that is out of capacity must not fail
 * CI, and a real regression still must.
 *
 * The xAI Grok 4.7 live tests failed the merge queue several times on one day with
 * "The model is currently at capacity due to high demand", on PRs that did not touch
 * providers. Only positively identified capacity errors are retried. If every attempt
 * hits capacity, the check is reported as skipped in a GitHub `::warning::` annotation,
 * so the log shows the live check did not run. Every other failure, including a
 * missing terminal event, still fails the test.
 */

/** Waits between attempts: 3 attempts with about 60 s of waiting in total. */
export const PROVIDER_CAPACITY_BACKOFF_MS: readonly number[] = [20_000, 40_000];

/** The fields of a `stream-error` event this rule reads. */
export interface StreamErrorLike {
  error: string;
  errorType?: string;
}

/**
 * The stream-error event carries the backend's classification, not the HTTP status:
 * `rate_limit` is a 429 that is not a billing quota (see classify429Capacity), and
 * `server_error` covers every 5xx. So 503 and 529 are recognized by their wording, and
 * only inside `server_error`, to keep a plain 500 failing.
 */
const XAI_CAPACITY = /\bcurrently at capacity\b/i;
const SERVER_ERROR_CAPACITY = [
  /\bservice unavailable\b/i, // HTTP 503 status text
  /\boverloaded \(HTTP 529\)/i, // StreamManager's normalized Anthropic overload
];

export function isProviderCapacityError(event: StreamErrorLike): boolean {
  if (event.errorType === "rate_limit") return true;
  if (XAI_CAPACITY.test(event.error)) return true;
  return (
    event.errorType === "server_error" &&
    SERVER_ERROR_CAPACITY.some((pattern) => pattern.test(event.error))
  );
}

/** Thrown by a live check for a stream error that isProviderCapacityError identified. */
export class ProviderCapacityError extends Error {
  constructor(detail: string) {
    super(`Provider at capacity: ${detail}`);
    this.name = "ProviderCapacityError";
  }
}

/**
 * Run `attempt`, retrying only on ProviderCapacityError. Returns "ran" once an attempt
 * completes, or "skipped" (after reporting the skip) when every attempt hit capacity.
 * Any other error propagates immediately.
 */
export async function retryOnProviderCapacity(
  label: string,
  attempt: () => Promise<void>,
  options: {
    backoffMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    report?: (line: string) => void;
  } = {}
): Promise<"ran" | "skipped"> {
  const backoffMs = options.backoffMs ?? PROVIDER_CAPACITY_BACKOFF_MS;
  assert(
    backoffMs.every((ms) => Number.isFinite(ms) && ms >= 0),
    "capacity backoff must be finite and non-negative"
  );
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Jest's --silent (CI) drops console output, so write the annotation to stdout directly.
  const report = options.report ?? ((line: string) => process.stdout.write(`${line}\n`));

  let lastCapacityError: ProviderCapacityError | undefined;
  for (let index = 0; index <= backoffMs.length; index++) {
    if (index > 0) await sleep(backoffMs[index - 1]);
    try {
      await attempt();
      return "ran";
    } catch (error) {
      if (!(error instanceof ProviderCapacityError)) throw error;
      lastCapacityError = error;
    }
  }
  assert(lastCapacityError, "every attempt must have hit capacity to reach the skip");
  const detail = lastCapacityError.message.replace(/\s+/g, " ");
  report(
    `::warning title=Live provider check skipped::${label}: all ${backoffMs.length + 1} attempts hit provider capacity, so the live check did not run. Last error: ${detail}`
  );
  return "skipped";
}
