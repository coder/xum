/**
 * Session tape replay driver: yields a loaded tape's onChat events in recorded order, either at
 * their recorded offsets or as fast as the consumer pulls.
 *
 * - `recorded`: event N is due at start + t(N), where start is the first pull. Deadlines are
 *   absolute, so time a slow consumer spends between pulls is absorbed (later events are not
 *   pushed back) instead of adding up as drift. A late event is yielded at once.
 * - `fast`: no intentional delay; order is kept.
 *
 * Finite and pure: it ends after the last event, adds nothing that is not on the tape, and
 * never executes tools or contacts providers. Keeping a subscription open after playback is the
 * caller's job (the desktop replay source). An aborted signal ends playback (also during a wait)
 * without an error.
 */
import { resolveXumEnvironmentValue, type XumEnvironment } from "@/common/compat/xumEnv";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { LoadedSessionTape } from "./sessionTapeLoader";

/**
 * Whether `XUM_REPLAY_TAPES` (legacy `MUX_REPLAY_TAPES`) is set: the process is in session tape
 * replay mode (perf harness). Any non-blank value counts, even an unparseable one, so a typo
 * never leaves a harness run live. Shared by the backend, desktop main and preload.
 */
export function isSessionTapeReplayConfigured(env: XumEnvironment): boolean {
  return (resolveXumEnvironmentValue("REPLAY_TAPES", env) ?? "").trim() !== "";
}

/**
 * `data` of the error that refuses onChat for a workspace mapped to a session tape
 * (XUM_REPLAY_TAPES) that cannot be served. It survives the oRPC transport (an ORPCError's
 * `data` is serialized with it), so the renderer can tell this terminal refusal apart from a
 * transient subscription failure: retrying cannot help, and there is no live fallback.
 */
export const SESSION_TAPE_REPLAY_REFUSAL_DATA = { sessionTapeReplayRefused: true } as const;

export function isSessionTapeReplayRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const data = (error as { data?: unknown }).data;
  return (
    data !== null &&
    typeof data === "object" &&
    (data as { sessionTapeReplayRefused?: unknown }).sessionTapeReplayRefused === true
  );
}

/** setTimeout fires at once for delays above this (2^31-1 ms, about 24.8 days). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export type SessionTapeReplayPacing = "recorded" | "fast";

export interface SessionTapeReplayOptions {
  pacing: SessionTapeReplayPacing;
  signal?: AbortSignal;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleepUntilAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* replaySessionTape(
  tape: Pick<LoadedSessionTape, "events">,
  options: SessionTapeReplayOptions
): AsyncGenerator<WorkspaceChatMessage> {
  const { pacing, signal } = options;
  // The generator body runs on the first pull, so offsets start when the consumer starts reading,
  // like the recorder's offsets.
  const startMs = performance.now();
  for (const { t, event } of tape.events) {
    if (signal?.aborted) return;
    if (pacing === "recorded") {
      // Wait in chunks against the absolute deadline: a longer single delay would fire at once.
      for (let waitMs = startMs + t - performance.now(); waitMs > 0; ) {
        await sleepUntilAborted(Math.min(waitMs, MAX_TIMER_DELAY_MS), signal);
        if (signal?.aborted) return;
        waitMs = startMs + t - performance.now();
      }
    }
    yield event;
  }
}
