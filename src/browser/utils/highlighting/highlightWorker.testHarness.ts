/**
 * A fake highlight Worker for tests of highlightWorkerClient and its callers. It speaks Comlink
 * over a real MessageChannel, so the client's real Comlink path runs, and each fake follows a
 * plan: when it starts, whether its script fails, and which inputs wedge or crash it.
 *
 * Use with fake timers (`jest.useFakeTimers()`): `settleWithin` advances fake time in small steps
 * and delivers the MessageChannel messages each step releases.
 */
import * as Comlink from "comlink";

/** An input that never finishes highlighting (catastrophic backtracking). */
export const WEDGED_INPUT = "wedged input";
/** An input that makes the worker fire `onerror` and never answer (a crash). */
export const CRASHING_INPUT = "crashing input";

/**
 * How the next fake worker starts: after this many ms; `null`: never; `{ errorAfterMs }`: its
 * script fails to load, so it fires `onerror` then and never answers.
 */
export type FakeWorkerStart = number | null | { errorAfterMs: number };

/** A highlighted line as the fake worker colors it (one token). */
export function fakeHighlightedLine(code: string): string {
  return `<span style="color:#abcdef">${code}</span>`;
}

/** The HTML a fake worker returns: Shiki's shape, so extractShikiLines reads it. */
export function fakeHighlightHtml(code: string): string {
  return `<pre class="shiki"><code><span class="line">${fakeHighlightedLine(code)}</span></code></pre>`;
}

export class FakeHighlightWorker {
  readonly port: MessagePort;
  terminated = false;
  readonly highlighted: string[] = [];
  onerror: ((event: unknown) => void) | null = null;

  constructor(start: FakeWorkerStart) {
    const channel = new MessageChannel();
    this.port = channel.port1;
    const api = {
      prepare: () => Promise.resolve(),
      highlight: (code: string) => {
        this.highlighted.push(code);
        return new Promise<string>((resolve) => {
          if (code === CRASHING_INPUT) setTimeout(() => this.crash(), 10);
          else if (code !== WEDGED_INPUT) setTimeout(() => resolve(fakeHighlightHtml(code)), 10);
        });
      },
    };
    // Messages posted before the worker starts wait in the port, as they do for a real worker.
    if (typeof start === "number") setTimeout(() => Comlink.expose(api, channel.port2), start);
    else if (start !== null) setTimeout(() => this.crash(), start.errorAfterMs);
  }

  private crash() {
    this.onerror?.(new Event("error"));
  }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    this.port.postMessage(message, transfer);
  }
  addEventListener(type: string, listener: EventListener) {
    this.port.addEventListener(type, listener);
  }
  removeEventListener(type: string, listener: EventListener) {
    this.port.removeEventListener(type, listener);
  }
  start() {
    this.port.start();
  }
  terminate() {
    this.terminated = true;
    this.port.close();
  }
}

/**
 * Replaces `globalThis.Worker` with fakes that start as `starts` says, in creation order. A
 * creation beyond the plan throws, which the client treats as "workers unavailable" and the test
 * sees in `created.length`. Returns the created fakes and the undo.
 */
export function installFakeHighlightWorkers(starts: FakeWorkerStart[]): {
  created: FakeHighlightWorker[];
  restore: () => void;
} {
  const originalWorker = globalThis.Worker;
  const plan = [...starts];
  const created: FakeHighlightWorker[] = [];
  globalThis.Worker = class {
    constructor() {
      const start = plan.shift();
      if (start === undefined) throw new Error("No start plan for this fake worker");
      const fake = new FakeHighlightWorker(start);
      created.push(fake);
      return fake;
    }
  } as unknown as typeof Worker;
  return {
    created,
    restore: () => {
      if (originalWorker === undefined) Reflect.deleteProperty(globalThis, "Worker");
      else globalThis.Worker = originalWorker;
    },
  };
}

const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

/** Lets real MessageChannel deliveries (macrotasks) and their promise chains run. */
export async function deliverMessages(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Advances fake time by `ms` in 50 ms steps, delivering messages after each step. */
export async function advanceFakeTime(ms: number, stopWhen: () => boolean = () => false) {
  await deliverMessages();
  for (let elapsed = 0; elapsed < ms && !stopWhen(); elapsed += 50) {
    fakeTimers.advanceTimersByTime(Math.min(50, ms - elapsed));
    await deliverMessages();
  }
}

/**
 * How `promise` settles while fake time advances by up to `ms`. "pending" when it has not
 * settled by then (never a hung test).
 */
export async function settleWithin<T>(promise: Promise<T>, ms: number) {
  let outcome: { value: T } | { error: string } | "pending" = "pending";
  promise.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error: String(error) })
  );
  await advanceFakeTime(ms, () => outcome !== "pending");
  return outcome;
}
