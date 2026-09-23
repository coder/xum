import { MAX_TOOL_PAYLOAD_JSON_DEPTH } from "@/constants/json";

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
