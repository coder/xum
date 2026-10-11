/**
 * Runs trusted Codex-format `mcp_tool` hooks (hooks.json) on Xum's hook points: PreToolUse and
 * PostToolUse on `tool.execute`. Source: https://learn.chatgpt.com/docs/hooks.
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
import type { EventSpine, ToolExecuteContext } from "@/node/services/events/eventSpine";
import { getErrorMessage } from "@/common/utils/errors";
import { validateJsonSchemaSubset } from "@/common/utils/jsonSchemaSubset";
import { log } from "@/node/services/log";
import type { PluginHookDefinition } from "./codexHooks";
import { isPlainObject } from "./manifest";

/** Xum's limits for one hook call, in seconds (Codex's default is 600). */
export const HOOK_DEFAULT_TIMEOUT_SECONDS = 10;
export const HOOK_MAX_TIMEOUT_SECONDS = 30;
/** Expanded `input` larger than this (as JSON) is not sent; the hook is skipped. */
const HOOK_INPUT_MAX_CHARS = 64 * 1024;
/** Hook text that reaches the model or the user is cut to this length. */
const HOOK_TEXT_MAX_CHARS = 16 * 1024;

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

/** The fields Xum reads from a hook's output (Codex common + hook-specific fields). */
interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  decision?: string;
  reason?: string;
  permissionDecision?: string;
  permissionDecisionReason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
}

/** Register one plugin's runnable hooks on the spine. Returns the unregister function. */
export function registerCodexPluginHooks(
  spine: EventSpine,
  registration: CodexHookRegistration
): () => void {
  const runnable = registration.hooks.filter((hook) => hook.status === "runnable");
  const forEvent = (event: string) => runnable.filter((hook) => hook.event === event);
  const scope = { workspaceId: registration.workspaceId, order: registration.order };
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
  for (const hook of pre.filter((candidate) => matches(candidate, ctx.toolName))) {
    const output = await invoke(
      hook,
      { tool_name: ctx.toolName, tool_input: ctx.args },
      "PreToolUse",
      registration,
      call
    );
    if (ctx.abortSignal?.aborted) break;
    if (output === null) continue;
    // Codex: PreToolUse does not support continue/stopReason or "ask"; such a run fails (open).
    if (
      output.continue !== undefined ||
      output.stopReason !== undefined ||
      output.permissionDecision === "ask"
    ) {
      warn(registration, hook, "returned fields PreToolUse does not support; ignoring its output");
      continue;
    }
    if (output.permissionDecision === "deny" || output.decision === "block") {
      const reason =
        output.permissionDecisionReason ?? output.reason ?? "No reason given by the hook.";
      // Codex keeps the context of a blocking PreToolUse, and of the hooks before it.
      if (output.additionalContext !== undefined) notes.push(output.additionalContext);
      const result = {
        error: `Tool call blocked by plugin '${registration.pluginName}' hook: ${reason}`,
      };
      ctx.blocked = { result: notes.length > 0 ? annotate(result, notes, registration) : result };
      return;
    }
    if (output.updatedInput !== undefined) applyUpdatedInput(ctx, output, registration, hook);
    if (output.additionalContext !== undefined) notes.push(output.additionalContext);
  }
  // The user cancelled while a hook ran: the tool must not start after the cancel.
  if (ctx.abortSignal?.aborted) {
    ctx.blocked = { result: { error: "Tool call interrupted while plugin hooks ran." } };
    return;
  }
  await next();
  if (ctx.executed) {
    for (const hook of post.filter((candidate) => matches(candidate, ctx.toolName))) {
      const output = await invoke(
        hook,
        { tool_name: ctx.toolName, tool_input: ctx.args, tool_response: ctx.result },
        "PostToolUse",
        registration,
        call
      );
      if (output === null) continue;
      if (output.additionalContext !== undefined) notes.push(output.additionalContext);
      // Codex: block (or continue: false) replaces the tool result with the hook's feedback.
      // The context gathered so far still reaches the model (Codex adds it next to the feedback).
      if (output.decision === "block" || output.continue === false) {
        const feedback = output.reason ?? output.stopReason ?? "Stopped by a plugin hook.";
        ctx.result = { error: `[plugin:${registration.pluginName}] ${feedback}` };
        break;
      }
    }
  }
  // Model-visible tool context rides on the tool result (logged in chat.jsonl with it).
  if (notes.length > 0 && ctx.executed) ctx.result = annotate(ctx.result, notes, registration);
}

function applyUpdatedInput(
  ctx: ToolExecuteContext,
  output: HookOutput,
  registration: CodexHookRegistration,
  hook: PluginHookDefinition
): void {
  if (output.permissionDecision !== "allow") {
    warn(registration, hook, "returned updatedInput without permissionDecision allow; ignoring it");
    return;
  }
  const schema = ctx.inputJsonSchema?.();
  const valid = schema !== undefined && validateJsonSchemaSubset(schema, output.updatedInput);
  if (valid === false || !valid.success) {
    warn(registration, hook, "returned updatedInput that does not match the tool's input schema");
    return;
  }
  ctx.args = output.updatedInput;
}

function matches(hook: PluginHookDefinition, toolName: string): boolean {
  // The parser already proved the matcher compiles. Codex applies it to tool_name.
  return hook.matcher === undefined || new RegExp(hook.matcher).test(toolName);
}

async function invoke(
  hook: PluginHookDefinition,
  eventFields: Record<string, unknown>,
  eventName: string,
  registration: CodexHookRegistration,
  /** Tool calls: the session cwd (a Codex common field) and the tool's abort signal. */
  call: { cwd?: string; abortSignal?: AbortSignal } = {}
): Promise<HookOutput | null> {
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
  // Everything below fails open, the trust gate included (it reads stores that can fail).
  try {
    if (!(await registration.deps.isHookAllowed(hook))) return null;
    const event = {
      hook_event_name: eventName,
      session_id: registration.workspaceId,
      ...(call.cwd !== undefined ? { cwd: call.cwd } : {}),
      ...eventFields,
    };
    const input = expandHookTemplate(handler.input, event);
    if (!isPlainObject(input) || JSON.stringify(input).length > HOOK_INPUT_MAX_CHARS) {
      warn(registration, hook, "expanded input is too large; skipping the hook");
      return null;
    }
    const result = await Promise.race([
      registration.deps.callPluginTool({
        server: handler.server,
        tool: handler.tool,
        input,
        signal,
      }),
      new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(new Error(timeout.signal.aborted ? `timed out after ${seconds}s` : "interrupted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    const output = parseHookOutput(result, eventName);
    if (output?.systemMessage !== undefined) registration.deps.notifyUser(output.systemMessage);
    return output;
  } catch (error) {
    warn(registration, hook, `failed (${getErrorMessage(error)}); continuing without it`);
    return null;
  } finally {
    clearTimeout(timer);
  }
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

/**
 * The hook's output from an MCP call result: `structuredContent`, else the first text content as
 * JSON. Plain text counts only for UserPromptSubmit (Codex adds it as context). An `isError`
 * result is a failure.
 */
export function parseHookOutput(result: unknown, eventName: string): HookOutput | null {
  const plainTextIsContext = eventName === "UserPromptSubmit";
  if (!isPlainObject(result)) throw new Error("the MCP result is not an object");
  if (result.isError === true) throw new Error("the MCP tool returned an error");
  let raw: unknown = result.structuredContent;
  if (!isPlainObject(raw)) {
    const content = Array.isArray(result.content) ? result.content : [];
    const first: unknown = content.find(
      (part: unknown) => isPlainObject(part) && part.type === "text"
    );
    const text = isPlainObject(first) && typeof first.text === "string" ? first.text.trim() : "";
    if (text.length === 0) return null;
    try {
      raw = JSON.parse(text);
    } catch {
      return plainTextIsContext ? { additionalContext: cut(text) } : null;
    }
  }
  if (!isPlainObject(raw)) return null;
  // Codex's schema requires hookSpecificOutput.hookEventName to name this event; an output
  // tagged for another event (or untagged) is malformed and fails open.
  if (
    raw.hookSpecificOutput !== undefined &&
    !(isPlainObject(raw.hookSpecificOutput) && raw.hookSpecificOutput.hookEventName === eventName)
  ) {
    throw new Error(`hookSpecificOutput is not tagged hookEventName "${eventName}"`);
  }
  const specific = isPlainObject(raw.hookSpecificOutput) ? raw.hookSpecificOutput : {};
  // Codex's schemas allow only these exact values; anything else (" deny ", "Block") is malformed
  // and fails open instead of becoming a policy action.
  const oneOf = (value: unknown, allowed: string[]) =>
    value == null || (typeof value === "string" && allowed.includes(value));
  if (!oneOf(raw.decision, eventName === "PreToolUse" ? ["approve", "block"] : ["block"])) {
    throw new Error(`invalid decision ${JSON.stringify(raw.decision)}`);
  }
  if (!oneOf(specific.permissionDecision, ["allow", "deny", "ask"])) {
    throw new Error(`invalid permissionDecision ${JSON.stringify(specific.permissionDecision)}`);
  }
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? cut(value) : undefined;
  const output: HookOutput = {
    ...(typeof raw.continue === "boolean" ? { continue: raw.continue } : {}),
    stopReason: text(raw.stopReason),
    systemMessage: text(raw.systemMessage),
    decision: text(raw.decision),
    reason: text(raw.reason),
    permissionDecision: text(specific.permissionDecision),
    permissionDecisionReason: text(specific.permissionDecisionReason),
    ...(specific.updatedInput !== undefined ? { updatedInput: specific.updatedInput } : {}),
    additionalContext: text(specific.additionalContext),
  };
  return Object.fromEntries(
    Object.entries(output).filter(([, value]) => value !== undefined)
  ) as HookOutput;
}

function cut(text: string): string {
  return text.trim().slice(0, HOOK_TEXT_MAX_CHARS);
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
