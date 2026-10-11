/**
 * Codex tool names and input shapes for plugin hooks, so a Codex hooks.json works without edits.
 * Source: the "Tool coverage" table on https://learn.chatgpt.com/docs/hooks.
 *
 * Mapped:
 * - `bash` → `Bash` ("Shell commands … Match as Bash"). Codex puts the script in
 *   `tool_input.command`; Xum's argument is `script`.
 * - MCP tools → `mcp__<server>__<tool>`, from the tool's origin (MCP_TOOL_ORIGIN), not from Xum's
 *   normalized name (that name can be lowercased or hash-suffixed). For a plugin's own server
 *   (`plugin:<instanceId>:<name>`) the server part is `<name>`, the name the plugin declared.
 *   Like Codex, each part keeps only `[A-Za-z0-9_]` (every other character becomes `_`). Codex
 *   also hash-suffixes names that collide after that or exceed 128 characters; Xum does not.
 *
 * Not mapped (no clear Codex equivalent; hooks match them by their Xum names):
 * - file_edit_replace_string, file_edit_insert: Codex `apply_patch` (also `Edit`, `Write`) carries
 *   a patch in `tool_input.command`; Xum edits take a path and strings, with no faithful patch.
 * - task: Codex `spawn_agent` (also `Agent`) has a different argument shape.
 * - todo_write: Codex `update_plan` has a different argument shape.
 * - bash_output, task_await and other polls: Codex `write_stdin` is transport and runs no hooks.
 * - web_fetch, web_search: Codex hosted tools run no hooks.
 * - file_read and every other built-in: no Codex counterpart is documented.
 */
import { isPlainObject } from "./manifest";

/** Enumerable symbol on a served MCP tool: survives descriptor clones and object spreads. */
export const MCP_TOOL_ORIGIN = Symbol.for("xum.mcpToolOrigin");

export interface McpToolOrigin {
  /** Xum server key, e.g. a user server name or `plugin:<instanceId>:<name>`. */
  serverName: string;
  /** The tool's name on its server, before Xum normalizes it. */
  toolName: string;
}

export function readMcpToolOrigin(tool: unknown): McpToolOrigin | undefined {
  if (tool === null || typeof tool !== "object" || !(MCP_TOOL_ORIGIN in tool)) return undefined;
  const origin: unknown = (tool as Record<symbol, unknown>)[MCP_TOOL_ORIGIN];
  return isPlainObject(origin) &&
    typeof origin.serverName === "string" &&
    typeof origin.toolName === "string"
    ? { serverName: origin.serverName, toolName: origin.toolName }
    : undefined;
}

interface BuiltinAlias {
  codexName: string;
  /** Codex-shaped fields added next to Xum's arguments in `tool_input`. */
  toCodexFields(args: Record<string, unknown>): Record<string, unknown>;
  /** Map a Codex-shaped `updatedInput` back to Xum's argument names. */
  fromCodexInput(input: Record<string, unknown>): Record<string, unknown>;
}

const BUILTIN_ALIASES: Record<string, BuiltinAlias> = {
  bash: {
    codexName: "Bash",
    toCodexFields: (args) => (typeof args.script === "string" ? { command: args.script } : {}),
    fromCodexInput: (input) => {
      if (typeof input.command !== "string") return input;
      const { command, ...rest } = input;
      return { ...rest, script: command };
    },
  },
};

export interface CodexToolView {
  /** The Codex name when one exists, else undefined (hooks then see Xum's name). */
  codexName?: string;
  toCodexFields(args: unknown): Record<string, unknown>;
  fromCodexInput(input: unknown): unknown;
}

export function codexToolView(toolName: string, origin?: McpToolOrigin): CodexToolView {
  const builtin = Object.hasOwn(BUILTIN_ALIASES, toolName) ? BUILTIN_ALIASES[toolName] : undefined;
  const codexName =
    builtin?.codexName ??
    (origin !== undefined
      ? `mcp__${codexNamePart(codexServerName(origin.serverName))}__${codexNamePart(origin.toolName)}`
      : undefined);
  return {
    ...(codexName !== undefined ? { codexName } : {}),
    toCodexFields: (args) => (builtin && isPlainObject(args) ? builtin.toCodexFields(args) : {}),
    fromCodexInput: (input) =>
      builtin && isPlainObject(input) ? builtin.fromCodexInput(input) : input,
  };
}

/** Codex's sanitize_responses_api_tool_name (codex-rs/codex-mcp/src/mcp/mod.rs). */
function codexNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_") || "_";
}

function codexServerName(serverKey: string): string {
  const plugin = /^plugin:[0-9a-f]+:(.+)$/.exec(serverKey);
  return plugin ? plugin[1] : serverKey;
}
