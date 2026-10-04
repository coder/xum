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
 * only yields event data. It never executes tools, contacts providers or recorded URLs, and does
 * not deliver events to a renderer or session; that integration (with network isolation) is
 * T3's. An aborted signal ends playback (also during a wait) without an error.
 */
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { LoadedSessionTape } from "./sessionTapeLoader";

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
      const waitMs = startMs + t - performance.now();
      if (waitMs > 0) await sleepUntilAborted(waitMs, signal);
      if (signal?.aborted) return;
    }
    yield event;
  }
}
