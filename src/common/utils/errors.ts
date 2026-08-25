import { ERROR_MESSAGE_CLAMP_MAX_CHARS } from "@/constants/errors";

/**
 * Extract a string message from an unknown error value.
 * Handles Error objects and other thrown values consistently.
 *
 * Walks the `.cause` chain so nested context (e.g. RuntimeError wrapping a
 * filesystem ENOENT) is surfaced rather than silently dropped.
 */
export function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    if (typeof error === "object" && error !== null) {
      try {
        const errorRecord = error as Record<string, unknown>;
        const message = errorRecord.message;
        if (typeof message === "string" && message.length > 0) {
          return message;
        }

        const serializedError = JSON.stringify(error);
        if (typeof serializedError === "string") {
          return serializedError;
        }
        // `JSON.stringify` can return undefined (for example when toJSON returns
        // undefined), so keep the string-return contract by falling back below.
      } catch {
        // Accessing properties on arbitrary thrown values (for example Proxies or
        // throwing getters) can itself throw. Keep this helper non-throwing and
        // fall back to String(error) below.
      }
    }

    return String(error);
  }

  let msg = error.message;
  // Guard against cyclic cause chains (e.g. err.cause = err) with a visited set.
  const seen = new WeakSet<Error>();
  seen.add(error);
  let current: unknown = error.cause;
  while (current instanceof Error) {
    if (seen.has(current)) break;
    seen.add(current);
    const causeMessage = current.message;
    // Some wrapped SDK errors stringify a plain object to "[object Object]",
    // which adds noise without surfacing any actionable context.
    if (causeMessage && causeMessage !== "[object Object]" && !msg.includes(causeMessage)) {
      msg += ` [cause: ${causeMessage}]`;
    }
    current = current.cause;
  }
  return msg;
}

/**
 * Clamp a pathologically long error message before it is persisted, sent over
 * IPC, or rendered. Some AI SDK errors embed entire request payloads in their
 * message: AI_TypeValidationError (surfaced via getErrorMessage's cause walk)
 * includes the full JSON-serialized prompt, easily hundreds of KB. Keeps the
 * head (error type + summary) and the tail (the actionable validation detail
 * usually trails the payload dump).
 */
export function clampErrorMessage(
  message: string,
  maxChars: number = ERROR_MESSAGE_CLAMP_MAX_CHARS
): string {
  if (message.length <= maxChars) {
    return message;
  }
  const tailChars = Math.floor(maxChars / 4);
  const headChars = maxChars - tailChars;
  const omitted = message.length - headChars - tailChars;
  return `${message.slice(0, headChars)}\n… [${omitted} chars omitted] …\n${message.slice(message.length - tailChars)}`;
}
