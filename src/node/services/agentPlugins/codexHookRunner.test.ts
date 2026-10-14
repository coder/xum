import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { loadPluginCodexHooks } from "./codexHooks";
import { EventSpine, type ToolExecuteContext } from "@/node/services/events/eventSpine";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { PluginHookDefinition } from "./codexHooks";
import {
  expandHookTemplate,
  registerCodexPluginHooks,
  type CodexHookRunnerDeps,
} from "./codexHookRunner";
import { runMessageSendHooks, runTurnStopHooks } from "./promptHooks";

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
    canCallPluginTool: () => true,
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
  mcpOrigin?: { serverName: string; toolName: string },
  opts: { abortSignal?: AbortSignal; result?: unknown } = {}
): Promise<ToolExecuteContext> {
  const ctx: ToolExecuteContext = {
    toolName,
    args,
    ...(mcpOrigin !== undefined ? { mcpOrigin } : {}),
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

  test("matchers run in Codex's dialect: inline flags and whole-name lists", async () => {
    const { spine, calls } = setup(
      [
        hook("PreToolUse", { matcher: "(?i)^BASH$", input: { n: "1" } }),
        hook("PreToolUse", { matcher: "file_read|bash", input: { n: "2" } }),
      ],
      () => ({ content: [] })
    );

    await runTool(spine, "bash", {});
    await runTool(spine, "bash_output", {});

    // bash matches both; bash_output matches neither ("bash" in a name list is a whole name).
    expect(calls.map((call) => call.n).sort()).toEqual(["1", "2"]);
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

    // A hung trust gate (a stalled filesystem) ends at the hook timeout too.
    const gateHangs = setup([hook("PreToolUse", { timeoutSeconds: 0.05 })], () => deny);
    gateHangs.deps.isHookAllowed = () => new Promise(() => undefined);
    expect((await runTool(gateHangs.spine, "bash", {})).executed).toBe(true);
    expect(gateHangs.calls).toEqual([]);
  });

  test("a trust gate that never settles ends at the hook deadline, and on cancel", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rRKxU): a stalled trust read must not hang the tool call.
    const atDeadline = setup([hook("PreToolUse", { timeoutSeconds: 0.05 })], () => deny);
    atDeadline.deps.isHookAllowed = () => new Promise(() => undefined);
    expect((await runTool(atDeadline.spine, "bash", {})).executed).toBe(true);
    expect(atDeadline.calls).toEqual([]);

    // The default deadline is 10 s: only the cancel ends this wait in time.
    const onCancel = setup([hook("PreToolUse")], () => deny);
    onCancel.deps.isHookAllowed = () => new Promise(() => undefined);
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 20);
    const ctx = await runTool(onCancel.spine, "bash", {}, undefined, undefined, {
      abortSignal: cancel.signal,
    });
    expect(ctx.executed).toBe(false);
    expect(ctx.blocked?.result).toEqual({ error: "Tool call interrupted while plugin hooks ran." });
    expect(onCancel.calls).toEqual([]);
  });

  test("a deny tagged for another event is malformed and fails open", async () => {
    const { spine } = setup([hook("PreToolUse")], () =>
      json({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "deny" } })
    );
    expect((await runTool(spine, "bash", {})).executed).toBe(true);
  });

  test("JSON null on an optional field is absent (Codex): a block or deny still holds", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rgpoH): a serializer that writes null defaults must not void a guard.
    const nulls = { continue: null, stopReason: null, systemMessage: null, suppressOutput: null };
    const outputs = [
      json({ ...nulls, decision: "block", reason: "no rm", hookSpecificOutput: null }),
      json({
        ...nulls,
        decision: null,
        reason: null,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "no rm",
          updatedInput: null,
          additionalContext: null,
        },
      }),
    ];
    for (const output of outputs) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      const ctx = await runTool(spine, "bash", { script: "rm -rf /" });
      expect(ctx.blocked?.result).toEqual({
        error: "Tool call blocked by plugin 'guard' hook: no rm",
      });
    }

    // An allow with updatedInput: null is an allow without a rewrite: the original call runs.
    const allow = setup([hook("PreToolUse")], () =>
      json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: null,
        },
      })
    );
    const ran = await runTool(allow.spine, "bash", { script: "ls" });
    expect(ran.result).toEqual({ ran: { script: "ls" } });
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

  test("an explicit continue: true is the default and keeps a deny; continue: false fails open", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rQe1X): output_parser.rs rejects only continue: false.
    const denies = [
      json({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "x",
        },
      }),
      json({ continue: true, decision: "block", reason: "x" }),
    ];
    for (const output of denies) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      const ctx = await runTool(spine, "bash", {});
      expect(ctx.executed).toBe(false);
      expect(ctx.blocked?.result).toEqual({
        error: "Tool call blocked by plugin 'guard' hook: x",
      });
    }
    const unsupported = setup([hook("PreToolUse")], () =>
      json({ continue: false, decision: "block", reason: "x" })
    );
    expect((await runTool(unsupported.spine, "bash", {})).executed).toBe(true);
  });

  test("a deny keeps its own context and the context of earlier hooks", async () => {
    const { spine } = setup(
      [hook("PreToolUse", { input: { first: true } }), hook("PreToolUse")],
      (input) =>
        json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: input.first === true ? "First." : "Second.",
            ...(input.first === true
              ? {}
              : { permissionDecision: "deny", permissionDecisionReason: "No." }),
          },
        })
    );

    const ctx = await runTool(spine, "bash", {});

    expect(ctx.blocked?.result).toEqual({
      error: "Tool call blocked by plugin 'guard' hook: No.",
      hook_output: "[plugin:guard] First.\n[plugin:guard] Second.",
    });
  });

  test("a field with the wrong type makes the whole output malformed (fails open)", async () => {
    const pre = setup([hook("PreToolUse")], () =>
      json({ decision: "block", reason: "x", suppressOutput: "yes" })
    );
    expect((await runTool(pre.spine, "bash", {})).executed).toBe(true);
    const post = setup([hook("PostToolUse")], () => json({ decision: "block", continue: "false" }));
    expect((await runTool(post.spine, "bash", {})).result).toEqual({ ran: {} });
  });

  test("an input too large to send denies the call instead of skipping the guard", async () => {
    const { spine, calls } = setup(
      [hook("PreToolUse", { input: { cmd: "${tool_input.script}" } })],
      () => null
    );

    const ctx = await runTool(spine, "bash", { script: "x".repeat(70 * 1024) });

    expect(calls).toEqual([]);
    expect(ctx.executed).toBe(false);
    expect(JSON.stringify(ctx.blocked?.result)).toContain("too large for the hook to check");
  });

  test("plugin middleware runs before default-order middleware, so it gates rewritten input", async () => {
    const spine = new EventSpine();
    const seen: unknown[] = [];
    // Stands in for the shell .xum/tool_pre gate (registered at the default order 0, first).
    spine.use("tool.execute", (ctx, next) => {
      seen.push(ctx.args);
      return next();
    });
    const deps: CodexHookRunnerDeps = {
      isHookAllowed: () => Promise.resolve(true),
      canCallPluginTool: () => true,
      callPluginTool: () =>
        Promise.resolve(
          json({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: { script: "safe" },
            },
          })
        ),
      notifyUser: () => undefined,
    };
    for (const order of [0, 1]) {
      registerCodexPluginHooks(spine, {
        workspaceId,
        pluginName: `p${order}`,
        order,
        hooks: [hook("PreToolUse")],
        deps,
      });
    }

    const schema = { type: "object", properties: { script: { type: "string" } } };
    const ctx = await runTool(spine, "bash", { script: "rm -rf /" }, schema);

    expect(seen).toEqual([{ script: "safe" }]);
    expect(ctx.result).toEqual({ ran: { script: "safe" } });
  });

  test("a cancel during a hook ends the hook call and the tool never starts", async () => {
    const controller = new AbortController();
    // The longest hook timeout: the run must end at the cancel, not when the hook times out.
    const { spine } = setup([hook("PreToolUse", { timeoutSeconds: 30 })], () => {
      controller.abort();
      return new Promise(() => undefined);
    });

    const ctx = await runTool(spine, "bash", {}, undefined, undefined, {
      abortSignal: controller.signal,
    });

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
      [json({ hookSpecificOutput: { updatedInput: { script: "ls" } } }), schema, { script: "x" }],
    ];
    // MCP schemas: local $ref/$defs (2020-12 by default) and a draft-07 declaration.
    const refSchema = {
      $defs: { script: { type: "string", minLength: 1 } },
      type: "object",
      properties: { script: { $ref: "#/$defs/script" } },
      required: ["script"],
    };
    const draft7 = { $schema: "http://json-schema.org/draft-07/schema#", ...schema };
    cases.push(
      [rewrite("allow", { script: "ls" }), refSchema, { script: "ls" }],
      [rewrite("allow", { script: "ls" }), draft7, { script: "ls" }]
    );
    for (const [output, toolSchema, expected] of cases) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      const ctx = await runTool(spine, "bash", { script: "x" }, toolSchema);
      expect(ctx.result).toEqual({ ran: expected });
    }
    // A rewrite that does not match the schema is denied too: the guard allowed only the
    // rewritten call (Codex PRRT_kwDOPxxmWM6rb3ih).
    for (const [output, toolSchema] of [
      [rewrite("allow", { script: 1 }), schema],
      [rewrite("allow", { script: "" }), refSchema],
    ] as const) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      const ctx = await runTool(spine, "bash", { script: "x" }, toolSchema);
      expect(ctx.executed).toBe(false);
      expect(ctx.blocked?.result).toEqual({
        error:
          "Tool call blocked by plugin 'guard' hook: its rewrite of this call does not match the tool's input.",
      });
    }
    // No schema to check the rewrite against: the call is denied, never run with the original
    // arguments the guard meant to replace (Codex PRRT_kwDOPxxmWM6rRKxR).
    const noSchema = setup([hook("PreToolUse")], () => rewrite("allow", { script: "ls" }));
    const denied = await runTool(noSchema.spine, "bash", { script: "x" });
    expect(denied.executed).toBe(false);
    expect(denied.blocked?.result).toEqual({
      error: "Tool call blocked by plugin 'guard' hook: Xum cannot check its rewrite of this call.",
    });
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

describe("Codex tool names", () => {
  test("a Codex hooks.json for Bash works unedited on Xum's bash tool", async () => {
    // Shape and names from the Codex hooks docs: matcher ^Bash$, ${tool_input.command}.
    using tmp = new DisposableTempDir("codex-bash-hooks");
    await fs.mkdir(path.join(tmp.path, "hooks"));
    await fs.writeFile(
      path.join(tmp.path, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                {
                  type: "mcp_tool",
                  server: "guard",
                  tool: "check_command",
                  input: { command: "${tool_input.command}", tool: "${tool_name}" },
                  timeout: 30,
                },
              ],
            },
          ],
        },
      })
    );
    // No com.openai extension: the default hooks/hooks.json.
    const { hooks } = await loadPluginCodexHooks({ rootPath: await fs.realpath(tmp.path) });
    const { spine, calls } = setup(hooks, () => deny);

    const ctx = await runTool(spine, "bash", { script: "rm -rf /", display_name: "Clean" });

    expect(calls).toEqual([{ command: "rm -rf /", tool: "Bash" }]);
    expect(ctx.executed).toBe(false);
  });

  test("MCP tools match and are named mcp__<server>__<tool>, from their origin", async () => {
    const { spine, calls } = setup(
      [hook("PreToolUse", { matcher: "^mcp__scanner__.*", input: { name: "${tool_name}" } })],
      () => deny
    );

    await runTool(spine, "plugin_0123456789abcdef_scanner_scan_ab12", {}, undefined, {
      serverName: "plugin:0123456789abcdef:scanner",
      toolName: "scan",
    });
    await runTool(spine, "other_scan", {}, undefined, { serverName: "other", toolName: "scan" });
    // A user server whose name only looks like a plugin key keeps its whole name.
    await runTool(spine, "user_scan", {}, undefined, {
      serverName: "plugin:abc:scanner",
      toolName: "scan",
    });

    expect(calls).toEqual([{ name: "mcp__scanner__scan" }]);
  });

  test("MCP name parts keep only [A-Za-z0-9_], as Codex sanitizes them", async () => {
    const { spine, calls } = setup(
      [
        hook("PreToolUse", {
          matcher: "^mcp__Scan_Server__Find_Issues$",
          input: { n: "${tool_name}" },
        }),
      ],
      () => deny
    );

    await runTool(spine, "scan_server_find_issues", {}, undefined, {
      serverName: "Scan Server",
      toolName: "Find-Issues",
    });

    expect(calls).toEqual([{ n: "mcp__Scan_Server__Find_Issues" }]);
  });

  test("a Codex-shaped updatedInput maps back to Xum's arguments before the schema check", async () => {
    const schema = {
      type: "object",
      properties: { script: { type: "string" }, display_name: { type: "string" } },
      required: ["script"],
      additionalProperties: false,
    };
    const { spine } = setup([hook("PreToolUse", { matcher: "^Bash$" })], () =>
      json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "echo rewritten", display_name: "Echo" },
        },
      })
    );

    const ctx = await runTool(spine, "bash", { script: "rm -rf /" }, schema);

    expect(ctx.result).toEqual({ ran: { script: "echo rewritten", display_name: "Echo" } });
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

    const raw = await runTool(spine, "mcp_x", {}, undefined, undefined, { result: mcpResult });
    const converted = await runTool(spine, "mcp_x", {}, undefined, undefined, {
      result: xumResult,
    });

    const note = { type: "text", text: "[plugin:guard] Note." };
    expect(raw.result).toMatchObject({ content: [mcpResult.content[0], note] });
    expect(converted.result).toMatchObject({ value: [xumResult.value[0], note] });
  });
});

describe("UserPromptSubmit and Stop", () => {
  test("UserPromptSubmit blocks, or adds context (JSON or plain text)", async () => {
    const block = setup([hook("UserPromptSubmit", { input: { p: "${prompt}" } })], () =>
      json({ decision: "block", reason: "Contains a token." })
    );
    expect(
      await runMessageSendHooks(block.spine, workspaceId, {
        text: "key=abc",
        origin: "user",
        canBlock: true,
      })
    ).toEqual({
      kind: "blocked",
      pluginName: "guard",
      reason: "Contains a token.",
    });
    expect(block.calls).toEqual([{ p: "key=abc" }]);

    const plain = setup([hook("UserPromptSubmit")], () => ({
      content: [{ type: "text", text: "Ask for a repro first." }],
    }));
    expect(
      await runMessageSendHooks(plain.spine, workspaceId, {
        text: "fix",
        origin: "user",
        canBlock: true,
      })
    ).toEqual({
      kind: "context",
      entries: [{ pluginId: "guard", text: "Ask for a repro first." }],
    });
  });

  test("UserPromptSubmit: hookSpecificOutput: null is absent (Codex), so the block holds", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6rgpoH): before, the null made the output malformed and the
    // prompt was sent.
    const { spine } = setup([hook("UserPromptSubmit")], () =>
      json({ decision: "block", reason: "secret detected", hookSpecificOutput: null })
    );
    expect(
      await runMessageSendHooks(spine, workspaceId, {
        text: "key=abc",
        origin: "user",
        canBlock: true,
      })
    ).toEqual({ kind: "blocked", pluginName: "guard", reason: "secret detected" });
  });

  test("prompt and Stop events carry the workspace cwd", async () => {
    const prompt = setup([hook("UserPromptSubmit", { input: { dir: "${cwd}" } })], () => null);
    await runMessageSendHooks(prompt.spine, workspaceId, {
      text: "hi",
      origin: "user",
      canBlock: true,
      cwd: "/w",
    });
    const stop = setup([hook("Stop", { input: { dir: "${cwd}" } })], () => null);
    await runTurnStopHooks(stop.spine, workspaceId, {
      messageId: "a1",
      lastAssistantMessage: null,
      stopHookActive: false,
      cwd: "/w",
    });
    expect([...prompt.calls, ...stop.calls]).toEqual([{ dir: "/w" }, { dir: "/w" }]);
  });

  test("Stop: decision block continues with the reason; continue false halts", async () => {
    const input = { messageId: "a1", lastAssistantMessage: "done", stopHookActive: false };
    const more = setup([hook("Stop", { input: { last: "${last_assistant_message}" } })], () =>
      json({ decision: "block", reason: "Run the tests again." })
    );
    expect(await runTurnStopHooks(more.spine, workspaceId, input)).toEqual({
      kind: "continue",
      prompt: "Run the tests again.",
    });
    expect(more.calls).toEqual([{ last: "done" }]);

    // One hook asks to continue, another says continue: false: the halt wins (Codex).
    const halt = setup(
      [hook("Stop", { key: "a", input: { n: 1 } }), hook("Stop", { key: "b", input: { n: 2 } })],
      (input) =>
        input.n === 1
          ? json({ decision: "block", reason: "Run the tests again." })
          : { structuredContent: { continue: false } }
    );
    expect(await runTurnStopHooks(halt.spine, workspaceId, input)).toEqual({ kind: "none" });
  });

  test("UserPromptSubmit: a block without a reason fails open (Codex), continue false still blocks", async () => {
    const send = (answer: unknown) =>
      runMessageSendHooks(setup([hook("UserPromptSubmit")], () => answer).spine, workspaceId, {
        text: "fix",
        origin: "user",
        canBlock: true,
      });
    expect(await send(json({ decision: "block" }))).toEqual({ kind: "none" });
    expect(
      await send(
        json({ decision: "block", reason: "  ", hookSpecificOutput: { additionalContext: "c" } })
      )
    ).toEqual({ kind: "none" });
    expect(await send(json({ continue: false }))).toMatchObject({ kind: "blocked" });
  });

  test("the decision comes from every text block, as Codex reads it, not from structuredContent", async () => {
    const answer = {
      content: [
        { type: "text", text: '{"decision": "block",' },
        { type: "text", text: '"reason": "Contains a token."}' },
      ],
      structuredContent: { scanned: 3 },
    };
    const prompt = setup([hook("UserPromptSubmit")], () => answer);
    expect(
      await runMessageSendHooks(prompt.spine, workspaceId, {
        text: "fix",
        origin: "user",
        canBlock: true,
      })
    ).toMatchObject({ kind: "blocked", reason: "Contains a token." });
    const stop = setup([hook("Stop")], () => ({
      content: [{ type: "text", text: JSON.stringify({ continue: false }) }],
      structuredContent: { decision: "block", reason: "metadata, not a decision" },
    }));
    expect(
      await runTurnStopHooks(stop.spine, workspaceId, {
        messageId: "a1",
        lastAssistantMessage: "done",
        stopHookActive: false,
      })
    ).toEqual({ kind: "none" });
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
});

describe("Codex output rules (output_parser.rs)", () => {
  const prompt = (answer: unknown) =>
    runMessageSendHooks(setup([hook("UserPromptSubmit")], () => answer).spine, workspaceId, {
      text: "fix",
      origin: "user",
      canBlock: true,
    });
  const stopInput = { messageId: "a1", lastAssistantMessage: "done", stopHookActive: false };

  test("an unknown field makes the output malformed, so it fails open", async () => {
    const outputs = [
      json({ decision: "block", reason: "x", unexpectedField: true }),
      json({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "x",
          extra: 1,
        },
      }),
    ];
    for (const output of outputs) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      expect((await runTool(spine, "bash", {})).executed).toBe(true);
    }
    // Codex's Stop output has no hookSpecificOutput field at all.
    const stop = setup([hook("Stop")], () =>
      json({ decision: "block", reason: "Again.", hookSpecificOutput: { hookEventName: "Stop" } })
    );
    expect(await runTurnStopHooks(stop.spine, workspaceId, stopInput)).toEqual({ kind: "none" });
  });

  test("a block or deny without a non-empty reason fails open on every tool event", async () => {
    const outputs = [
      json({ decision: "block" }),
      json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } }),
    ];
    for (const output of outputs) {
      const { spine } = setup([hook("PreToolUse")], () => output);
      expect((await runTool(spine, "bash", {})).executed).toBe(true);
    }
    const post = setup([hook("PostToolUse")], () => json({ decision: "block", reason: " " }));
    expect((await runTool(post.spine, "bash", {})).result).toEqual({ ran: {} });
  });

  test("suppressOutput on a tool event fails open, but its systemMessage still shows", async () => {
    const pre = setup([hook("PreToolUse")], () =>
      json({ suppressOutput: true, systemMessage: "Seen.", decision: "block", reason: "x" })
    );
    expect((await runTool(pre.spine, "bash", {})).executed).toBe(true);
    expect(pre.notices).toEqual(["Seen."]);
    const post = setup([hook("PostToolUse")], () =>
      json({ suppressOutput: true, decision: "block", reason: "x" })
    );
    expect((await runTool(post.spine, "bash", {})).result).toEqual({ ran: {} });
  });

  test("a hook-specific decision wins over a legacy block", async () => {
    const { spine } = setup([hook("PreToolUse")], () =>
      json({
        decision: "block",
        reason: "legacy",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { script: "safe" },
        },
      })
    );
    const schema = { type: "object", properties: { script: { type: "string" } } };
    const ctx = await runTool(spine, "bash", { script: "rm -rf /" }, schema);
    expect(ctx.result).toEqual({ ran: { script: "safe" } });
  });

  test("PostToolUse continue: false replaces the result, and a nested caller gets no output", async () => {
    const stopped = setup([hook("PostToolUse")], () =>
      json({ continue: false, stopReason: "Stop here." })
    );
    const ctx = await runTool(stopped.spine, "bash", {});
    expect(ctx.result).toEqual({ error: "[plugin:guard] Stop here." });
    // A nested caller (mux.load) must not hand on the output the hook replaced.
    expect(ctx.postBlocked).toBe(true);

    const blocked = setup([hook("PostToolUse")], () => json({ decision: "block", reason: "No." }));
    expect((await runTool(blocked.spine, "bash", {})).postBlocked).toBe(true);

    // continue: false is checked before invalid fields: it still stops, with `reason` as the
    // feedback, but the invalid output's context is dropped (Codex post_tool_use.rs).
    const invalidStop = setup([hook("PostToolUse")], () =>
      json({
        continue: false,
        reason: "Why.",
        suppressOutput: true,
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Dropped." },
      })
    );
    expect((await runTool(invalidStop.spine, "bash", {})).result).toEqual({
      error: "[plugin:guard] Why.",
    });
  });

  test("UserPromptSubmit: continue: false shows stopReason over reason", async () => {
    expect(
      await prompt(
        json({ continue: false, stopReason: "Stopped.", decision: "block", reason: "r" })
      )
    ).toEqual({ kind: "blocked", pluginName: "guard", reason: "Stopped." });
  });

  test("UserPromptSubmit: text that looks like JSON but is malformed fails; other text is context", async () => {
    const text = (value: string) => ({ content: [{ type: "text", text: value }] });
    expect(await prompt(text('{"decision": "block", "reason": '))).toEqual({ kind: "none" });
    expect(await prompt(text("[1, 2]"))).toEqual({ kind: "none" });
    for (const scalar of ["42", '"note"', "true"]) {
      expect(await prompt(text(scalar))).toEqual({
        kind: "context",
        entries: [{ pluginId: "guard", text: scalar }],
      });
    }
  });

  test("a result over the size cap fails open before it is parsed", async () => {
    // Without the cap, this block would apply (its reason is cut to 16 KiB after parsing).
    const huge = json({ decision: "block", reason: "x".repeat(1024 * 1024) });
    const { spine } = setup([hook("PreToolUse")], () => huge);
    expect((await runTool(spine, "bash", {})).executed).toBe(true);
  });
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
