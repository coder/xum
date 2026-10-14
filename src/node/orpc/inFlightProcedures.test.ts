import { describe, expect, test } from "bun:test";
import { createRouterClient, ORPCError, os } from "@orpc/server";
import { FlightRecorder } from "@/node/services/perf/flightRecorder";
import {
  inFlightProcedureCount,
  inFlightProcedureMiddleware,
  trackInFlightProcedure,
} from "./inFlightProcedures";

const admit = () => true;
const refuse = () => false;

describe("in-flight procedure tracking", () => {
  test("counts calls for their whole duration and settles on failure too", async () => {
    let release!: () => void;
    const pending = trackInFlightProcedure(
      ["workspace", "remove"],
      admit,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    expect(inFlightProcedureCount()).toBe(1);
    release();
    await pending;
    expect(inFlightProcedureCount()).toBe(0);
    let failed = false;
    try {
      await trackInFlightProcedure(["project", "create"], admit, () =>
        Promise.reject(new Error("boom"))
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(inFlightProcedureCount()).toBe(0);
  });

  test("the install call never blocks its own restart, even once shutdown has begun", async () => {
    let release!: () => void;
    const pending = trackInFlightProcedure(
      ["update", "install"],
      refuse,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    expect(inFlightProcedureCount()).toBe(0);
    release();
    await pending;
  });

  test("refuses every other call once shutdown has begun without running it", async () => {
    let ran = false;
    let error: unknown;
    try {
      await trackInFlightProcedure(["workspace", "stageAttachment"], refuse, () => {
        ran = true;
        return Promise.resolve();
      });
    } catch (caught) {
      error = caught;
    }
    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe("SERVICE_UNAVAILABLE");
    expect(inFlightProcedureCount()).toBe(0);
  });
});

describe("in-flight procedure middleware rpc recording", () => {
  function createClient() {
    let nowMs = 1_000_000;
    // Inert probes and a manual scheduler: only the rpc recording is under test.
    const recorder = new FlightRecorder({
      probes: {
        createLoopDelayHistogram: () => ({
          enable: () => undefined,
          disable: () => undefined,
          reset: () => undefined,
          percentile: () => 0,
          min: 0,
          max: 0,
          count: 0,
        }),
        readEventLoopUtilization: () => ({ idleMs: 0, activeMs: 0 }),
        observeGc: () => ({ disconnect: () => undefined }),
        readHeap: () => ({ usedBytes: 0, totalBytes: 0, limitBytes: 0 }),
      },
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      now: () => nowMs,
    });
    // Every handler takes 2.5 s on the fake clock, so each recorded call is also a slow span.
    const slow = () => {
      nowMs += 2500;
    };
    const t = os
      .$context<{ perfFlightRecorder: FlightRecorder }>()
      .use(inFlightProcedureMiddleware);
    const businessError = new ORPCError("CONFLICT", { message: "taken" });
    const plainError = new Error("boom");
    // t.router re-applies t's middleware to every procedure, like the real router does.
    const routes = t.router({
      ok: t.handler(() => {
        slow();
        return "done";
      }),
      conflict: t.handler(() => {
        slow();
        throw businessError;
      }),
      crash: t.handler(() => {
        slow();
        throw plainError;
      }),
      stream: t.handler(async function* () {
        slow();
        await Promise.resolve();
        yield 1;
        yield 2;
      }),
    });
    const client = createRouterClient(routes, { context: { perfFlightRecorder: recorder } });
    return { client, recorder, businessError, plainError };
  }

  test("records ok and failed calls once each and rethrows the original error", async () => {
    const { client, recorder, businessError, plainError } = createClient();
    recorder.setEnabled(true);
    expect(await client.ok()).toBe("done");
    expect(await client.conflict().catch((error: unknown) => error)).toBe(businessError);
    expect(await client.crash().catch((error: unknown) => error)).toBe(plainError);

    const rpc = recorder.getSnapshot().rpc;
    expect(
      rpc.procedures.map(({ path, count, errorCount }) => ({ path, count, errorCount }))
    ).toEqual([
      { path: "ok", count: 1, errorCount: 0 },
      { path: "conflict", count: 1, errorCount: 1 },
      { path: "crash", count: 1, errorCount: 1 },
    ]);
    expect(rpc.slowCalls.map(({ path, ok, errorCode }) => ({ path, ok, errorCode }))).toEqual([
      { path: "ok", ok: true, errorCode: undefined },
      { path: "conflict", ok: false, errorCode: "CONFLICT" },
      { path: "crash", ok: false, errorCode: "UNKNOWN" },
    ]);
  });

  test("a subscription install is not recorded as a call", async () => {
    const { client, recorder } = createClient();
    recorder.setEnabled(true);
    const values: number[] = [];
    for await (const value of await client.stream()) values.push(value);
    expect(values).toEqual([1, 2]);
    expect(recorder.getSnapshot().rpc.procedures).toEqual([]);
    expect(recorder.getSnapshot().rpc.slowCalls).toEqual([]);
  });
});
