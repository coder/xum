/**
 * Runs trusted Codex-format `mcp_tool` hooks (hooks.json) on Xum's hook points:
 * PreToolUse and PostToolUse on `tool.execute`, UserPromptSubmit on `message.send`, and Stop on
 * `turn.stop`. Source: https://learn.chatgpt.com/docs/hooks.
 *
 * Security (the fix for #6042's P1-a and P1-b): `deps.isHookAllowed` runs before EACH call. It
 * reads the trust store and the plugin and project state at that moment, never a snapshot from
 * turn start, so a revoke, an uninstall or an untrusted project stops the next call.
 *
 * Failure rule: every event fails OPEN. An error, a timeout, a missing server or a malformed
 * output never blocks anything; Xum logs a warning and continues. The brief proposed failing
 * PreToolUse closed, but Codex documents the opposite ("Errors, missing servers, and unavailable
 * tools don't block the operation"; a PreToolUse "error, timeout, or malformed response can fail
 * the hook without blocking the tool"), and the brief says to follow Codex where they differ.
 * Only an explicit deny or block decision blocks.
 *
 * Within one plugin, matching hooks run one after another in declaration order (Codex launches
 * them concurrently). Plugins run in discovery order (spine `order`), except PostToolUse: it runs
 * as the around-middleware unwinds, so in reverse plugin order (Codex promises no order at all).
 */
import assert from "node:assert";
import type { EventSpine, ToolExecuteContext } from "@/node/services/events/eventSpine";
import { getErrorMessage } from "@/common/utils/errors";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { log } from "@/node/services/log";
import { compileHookMatcher, type PluginHookDefinition } from "./codexHooks";
import { isPlainObject } from "./manifest";
import { codexToolView, type CodexToolView } from "./codexToolNames";
import {
  parsePostToolUseOutput,
  parsePreToolUseOutput,
  parseStopOutput,
  parseUserPromptSubmitOutput,
  type HookEventName,
  type PreToolUseOutput,
} from "./codexHookOutput";

/** Xum's limits for one hook call, in seconds (Codex's default is 600). */
export const HOOK_DEFAULT_TIMEOUT_SECONDS = 10;
export const HOOK_MAX_TIMEOUT_SECONDS = 30;
/** Spine order of discovery index 0; below the default order 0 of the shell hook middleware. */
const CODEX_HOOK_ORDER_BASE = -1_000_000;
/** Expanded `input` larger than this (as JSON) is not sent (PreToolUse then denies the call). */
const HOOK_INPUT_MAX_CHARS = 64 * 1024;

export interface CodexHookRunnerDeps {
  /** Per-call gate: plugin still installed, project trusted, this exact hash still trusted. */
  isHookAllowed(hook: PluginHookDefinition): Promise<boolean>;
  /**
   * Call `tool` on the plugin's own MCP server `server`. Implementations refuse a server that is
   * not this plugin's, not enabled in this workspace, or not already running.
   */
  callPluginTool(call: {
    server: string;
    tool: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<unknown>;
  /**
   * Whether `callPluginTool` would reach `tool` on `server` now (enabled, running, allowed),
   * from cached state. Only the oversized-input deny asks: it must not block a call when the
   * hook could not run anyway.
   */
  canCallPluginTool(call: { server: string; tool: string }): boolean;
  /** Show a hook's `systemMessage` to the user. It never reaches the model. */
  notifyUser(message: string): void;
}

export interface CodexHookRegistration {
  workspaceId: string;
  pluginName: string;
  /** Discovery index (spine order). */
  order: number;
  hooks: PluginHookDefinition[];
  deps: CodexHookRunnerDeps;
}

/** Register one plugin's runnable hooks on the spine. Returns the unregister function. */
export function registerCodexPluginHooks(
  spine: EventSpine,
  registration: CodexHookRegistration
): () => void {
  const runnable = registration.hooks.filter((hook) => hook.status === "runnable");
  const forEvent = (event: string) => runnable.filter((hook) => hook.event === event);
  assert(
    Number.isInteger(registration.order) && registration.order >= 0,
    "Codex hook order must be a discovery index"
  );
  // Codex plugin middleware runs outside every default-order middleware (the shell
  // .xum/tool_pre gate registers at order 0), in discovery order. Rewrites (updatedInput) then
  // finish before the shell pre-hook reads ctx.args, so the shell policy checks the exact input
  // the tool runs with.
  const scope = {
    workspaceId: registration.workspaceId,
    order: CODEX_HOOK_ORDER_BASE + registration.order,
  };
  const unregisters: Array<() => void> = [];
  const pre = forEvent("PreToolUse");
  const post = forEvent("PostToolUse");
  if (pre.length + post.length > 0) {
    unregisters.push(
      spine.use(
        "tool.execute",
        (ctx, next) => runToolHooks(ctx, next, pre, post, registration),
        scope
      )
    );
  }
  const prompt = forEvent("UserPromptSubmit");
  if (prompt.length > 0) {
    unregisters.push(
      spine.useBefore(
        "message.send",
        async (ctx) => {
          for (const hook of prompt) {
            const output = await invoke(
              hook,
              { prompt: ctx.text },
              "UserPromptSubmit",
              registration,
              parseUserPromptSubmitOutput,
              { cwd: ctx.cwd }
            );
            if (output === null) continue;
            if (output.stopped === true || output.blockReason !== undefined) {
              ctx.blocked = {
                pluginName: registration.pluginName,
                reason: output.blockReason ?? "Blocked by a plugin hook.",
              };
              return;
            }
            if (output.additionalContext !== undefined) {
              ctx.additionalContext.push({
                pluginId: registration.pluginName,
                text: output.additionalContext,
              });
            }
          }
        },
        scope
      )
    );
  }
  const stop = forEvent("Stop");
  if (stop.length > 0) {
    unregisters.push(
      spine.useBefore(
        "turn.stop",
        async (ctx) => {
          for (const hook of stop) {
            const output = await invoke(
              hook,
              {
                stop_hook_active: ctx.stopHookActive,
                last_assistant_message: ctx.lastAssistantMessage,
              },
              "Stop",
              registration,
              parseStopOutput,
              { cwd: ctx.cwd }
            );
            if (output === null) continue;
            if (output.halt !== undefined) ctx.halted = { pluginName: registration.pluginName };
            else if (output.continueWith !== undefined)
              ctx.continueReasons.push(output.continueWith);
          }
        },
        scope
      )
    );
  }
  return () => unregisters.forEach((unregister) => unregister());
}

async function runToolHooks(
  ctx: ToolExecuteContext,
  next: () => Promise<void>,
  pre: PluginHookDefinition[],
  post: PluginHookDefinition[],
  registration: CodexHookRegistration
): Promise<void> {
  const notes: string[] = [];
  const call = { cwd: ctx.host.cwd, abortSignal: ctx.abortSignal };
  const preCall = {
    ...call,
    inputTooLarge: {
      denyReason: `the call is too large for the hook to check (its input is over ${HOOK_INPUT_MAX_CHARS} characters)`,
    } satisfies PreToolUseOutput,
  };
  // Codex names and fields (Bash, mcp__<server>__<tool>, tool_input.command), so a Codex
  // hooks.json works without edits. Xum's own names and fields stay available too.
  const view = codexToolView(ctx.toolName, ctx.mcpOrigin);
  const toolEvent = () => ({
    tool_name: view.codexName ?? ctx.toolName,
    tool_input: isPlainObject(ctx.args)
      ? { ...ctx.args, ...view.toCodexFields(ctx.args) }
      : ctx.args,
  });
  for (const hook of pre.filter((candidate) => matches(candidate, ctx.toolName, view))) {
    const output = await invoke(
      hook,
      toolEvent(),
      "PreToolUse",
      registration,
      parsePreToolUseOutput,
      preCall
    );
    if (ctx.abortSignal?.aborted) break;
    if (output === null) continue;
    if (output.denyReason !== undefined) {
      // Codex keeps the context of a blocking PreToolUse, and of the hooks before it.
      if (output.additionalContext !== undefined) notes.push(output.additionalContext);
      const result = {
        error: `Tool call blocked by plugin '${registration.pluginName}' hook: ${output.denyReason}`,
      };
      ctx.blocked = { result: notes.length > 0 ? annotate(result, notes, registration) : result };
      return;
    }
    if (output.updatedInput !== undefined) {
      applyUpdatedInput(ctx, output.updatedInput, view, registration, hook);
      if (ctx.blocked) return;
    }
    if (output.additionalContext !== undefined) notes.push(output.additionalContext);
  }
  // The user cancelled while a hook ran: the tool must not start after the cancel.
  if (ctx.abortSignal?.aborted) {
    ctx.blocked = { result: { error: "Tool call interrupted while plugin hooks ran." } };
    return;
  }
  await next();
  if (ctx.executed) {
    for (const hook of post.filter((candidate) => matches(candidate, ctx.toolName, view))) {
      const output = await invoke(
        hook,
        { ...toolEvent(), tool_response: ctx.result },
        "PostToolUse",
        registration,
        parsePostToolUseOutput,
        call
      );
      if (output === null) continue;
      if (output.additionalContext !== undefined) notes.push(output.additionalContext);
      // Codex: block or continue: false replaces the tool result with the hook's feedback.
      // The context gathered so far still reaches the model (Codex adds it next to the feedback).
      const feedback = output.blockReason ?? output.stopFeedback;
      if (feedback !== undefined) {
        ctx.result = { error: `[plugin:${registration.pluginName}] ${feedback}` };
        // A nested caller (mux.load) holds the original output outside ctx.result: it must not
        // hand it on (Codex PRRT_kwDOPxxmWM6r6NnK). That holds for continue: false too, though
        // Codex keeps it apart from a block: the hook replaced the output the model sees, so a
        // nested call must not return it either (Codex security review PRRT_kwDOPxxmWM6sQaTG).
        ctx.postBlocked = true;
        break;
      }
    }
  }
  // Model-visible tool context rides on the tool result (logged in chat.jsonl with it).
  if (notes.length > 0 && ctx.executed) ctx.result = annotate(ctx.result, notes, registration);
}

function applyUpdatedInput(
  ctx: ToolExecuteContext,
  updatedInput: unknown,
  view: CodexToolView,
  registration: CodexHookRegistration,
  hook: PluginHookDefinition
): void {
  // A Codex-shaped rewrite (Bash `command`) maps back to Xum's names before the schema check.
  const updated = view.fromCodexInput(updatedInput);
  const schema = ctx.inputJsonSchema?.();
  if (schema === undefined) {
    // No schema to check the rewrite against (a caller that omitted it): deny. Running the
    // original arguments would silently bypass a guard that redirects the call (Codex
    // PRRT_kwDOPxxmWM6rRKxR).
    warn(registration, hook, "returned updatedInput, but the tool has no input schema to check it");
    ctx.blocked = {
      result: {
        error: `Tool call blocked by plugin '${registration.pluginName}' hook: Xum cannot check its rewrite of this call.`,
      },
    };
    return;
  }
  if (!matchesToolSchema(schema, updated)) {
    // Deny, as for a missing schema: the hook allowed only its rewrite, so running the original
    // arguments would bypass it (a mux.load guard that narrows a read to a range, Codex
    // PRRT_kwDOPxxmWM6rb3ih).
    warn(registration, hook, "returned updatedInput that does not match the tool's input schema");
    ctx.blocked = {
      result: {
        error: `Tool call blocked by plugin '${registration.pluginName}' hook: its rewrite of this call does not match the tool's input.`,
      },
    };
    return;
  }
  ctx.args = updated;
}

/**
 * The MCP SDK's own validator (the one Xum's MCP client checks tool output schemas with): it picks
 * the engine from the schema's `$schema` (2020-12 by default, the MCP rule; draft-07 and 2019-09
 * too) and resolves local `$ref`/`$defs`. Compiled validators are cached per schema text.
 */
const rewriteValidator = new AjvJsonSchemaValidator();
const rewriteValidatorCache = new Map<string, (input: unknown) => { valid: boolean }>();

function matchesToolSchema(schema: unknown, value: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  try {
    const key = JSON.stringify(schema);
    let validate = rewriteValidatorCache.get(key);
    if (validate === undefined) {
      validate = rewriteValidator.getValidator(schema);
      rewriteValidatorCache.set(key, validate);
    }
    return validate(value).valid;
  } catch {
    return false; // a schema the validator cannot compile: keep the original arguments
  }
}

function matches(hook: PluginHookDefinition, toolName: string, view: CodexToolView): boolean {
  // The parser already proved the matcher compiles, with the same Codex-dialect translation
  // (inline flags, whole-name lists). Codex applies it to tool_name; Xum tests both the Xum
  // name and the Codex alias.
  if (hook.matcher === undefined) return true;
  const matcher = compileHookMatcher(hook.matcher);
  return matcher.test(toolName) || (view.codexName !== undefined && matcher.test(view.codexName));
}

async function invoke<T extends { systemMessage?: string; invalid?: string }>(
  hook: PluginHookDefinition,
  eventFields: Record<string, unknown>,
  eventName: HookEventName,
  registration: CodexHookRegistration,
  /** Reads the MCP result with the event's Codex rules (codexHookOutput.ts); throws if malformed. */
  parse: (result: unknown) => T | null,
  /**
   * Tool calls: the session cwd (a Codex common field) and the tool's abort signal. PreToolUse
   * also passes the decision for an input too large to send.
   */
  call: { cwd?: string; abortSignal?: AbortSignal; inputTooLarge?: T } = {}
): Promise<T | null> {
  const handler = hook.handler;
  if (handler.type !== "mcp_tool") return null;
  if (call.abortSignal?.aborted) return null;
  const seconds = Math.min(
    handler.timeoutSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS,
    HOOK_MAX_TIMEOUT_SECONDS
  );
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), seconds * 1000);
  // The hook call ends at the hook timeout or when the user cancels the tool, whichever is first.
  const signal = call.abortSignal
    ? AbortSignal.any([timeout.signal, call.abortSignal])
    : timeout.signal;
  // The deadline ends the whole hook, the trust gate included (its reads can stall on a slow
  // filesystem; Codex PRRT_kwDOPxxmWM6rN771).
  const ended = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(new Error(timeout.signal.aborted ? `timed out after ${seconds}s` : "interrupted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // Unobserved until a race below awaits it; a rejection must not surface as unhandled.
  ended.catch(() => undefined);
  // Everything below fails open, the trust gate included (it reads stores that can fail).
  try {
    if (!(await Promise.race([registration.deps.isHookAllowed(hook), ended]))) return null;
    const event = {
      hook_event_name: eventName,
      session_id: registration.workspaceId,
      ...(call.cwd !== undefined ? { cwd: call.cwd } : {}),
      ...eventFields,
    };
    const input = expandHookTemplate(handler.input, event);
    if (!isPlainObject(input) || JSON.stringify(input).length > HOOK_INPUT_MAX_CHARS) {
      warn(registration, hook, "expanded input is too large; the hook cannot check this call");
      // A PreToolUse guard that cannot see the call must not let it through: tool arguments
      // (a Bash script) are model-controlled and could be padded past the limit on purpose.
      // Only a hook that could run denies (Codex PRRT_kwDOPxxmWM6rPrku): with its server or tool
      // off, it fails open like any unavailable hook.
      if (call.inputTooLarge === undefined) return null;
      const couldRun = registration.deps.canCallPluginTool({
        server: handler.server,
        tool: handler.tool,
      });
      return couldRun ? call.inputTooLarge : null;
    }
    const result = await Promise.race([
      registration.deps.callPluginTool({
        server: handler.server,
        tool: handler.tool,
        input,
        signal,
      }),
      ended,
    ]);
    return applyOutput(parse(result), registration, hook);
  } catch (error) {
    warn(registration, hook, `failed (${getErrorMessage(error)}); continuing without it`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function applyOutput<T extends { systemMessage?: string; invalid?: string }>(
  output: T | null,
  registration: CodexHookRegistration,
  hook: PluginHookDefinition
): T | null {
  if (output === null) return null;
  // Codex shows systemMessage even when the rest of the output breaks a rule.
  if (output.systemMessage !== undefined) registration.deps.notifyUser(output.systemMessage);
  if (output.invalid === undefined) return output;
  warn(registration, hook, `${output.invalid}; ignoring its output`);
  return null;
}

/**
 * Expand `${field.nested}` placeholders from the event object only (Codex). A placeholder that is
 * the whole string keeps its JSON type; one inside a longer string is rendered as text. Objects
 * and arrays expand recursively. No code runs: a placeholder is a dotted own-property path.
 */
export function expandHookTemplate(template: unknown, event: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const whole = /^\$\{([\w-]+(?:\.[\w-]+)*)\}$/.exec(template);
    if (whole) return lookup(event, whole[1]) ?? null;
    return template.replace(/\$\{([\w-]+(?:\.[\w-]+)*)\}/g, (_, path: string) => {
      const value = lookup(event, path);
      if (value === undefined || value === null) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
    });
  }
  if (Array.isArray(template)) return template.map((item) => expandHookTemplate(item, event));
  if (isPlainObject(template)) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, expandHookTemplate(value, event)])
    );
  }
  return template;
}

function lookup(root: unknown, dottedPath: string): unknown {
  let value: unknown = root;
  for (const segment of dottedPath.split(".")) {
    if (!isPlainObject(value) && !Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function annotate(result: unknown, notes: string[], registration: CodexHookRegistration): unknown {
  if (result === null || typeof result !== "object" || Symbol.asyncIterator in result)
    return result;
  const note = notes.map((text) => `[plugin:${registration.pluginName}] ${text}`).join("\n");
  const existing = (result as { hook_output?: unknown }).hook_output;
  // MCP tools convert their result for the model from `content` (raw MCP) or `value` (Xum's
  // { type: "content" } shape) only (mcpToModelOutput), so the note must ride there as text too.
  const record = result as Record<string, unknown>;
  const part = { type: "text", text: note };
  const contentParts: Record<string, unknown[]> = Array.isArray(record.content)
    ? { content: [...(record.content as unknown[]), part] }
    : record.type === "content" && Array.isArray(record.value)
      ? { value: [...(record.value as unknown[]), part] }
      : {};
  return {
    ...result,
    ...contentParts,
    hook_output:
      typeof existing === "string" && existing.length > 0 ? `${existing}\n${note}` : note,
  };
}

function warn(registration: CodexHookRegistration, hook: PluginHookDefinition, message: string) {
  log.warn(`Plugin hooks: '${registration.pluginName}' ${hook.event} hook ${message}`, {
    workspaceId: registration.workspaceId,
    key: hook.key,
  });
}
