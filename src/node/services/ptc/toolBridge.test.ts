/**
 * Tests for ToolBridge
 */

import { describe, it, expect, mock } from "bun:test";
import { ToolBridge, type KernelBridgeOptions } from "./toolBridge";
import type { Tool } from "ai";
import type { IJSRuntime, RuntimeLimits } from "./runtime";
import type { PTCEvent, PTCExecutionResult } from "./types";
import { z } from "zod";

// Helper to create a mock runtime for testing
function createMockRuntime(overrides: Partial<IJSRuntime> = {}): IJSRuntime {
  const defaultResult: PTCExecutionResult = {
    success: true,
    result: undefined,
    toolCalls: [],
    consoleOutput: [],
    duration_ms: 0,
  };

  return {
    eval: mock(() => Promise.resolve(defaultResult)),
    registerFunction: mock((_name: string, _fn: () => Promise<unknown>) => undefined),
    registerObject: mock(
      (_name: string, _obj: Record<string, () => Promise<unknown>>) => undefined
    ),
    registerPromiseFunction: mock((_name: string, _fn: () => Promise<unknown>) => undefined),
    registerSyncFunction: mock((_name: string, _fn: () => unknown) => undefined),
    setVarsProperty: mock((_key: string, _value: string) => undefined),
    setKernelRecordBounds: mock(() => undefined),
    setPendingJobGate: mock((_gate: (run: () => void) => void) => undefined),
    setLimits: mock((_limits: RuntimeLimits) => undefined),
    onEvent: mock((_handler: (event: PTCEvent) => void) => undefined),
    abort: mock(() => undefined),
    getAbortSignal: mock(() => undefined),
    dispose: mock(() => undefined),
    [Symbol.dispose]: mock(() => undefined),
    ...overrides,
  };
}

// Create a mock tool for testing - executeFn can be sync, will be wrapped
function createMockTool(
  name: string,
  schema: z.ZodType,
  executeFn?: (args: unknown) => unknown
): Tool {
  const tool: Tool = {
    description: `Mock ${name} tool`,
    inputSchema: schema,
    ...(executeFn ? { execute: (args) => Promise.resolve(executeFn(args)) } : {}),
  };
  return tool;
}

describe("ToolBridge", () => {
  describe("constructor", () => {
    it("filters out excluded tools", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        code_execution: createMockTool("code_execution", z.object({}), () => ({})),
        ask_user_question: createMockTool("ask_user_question", z.object({}), () => ({})),
        propose_plan: createMockTool("propose_plan", z.object({}), () => ({})),
        todo_write: createMockTool("todo_write", z.object({}), () => ({})),
        todo_read: createMockTool("todo_read", z.object({}), () => ({})),
        status_set: createMockTool("status_set", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toEqual(["file_read"]);
      expect(names).not.toContain("code_execution");
      expect(names).not.toContain("ask_user_question");
      expect(names).not.toContain("propose_plan");
      expect(names).not.toContain("todo_write");
      expect(names).not.toContain("todo_read");
      expect(names).not.toContain("status_set");
    });

    it("filters out tools without execute function", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        web_search: createMockTool("web_search", z.object({})), // No execute
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toEqual(["file_read"]);
      expect(names).not.toContain("web_search");
    });
  });

  describe("getBridgeableToolNames", () => {
    it("returns list of bridgeable tool names", () => {
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
        bash: createMockTool("bash", z.object({}), () => ({})),
        web_fetch: createMockTool("web_fetch", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      const names = bridge.getBridgeableToolNames();

      expect(names).toHaveLength(3);
      expect(names).toContain("file_read");
      expect(names).toContain("bash");
      expect(names).toContain("web_fetch");
    });
  });

  describe("register", () => {
    it("registers the same tools object under xum and mux", () => {
      const mockRegisterObject = mock(
        (_name: string, _obj: Record<string, () => Promise<unknown>>) => undefined
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), () => ({})),
      };

      const bridge = new ToolBridge(tools);
      bridge.register(mockRuntime);

      expect(mockRegisterObject).toHaveBeenCalledTimes(2);
      const calls = mockRegisterObject.mock.calls as unknown as Array<
        [string, Record<string, unknown>]
      >;
      expect(calls.map(([name]) => name)).toEqual(["xum", "mux"]);
      const [, xumObj] = calls[0];
      const [, muxObj] = calls[1];
      expect(muxObj).toBe(xumObj);
      expect(typeof xumObj.file_read).toBe("function");
    });

    it("enforces capability grants: denied tools are excluded, stubbed, and never leak", async () => {
      const executed = mock(() => ({ result: "ok" }));
      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({}), executed),
        bash: createMockTool("bash", z.object({}), executed),
      };

      const bridge = new ToolBridge(tools, {
        version: 1,
        bridgeTools: { allow: ["file_read"] },
        vars: false,
        hostEvents: false,
      });

      // Denied tool is not advertised as bridgeable...
      expect(bridge.getBridgeableToolNames()).toEqual(["file_read"]);
      // ...and must not leak into the model-visible non-bridgeable set either.
      expect(Object.keys(bridge.getNonBridgeableTools())).toEqual([]);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      bridge.register(createMockRuntime({ registerObject: mockRegisterObject }));

      // Granted tool executes.
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      await fileRead({});
      expect(executed).toHaveBeenCalledTimes(1);

      // Denied tool is stubbed with a clear capability error, not a crash.
      const bash = registeredMux.bash as (...args: unknown[]) => Promise<unknown>;
      try {
        await bash({});
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Capability denied: xum.bash is not granted");
      }
      expect(executed).toHaveBeenCalledTimes(1); // bash never ran
    });

    it("validates arguments before executing tool", async () => {
      const mockExecute = mock(() => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      // Create a simple mock runtime that captures registered functions
      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      bridge.register(mockRuntime);

      // Call with invalid args - should throw
      // Type assertion needed because Record indexing returns T | undefined for ESLint
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      try {
        await fileRead({ wrongField: "test" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Invalid arguments for file_read");
      }

      // Call with valid args - should succeed
      await fileRead({ filePath: "test.txt" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("serializes non-JSON values", async () => {
      // Tool that returns a non-plain object (with circular reference)
      const circularObj: Record<string, unknown> = { a: 1 };
      circularObj.self = circularObj;

      const mockExecute = mock(() => circularObj);

      const tools: Record<string, Tool> = {
        circular: createMockTool("circular", z.object({}), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, () => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      const mockRuntime = createMockRuntime({ registerObject: mockRegisterObject });

      bridge.register(mockRuntime);

      const result = await registeredMux.circular({});
      expect(result).toEqual({ error: "Result not JSON-serializable" });
    });

    it("uses runtime abort signal for tool cancellation", async () => {
      const mockExecute = mock((_args: unknown) => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, () => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );
      // Provide an abort signal via getAbortSignal
      const abortController = new AbortController();
      const mockRuntime = createMockRuntime({
        registerObject: mockRegisterObject,
        getAbortSignal: () => abortController.signal,
      });

      bridge.register(mockRuntime);

      await registeredMux.file_read({ filePath: "test.txt" });
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it("throws if runtime abort signal is already aborted", async () => {
      const mockExecute = mock(() => ({ result: "ok" }));

      const tools: Record<string, Tool> = {
        file_read: createMockTool("file_read", z.object({ filePath: z.string() }), mockExecute),
      };

      const bridge = new ToolBridge(tools);

      let registeredMux: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      const mockRegisterObject = mock(
        (name: string, obj: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
          if (name === "mux") registeredMux = obj;
          return undefined;
        }
      );

      // Pre-abort the signal
      const abortController = new AbortController();
      abortController.abort();
      const mockRuntime = createMockRuntime({
        registerObject: mockRegisterObject,
        getAbortSignal: () => abortController.signal,
      });

      bridge.register(mockRuntime);

      // Type assertion needed because Record indexing returns T | undefined for ESLint
      const fileRead = registeredMux.file_read as (...args: unknown[]) => Promise<unknown>;
      try {
        await fileRead({ filePath: "test.txt" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Execution aborted");
      }
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("RLM kernel namespace (task_spawn + events)", () => {
    const taskSchema = z.object({
      prompt: z.string(),
      title: z.string(),
      run_in_background: z.boolean().nullish(),
    });

    interface Captured {
      mux: Record<string, (...args: unknown[]) => Promise<unknown>>;
      sync: Record<string, (...args: unknown[]) => unknown>;
    }

    function registerCapturing(
      bridge: ToolBridge,
      kernel?: KernelBridgeOptions,
      runtimeOverrides: Partial<IJSRuntime> = {}
    ) {
      const captured: Captured = { mux: {}, sync: {} };
      const mockRuntime = createMockRuntime({
        registerObject: (
          name: string,
          obj: Record<string, (...args: unknown[]) => Promise<unknown>>,
          syncMethods?: Record<string, (...args: unknown[]) => unknown>
        ) => {
          if (name === "mux") {
            captured.mux = obj;
            captured.sync = syncMethods ?? {};
          }
        },
        ...runtimeOverrides,
      });
      bridge.register(mockRuntime, kernel);
      return captured;
    }

    it("without kernel options, task_spawn and events are absent from the namespace", () => {
      const bridge = new ToolBridge({
        task: createMockTool("task", taskSchema, () => ({ taskId: "t1", status: "queued" })),
      });
      const captured = registerCapturing(bridge);
      expect(captured.mux.task_spawn).toBeUndefined();
      expect(captured.sync.events).toBeUndefined();
    });

    it("task_spawn forces run_in_background and returns the admission handle without waiting", async () => {
      let receivedArgs: unknown;
      const taskTool = createMockTool("task", taskSchema, (args) => {
        receivedArgs = args;
        // Background admission result: returned immediately after create.
        return { status: "queued", taskId: "child-1" };
      });

      const bridge = new ToolBridge({ task: taskTool });
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      const handle = await taskSpawn({
        prompt: "do it",
        title: "Worker",
        run_in_background: false, // guest cannot opt out of background admission
      });
      expect(handle).toEqual({ taskId: "child-1", status: "spawned" });
      expect((receivedArgs as { run_in_background?: boolean }).run_in_background).toBe(true);
    });

    it("task_spawn maps grouped admissions to taskIds", async () => {
      const taskTool = createMockTool("task", taskSchema, () => ({
        status: "queued",
        taskIds: ["c1", "c2"],
      }));
      const bridge = new ToolBridge({ task: taskTool });
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      expect(await taskSpawn({ prompt: "p", title: "T" })).toEqual({
        taskIds: ["c1", "c2"],
        status: "spawned",
      });
    });

    it("concurrent task_spawn calls receive distinct toolCallIds", async () => {
      // The task tool derives its best-of group ID from toolCallId, so two
      // grouped spawns launched in the same millisecond (Promise.all) must
      // not share an ID — colliding IDs merge independent launches into one
      // cohort and mix completion/winner selection across prompts.
      const seenToolCallIds: string[] = [];
      const taskTool: Tool = {
        description: "Mock task tool",
        inputSchema: taskSchema,
        execute: (_args, options) => {
          seenToolCallIds.push(options.toolCallId);
          return Promise.resolve({ status: "queued", taskId: `child-${seenToolCallIds.length}` });
        },
      };
      const bridge = new ToolBridge({ task: taskTool });
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      // 20 concurrent launches: with millisecond-timestamp IDs these land in
      // the same ms and collide; collision-free IDs must all be unique.
      await Promise.all(
        Array.from({ length: 20 }, (_v, i) => taskSpawn({ prompt: `p${i}`, title: "T" }))
      );
      expect(seenToolCallIds).toHaveLength(20);
      expect(new Set(seenToolCallIds).size).toBe(20);
    });

    it("task_spawn is denied by the same grant as task", async () => {
      const executed = mock(() => ({ status: "queued", taskId: "never" }));
      const bridge = new ToolBridge(
        { task: createMockTool("task", taskSchema, executed) },
        { version: 1, bridgeTools: { allow: [] }, vars: true, hostEvents: true }
      );
      const captured = registerCapturing(bridge, { drainHostEvents: () => [] });

      const taskSpawn = captured.mux.task_spawn as (...args: unknown[]) => Promise<unknown>;
      try {
        await taskSpawn({ prompt: "p", title: "T" });
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(String(e)).toContain("Capability denied: mux.task_spawn is not granted");
      }
      expect(executed).not.toHaveBeenCalled();
    });

    it("events drains the kernel queue; denied without the hostEvents grant", () => {
      const queue: unknown[] = [{ type: "task-terminal", taskId: "c1" }];
      const bridge = new ToolBridge({
        task: createMockTool("task", taskSchema, () => ({ taskId: "t", status: "queued" })),
      });
      const captured = registerCapturing(bridge, {
        drainHostEvents: () => queue.splice(0, queue.length),
      });
      expect(captured.sync.events()).toEqual([{ type: "task-terminal", taskId: "c1" }]);
      expect(captured.sync.events()).toEqual([]);

      const denied = new ToolBridge(
        { task: createMockTool("task", taskSchema, () => ({ taskId: "t", status: "queued" })) },
        { version: 1, bridgeTools: { allow: "all" }, vars: true, hostEvents: false }
      );
      const deniedCaptured = registerCapturing(denied, { drainHostEvents: () => [] });
      expect(() => deniedCaptured.sync.events()).toThrow(
        /Capability denied: mux\.events is not granted/
      );
    });

    describe("mux.load", () => {
      const fileReadTool = () =>
        createMockTool("file_read", z.object({ path: z.string() }), () => ({ content: "x" }));
      const loaded = {
        content: "line1\nline2",
        bytes: 11,
        lines: 2,
        preview: "line1\nline2",
      };

      it("writes content into vars via the runtime and returns only the bounded summary", async () => {
        const setVarsProperty = mock((_key: string, _value: string) => undefined);
        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(
          bridge,
          { drainHostEvents: () => [], loadFile: () => Promise.resolve(loaded) },
          { setVarsProperty }
        );
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        const summary = await load({ path: "a.txt", key: "data" });
        // Content reaches the guest heap through setVarsProperty only.
        expect(setVarsProperty).toHaveBeenCalledWith("data", loaded.content);
        expect(summary).toEqual({ key: "data", bytes: 11, lines: 2, preview: "line1\nline2" });
      });

      it("tracks successful load keys host-side, immune to record bounding (r67)", async () => {
        // Retention bookkeeping must not depend on the model-visible record:
        // an oversized hookResult annotation can get a load record replaced
        // by a keyless __kernelBounded marker, so keys are recorded at the
        // moment the vars write succeeds and drained by code_execution.
        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(
          bridge,
          { drainHostEvents: () => [], loadFile: () => Promise.resolve(loaded) },
          { setVarsProperty: mock((_key: string, _value: string) => undefined) }
        );
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        await load({ path: "a.txt", key: "data" });
        await load({ path: "a.txt", key: "data" }); // same key: deduplicated
        await load({ path: "b.txt", key: "other" });
        expect(bridge.drainNewlyLoadedVarsKeys()).toEqual(["data", "other"]);
        // One-shot drain: the next call yields only newer loads.
        expect(bridge.drainNewlyLoadedVarsKeys()).toEqual([]);
      });

      it("passes the kernel abort signal to the loader and refuses to mutate vars after abort", async () => {
        // Without propagation, a stalled remote read rides RemoteRuntime's
        // 300s cat timeout regardless of the execution deadline; and an abort
        // landing mid-read must not write the loaded content into vars.
        const controller = new AbortController();
        const setVarsProperty = mock((_key: string, _value: string) => undefined);
        let loaderSignal: AbortSignal | undefined;
        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(
          bridge,
          {
            drainHostEvents: () => [],
            loadFile: (args: { path: string; abortSignal?: AbortSignal }) => {
              loaderSignal = args.abortSignal;
              // Abort lands while the read is in flight.
              controller.abort();
              return Promise.resolve(loaded);
            },
          },
          { setVarsProperty, getAbortSignal: () => controller.signal }
        );
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await load({ path: "a.txt", key: "data" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("Execution aborted");
        }
        expect(loaderSignal).toBe(controller.signal);
        expect(setVarsProperty).not.toHaveBeenCalled();
        // A load that never wrote vars must not register a retention key (r67).
        expect(bridge.drainNewlyLoadedVarsKeys()).toEqual([]);
      });

      it("is absent without a loader, and absent when file_read is not bridged", () => {
        const noLoader = registerCapturing(new ToolBridge({ file_read: fileReadTool() }), {
          drainHostEvents: () => [],
        });
        expect(noLoader.mux.load).toBeUndefined();

        const noFileRead = registerCapturing(new ToolBridge({}), {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        expect(noFileRead.mux.load).toBeUndefined();
      });

      it("is denied by file_read's grant and rejects reserved keys", async () => {
        const denied = new ToolBridge(
          { file_read: fileReadTool() },
          { version: 1, bridgeTools: { allow: [] }, vars: true, hostEvents: true }
        );
        const deniedCaptured = registerCapturing(denied, {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        const deniedLoad = deniedCaptured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await deniedLoad({ path: "a.txt", key: "data" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("Capability denied: mux.load is not granted");
        }

        const bridge = new ToolBridge({ file_read: fileReadTool() });
        const captured = registerCapturing(bridge, {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await load({ path: "a.txt", key: "__handleSeq" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("reserved");
        }
      });

      it("requires the vars grant (content has nowhere to live without it)", async () => {
        const bridge = new ToolBridge(
          { file_read: fileReadTool() },
          { version: 1, bridgeTools: { allow: "all" }, vars: false, hostEvents: true }
        );
        const captured = registerCapturing(bridge, {
          drainHostEvents: () => [],
          loadFile: () => Promise.resolve(loaded),
        });
        const load = captured.mux.load as (...args: unknown[]) => Promise<unknown>;
        try {
          await load({ path: "a.txt", key: "data" });
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(String(e)).toContain("requires the vars grant");
        }
      });
    });
  });
});
