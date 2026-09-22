/**
 * Maximum decimal digits jsonSafeClone will expand a BigInt into. Generous
 * for real values (a 4096-bit RSA modulus is ~1,234 digits) while bounding
 * the superlinear BigInt#toString() cost a hostile sandbox value could
 * otherwise impose on the host event loop.
 */
export const JSON_SAFE_CLONE_MAX_BIGINT_DIGITS = 4_096;

/**
 * Maximum JSON container nesting (objects/arrays enclosing the deepest value)
 * accepted for a tool call's input and for persisted dynamic-tool
 * input/output. Deeper payloads overflow the stack in the AI SDK's recursive
 * step-finish clone and in V8's JSON.stringify/structuredClone: observed in the
 * app from depth ~1200 (deep real async stacks) and in an in-process Node 22
 * test harness from ~4000; a persisted deep row then fails every later
 * compaction that re-serializes it. 256 is a policy safety bound chosen well
 * below those observed failures. Payloads above it are rejected explicitly
 * (the live guard turns the call into an invalid tool call); no claim is made
 * that every external tool stays below it.
 */
export const MAX_TOOL_PAYLOAD_JSON_DEPTH = 256;
