/**
 * Reads a Codex `mcp_tool` hook's output into one decision per event, with Codex's rules
 * (openai/codex codex-rs/hooks/src/engine/output_parser.rs and hooks/src/events/*.rs).
 *
 * Two failure kinds, both fail open in the runner:
 * - `parse*` throws when the output does not match Codex's output schema: an unknown field
 *   (Codex's wire structs use `deny_unknown_fields`; the generated output schemas set
 *   `additionalProperties: false`), a wrong type or a value outside an enum. Nothing of it applies.
 * - A result with `invalid` set parsed but breaks a semantic rule (a reason without a decision, a
 *   field the event does not support). Codex still shows its `systemMessage` and ignores the rest.
 *
 * Xum differences:
 * - An explicit PreToolUse deny and a PostToolUse block or stop always apply, also when Codex
 *   would void the output for a semantic rule (no reason, suppressOutput, continue: false next to
 *   a deny). A trusted guard's refusal must not let a model-controlled call through (Codex
 *   security review PRRT_kwDOPxxmWM6sQaTD). Only a malformed output fails open.
 * - JSON null on any optional field reads as absent (Codex PRRT_kwDOPxxmWM6rgpoH).
 * - `structuredContent` is read when the result has no text (Codex reads text only).
 */
import { isPlainObject } from "./manifest";

/** Hook text that reaches the model or the user is cut to this length. */
export const HOOK_TEXT_MAX_CHARS = 16 * 1024;
/**
 * The joined text of one hook result is refused above this length before JSON.parse
 * (Codex PRRT_kwDOPxxmWM6sDjM3). Xum-only: Codex has no bound here, but every field Xum keeps is
 * cut to HOOK_TEXT_MAX_CHARS anyway, so a larger result can only carry padding.
 */
export const HOOK_RESULT_MAX_CHARS = 1024 * 1024;

export type HookEventName = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

interface Common {
  systemMessage?: string;
  /** Set when the output breaks a Codex rule: the runner ignores everything but systemMessage. */
  invalid?: string;
}

export interface PreToolUseOutput extends Common {
  /** permissionDecision deny (or legacy decision block) with its non-empty reason. */
  denyReason?: string;
  /** permissionDecision allow with updatedInput. */
  updatedInput?: unknown;
  additionalContext?: string;
}

export interface PostToolUseOutput extends Common {
  /** decision block with its non-empty reason: the tool result is replaced with it. */
  blockReason?: string;
  /** continue: false: the tool result is replaced with this feedback (`reason`, else `stopReason`). */
  stopFeedback?: string;
  additionalContext?: string;
}

export interface UserPromptSubmitOutput extends Common {
  /** continue: false (wins over a block) or decision block: the prompt is not sent. */
  blockReason?: string;
  /** True when continue: false stopped the prompt (its reason may be absent). */
  stopped?: boolean;
  additionalContext?: string;
}

export interface StopOutput extends Common {
  /** continue: false halts the turn; `stopReason` says why, when given. */
  halt?: { stopReason?: string };
  /** decision block: the turn continues with this prompt. */
  continueWith?: string;
}

const UNIVERSAL_FIELDS = ["continue", "stopReason", "suppressOutput", "systemMessage"];
/** Top-level and hookSpecificOutput fields Codex's output schema allows, per event. */
const ALLOWED_FIELDS: Record<HookEventName, { top: string[]; specific: string[] | null }> = {
  PreToolUse: {
    top: [...UNIVERSAL_FIELDS, "decision", "reason", "hookSpecificOutput"],
    specific: [
      "hookEventName",
      "permissionDecision",
      "permissionDecisionReason",
      "updatedInput",
      "additionalContext",
    ],
  },
  PostToolUse: {
    top: [...UNIVERSAL_FIELDS, "decision", "reason", "hookSpecificOutput"],
    specific: ["hookEventName", "additionalContext", "updatedMCPToolOutput"],
  },
  UserPromptSubmit: {
    top: [...UNIVERSAL_FIELDS, "decision", "reason", "hookSpecificOutput"],
    specific: ["hookEventName", "additionalContext"],
  },
  // Codex's Stop output has no hookSpecificOutput at all (PRRT_kwDOPxxmWM6rkl87).
  Stop: { top: [...UNIVERSAL_FIELDS, "decision", "reason"], specific: null },
};

export function parsePreToolUseOutput(result: unknown): PreToolUseOutput | null {
  const wire = readWire(result, "PreToolUse");
  if (wire === null) return null;
  const { raw, specific } = wire;
  // Codex: any hook-specific decision field means the legacy `decision`/`reason` pair is not
  // consulted (PRRT_kwDOPxxmWM6r6NnG).
  const legacy = preLegacyDecision(raw);
  const chosen = hasSpecificDecision(specific)
    ? keepLegacyDeny(preSpecificDecision(specific), legacy)
    : legacy;
  // PreToolUse does not support continue: false, stopReason or suppressOutput. Codex voids such an
  // output; Xum still honors its deny (see NO_REASON) and voids the rest: a rewrite, the context
  // (PRRT_kwDOPxxmWM6sSNEa).
  const unsupported = unsupportedPreToolUseField(raw);
  const decision: Decision<PreToolUseOutput> =
    unsupported !== undefined && !("denyReason" in chosen) ? { invalid: unsupported } : chosen;
  return withContext(
    raw,
    decision,
    specific,
    unsupported === undefined && !("invalid" in decision)
  );
}

function unsupportedPreToolUseField(raw: Record<string, unknown>): string | undefined {
  if (raw.continue === false) return "returned unsupported continue false";
  if (raw.stopReason != null) return "returned unsupported stopReason";
  if (raw.suppressOutput === true) return "returned unsupported suppressOutput";
  return undefined;
}

/**
 * An invalid hook-specific decision (a lone permissionDecisionReason, say) does not void a legacy
 * block next to it: only a valid specific decision supersedes it (Codex security review
 * PRRT_kwDOPxxmWM6sTAAF, see NO_REASON).
 */
function keepLegacyDeny(
  specific: Decision<PreToolUseOutput>,
  legacy: Decision<PreToolUseOutput>
): Decision<PreToolUseOutput> {
  return "invalid" in specific && "denyReason" in legacy ? legacy : specific;
}

function hasSpecificDecision(specific: Record<string, unknown>): boolean {
  return ["permissionDecision", "permissionDecisionReason", "updatedInput"].some(
    (field) => specific[field] != null
  );
}

/**
 * Xum honors an explicit deny even when Codex would void the output for a missing reason or an
 * extra field next to it (Codex security review PRRT_kwDOPxxmWM6sQaTD): a trusted guard that
 * denies a model-controlled call must not let it run. Only a malformed output (readWire) fails
 * open, as in Codex.
 */
const NO_REASON = "No reason given by the hook.";

function preSpecificDecision(specific: Record<string, unknown>): Decision<PreToolUseOutput> {
  const permissionDecision = specific.permissionDecision;
  if (permissionDecision === "deny") {
    return { denyReason: trimmed(stringField(specific, "permissionDecisionReason")) ?? NO_REASON };
  }
  if (permissionDecision === "allow" && specific.updatedInput != null) {
    return { updatedInput: specific.updatedInput };
  }
  if (specific.updatedInput != null) {
    return { invalid: "returned updatedInput without permissionDecision allow" };
  }
  return permissionDecision == null
    ? { invalid: "returned permissionDecisionReason without permissionDecision" }
    : {
        invalid: `returned unsupported permissionDecision ${stringField(specific, "permissionDecision") ?? ""}`,
      };
}

function preLegacyDecision(raw: Record<string, unknown>): Decision<PreToolUseOutput> {
  switch (raw.decision) {
    case "approve":
      return { invalid: "returned unsupported decision approve" };
    case "block":
      return { denyReason: trimmed(stringField(raw, "reason")) ?? NO_REASON };
    default:
      return raw.reason != null ? { invalid: "returned reason without decision" } : {};
  }
}

export function parsePostToolUseOutput(result: unknown): PostToolUseOutput | null {
  const wire = readWire(result, "PostToolUse");
  if (wire === null) return null;
  const { raw, specific } = wire;
  const invalid = postInvalid(raw, specific);
  const decision: Decision<PostToolUseOutput> =
    raw.continue === false
      ? { stopFeedback: stopFeedback(raw) }
      : raw.decision === "block"
        ? { blockReason: trimmed(stringField(raw, "reason")) ?? NO_REASON }
        : invalid !== undefined
          ? { invalid }
          : {};
  return withContext(raw, decision, specific, invalid === undefined);
}

/**
 * Codex's semantic rules for PostToolUse. Codex voids such an output; Xum drops only its context
 * and keeps a block or stop, as for a PreToolUse deny: it hides an output the hook refused (see
 * NO_REASON).
 */
function postInvalid(
  raw: Record<string, unknown>,
  specific: Record<string, unknown>
): string | undefined {
  const block = raw.decision === "block";
  if (raw.suppressOutput === true) return "returned unsupported suppressOutput";
  if (specific.updatedMCPToolOutput != null) return "returned unsupported updatedMCPToolOutput";
  if (block && trimmed(stringField(raw, "reason")) === undefined) {
    return "returned a block without a non-empty reason";
  }
  if (!block && raw.continue !== false && raw.reason != null) {
    return "returned reason without decision";
  }
  return undefined;
}

/** continue: false feeds the model `reason`, else `stopReason` (Codex post_tool_use.rs). */
function stopFeedback(raw: Record<string, unknown>): string {
  const feedback = trimmed(stringField(raw, "reason")) ?? trimmed(stringField(raw, "stopReason"));
  return feedback ?? "PostToolUse hook stopped execution";
}

export function parseUserPromptSubmitOutput(result: unknown): UserPromptSubmitOutput | null {
  const text = joinedText(result);
  // Codex adds plain text as context. Text that looks like JSON (starts with `{` or `[`) but is
  // not a valid output object fails the hook instead (user_prompt_submit.rs, looks_like_json):
  // a malformed block must not reach the model as context (PRRT_kwDOPxxmWM6rPp1R). Any other
  // text, a JSON scalar such as `42` or `"note"` included, is context (PRRT_kwDOPxxmWM6rZa3U).
  if (text !== undefined && !looksLikeJson(text)) {
    return { additionalContext: cut(text) };
  }
  const wire = readWire(result, "UserPromptSubmit", text);
  if (wire === null) return null;
  const { raw, specific } = wire;
  // Codex's only semantic rule here: a block needs a non-empty reason. Such a block fails open
  // and loses its context, also when continue: false stops the prompt. A reason without a
  // decision is ignored (PRRT_kwDOPxxmWM6sQVfe).
  const invalidBlock =
    raw.decision === "block" && trimmed(stringField(raw, "reason")) === undefined;
  return withContext(raw, promptDecision(raw, invalidBlock), specific, !invalidBlock);
}

function promptDecision(
  raw: Record<string, unknown>,
  invalidBlock: boolean
): Decision<UserPromptSubmitOutput> {
  if (raw.continue === false) {
    // Codex stops the prompt and keeps `stopReason` (user_prompt_submit.rs). Showing `reason`
    // when there is no stopReason is a Xum display choice (PRRT_kwDOPxxmWM6rb29w).
    const why = trimmed(stringField(raw, "stopReason")) ?? trimmed(stringField(raw, "reason"));
    return why !== undefined ? { stopped: true, blockReason: why } : { stopped: true };
  }
  if (invalidBlock) return { invalid: "returned a block without a non-empty reason" };
  return raw.decision === "block" ? { blockReason: trimmed(stringField(raw, "reason")) } : {};
}

export function parseStopOutput(result: unknown): StopOutput | null {
  const wire = readWire(result, "Stop");
  if (wire === null) return null;
  const { raw } = wire;
  const out: StopOutput = common(raw);
  const block = enumField(raw, "decision", ["block"]) === "block";
  const reason = trimmed(stringField(raw, "reason"));
  if (raw.continue === false) {
    const stopReason = trimmed(stringField(raw, "stopReason"));
    out.halt = stopReason !== undefined ? { stopReason } : {};
  } else if (block && reason === undefined) {
    out.invalid = "returned decision block without a non-empty reason";
  } else if (block) {
    out.continueWith = reason;
  }
  return compact(out);
}

type Decision<T> = Omit<T, "systemMessage" | "additionalContext">;

/** systemMessage always; additionalContext only when Codex keeps it (`keepContext`). */
function withContext<T extends Common & { additionalContext?: string }>(
  raw: Record<string, unknown>,
  decision: Decision<T>,
  specific: Record<string, unknown>,
  keepContext: boolean
): T {
  const context = keepContext ? trimmed(stringField(specific, "additionalContext")) : undefined;
  return compact({ ...common(raw), ...decision, additionalContext: context } as T);
}

/**
 * The output object, checked against Codex's schema for `event`. Returns null for an empty
 * result (no text, no structuredContent) and for a result that is not an object (Codex ignores
 * both); throws for a malformed one.
 */
function readWire(
  result: unknown,
  event: HookEventName,
  text: string | undefined = joinedText(result)
): { raw: Record<string, unknown>; specific: Record<string, unknown> } | null {
  const raw =
    text !== undefined
      ? parseText(text, event)
      : isPlainObject(result)
        ? result.structuredContent
        : undefined;
  if (!isPlainObject(raw)) return null;
  rejectUnknown(raw, ALLOWED_FIELDS[event].top, "output");
  const specific = readSpecific(raw.hookSpecificOutput, event);
  typed(raw, ["continue", "suppressOutput"], "boolean");
  typed(raw, ["stopReason", "systemMessage", "reason"], "string");
  typed(specific, ["permissionDecisionReason", "additionalContext"], "string");
  // Every enum is checked here, also one a later rule ignores: Codex's schema rejects the whole
  // output first (PRRT_kwDOPxxmWM6sQVfa, PRRT_kwDOPxxmWM6sQVfk).
  enumField(raw, "decision", event === "PreToolUse" ? ["approve", "block"] : ["block"]);
  enumField(specific, "permissionDecision", ["allow", "deny", "ask"]);
  return { raw, specific };
}

/** JSON text; text that looks like JSON but does not parse is a malformed output. */
function parseText(text: string, event: HookEventName): unknown {
  try {
    return JSON.parse(text);
  } catch {
    if (looksLikeJson(text)) throw new Error(`returned invalid ${event} JSON output`);
    return undefined;
  }
}

/** Codex requires hookSpecificOutput.hookEventName to name this event. */
function readSpecific(value: unknown, event: HookEventName): Record<string, unknown> {
  if (value == null) return {};
  const allowed = ALLOWED_FIELDS[event].specific;
  if (allowed === null) throw new Error(`hookSpecificOutput is not a ${event} field`);
  if (!isPlainObject(value) || value.hookEventName !== event) {
    throw new Error(`hookSpecificOutput is not tagged hookEventName "${event}"`);
  }
  rejectUnknown(value, allowed, "hookSpecificOutput");
  return value;
}

/**
 * Every text content block joined with newlines, trimmed, as Codex reads an MCP hook result
 * (core/src/hook_mcp_executor.rs). Undefined when there is no text. Throws for a non-object or
 * isError result (a failed hook) and for text over HOOK_RESULT_MAX_CHARS.
 */
function joinedText(result: unknown): string | undefined {
  if (!isPlainObject(result)) throw new Error("the MCP result is not an object");
  if (result.isError === true) throw new Error("the MCP tool returned an error");
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  const parts = content.flatMap(textOf);
  // Joined length (one newline between parts), checked before joining or parsing.
  const length = parts.reduce((sum, part) => sum + part.length, Math.max(0, parts.length - 1));
  if (length > HOOK_RESULT_MAX_CHARS) {
    throw new Error(`the result is over ${HOOK_RESULT_MAX_CHARS} characters`);
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

function textOf(part: unknown): string[] {
  return isPlainObject(part) && part.type === "text" && typeof part.text === "string"
    ? [part.text]
    : [];
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

function rejectUnknown(record: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where} has the unknown field ${JSON.stringify(key).slice(0, 80)}`);
    }
  }
}

/** Codex types every field: a wrong type anywhere makes the whole output malformed. */
function typed(record: Record<string, unknown>, fields: string[], type: string) {
  for (const field of fields) {
    if (record[field] != null && typeof record[field] !== type) {
      throw new Error(`${field} is not a ${type}`);
    }
  }
}

/** Codex's enums allow only these exact values (" deny ", "Block" are malformed). */
function enumField(record: Record<string, unknown>, field: string, allowed: string[]) {
  const value = record[field];
  if (value == null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`invalid ${field} ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function common(raw: Record<string, unknown>): Common {
  const systemMessage = trimmed(stringField(raw, "systemMessage"));
  return systemMessage !== undefined ? { systemMessage } : {};
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() ? cut(value) : undefined;
}

function cut(text: string): string {
  return text.trim().slice(0, HOOK_TEXT_MAX_CHARS);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
