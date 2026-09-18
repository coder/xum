import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { getErrorMessage } from "@/common/utils/errors";

export type HealthResponse =
  | { statusCode: 200; body: { status: "ok" } }
  | { statusCode: 503; body: { status: "degraded"; reason: string } };

/**
 * Turns a filesystem probe into the GET /health answer. Node routes async fs work through a
 * small libuv threadpool; when that pool is wedged on unresponsive storage the probe never
 * settles while the event loop stays idle, so the timeout branch is the one that matters:
 * it reports the stall as a prompt 503 instead of letting the client time out.
 */
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
    return {
      statusCode: 503,
      body: { status: "degraded", reason: `fs probe failed: ${getErrorMessage(error)}` },
    };
  }
}
