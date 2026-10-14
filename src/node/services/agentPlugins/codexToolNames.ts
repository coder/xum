/**
 * Codex tool names and input shapes for plugin hooks, so a Codex hooks.json works without edits.
 * Source: the "Tool coverage" table on https://learn.chatgpt.com/docs/hooks.
 *
 * Mapped:
 * - `bash` → `Bash` ("Shell commands … Match as Bash"). Codex's hook contract for its shell
 *   (core/src/tools/context.rs, handlers/unified_exec.rs): `tool_input` is `{ command }` only,
 *   `tool_response` is the output text as a string, and a command still running (Xum
 *   `run_in_background`) gets no PostToolUse. A rewrite sets only the command: the call keeps
 *   its other Xum arguments (Codex PRRT_kwDOPxxmWM6rPqzP, PRRT_kwDOPxxmWM6rPqzQ,
 *   PRRT_kwDOPxxmWM6rPqzS).
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
import { isCanonicalPluginServerKey } from "@/common/utils/mcp/pluginServerKey";

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

/** No PostToolUse for this result (Codex sends none for it). */
export const NO_POST_TOOL_USE = Symbol("noPostToolUse");

interface BuiltinAlias {
  codexName: string;
  /** The whole Codex `tool_input`: Codex's fields only, not Xum's arguments. */
  toCodexInput(args: Record<string, unknown>): Record<string, unknown>;
  /** Apply a Codex-shaped `updatedInput` to the call's arguments; undefined when it is invalid. */
  fromCodexInput(
    input: Record<string, unknown>,
    original: Record<string, unknown>
  ): Record<string, unknown> | undefined;
  /** The Codex `tool_response` for a tool result, or NO_POST_TOOL_USE. */
  toCodexResponse(result: unknown): unknown;
}

const BUILTIN_ALIASES: Record<string, BuiltinAlias> = {
  bash: {
    codexName: "Bash",
    toCodexInput: (args) => (typeof args.script === "string" ? { command: args.script } : {}),
    // Only the command: a hook must not set Xum-only arguments it never saw (run_in_background).
    fromCodexInput: (input, original) =>
      typeof input.command === "string" ? { ...original, script: input.command } : undefined,
    toCodexResponse: (result) => {
      if (!isPlainObject(result)) return result;
      // A background command is still running (Codex: a live process_id).
      if (typeof result.backgroundProcessId === "string") return NO_POST_TOOL_USE;
      if (typeof result.output === "string") return result.output;
      return typeof result.error === "string" ? result.error : "";
    },
  },
};

export interface CodexToolView {
  /** The Codex name when one exists, else undefined (hooks then see Xum's name). */
  codexName?: string;
  /** The `tool_input` hooks see: Codex's fields for an aliased built-in, else Xum's arguments. */
  toCodexInput(args: unknown): unknown;
  /** The arguments after a hook's `updatedInput`; undefined when the rewrite is invalid. */
  fromCodexInput(input: unknown, original: unknown): unknown;
  /** The `tool_response` hooks see, or NO_POST_TOOL_USE. */
  toCodexResponse(result: unknown): unknown;
}

/** The view of a tool without a Codex alias: hooks see Xum's arguments and result as they are. */
const IDENTITY_VIEW = {
  toCodexInput: (args: unknown) => args,
  fromCodexInput: (input: unknown) => input,
  toCodexResponse: (result: unknown) => result,
};

export function codexToolView(toolName: string, origin?: McpToolOrigin): CodexToolView {
  const builtin = Object.hasOwn(BUILTIN_ALIASES, toolName) ? BUILTIN_ALIASES[toolName] : undefined;
  if (builtin !== undefined) return { codexName: builtin.codexName, ...builtinView(builtin) };
  return origin !== undefined
    ? {
        codexName: `mcp__${codexNamePart(codexServerName(origin.serverName))}__${codexNamePart(origin.toolName)}`,
        ...IDENTITY_VIEW,
      }
    : IDENTITY_VIEW;
}

function builtinView(builtin: BuiltinAlias): Omit<CodexToolView, "codexName"> {
  return {
    toCodexInput: (args) => (isPlainObject(args) ? builtin.toCodexInput(args) : args),
    fromCodexInput: (input, original) =>
      isPlainObject(input) && isPlainObject(original)
        ? builtin.fromCodexInput(input, original)
        : undefined,
    toCodexResponse: (result) => builtin.toCodexResponse(result),
  };
}

/** Codex's sanitize_responses_api_tool_name (codex-rs/codex-mcp/src/mcp/mod.rs). */
function codexNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/gu, "_") || "_";
}

function codexServerName(serverKey: string): string {
  // Only the canonical plugin key is a plugin's own server: a user server may be named
  // "plugin:abc:scanner", and its hooks must see that whole name.
  if (!isCanonicalPluginServerKey(serverKey)) return serverKey;
  return serverKey.slice(serverKey.indexOf(":", "plugin:".length) + 1);
}
