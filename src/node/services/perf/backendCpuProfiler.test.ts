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
