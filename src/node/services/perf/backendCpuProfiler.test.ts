/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { describe, expect, test } from "bun:test";
import { createBackendCpuProfiler, type InspectorSessionLike } from "./backendCpuProfiler";

/** Records CDP posts; `failOn` makes one method reject. */
class FakeSession implements InspectorSessionLike {
  readonly posts: string[] = [];
  connected = false;
  disconnects = 0;
  constructor(private readonly failOn?: string) {}
  connect(): void {
    this.connected = true;
  }
  post(method: string): Promise<unknown> {
    this.posts.push(method);
    if (!this.connected) return Promise.reject(new Error("not connected"));
    if (method === this.failOn) return Promise.reject(new Error(`${method} failed`));
    if (method === "Profiler.stop") return Promise.resolve({ profile: { nodes: [] } });
    return Promise.resolve({});
  }
  disconnect(): void {
    this.connected = false;
    this.disconnects += 1;
  }
}

function setup(options: { inspectorUrl?: string; failOn?: string } = {}) {
  const sessions: FakeSession[] = [];
  const profiler = createBackendCpuProfiler({
    createSession: () => {
      const session = new FakeSession(options.failOn);
      sessions.push(session);
      return session;
    },
    inspectorUrl: () => options.inspectorUrl,
  });
  return { profiler, sessions };
}

describe("createBackendCpuProfiler", () => {
  test("an exposed inspector endpoint skips without opening a session", async () => {
    const { profiler, sessions } = setup({ inspectorUrl: "ws://127.0.0.1:9229/abc" });
    await expect(profiler.start({ samplingIntervalUs: 1000 })).resolves.toEqual({
      ok: false,
      skippedReason: "inspector-open",
    });
    expect(sessions).toHaveLength(0);
  });

  test("stop returns the profile and disconnects once, even when stopped twice", async () => {
    const { profiler, sessions } = setup();
    const started = await profiler.start({ samplingIntervalUs: 1000 });
    if (!started.ok) throw new Error("expected a run");
    expect(await started.run.stop()).toEqual({ nodes: [] });
    await started.run.stop();
    await started.run.cancel();
    expect(sessions[0].disconnects).toBe(1);
    expect(sessions[0].posts.filter((method) => method === "Profiler.stop")).toHaveLength(1);
  });

  test("a failing start or stop still disconnects the session", async () => {
    const failedStart = setup({ failOn: "Profiler.start" });
    await expect(failedStart.profiler.start({ samplingIntervalUs: 1000 })).rejects.toThrow(
      "Profiler.start failed"
    );
    expect(failedStart.sessions[0].disconnects).toBe(1);

    const failedStop = setup({ failOn: "Profiler.stop" });
    const started = await failedStop.profiler.start({ samplingIntervalUs: 1000 });
    if (!started.ok) throw new Error("expected a run");
    await expect(started.run.stop()).rejects.toThrow("Profiler.stop failed");
    expect(failedStop.sessions[0].disconnects).toBe(1);
  });

  // While any inspector session is connected, V8 keeps every console.* argument it logs (up to
  // ~1000 messages), and a disconnect does not free them: an APICallError logged during an 8 s
  // capture kept its whole request body for the life of the process (F12, #6754).
  test("every release discards console entries before it disconnects", async () => {
    const discardedBeforeDisconnect = (session: FakeSession) =>
      session.posts.at(-1) === "Runtime.discardConsoleEntries" && session.disconnects === 1;

    const stopped = setup();
    const run = await stopped.profiler.start({ samplingIntervalUs: 1000 });
    if (!run.ok) throw new Error("expected a run");
    await run.run.stop();
    expect(discardedBeforeDisconnect(stopped.sessions[0])).toBe(true);

    const cancelled = setup();
    const cancelRun = await cancelled.profiler.start({ samplingIntervalUs: 1000 });
    if (!cancelRun.ok) throw new Error("expected a run");
    await cancelRun.run.cancel();
    expect(discardedBeforeDisconnect(cancelled.sessions[0])).toBe(true);

    // A failing discard must not keep the session connected.
    const failedDiscard = setup({ failOn: "Runtime.discardConsoleEntries" });
    const failRun = await failedDiscard.profiler.start({ samplingIntervalUs: 1000 });
    if (!failRun.ok) throw new Error("expected a run");
    expect(await failRun.run.stop()).toEqual({ nodes: [] });
    expect(failedDiscard.sessions[0].disconnects).toBe(1);
  });

  test("cancel releases the session without stopping through it", async () => {
    const { profiler, sessions } = setup();
    const started = await profiler.start({ samplingIntervalUs: 1000 });
    if (!started.ok) throw new Error("expected a run");
    await started.run.cancel();
    await started.run.cancel();
    expect(sessions[0].disconnects).toBe(1);
    await expect(started.run.stop()).rejects.toThrow("already released");
  });
});
