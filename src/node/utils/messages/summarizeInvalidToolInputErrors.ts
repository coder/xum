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
  RECEIVED_ARGUMENTS_MARKER,
  UNRECOGNIZED_KEY_MARKER,
  UNRECOGNIZED_KEYS_MARKER,
} from "@/common/utils/tools/formatToolInputIssues";
import { log } from "@/node/services/log";

export const INVALID_TOOL_INPUT_PREFIX = "Invalid input for tool ";

const LOGGED_ERROR_MAX_CHARS = 500;
const SUMMARY_HEAD = /^([^:]*: )(.*)$/;
const SDK_ERROR_NAME = /^[A-Za-z_$][\w$]*Error: /;
const UNRECOGNIZED_KEY_MARKERS = [UNRECOGNIZED_KEY_MARKER, UNRECOGNIZED_KEYS_MARKER];

export interface RejectedToolCallLogContext {
  model?: string;
  workspaceId?: string;
}

/**
 * The SDK's InvalidToolInputError message echoes the entire submitted input
 * and buries the zod issue at the end, so the model retries blind. Render only
 * the issues (with received string lengths and, for a missing property, the
 * received keys with each value's type and length) when the cause chain
 * (InvalidToolInputError -> TypeValidationError -> ZodError) exposes them.
 */
export function describeInvalidToolInput(toolName: string, input: unknown, error: unknown): string {
  if (InvalidToolInputError.isInstance(error)) {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 3 && typeof cause === "object" && cause !== null; depth += 1) {
      const issues: unknown = (cause as { issues?: unknown }).issues;
      if (isToolInputIssueArray(issues)) {
        return `${INVALID_TOOL_INPUT_PREFIX}${toolName}: ${formatToolInputIssues(issues, input)}`;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
  }
  return clampErrorMessage(getErrorMessage(error));
}

/**
 * The copy of a rejected call's error for the shared log. The model keeps the
 * key names it sent, on purpose: they are its own text and show it what to fix.
 * The log is shared across workspaces, so the sink is the boundary, and no shape
 * rule tells a parameter name from a key that holds a credential. Clauses that
 * list keys become [redacted], label path segments after the first become
 * [withheld], an SDK message that echoes the input keeps only its error name,
 * and only the first line is kept, capped at 500 characters. Segment 0 is
 * schema-declared for every mux tool, but a dynamic or MCP tool whose whole
 * argument object is a free-form map would put model text there.
 */
export function redactRejectedToolCallError(error: unknown): unknown {
  if (typeof error !== "string" || !error.startsWith(INVALID_TOOL_INPUT_PREFIX)) {
    return error;
  }
  const newline = error.indexOf("\n");
  const line = newline === -1 ? error : error.slice(0, newline);
  const redacted = line.replace(
    SUMMARY_HEAD,
    (_match, head: string, body: string) => `${head}${redactBody(body)}`
  );
  const cut = newline === -1 ? "" : " [further lines withheld]";
  return clampErrorMessage(`${redacted}${cut}`, LOGGED_ERROR_MAX_CHARS);
}

function redactBody(body: string): string {
  const errorName = SDK_ERROR_NAME.exec(body);
  if (errorName !== null) {
    return `${errorName[0]}[withheld]`;
  }
  const receivedAt = body.indexOf(`. ${RECEIVED_ARGUMENTS_MARKER}`);
  const issues = (receivedAt === -1 ? body : body.slice(0, receivedAt))
    .split("; ")
    .map(redactIssue)
    .join("; ");
  return receivedAt === -1 ? issues : `${issues}. ${RECEIVED_ARGUMENTS_MARKER}[redacted]`;
}

function redactIssue(issue: string): string {
  const labelEnd = issue.indexOf(": ");
  if (labelEnd === -1) {
    return issue;
  }
  const label = issue.slice(0, labelEnd);
  const message = issue.slice(labelEnd + 2);
  const dot = label.indexOf(".");
  const shownLabel = dot === -1 ? label : `${label.slice(0, dot)}.[withheld]`;
  const marker = UNRECOGNIZED_KEY_MARKERS.find((candidate) => message.startsWith(candidate));
  return `${shownLabel}: ${marker === undefined ? message : `${marker}[redacted]`}`;
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
          logRejectedToolCall(part, context);
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
 * Records that a call was rejected and how much argument text arrived, so a log
 * shows a cut-off call. The text itself stays out: warnings persist to the shared
 * log, and arguments can carry credentials or file content. With API Debug Logs
 * on, devtools.jsonl holds the provider's raw tool-call arguments for the same
 * toolCallId.
 */
function logRejectedToolCall(
  part: { toolName: string; toolCallId: string; input: unknown; error?: unknown },
  context: RejectedToolCallLogContext
): void {
  log.warn("Rejected a tool call with invalid input", {
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    model: context.model,
    workspaceId: context.workspaceId,
    argumentsBytes: Buffer.byteLength(receivedArgumentsText(part.input, part.error), "utf8"),
  });
}

// InvalidToolInputError keeps the argument text exactly as the SDK received it from
// the provider, so its length is what arrived; re-serializing would change it.
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
