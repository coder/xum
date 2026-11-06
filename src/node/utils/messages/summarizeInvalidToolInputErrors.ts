import {
  InvalidToolInputError,
  type StreamTextTransform,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import {
  formatToolInputIssues,
  isToolInputIssueArray,
} from "@/common/utils/tools/formatToolInputIssues";
import { log } from "@/node/services/log";

// A bounded sample, not a full record: a cut-off script shows within its first
// few words. Other rejected-input logs keep less (the input depth guard logs
// only inputLength; historyService logs 100 characters of a malformed line).
const LOGGED_ARGUMENTS_MAX_CHARS = 512;

export interface RejectedToolCallLogContext {
  model?: string;
  workspaceId?: string;
}

/**
 * The SDK's InvalidToolInputError message echoes the entire submitted input
 * and buries the zod issue at the end, so the model retries blind. Render only
 * the issues (with received string lengths and, for a missing property, a
 * bounded preview of the received arguments) when the cause chain
 * (InvalidToolInputError -> TypeValidationError -> ZodError) exposes them.
 */
export function describeInvalidToolInput(toolName: string, input: unknown, error: unknown): string {
  if (InvalidToolInputError.isInstance(error)) {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 3 && typeof cause === "object" && cause !== null; depth += 1) {
      const issues: unknown = (cause as { issues?: unknown }).issues;
      if (isToolInputIssueArray(issues)) {
        return `Invalid input for tool ${toolName}: ${formatToolInputIssues(issues, input)}`;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
  }
  return clampErrorMessage(getErrorMessage(error));
}

/**
 * streamText transform that rewrites the tool-error of a call the SDK rejected
 * before execution (invalid input) to describeInvalidToolInput's summary.
 *
 * This has to be a stream transform rather than fullStream consumer logic:
 * streamText builds the next step's tool-result message from the transformed
 * stream, so only a transform changes what the model sees on its same-turn
 * retry. The consumer then persists the same summary for later turns.
 */
export function summarizeInvalidToolInputErrors<TOOLS extends ToolSet>(
  context: RejectedToolCallLogContext = {}
): StreamTextTransform<TOOLS> {
  return () => {
    const summaries = new Map<string, string>();
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (
          part.type === "tool-call" &&
          part.dynamic === true &&
          part.invalid === true &&
          part.error != null
        ) {
          logRejectedToolCall(part.toolName, part.input, part.error, context);
          summaries.set(
            part.toolCallId,
            describeInvalidToolInput(part.toolName, part.input, part.error)
          );
        } else if (part.type === "tool-error") {
          const summary = summaries.get(part.toolCallId);
          if (summary != null) {
            controller.enqueue({ ...part, error: summary });
            return;
          }
        }
        controller.enqueue(part);
      },
    });
  };
}

/**
 * Records what Xum received for a rejected call, so a log alone shows whether
 * the provider, the SDK or the model cut a tool argument short.
 */
function logRejectedToolCall(
  toolName: string,
  input: unknown,
  error: unknown,
  context: RejectedToolCallLogContext
): void {
  const received = receivedArgumentsText(input, error);
  log.warn("Rejected a tool call with invalid input", {
    toolName,
    model: context.model,
    workspaceId: context.workspaceId,
    argumentsBytes: Buffer.byteLength(received, "utf8"),
    arguments:
      received.length > LOGGED_ARGUMENTS_MAX_CHARS
        ? `${received.slice(0, LOGGED_ARGUMENTS_MAX_CHARS)}…`
        : received,
  });
}

// InvalidToolInputError keeps the argument text exactly as the SDK received it from
// the provider; re-serializing the parsed input would hide whitespace and escaping.
function receivedArgumentsText(input: unknown, error: unknown): string {
  if (InvalidToolInputError.isInstance(error)) {
    return error.toolInput;
  }
  if (typeof input === "string") {
    return input;
  }
  const serialized: string | undefined = JSON.stringify(input);
  // mutation-equivalent: JSON.stringify never returns "", so ?? and || agree
  return serialized ?? "";
}
