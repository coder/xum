import { z } from "zod";

/** UTF-8 byte length of the JSON serialization — the size a value occupies when persisted. */
export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * `superRefine` check bounding the aggregate serialized size of an object.
 * Per-field character limits alone cannot bound persisted bytes (a character
 * is up to 4 UTF-8 bytes, an escaped control character 6), so schemas that
 * are written on every tool call enforce one byte budget on the whole value.
 */
export function enforceUtf8ByteBudget(
  maxBytes: number
): (value: unknown, ctx: z.RefinementCtx) => void {
  return (value, ctx) => {
    const bytes = utf8JsonByteLength(value);
    if (bytes > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `serialized size ${bytes} bytes exceeds the ${maxBytes}-byte budget`,
      });
    }
  };
}
