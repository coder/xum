import { ORPCError, os } from "@orpc/server";
import type { FlightRecorder } from "@/node/services/perf/flightRecorder";
import type { ServerService } from "@/node/services/serverService";

// Every RPC-driven mutation (project clone/create/remove, workspace rename, archive, ...) is in
// flight for exactly as long as its procedure call, so counting calls gates restarts on all of
// them without enumerating each operation. Subscriptions return their iterator immediately and
// therefore do not pin the count; the install call itself is the restart and is excluded.
let inFlight = 0;

export function inFlightProcedureCount(): number {
  return inFlight;
}

export async function trackInFlightProcedure<T>(
  path: readonly string[],
  admit: () => boolean,
  run: () => Promise<T>
) {
  if (path.join(".") === "update.install") return run();
  // Teardown keeps serving the socket until the very end; a mutation admitted then would be
  // killed half-done by the exit, so refuse every new call once shutdown has begun.
  if (!admit()) throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Server is shutting down" });
  inFlight++;
  try {
    return await run();
  } finally {
    inFlight--;
  }
}

// oRPC applies builder middlewares at both the router and the procedure level (1.14 dropped the
// leading-middleware dedupe), so the first pass marks the context and the second pass is a no-op.
const TRACKED = "inFlight/tracked";
// The procedure path, passed down in the same context object as TRACKED (no extra allocation) so
// subscription handlers can attribute their events to it (perf flight recorder, F3).
const RPC_PATH = "rpc/path";

/** The procedure path inFlightProcedureMiddleware put into a handler's context, if any. */
export function getRpcPath(context: unknown): readonly string[] | undefined {
  if (typeof context !== "object" || context === null || !(RPC_PATH in context)) return undefined;
  const path: unknown = context[RPC_PATH];
  return Array.isArray(path) ? path : undefined;
}

function isAsyncIterable(value: unknown): boolean {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

type RpcCallRecorder = Pick<FlightRecorder, "beginRpcCall" | "endRpcCall">;

// serverService and perfFlightRecorder are optional because unit tests assemble partial contexts.
export const inFlightProcedureMiddleware = os
  .$context<{
    serverService?: Pick<ServerService, "isShuttingDown">;
    perfFlightRecorder?: RpcCallRecorder;
    [TRACKED]?: true;
  }>()
  .middleware(async ({ context, path, next }) => {
    if (context[TRACKED]) return await next();
    return await trackInFlightProcedure(
      path,
      () => !context.serverService?.isShuttingDown(),
      async () => {
        // Recorder off (the default): beginRpcCall is one boolean check returning null, and the
        // call runs exactly as before. Recording lives here rather than in a sibling middleware
        // because another async middleware would allocate a Promise per call even while off.
        const recorder = context.perfFlightRecorder;
        const startMs = recorder?.beginRpcCall() ?? null;
        if (recorder === undefined || startMs === null) {
          return next({ context: { [TRACKED]: true, [RPC_PATH]: path } });
        }
        let result;
        try {
          result = await next({ context: { [TRACKED]: true, [RPC_PATH]: path } });
        } catch (error) {
          recorder.endRpcCall(
            path.join("."),
            startMs,
            error instanceof ORPCError && typeof error.code === "string" ? error.code : "UNKNOWN"
          );
          throw error;
        }
        // A subscription install returns its iterator at once; subscription stats count it.
        if (!isAsyncIterable(result.output)) recorder.endRpcCall(path.join("."), startMs, null);
        return result;
      }
    );
  });
