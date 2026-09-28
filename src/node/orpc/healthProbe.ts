import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

export type HealthResponse =
  | { statusCode: 200; body: { status: "ok" } }
  | { statusCode: 503; body: { status: "degraded"; reason: string } };

/**
 * Builds the GET /health probe. Node routes async fs work through a small libuv threadpool;
 * when that pool is wedged on unresponsive storage the probe never settles while the event
 * loop stays idle, so the timeout branch is the one that matters: it reports the stall as a
 * prompt 503 instead of letting the client time out.
 *
 * One fs operation is in flight at a time. A timed-out stat is still queued in the threadpool,
 * so per-request probes during a long stall would pile up behind it (the Coder app healthcheck
 * polls every 5 s) and burst onto the disk the moment storage recovers.
 */
export function createHealthProbe(
  probe: () => Promise<unknown>,
  timeoutMs: number
): () => Promise<HealthResponse> {
  let inflight: Promise<unknown> | null = null;
  return async () => {
    inflight ??= probe().finally(() => {
      inflight = null;
    });
    return await resolveHealthResponse(inflight, timeoutMs);
  };
}

export async function resolveHealthResponse(
  probe: Promise<unknown>,
  timeoutMs: number
): Promise<HealthResponse> {
  try {
    const result = await raceWithAbortAndTimeout(probe, { timeoutMs });
    if (result.kind === "ok") {
      return { statusCode: 200, body: { status: "ok" } };
    }
    return {
      statusCode: 503,
      body: { status: "degraded", reason: `fs probe did not complete within ${timeoutMs}ms` },
    };
  } catch (error) {
    // /health is unauthenticated and fs error messages embed the probed path, so only the
    // errno code goes to the client; the operator already knows which root is configured.
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : null;
    return {
      statusCode: 503,
      body: { status: "degraded", reason: code ? `fs probe failed: ${code}` : "fs probe failed" },
    };
  }
}
