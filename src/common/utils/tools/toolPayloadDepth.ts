import { MAX_TOOL_PAYLOAD_JSON_DEPTH } from "@/constants/json";
import { isPlainObject } from "@/common/utils/isPlainObject";

/**
 * Replacement for a tool payload whose JSON nesting exceeds
 * MAX_TOOL_PAYLOAD_JSON_DEPTH.
 *
 * Deliberately NOT valid JSON: the live guard substitutes it for the raw
 * `tool-call.input` text before the AI SDK parses it, so `JSON.parse` fails,
 * the call is stamped `invalid` and is never executed. A valid shallow object
 * would instead validate against permissive schemas (`z.record`, passthrough
 * objects) and run the tool with fabricated arguments.
 */
export const TOOL_PAYLOAD_DEPTH_REJECTION = `xum rejected this tool payload: JSON nesting depth exceeds ${MAX_TOOL_PAYLOAD_JSON_DEPTH}`;

// Fail fast if the invariant above is ever broken by an edit to the text.
try {
  JSON.parse(TOOL_PAYLOAD_DEPTH_REJECTION);
  throw new Error("TOOL_PAYLOAD_DEPTH_REJECTION must not be valid JSON");
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
}

/**
 * True when the raw JSON text nests containers deeper than `limit`.
 * Linear, non-recursive scan that ignores brackets inside strings (honouring
 * `\"` escapes) and exits at the first excess opener. Malformed text is
 * scanned best-effort: the SDK rejects it as invalid JSON anyway.
 */
export function jsonTextExceedsDepth(text: string, limit = MAX_TOOL_PAYLOAD_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 0x5c /* \ */) i++;
      else if (code === 0x22 /* " */) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x7b /* { */ || code === 0x5b /* [ */) {
      if (++depth > limit) return true;
    } else if (code === 0x7d /* } */ || code === 0x5d /* ] */) {
      depth--;
    }
  }
  return false;
}

/**
 * True when a parsed value nests objects/arrays deeper than `limit`.
 * Explicit-stack walk so measuring a hostile value never overflows the stack
 * the way JSON.stringify/structuredClone/the SDK clone do.
 */
export function valueExceedsDepth(value: unknown, limit = MAX_TOOL_PAYLOAD_JSON_DEPTH): boolean {
  const stack: Array<{ value: object; depth: number }> = [];
  if (typeof value === "object" && value !== null) stack.push({ value, depth: 1 });
  while (stack.length > 0) {
    const { value: container, depth } = stack.pop()!;
    if (depth > limit) return true;
    const children: unknown[] = Array.isArray(container)
      ? container
      : Object.values(container as Record<string, unknown>);
    for (const child of children) {
      if (typeof child === "object" && child !== null)
        stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Replace over-deep `input`/`output` of dynamic-tool parts — and of their
 * persisted `nestedCalls[*]` (code_execution sub-calls carry their own
 * payloads) — with TOOL_PAYLOAD_DEPTH_REJECTION so request building, partial
 * promotion and compaction rewrites (JSON.stringify, structuredClone, SDK
 * clone) stay shallow. Only those known payload keys are touched; every other
 * field (ids, state, timestamps, workflowRun, metadata) is retained. Returns
 * the SAME reference when nothing exceeds the bound: history rewrites keep
 * untouched rows byte-for-byte by identity.
 *
 * In-memory only. The on-disk row is untouched until a rewrite targets that
 * row itself; sealed epochs are archived as raw bytes.
 */
export function boundToolPayloadDepth<Row extends { parts?: unknown }>(row: Row): Row {
  if (!Array.isArray(row.parts)) return row;
  let parts: unknown[] | undefined;
  for (let i = 0; i < row.parts.length; i++) {
    const part: unknown = row.parts[i];
    if (!isPlainObject(part) || part.type !== "dynamic-tool") continue;
    const bounded = boundNestedCallPayloads(boundPayloadKeys(part));
    if (bounded !== part) {
      parts ??= row.parts.slice();
      parts[i] = bounded;
    }
  }
  return parts === undefined ? row : { ...row, parts };
}

const TOOL_PAYLOAD_KEYS = ["input", "output"] as const;

/** Same reference unless a known payload key exceeds the bound. */
function boundPayloadKeys<T extends Record<string, unknown>>(value: T): T {
  let bounded = value;
  for (const key of TOOL_PAYLOAD_KEYS) {
    if (key in value && valueExceedsDepth(value[key])) {
      bounded = { ...bounded, [key]: TOOL_PAYLOAD_DEPTH_REJECTION };
    }
  }
  return bounded;
}

/** Bound each persisted nested call's payload keys; same reference when none change. */
function boundNestedCallPayloads<T extends Record<string, unknown>>(part: T): T {
  const nestedCalls = part.nestedCalls;
  if (!Array.isArray(nestedCalls)) return part;
  let copy: unknown[] | undefined;
  for (let i = 0; i < nestedCalls.length; i++) {
    const call: unknown = nestedCalls[i];
    if (!isPlainObject(call)) continue;
    const bounded = boundPayloadKeys(call);
    if (bounded !== call) {
      copy ??= nestedCalls.slice();
      copy[i] = bounded;
    }
  }
  return copy === undefined ? part : { ...part, nestedCalls: copy };
}
