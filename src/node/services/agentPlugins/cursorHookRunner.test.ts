import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExecOptions, ExecStream, Runtime, RuntimeLocation } from "@/node/runtime/Runtime";
import { FakeRuntime } from "@/node/runtime/fakeRuntime.testHarness";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ScriptTable } from "@/node/services/hostProcesses/scriptedCommands.testHarness";
import { createFixedMemfs } from "@/node/services/sessionFiles/memorySessionFiles.testHarness";
import { EventSpine, type ToolExecuteContext } from "@/node/services/events/eventSpine";
import { DisposableTempDir } from "@/node/services/tempDir";
import type { PluginHookDefinition } from "./codexHooks";
import { loadPluginCursorHooks } from "./cursorHooks";
import { registerCursorPluginHooks, type CursorHookGate } from "./cursorHookRunner";
import { nodePluginFs } from "./discovery";
import { runTurnStopHooks, type TurnStopHookOutcome } from "./promptHooks";

const workspaceId = "ws-cursor";
const instanceId = "abc123";
const pluginRoot = "/plugins/ralph";
const workspaceRoot = "/work/repo";
const transcriptPath = "/home/u/.xum/sessions/ws-cursor/chat.jsonl";

async function hooksOf(hooks: Record<string, Array<Record<string, unknown>>>) {
  const result = await loadPluginCursorHooks({
    rootPath: pluginRoot,
    source: { version: 1, hooks },
    fs: nodePluginFs,
  });
  return result.hooks;
}

/** `location: null` builds a runtime without a family, as a multi-project runtime is. */
function fakeRuntime(commands: ScriptTable, location: RuntimeLocation | null = "local") {
  return new FakeRuntime(createFixedMemfs(), {
    userHome: "/home/u",
    xumHome: "/home/u/.xum",
    tempDir: "/tmp",
    commands,
    ...(location !== null ? { location } : {}),
  });
}

function withExecHook(inner: Runtime, onExec: (command: string) => void): Runtime {
  return Object.assign(Object.create(inner) as Runtime, {
    exec: (command: string, options: ExecOptions): Promise<ExecStream> => {
      const started = inner.exec(command, options);
      onExec(command);
      return started;
    },
  });
}

interface Harness {
  spine: EventSpine;
  notices: string[];
  stop: (
    overrides?: Partial<Parameters<typeof runTurnStopHooks>[2]>
  ) => Promise<TurnStopHookOutcome>;
  edit: (toolName: string, args: Record<string, unknown>, result: unknown) => Promise<void>;
}

function harness(args: {
  hooks: PluginHookDefinition[];
  runtime: Runtime;
  gate?: (hook: PluginHookDefinition) => CursorHookGate | Promise<CursorHookGate>;
}): Harness {
  const spine = new EventSpine();
  const notices: string[] = [];
  registerCursorPluginHooks(spine, {
    workspaceId,
    pluginName: "ralph",
    pluginInstanceId: instanceId,
    pluginRoot,
    transcriptPath,
    cursorVersion: "xum-v1.2.3",
    order: 0,
    hooks: args.hooks,
    deps: {
      checkHook: async (hook) => (args.gate ? args.gate(hook) : "allowed"),
      runtime: args.runtime,
      notifyUser: (message) => notices.push(message),
    },
  });
  return {
    spine,
    notices,
    stop: (overrides = {}) =>
      runTurnStopHooks(spine, workspaceId, {
        messageId: "msg-1",
        lastAssistantMessage: "All done. <promise>DONE</promise>",
        model: "anthropic:claude-opus-5-5",
        turnContinuations: 0,
        hookContinuations: new Map(),
        cwd: workspaceRoot,
        ...overrides,
      }),
    edit: async (toolName, toolArgs, result) => {
      const ctx: ToolExecuteContext = {
        toolName,
        args: toolArgs,
        host: {
          runtime: args.runtime,
          runtimeTempDir: "/tmp",
          cwd: workspaceRoot,
          workspaceId,
          turn: { turnId: "msg-2", model: "openai:gpt-6.1" },
        },
        executed: false,
      };
      await spine.run("tool.execute", ctx, (c) => {
        c.result = result;
        c.executed = true;
      });
    },
  };
}

const followup = (text: unknown) => ({ stdout: JSON.stringify({ followup_message: text }) });
const stdinOf = (runtime: FakeRuntime, index = 0) =>
  JSON.parse(runtime.execCalls[index].stdin) as Record<string, unknown>;

describe("Cursor hook input, environment and working folder", () => {
  test("stdin carries Cursor's common fields and the stop fields", async () => {
    const runtime = fakeRuntime({ "./stop.sh": {} });
    const h = harness({ hooks: await hooksOf({ stop: [{ command: "./stop.sh" }] }), runtime });
    await h.stop();
    expect(stdinOf(runtime)).toEqual({
      conversation_id: workspaceId,
      generation_id: "msg-1",
      model: "anthropic:claude-opus-5-5",
      hook_event_name: "stop",
      cursor_version: "xum-v1.2.3",
      workspace_roots: [workspaceRoot],
      user_email: null,
      transcript_path: transcriptPath,
      status: "completed",
      loop_count: 0,
    });
  });

  test("the environment has the Cursor variables and passes PATH and HOME, nothing else of Xum's", async () => {
    const runtime = fakeRuntime({ "./stop.sh": {} });
    const h = harness({ hooks: await hooksOf({ stop: [{ command: "./stop.sh" }] }), runtime });
    await h.stop();
    const options = runtime.execCalls[0].options;
    expect(options.hostEnv).toBe("minimal");
    expect(options.env).toEqual({
      CURSOR_PROJECT_DIR: workspaceRoot,
      CLAUDE_PROJECT_DIR: workspaceRoot,
      CURSOR_PLUGIN_ROOT: pluginRoot,
      CURSOR_TRANSCRIPT_PATH: transcriptPath,
      CURSOR_VERSION: "xum-v1.2.3",
      ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
    });
    expect(options.env).not.toHaveProperty("CURSOR_USER_EMAIL");
    expect(options.env).not.toHaveProperty("CURSOR_CODE_REMOTE");
  });

  test("stop runs in the workspace root, afterAgentResponse and afterFileEdit in the plugin folder", async () => {
    const runtime = fakeRuntime({ "./a.sh": {}, "./s.sh": {}, "./e.sh": {} });
    const h = harness({
      hooks: await hooksOf({
        afterAgentResponse: [{ command: "./a.sh" }],
        stop: [{ command: "./s.sh" }],
        afterFileEdit: [{ command: "./e.sh" }],
      }),
      runtime,
    });
    await h.stop();
    await h.edit("file_edit_insert", { path: "a.txt", content: "x" }, { success: true });
    expect(runtime.execCalls.map((call) => [call.command, call.options.cwd])).toEqual([
      ["./a.sh", pluginRoot],
      ["./s.sh", workspaceRoot],
      ["./e.sh", pluginRoot],
    ]);
    expect(stdinOf(runtime, 0).text).toBe("All done. <promise>DONE</promise>");
  });

  test("afterFileEdit runs after the two edit tools with Cursor's edits, not after bash or a failed edit", async () => {
    const runtime = fakeRuntime({ "./e.sh": {} });
    const h = harness({
      hooks: await hooksOf({ afterFileEdit: [{ command: "./e.sh" }] }),
      runtime,
    });
    await h.edit(
      "file_edit_replace_string",
      { path: "src/a.ts", old_string: "a", new_string: "b" },
      { success: true, diff: "", edits_applied: 1 }
    );
    await h.edit("file_edit_insert", { path: "/abs/b.ts", content: "new" }, { success: true });
    await h.edit("bash", { script: "echo x > a.ts" }, { success: true });
    await h.edit(
      "file_edit_replace_string",
      { path: "src/a.ts", old_string: "zz", new_string: "b" },
      { success: false, error: "old_string not found" }
    );
    expect(runtime.execCalls).toHaveLength(2);
    expect(stdinOf(runtime, 0)).toMatchObject({
      hook_event_name: "afterFileEdit",
      generation_id: "msg-2",
      file_path: path.posix.join(workspaceRoot, "src/a.ts"),
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(stdinOf(runtime, 1)).toMatchObject({
      file_path: "/abs/b.ts",
      edits: [{ old_string: "", new_string: "new" }],
    });
  });
});

describe("stop output and loop counts", () => {
  test("followup_message adds one reason keyed by plugin instance and hook; empty stdout adds none", async () => {
    const hooks = await hooksOf({ stop: [{ command: "./s.sh", loop_limit: 7 }] });
    const continued = await harness({
      hooks,
      runtime: fakeRuntime({ "./s.sh": followup("again") }),
    }).stop();
    expect(continued).toEqual({
      kind: "continue",
      reasons: [
        {
          text: "again",
          pluginName: "ralph",
          hookKey: `${instanceId}:cursor:plugin.json#hooks#stop[0]`,
          loopLimit: 7,
        },
      ],
    });
    const quiet = await harness({ hooks, runtime: fakeRuntime({ "./s.sh": {} }) }).stop();
    expect(quiet).toEqual({ kind: "none" });
  });

  test("loop_count is the user turn's continuations from any source, not the hook's own count", async () => {
    const runtime = fakeRuntime({ "./s.sh": {} });
    const h = harness({ hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }), runtime });
    await h.stop();
    // Another hook (or a Xum nudge) continued the turn once; this hook has no count of its own.
    await h.stop({ turnContinuations: 1, hookContinuations: new Map([["other:hook", 1]]) });
    expect(stdinOf(runtime, 0).loop_count).toBe(0);
    expect(stdinOf(runtime, 1).loop_count).toBe(1);
  });
});

describe("failures warn once and never block", () => {
  test.each([
    ["exit 2", { exitCode: 2 }],
    ["permission deny", { stdout: JSON.stringify({ permission: "deny", followup_message: "x" }) }],
    ["invalid JSON", { stdout: "{not json" }],
    ["a non-string followup_message", followup(3)],
    ["exit 1", { exitCode: 1, stdout: JSON.stringify({ followup_message: "x" }) }],
    ["stdout over 64 KiB", { stdout: "x".repeat(64 * 1024 + 1) }],
  ])("%s from stop adds no reason and one notice", async (_name, outcome) => {
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }),
      runtime: fakeRuntime({ "./s.sh": outcome }),
    });
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toStartWith("hook stop failed (");
    expect(h.notices[0]).toEndWith("). Turn the hook off in Settings > Plugins.");
  });

  test("exit 127 names both causes, once for two calls", async () => {
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./hooks/x.sh" }] }),
      runtime: fakeRuntime({ "./hooks/x.sh": { exitCode: 127 } }),
    });
    await h.stop();
    await h.stop();
    expect(h.notices).toEqual([
      "hook stop failed (`./hooks/x.sh`: a command or one of its dependencies was not found (exit 127)). Turn the hook off in Settings > Plugins.",
    ]);
  });

  test("failClosed: true changes nothing for stop: a crash adds no reason and one notice", async () => {
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./s.sh", failClosed: true }] }),
      runtime: fakeRuntime({ "./s.sh": { exitCode: 1 } }),
    });
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(h.notices).toHaveLength(1);
  });

  test("an input over HOOK_INPUT_MAX_CHARS skips the call with one notice", async () => {
    const runtime = fakeRuntime({ "./a.sh": {} });
    const h = harness({
      hooks: await hooksOf({ afterAgentResponse: [{ command: "./a.sh" }] }),
      runtime,
    });
    await h.stop({ lastAssistantMessage: "x".repeat(64 * 1024) });
    expect(runtime.execCalls).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("its input is over 65536 characters");
  });

  test("a trust gate that throws fails the call with one notice and runs nothing", async () => {
    const runtime = fakeRuntime({ "./s.sh": followup("again") });
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }),
      runtime,
      gate: () => {
        throw new Error("registry unreadable");
      },
    });
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(runtime.execCalls).toEqual([]);
    expect(h.notices).toEqual([
      "hook stop failed (registry unreadable). Turn the hook off in Settings > Plugins.",
    ]);
  });

  test("an unreadable trust store skips the call with one notice", async () => {
    const runtime = fakeRuntime({ "./s.sh": followup("again") });
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }),
      runtime,
      gate: () => "trust-store-unreadable",
    });
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(runtime.execCalls).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("Xum cannot read its hook trust store");
  });
});

describe("start conditions", () => {
  const switches = [
    "XUM_DISABLE_AGENT_TOOLS",
    "XUM_DISABLE_TERMINALS",
    "XUM_DISABLE_PROJECT_AUTOMATION",
  ] as const;
  const saved = Object.fromEntries(switches.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of switches) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test.each(switches.map((name) => [name]))("%s=1 starts no process", async (name) => {
    process.env[name] = "1";
    const runtime = fakeRuntime({ "./s.sh": followup("again") });
    const h = harness({ hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }), runtime });
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(runtime.execCalls).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test.each([["devcontainer"], ["remote"], [null]] as const)(
    "a %s runtime starts no process",
    async (location) => {
      const runtime = fakeRuntime({ "./s.sh": followup("again") }, location);
      const h = harness({ hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }), runtime });
      expect(await h.stop()).toEqual({ kind: "none" });
      expect(runtime.execCalls).toEqual([]);
    }
  );

  test("an untrusted hook starts no process, and revoking trust between two calls stops the second", async () => {
    let trusted = false;
    const runtime = fakeRuntime({ "./s.sh": followup("again") });
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }),
      runtime,
      gate: () => (trusted ? "allowed" : "refused"),
    });
    await h.stop();
    expect(runtime.execCalls).toHaveLength(0);
    trusted = true;
    expect((await h.stop()).kind).toBe("continue");
    trusted = false;
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(runtime.execCalls).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  test("after a user Stop no Cursor hook runs (D5)", async () => {
    const runtime = fakeRuntime({ "./a.sh": {}, "./s.sh": followup("again") });
    const h = harness({
      hooks: await hooksOf({
        afterAgentResponse: [{ command: "./a.sh" }],
        stop: [{ command: "./s.sh" }],
      }),
      runtime,
    });
    expect(await h.stop({ abortSignal: AbortSignal.abort() })).toEqual({ kind: "none" });
    expect(runtime.execCalls).toEqual([]);
    expect(h.notices).toEqual([]);
  });
});

describe("cancellation", () => {
  test("an abort while stop runs reaches exec, and the call adds no reason and no notice", async () => {
    const controller = new AbortController();
    const fake = fakeRuntime({ "./s.sh": followup("again") });
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./s.sh" }] }),
      runtime: withExecHook(fake, () => controller.abort()),
    });
    expect(await h.stop({ abortSignal: controller.signal })).toEqual({ kind: "none" });
    expect(fake.execCalls[0].options.abortSignal).toBe(controller.signal);
    expect(h.notices).toEqual([]);
  });

  test("a Stop while the first of two stop hooks runs starts no process for the second", async () => {
    const controller = new AbortController();
    const fake = fakeRuntime({ "./one.sh": followup("one"), "./two.sh": followup("two") });
    const h = harness({
      hooks: await hooksOf({ stop: [{ command: "./one.sh" }, { command: "./two.sh" }] }),
      runtime: withExecHook(fake, () => controller.abort()),
    });
    expect(await h.stop({ abortSignal: controller.signal })).toEqual({ kind: "none" });
    expect(fake.execs).toEqual(["./one.sh"]);
  });
});

describe("with the local runtime", () => {
  let tmp: DisposableTempDir;
  let marker: string;
  let root: string;
  afterEach(() => tmp[Symbol.dispose]());

  async function local() {
    tmp = new DisposableTempDir("cursor-hook-runner");
    root = await fs.realpath(tmp.path);
    marker = path.join(root, "marker");
    return new LocalRuntime(root);
  }

  async function localHarness(entry: Record<string, unknown>, runtime: Runtime) {
    const h = harness({ hooks: await hooksOf({ stop: [entry] }), runtime });
    return { ...h, stop: (overrides = {}) => h.stop({ cwd: root, ...overrides }) };
  }

  const exists = (file: string) =>
    fs.access(file).then(
      () => true,
      () => false
    );
  /** Longer than the hook's sleep: a process that escaped the kill would have written by now. */
  const outlive = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  test.each(["before the call", "while exec prepares the process", "while the process runs"])(
    "a Stop %s leaves no marker, no reason and no notice",
    async (point) => {
      const inner = await local();
      const controller = new AbortController();
      if (point === "before the call") controller.abort();
      const runtime =
        point === "while exec prepares the process"
          ? // exec runs synchronously up to its first await (the working-folder check), so this
            // abort lands while exec prepares the process.
            withExecHook(inner, () => controller.abort())
          : inner;
      const h = await localHarness(
        { command: `sleep 1; touch "${marker}"; echo '{"followup_message":"again"}'` },
        runtime
      );
      if (point === "while the process runs") setTimeout(() => controller.abort(), 200);
      expect(await h.stop({ abortSignal: controller.signal })).toEqual({ kind: "none" });
      expect(await exists(marker)).toBe(false);
      await outlive();
      expect(await exists(marker)).toBe(false);
      expect(h.notices).toEqual([]);
    },
    10_000
  );

  test("a hook that sleeps past its timeout is killed and the turn proceeds", async () => {
    const h = await localHarness({ command: "sleep 10", timeout: 1 }, await local());
    const started = Date.now();
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.notices).toEqual([
      "hook stop failed (timed out after 1s). Turn the hook off in Settings > Plugins.",
    ]);
  }, 10_000);

  test("a process that leaves the group and holds stdout open cannot hold the turn", async () => {
    // `set -m` gives the background job its own process group, which the kill at exit misses.
    const h = await localHarness(
      { command: `set -m; sleep 30 & echo '{"followup_message":"again"}'`, timeout: 1 },
      await local()
    );
    const started = Date.now();
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(h.notices).toEqual([
      "hook stop failed (its output stayed open past its 1s timeout). Turn the hook off in Settings > Plugins.",
    ]);
  }, 10_000);

  test("1 MiB on stderr does not stall the hook: its reason arrives before the timeout", async () => {
    const h = await localHarness(
      {
        command: `head -c 1048576 /dev/zero >&2; echo '{"followup_message":"again"}'`,
        timeout: 5,
      },
      await local()
    );
    const outcome = await h.stop();
    expect(outcome.kind === "continue" && outcome.reasons.map((reason) => reason.text)).toEqual([
      "again",
    ]);
    expect(h.notices).toEqual([]);
  }, 10_000);

  test("1 MiB on stdout ends as invalid output before the timeout, not as a timeout", async () => {
    const h = await localHarness(
      { command: "head -c 1048576 /dev/zero | tr '\\0' x", timeout: 5 },
      await local()
    );
    const started = Date.now();
    expect(await h.stop()).toEqual({ kind: "none" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("invalid output");
    expect(h.notices[0]).not.toContain("timed out");
  }, 10_000);
});
