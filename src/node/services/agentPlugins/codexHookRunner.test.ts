import { describe, expect, test } from "bun:test";
import { EventSpine, type ToolExecuteContext } from "@/node/services/events/eventSpine";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { PluginHookDefinition } from "./codexHooks";
import {
  expandHookTemplate,
  registerCodexPluginHooks,
  type CodexHookRunnerDeps,
} from "./codexHookRunner";

const workspaceId = "ws";

function hook(
  event: string,
  overrides: Partial<PluginHookDefinition> & {
    input?: Record<string, unknown>;
    timeoutSeconds?: number;
  } = {}
): PluginHookDefinition {
  const { input, timeoutSeconds, ...rest } = overrides;
  return {
    key: `hooks/hooks.json#${event}[0][0]`,
    hash: "h".repeat(64),
    event,
    handler: {
      type: "mcp_tool",
      server: "guard",
      tool: "check",
      input: input ?? {},
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    },
    status: "runnable",
    source: "hooks/hooks.json",
    ...rest,
  };
}

/** A fake plugin server whose answers come from `answer`; records every call. */
function setup(hooks: PluginHookDefinition[], answer: (input: Record<string, unknown>) => unknown) {
  const spine = new EventSpine();
  const calls: Array<Record<string, unknown>> = [];
  const notices: string[] = [];
  const state = { allowed: true };
  const deps: CodexHookRunnerDeps = {
    isHookAllowed: () => Promise.resolve(state.allowed),
    callPluginTool: (call) => {
      calls.push(call.input);
      return Promise.resolve(answer(call.input));
    },
    notifyUser: (message) => notices.push(message),
  };
  registerCodexPluginHooks(spine, { workspaceId, pluginName: "guard", order: 0, hooks, deps });
  return { spine, calls, notices, state, deps };
}

const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

async function runTool(
  spine: EventSpine,
  toolName: string,
  args: unknown,
  inputJsonSchema?: unknown,
  opts: { abortSignal?: AbortSignal; result?: unknown } = {}
): Promise<ToolExecuteContext> {
  const ctx: ToolExecuteContext = {
    toolName,
    args,
    host: { runtime: new LocalRuntime("/tmp"), runtimeTempDir: "/tmp", cwd: "/w", workspaceId },
    ...(inputJsonSchema !== undefined ? { inputJsonSchema: () => inputJsonSchema } : {}),
    ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
    executed: false,
  };
  await spine.run("tool.execute", ctx, (c) => {
    c.result = opts.result ?? { ran: c.args };
    c.executed = true;
  });
  return ctx;
}

const deny = json({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "no rm",
  },
});

describe("PreToolUse", () => {
  test("a deny blocks a matching tool with the reason; other tools still run", async () => {
    const { spine, calls } = setup(
      [hook("PreToolUse", { matcher: "^bash$", input: { cmd: "${tool_input.script}" } })],
      () => deny
    );

    const blocked = await runTool(spine, "bash", { script: "rm -rf /" });
    const other = await runTool(spine, "file_read", { path: "a" });

    expect(blocked.executed).toBe(false);
    expect(blocked.blocked?.result).toEqual({
      error: "Tool call blocked by plugin 'guard' hook: no rm",
    });
    expect(other.executed).toBe(true);
    expect(calls).toEqual([{ cmd: "rm -rf /" }]);
  });

  test("the trust gate runs before each call: a revoke stops the next call", async () => {
    const { spine, calls, state } = setup([hook("PreToolUse")], () => deny);

    expect((await runTool(spine, "bash", {})).executed).toBe(false);
    state.allowed = false; // e.g. the user turned the hook off mid-turn
    const after = await runTool(spine, "bash", {});

    expect(after.executed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("an error or a timeout fails open (Codex): the tool still runs", async () => {
    const failing = setup([hook("PreToolUse")], () => {
      throw new Error("server crashed");
    });
    expect((await runTool(failing.spine, "bash", {})).executed).toBe(true);

    const slow = setup(
      [hook("PreToolUse", { timeoutSeconds: 0.05 })],
      () => new Promise(() => undefined)
    );
    expect((await runTool(slow.spine, "bash", {})).executed).toBe(true);

    const isError = setup([hook("PreToolUse")], () => ({ ...deny, isError: true }));
    expect((await runTool(isError.spine, "bash", {})).executed).toBe(true);

    const gateFails = setup([hook("PreToolUse")], () => deny);
    gateFails.deps.isHookAllowed = () => Promise.reject(new Error("trust store unreadable"));
    expect((await runTool(gateFails.spine, "bash", {})).executed).toBe(true);
  });

  test("a deny tagged for another event is malformed and fails open", async () => {
    const { spine } = setup([hook("PreToolUse")], () =>
      json({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } })
    );
    expect((await runTool(spine, "bash", {})).executed).toBe(true);
  });

  test("a decision that is not an exact Codex enum value is malformed and fails open", async () => {
    const outputs = [
      json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: " deny " } }),
      json({ decision: " block ", reason: "x" }),
      json({ decision: "Block", reason: "x" }),
    ];
    for (const output of outputs) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      expect((await runTool(spine, "bash", {})).executed).toBe(true);
    }
  });

  test("a deny keeps its own context and the context of earlier hooks", async () => {
    const { spine } = setup(
      [hook("PreToolUse", { input: { first: true } }), hook("PreToolUse")],
      (input) =>
        json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: input.first === true ? "First." : "Second.",
            ...(input.first === true ? {} : { permissionDecision: "deny" }),
          },
        })
    );

    const ctx = await runTool(spine, "bash", {});

    expect(ctx.blocked?.result).toEqual({
      error: "Tool call blocked by plugin 'guard' hook: No reason given by the hook.",
      hook_output: "[plugin:guard] First.\n[plugin:guard] Second.",
    });
  });

  test("a cancel during a hook ends the hook call and the tool never starts", async () => {
    const controller = new AbortController();
    // The longest hook timeout: the run must end at the cancel, not when the hook times out.
    const { spine } = setup([hook("PreToolUse", { timeoutSeconds: 30 })], () => {
      controller.abort();
      return new Promise(() => undefined);
    });

    const ctx = await runTool(spine, "bash", {}, undefined, { abortSignal: controller.signal });

    expect(ctx.executed).toBe(false);
    expect(ctx.blocked?.result).toEqual({ error: "Tool call interrupted while plugin hooks ran." });
  });

  test("the event carries the session cwd", async () => {
    const { spine, calls } = setup([hook("PreToolUse", { input: { dir: "${cwd}" } })], () => null);
    await runTool(spine, "bash", {});
    expect(calls).toEqual([{ dir: "/w" }]);
  });

  test("updatedInput applies only with allow and a schema-valid value", async () => {
    const schema = {
      type: "object",
      properties: { script: { type: "string" } },
      required: ["script"],
      additionalProperties: false,
    };
    const rewrite = (permissionDecision: string, updatedInput: unknown) =>
      json({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, updatedInput },
      });
    const cases: Array<[unknown, unknown, unknown]> = [
      [rewrite("allow", { script: "ls" }), schema, { script: "ls" }],
      [rewrite("allow", { script: 1 }), schema, { script: "x" }],
      [rewrite("allow", { script: "ls" }), undefined, { script: "x" }],
      [json({ hookSpecificOutput: { updatedInput: { script: "ls" } } }), schema, { script: "x" }],
    ];
    for (const [output, toolSchema, expected] of cases) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      const ctx = await runTool(spine, "bash", { script: "x" }, toolSchema);
      expect(ctx.result).toEqual({ ran: expected });
    }
  });

  test("additionalContext and systemMessage: the model sees the context, only the user sees the message", async () => {
    const { spine, notices } = setup([hook("PreToolUse")], () =>
      json({
        systemMessage: "Checked by guard.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "Touches generated files.",
        },
      })
    );

    const ctx = await runTool(spine, "bash", {});

    expect(ctx.result).toEqual({ ran: {}, hook_output: "[plugin:guard] Touches generated files." });
    expect(notices).toEqual(["Checked by guard."]);
  });
});

describe("PostToolUse", () => {
  test("receives the tool response; block replaces the result with the feedback", async () => {
    const { spine, calls } = setup(
      [hook("PostToolUse", { input: { out: "${tool_response}" } })],
      () => json({ decision: "block", reason: "Output needs review." })
    );

    const ctx = await runTool(spine, "bash", { script: "ls" });

    expect(calls).toEqual([{ out: { ran: { script: "ls" } } }]);
    expect(ctx.result).toEqual({ error: "[plugin:guard] Output needs review." });
  });

  test("block keeps the context gathered so far for the model", async () => {
    const context = (hookEventName: string, extra: Record<string, unknown> = {}) =>
      json({ ...extra, hookSpecificOutput: { hookEventName, additionalContext: hookEventName } });
    const { spine } = setup(
      [hook("PreToolUse", { input: { event: "pre" } }), hook("PostToolUse")],
      (input) =>
        input.event === "pre"
          ? context("PreToolUse")
          : context("PostToolUse", { decision: "block", reason: "Review." })
    );

    const ctx = await runTool(spine, "bash", {});

    expect(ctx.result).toEqual({
      error: "[plugin:guard] Review.",
      hook_output: "[plugin:guard] PreToolUse\n[plugin:guard] PostToolUse",
    });
  });

  test("context on an MCP-shaped result also rides in its content, which the model reads", async () => {
    const { spine } = setup([hook("PostToolUse")], () =>
      json({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Note." } })
    );
    const mcpResult = { content: [{ type: "text", text: "out" }] };
    const xumResult = { type: "content", value: [{ type: "text", text: "out" }] };

    const raw = await runTool(spine, "mcp_x", {}, undefined, { result: mcpResult });
    const converted = await runTool(spine, "mcp_x", {}, undefined, { result: xumResult });

    const note = { type: "text", text: "[plugin:guard] Note." };
    expect(raw.result).toMatchObject({ content: [mcpResult.content[0], note] });
    expect(converted.result).toMatchObject({ value: [xumResult.value[0], note] });
  });
});

test("hooks that cannot run are never called", async () => {
  const { spine, calls } = setup(
    [
      hook("PreToolUse", { status: "unsupported-handler" }),
      hook("SessionStart", { status: "ignored-event" }),
    ],
    () => deny
  );
  expect((await runTool(spine, "bash", {})).executed).toBe(true);
  expect(calls).toEqual([]);
});

describe("expandHookTemplate", () => {
  test("whole placeholders keep their type, embedded ones render as text, nothing else is read", () => {
    const event = { tool_input: { file_path: "src/a.ts", count: 3, list: [1, 2] } };
    expect(
      expandHookTemplate(
        {
          path: "${tool_input.file_path}",
          count: "${tool_input.count}",
          message: "Scanning ${tool_input.file_path} (${tool_input.list})",
          nested: ["${tool_input.count}", { missing: "${tool_input.nope}" }],
          proto: "${tool_input.constructor}",
          embeddedMissing: "x${nope}y",
        },
        event
      )
    ).toEqual({
      path: "src/a.ts",
      count: 3,
      message: "Scanning src/a.ts ([1,2])",
      nested: [3, { missing: null }],
      proto: null,
      embeddedMissing: "xy",
    });
  });
});
