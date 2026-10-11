import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DisposableTempDir } from "@/node/services/tempDir";
import { loadPluginCodexHooks } from "./codexHooks";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
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
  mcpOrigin?: { serverName: string; toolName: string }
): Promise<ToolExecuteContext> {
  const ctx: ToolExecuteContext = {
    toolName,
    args,
    ...(mcpOrigin !== undefined ? { mcpOrigin } : {}),
    host: { runtime: new LocalRuntime("/tmp"), runtimeTempDir: "/tmp", cwd: "/w", workspaceId },
    ...(inputJsonSchema !== undefined ? { inputJsonSchema: () => inputJsonSchema } : {}),
    executed: false,
  };
  await spine.run("tool.execute", ctx, (c) => {
    c.result = { ran: c.args };
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
    const { hooks } = await loadPluginCodexHooks({
      rootPath: await fs.realpath(tmp.path),
      manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "guard" },
    });
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

    expect(calls).toEqual([{ name: "mcp__scanner__scan" }]);
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
});

describe("UserPromptSubmit and Stop", () => {
  test("UserPromptSubmit blocks, or adds context (JSON or plain text)", async () => {
    const block = setup([hook("UserPromptSubmit", { input: { p: "${prompt}" } })], () =>
      json({ decision: "block", reason: "Contains a token." })
    );
    expect(
      await runMessageSendHooks(block.spine, workspaceId, { text: "key=abc", origin: "user" })
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
      await runMessageSendHooks(plain.spine, workspaceId, { text: "fix", origin: "user" })
    ).toEqual({
      kind: "context",
      entries: [{ pluginId: "guard", text: "Ask for a repro first." }],
    });
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
