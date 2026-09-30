import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { withSequentialExecution } from "./withSequentialExecution";
import { markBuiltInTaskTool } from "./task";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] | undefined;
  let reject: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  if (!resolve || !reject) {
    throw new Error("createDeferred failed to initialize promise controls");
  }

  return { promise, resolve, reject };
}

function callWrappedExecute(
  toolRecord: Record<string, unknown>,
  args: unknown,
  options: unknown
): Promise<unknown> {
  const execute = toolRecord.execute;
  if (typeof execute !== "function") {
    throw new Error("Expected wrapped tool execute handler");
  }

  const invoke = execute as (args: unknown, options: unknown) => unknown;
  return Promise.resolve(invoke(args, options));
}

describe("withSequentialExecution", () => {
  test("serializes sibling execute handlers in invocation order", async () => {
    const executionLog: string[] = [];
    const started = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
      c: createDeferred<void>(),
    };
    const release = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
      c: createDeferred<void>(),
    };

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start A");
          started.a.resolve();
          await release.a.promise;
          executionLog.push("end A");
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start B");
          started.b.resolve();
          await release.b.promise;
          executionLog.push("end B");
          return { tool: "B" };
        },
      }),
      c: tool({
        description: "Tool C",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start C");
          started.c.resolve();
          await release.c.promise;
          executionLog.push("end C");
          return { tool: "C" };
        },
      }),
    };

    const wrappedTools = withSequentialExecution(tools);
    expect(wrappedTools).toBeDefined();
    expect(wrappedTools).not.toBe(tools);
    expect(wrappedTools!.a).not.toBe(tools.a);
    expect(wrappedTools!.b).not.toBe(tools.b);
    expect(wrappedTools!.c).not.toBe(tools.c);

    const resultsPromise = Promise.all([
      wrappedTools!.a.execute!({}, {} as never),
      wrappedTools!.b.execute!({}, {} as never),
      wrappedTools!.c.execute!({}, {} as never),
    ]);

    await started.a.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A"]);

    release.a.resolve();
    await started.b.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A", "end A", "start B"]);

    release.b.resolve();
    await started.c.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start A", "end A", "start B", "end B", "start C"]);

    release.c.resolve();
    const results = await resultsPromise;

    expect(results).toEqual([{ tool: "A" }, { tool: "B" }, { tool: "C" }]);
    expect(executionLog).toEqual(["start A", "end A", "start B", "end B", "start C", "end C"]);
  });

  test("reports execution start only after the lock is acquired", async () => {
    const events: string[] = [];
    const startedA = createDeferred<void>();
    const releaseA = createDeferred<void>();

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          events.push("run A");
          startedA.resolve();
          await releaseA.promise;
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: () => {
          events.push("run B");
          return Promise.resolve({ tool: "B" });
        },
      }),
    };

    const wrappedTools = withSequentialExecution(tools, (toolCallId) => {
      events.push(`execution-start ${toolCallId}`);
    });

    const resultsPromise = Promise.all([
      callWrappedExecute(wrappedTools!.a as Record<string, unknown>, {}, { toolCallId: "call-a" }),
      callWrappedExecute(wrappedTools!.b as Record<string, unknown>, {}, { toolCallId: "call-b" }),
    ]);

    await startedA.promise;
    await Promise.resolve();
    // B is queued behind A: its execution start must not have been reported yet.
    expect(events).toEqual(["execution-start call-a", "run A"]);

    releaseA.resolve();
    await resultsPromise;
    expect(events).toEqual(["execution-start call-a", "run A", "execution-start call-b", "run B"]);
  });

  test("does not execute queued siblings after stream abort", async () => {
    const executionLog: string[] = [];
    const startedA = createDeferred<void>();
    const releaseA = createDeferred<void>();
    let startedB = false;

    const tools = {
      a: tool({
        description: "Tool A",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start A");
          startedA.resolve();
          await releaseA.promise;
          executionLog.push("end A");
          return { tool: "A" };
        },
      }),
      b: tool({
        description: "Tool B",
        inputSchema: z.object({}),
        execute: () => {
          startedB = true;
          executionLog.push("start B");
          return { tool: "B" };
        },
      }),
    };

    const wrappedTools = withSequentialExecution(tools);
    expect(wrappedTools).toBeDefined();

    const controller = new AbortController();
    const firstPromise = callWrappedExecute(
      wrappedTools!.a as Record<string, unknown>,
      {},
      {} as never
    );
    await startedA.promise;

    const secondPromise = callWrappedExecute(wrappedTools!.b as Record<string, unknown>, {}, {
      abortSignal: controller.signal,
    } as never);
    controller.abort();

    try {
      await secondPromise;
      throw new Error("Expected queued tool to reject after abort");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Interrupted");
    }
    expect(startedB).toBe(false);
    expect(executionLog).toEqual(["start A"]);

    releaseA.resolve();
    expect(await firstPromise).toEqual({ tool: "A" });
    await Promise.resolve();
    expect(startedB).toBe(false);
    expect(executionLog).toEqual(["start A", "end A"]);
  });

  test("runs forked built-in explore tasks in parallel while writers wait", async () => {
    const executionLog: string[] = [];
    const started = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
      writer: createDeferred<void>(),
    };
    const release = {
      a: createDeferred<void>(),
      b: createDeferred<void>(),
      writer: createDeferred<void>(),
    };

    const tools = {
      task: markBuiltInTaskTool(
        tool({
          description: "Task",
          inputSchema: z.object({
            id: z.enum(["a", "b"]),
            agentId: z.string(),
            isolation: z.string().optional(),
          }),
          execute: async ({ id }: { id: "a" | "b" }) => {
            executionLog.push(`start ${id}`);
            started[id].resolve();
            await release[id].promise;
            executionLog.push(`end ${id}`);
            return { task: id };
          },
        })
      ),
      bash: tool({
        description: "Writer",
        inputSchema: z.object({}),
        execute: async () => {
          executionLog.push("start writer");
          started.writer.resolve();
          await release.writer.promise;
          executionLog.push("end writer");
          return { tool: "writer" };
        },
      }),
    };

    const wrappedTools = withSequentialExecution(tools)!;
    const resultsPromise = Promise.all([
      callWrappedExecute(
        wrappedTools.task as Record<string, unknown>,
        { id: "a", agentId: "explore" },
        {} as never
      ),
      callWrappedExecute(
        wrappedTools.task as Record<string, unknown>,
        { id: "b", agentId: "explore" },
        {} as never
      ),
      callWrappedExecute(wrappedTools.bash as Record<string, unknown>, {}, {} as never),
    ]);

    await started.a.promise;
    await started.b.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start a", "start b"]);

    release.a.resolve();
    await Promise.resolve();
    expect(executionLog).toEqual(["start a", "start b", "end a"]);

    release.b.resolve();
    await started.writer.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start a", "start b", "end a", "end b", "start writer"]);

    release.writer.resolve();
    const results = await resultsPromise;
    expect(results).toEqual([{ task: "a" }, { task: "b" }, { tool: "writer" }]);
  });

  test("keeps shared-workspace explore tasks serialized", async () => {
    const executionLog: string[] = [];
    const startedA = createDeferred<void>();
    const releaseA = createDeferred<void>();
    let startedB = false;

    const tools = {
      task: markBuiltInTaskTool(
        tool({
          description: "Task",
          inputSchema: z.object({ agentId: z.string(), isolation: z.string().optional() }),
          execute: async ({ isolation }: { isolation?: string }) => {
            executionLog.push(`start ${isolation ?? "fork"}`);
            if (isolation === "none") {
              if (!startedB) {
                startedA.resolve();
                await releaseA.promise;
                executionLog.push("end first");
              } else {
                executionLog.push("start second");
              }
            }
            return { ok: true };
          },
        })
      ),
    };

    const wrappedTools = withSequentialExecution(tools)!;
    const firstPromise = callWrappedExecute(
      wrappedTools.task as Record<string, unknown>,
      { agentId: "explore", isolation: "none" },
      {} as never
    );
    await startedA.promise;

    const secondPromise = callWrappedExecute(
      wrappedTools.task as Record<string, unknown>,
      { agentId: "explore", isolation: "none" },
      {} as never
    );
    await Promise.resolve();
    expect(executionLog).toEqual(["start none"]);

    startedB = true;
    releaseA.resolve();
    await firstPromise;
    await secondPromise;
    expect(executionLog).toEqual(["start none", "end first", "start none", "start second"]);
  });

  test("treats non-canonical explore agent ids as readers (trim + lowercase)", async () => {
    // The task inputSchema passes the raw agentId through; classification must mirror the schema's
    // trim()/toLowerCase() normalization so " Explore " / "EXPLORE" still share the reader lock.
    const executionLog: string[] = [];
    const started = { a: createDeferred<void>(), b: createDeferred<void>() };
    const release = { a: createDeferred<void>(), b: createDeferred<void>() };

    const tools = {
      task: markBuiltInTaskTool(
        tool({
          description: "Task",
          inputSchema: z.object({ id: z.enum(["a", "b"]), agentId: z.string() }),
          execute: async ({ id }: { id: "a" | "b" }) => {
            executionLog.push(`start ${id}`);
            started[id].resolve();
            await release[id].promise;
            return { task: id };
          },
        })
      ),
    };

    const wrappedTools = withSequentialExecution(tools)!;
    const resultsPromise = Promise.all([
      callWrappedExecute(
        wrappedTools.task as Record<string, unknown>,
        { id: "a", agentId: " Explore " },
        {} as never
      ),
      callWrappedExecute(
        wrappedTools.task as Record<string, unknown>,
        { id: "b", agentId: "EXPLORE" },
        {} as never
      ),
    ]);

    // Both overlap before either finishes — proving they share the reader lock despite casing.
    await started.a.promise;
    await started.b.promise;
    await Promise.resolve();
    expect(executionLog).toEqual(["start a", "start b"]);

    release.a.resolve();
    release.b.resolve();
    const results = await resultsPromise;
    expect(results).toEqual([{ task: "a" }, { task: "b" }]);
  });
});
