import { getCompactionFollowUpContent } from "@/common/types/message";
import type { CompactionFollowUpRequest, MuxMessage } from "@/common/types/message";
import type { StreamErrorType } from "@/common/types/errors";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

export interface MockAiRouterRequest {
  messages: MuxMessage[];
  latestUserMessage: MuxMessage;
  latestUserText: string;
}

export interface MockAiToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
}

export interface MockAiRouterReply {
  assistantText: string;
  /** Optional: stream-start mode (exec/plan/compact). */
  mode?: "plan" | "exec" | "compact";
  /** Optional: hold stream-start until released by the mock controller. */
  waitForStreamStart?: boolean;
  /** Optional: if present, the mock adapter will emit a usage-delta early in the stream. */
  usage?: LanguageModelV2Usage;

  /** Optional: delay before mock tool calls begin (useful for interaction-driven queue tests). */
  toolCallDelayMs?: number;

  /** Optional: mock tool calls to emit before assistant text streaming. */
  toolCalls?: MockAiToolCall[];

  /** Optional: mock reasoning stream (think step deltas). */
  reasoningDeltas?: string[];

  /** Optional: if present, the mock adapter will emit a stream-error and stop the stream. */
  error?: {
    message: string;
    type: StreamErrorType;
  };
}

export interface MockAiRouterHandler {
  match(request: MockAiRouterRequest): boolean;
  respond(request: MockAiRouterRequest): MockAiRouterReply;
}

const DEFAULT_FORCE_COMPACTION_INPUT_TOKENS = 160_000;
const FORCE_MARKER = "[force]";
const STREAM_START_WAIT_PATTERN = /\[mock:wait-start(?:=|:)?([a-z0-9_-]+)?\]/i;
const MOCK_MARKER_PREFIX = "[mock:";

/** Marker to trigger the mock stream-start gate (holds stream until released). */
export const MOCK_STREAM_START_GATE_MARKER = "[mock:wait-start]";

/** Build a message that triggers the mock stream-start gate. */
export function buildMockStreamStartGateMessage(text: string): string {
  return `${MOCK_STREAM_START_GATE_MARKER} ${text}`.trim();
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function shouldWaitForStreamStart(text: string): boolean {
  return STREAM_START_WAIT_PATTERN.test(text);
}

function applyStreamStartGate(reply: MockAiRouterReply, latestUserText: string): MockAiRouterReply {
  if (reply.waitForStreamStart !== undefined) {
    return reply;
  }
  if (!shouldWaitForStreamStart(latestUserText)) {
    return reply;
  }
  return { ...reply, waitForStreamStart: true };
}
function hasMockMarker(text: string, marker: string): boolean {
  const normalized = normalizeText(text);
  return normalized.includes(`${MOCK_MARKER_PREFIX}${marker.toLowerCase()}`);
}

function hasCompactionHistory(messages: MuxMessage[]): boolean {
  return messages.some((message) => {
    if (readCompactionRequest(message)) {
      return true;
    }
    return Boolean(message.metadata?.compacted);
  });
}
function readCompactionRequest(
  message: MuxMessage
): { followUpContent?: CompactionFollowUpRequest } | undefined {
  const muxMeta = message.metadata?.muxMetadata;
  if (!muxMeta || muxMeta.type !== "compaction-request") {
    return undefined;
  }
  return { followUpContent: getCompactionFollowUpContent(muxMeta) };
}

function buildUsage(inputTokens: number, outputTokens: number): LanguageModelV2Usage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function buildMockCompactionSummary(options: {
  preCompactionMessages: MuxMessage[];
  followUpContent?: CompactionFollowUpRequest;
}): string {
  const userCount = options.preCompactionMessages.filter((m) => m.role === "user").length;
  const assistantCount = options.preCompactionMessages.filter((m) => m.role === "assistant").length;
  const totalCount = options.preCompactionMessages.length;

  const followUpText = options.followUpContent?.text?.trim();

  return [
    "Mock compaction summary:",
    `Messages: ${totalCount} (user: ${userCount}, assistant: ${assistantCount})`,
    ...(followUpText ? [`Continue with: ${followUpText}`] : []),
  ].join("\n");
}

function buildDefaultReply(latestUserText: string): MockAiRouterReply {
  const trimmed = latestUserText.trim();
  return {
    assistantText: trimmed.length > 0 ? `Mock response: ${trimmed}` : "Mock response: <empty>",
  };
}

function buildForceCompactionReply(): MockAiRouterReply {
  // Intentionally long to keep the stream alive long enough for UI force-compaction effects.
  const assistantText = Array.from({ length: 120 }, () => "Streaming response...").join(" ");

  return {
    assistantText,
    usage: buildUsage(DEFAULT_FORCE_COMPACTION_INPUT_TOKENS, 1),
  };
}

function buildListProgrammingLanguagesReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Here are three programming languages:",
      "1. Python",
      "2. JavaScript",
      "3. Rust",
    ].join("\n"),
  };
}

function buildPermissionPlanReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Plan summary:",
      "1. Extract validation into verifyInputs().",
      "2. Move formatting logic into buildResponse().",
      "3. Keep handleRequest lean by delegating to helpers.",
    ].join("\n"),
  };
}

function buildPermissionExecReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Applied refactor plan:",
      "- Updated src/utils/legacyFunction.ts",
      "- Extracted verifyInputs and buildResponse helpers.",
    ].join("\n"),
    toolCalls: [
      {
        toolCallId: "tool-apply-refactor",
        toolName: "bash",
        args: {
          script:
            'apply_patch <<\'PATCH\'\n*** Begin Patch\n*** Update File: src/utils/legacyFunction.ts\n@@\n-export function handleRequest(input: Request) {\n-  if (!input.userId || !input.payload) {\n-    throw new Error("Missing fields");\n-  }\n-\n-  const result = heavyFormatter(input.payload);\n-  return {\n-    id: input.userId,\n-    details: result,\n-  };\n-}\n+function verifyInputs(input: Request) {\n+  if (!input.userId || !input.payload) {\n+    throw new Error("Missing fields");\n+  }\n+}\n+\n+function buildResponse(input: Request) {\n+  const result = heavyFormatter(input.payload);\n+  return { id: input.userId, details: result };\n+}\n+\n+export function handleRequest(input: Request) {\n+  verifyInputs(input);\n+  return buildResponse(input);\n+}\n*** End Patch\nPATCH',
          timeout_secs: 10,
          display_name: "Apply refactor",
        },
        result: {
          success: true,
          output: "patch applied\n",
          exitCode: 0,
          wall_duration_ms: 180,
        },
      },
    ],
  };
}

function buildParallelToolStepReply(): MockAiRouterReply {
  return {
    assistantText: "Finished both sibling tool calls before continuing.",
    toolCallDelayMs: 10_000,
    toolCalls: [
      {
        toolCallId: "tool-parallel-step-a",
        toolName: "file_read",
        args: { path: "parallel-step-a.txt" },
        result: {
          success: true,
          file_size: 24,
          modifiedTime: "2024-01-01T00:00:00.000Z",
          lines_read: 1,
          content: "1\tparallel step A complete",
          lease: "lease-parallel-step-a",
        },
      },
      {
        toolCallId: "tool-parallel-step-b",
        toolName: "file_read",
        args: { path: "parallel-step-b.txt" },
        result: {
          success: true,
          file_size: 24,
          modifiedTime: "2024-01-01T00:00:00.000Z",
          lines_read: 1,
          content: "1\tparallel step B complete",
          lease: "lease-parallel-step-b",
        },
      },
    ],
  };
}

function buildToolReadmeReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Here's what README.md contains:",
      "1\tMock README content for tool flow test.",
    ].join("\n"),
    toolCalls: [
      {
        toolCallId: "tool-file-read-1",
        toolName: "file_read",
        args: { filePath: "README.md" },
        result: {
          success: true,
          file_size: 64,
          modifiedTime: "2024-01-01T00:00:00.000Z",
          lines_read: 1,
          content: "1\tMock README content for tool flow test.",
          lease: "lease-readme-v1",
        },
      },
    ],
  };
}

function buildToolListDirectoryReply(): MockAiRouterReply {
  return {
    assistantText: ["Directory listing:", "- README.md", "- package.json", "- src"].join("\n"),
    toolCalls: [
      {
        toolCallId: "tool-bash-ls",
        toolName: "bash",
        args: { script: "ls -1", timeout_secs: 10, display_name: "List directory" },
        result: {
          success: true,
          output: "README.md\npackage.json\nsrc\n",
          exitCode: 0,
          wall_duration_ms: 120,
        },
      },
    ],
  };
}

function buildToolCreateTestFileReply(): MockAiRouterReply {
  return {
    assistantText: "Created test.txt with the contents 'hello'.",
    toolCalls: [
      {
        toolCallId: "tool-bash-create-test-file",
        toolName: "bash",
        args: {
          script: "printf 'hello' > test.txt",
          timeout_secs: 10,
          display_name: "Create test file",
        },
        result: {
          success: true,
          output: "",
          exitCode: 0,
          wall_duration_ms: 90,
        },
      },
    ],
  };
}

function buildToolReadTestFileReply(): MockAiRouterReply {
  return {
    assistantText: ["Here's what's inside test.txt:", "1\thello"].join("\n"),
    toolCalls: [
      {
        toolCallId: "tool-file-read-test-file",
        toolName: "file_read",
        args: { filePath: "test.txt" },
        result: {
          success: true,
          file_size: 6,
          modifiedTime: "2024-01-01T00:00:00.000Z",
          lines_read: 1,
          content: "1\thello",
          lease: "lease-test-txt",
        },
      },
    ],
  };
}

function buildToolRecallTestFileReply(): MockAiRouterReply {
  return {
    assistantText: "You just created test.txt and it contains the line 'hello'.",
  };
}

function buildToolNotifyReply(): MockAiRouterReply {
  return {
    assistantText: "I've sent you a notification that the task is complete.",
    toolCalls: [
      {
        toolCallId: "tool-notify-1",
        toolName: "notify",
        args: {
          title: "Task Complete",
          message: "Your requested task has been completed successfully.",
        },
        result: {
          success: true,
          title: "Task Complete",
          message: "Your requested task has been completed successfully.",
          ui_only: {
            notify: {
              notifiedVia: "electron",
            },
          },
        },
      },
    ],
  };
}

function buildReasoningQuicksortReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Quicksort works by picking a pivot, partitioning smaller and larger items around it, then recursing.",
      "1. Choose a pivot (often the middle element for simplicity).",
      "2. Partition: items < pivot move left, items > pivot move right.",
      "3. Recursively quicksort the left and right partitions.",
      "4. Base case: arrays of length 0 or 1 are already sorted.",
      "This yields O(n log n) average time and in-place sorting when implemented carefully.",
    ].join("\n"),
    reasoningDeltas: [
      "Assessing quicksort mechanics and choosing example array...\n",
      "Plan: explain pivot selection, partitioning, recursion, base case.",
    ],
  };
}

function buildReviewBranchesReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Here’s the current branch roster:",
      "• `main` – release baseline",
      "• `feature/login` – authentication refresh",
      "• `demo-review` – sandbox you just created",
    ].join("\n"),
  };
}

function buildReviewOpenDocErrorReply(): MockAiRouterReply {
  return {
    assistantText: "",
    error: {
      message: "ENOENT: docs/onboarding.md not found",
      type: "api",
    },
  };
}

function buildReviewShowDocReply(): MockAiRouterReply {
  return {
    assistantText: [
      "Found it. Here’s the quick-start summary:",
      "• Clone → bun install",
      "• bun dev boots the desktop shell",
      "• See docs/onboarding.md for the full checklist",
    ].join("\n"),
  };
}

function buildModelStatusReply(): MockAiRouterReply {
  return {
    assistantText: "Claude Sonnet 5.1 is now responding with standard reasoning capacity.",
  };
}

function buildRateLimitErrorReply(): MockAiRouterReply {
  return {
    assistantText: "Processing your request...",
    error: {
      message: "Rate limit exceeded. Please retry after 60 seconds.",
      type: "rate_limit",
    },
  };
}

function buildApiErrorReply(): MockAiRouterReply {
  return {
    assistantText: "",
    error: {
      message: "Internal server error occurred while processing the request.",
      type: "server_error",
    },
  };
}

function buildContextExceededReply(): MockAiRouterReply {
  return {
    assistantText: "Streaming response before context limit.",
    error: {
      message: "Context length exceeded in mock stream.",
      type: "context_exceeded",
    },
  };
}
function buildNetworkErrorReply(): MockAiRouterReply {
  return {
    assistantText: "",
    error: {
      message: "Network connection lost. Please check your internet connection.",
      type: "network",
    },
  };
}

const defaultHandlers: MockAiRouterHandler[] = [
  {
    match: (request) => Boolean(readCompactionRequest(request.latestUserMessage)),
    respond: (request) => {
      const compactionRequest = readCompactionRequest(request.latestUserMessage);
      const preCompactionMessages = request.messages.slice(0, -1);
      return {
        assistantText: buildMockCompactionSummary({
          preCompactionMessages,
          followUpContent: compactionRequest?.followUpContent,
        }),
        mode: "compact",
      };
    },
  },
  {
    match: (request) => normalizeText(request.latestUserText).includes(FORCE_MARKER),
    respond: () => buildForceCompactionReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "list-languages") ||
      normalizeText(request.latestUserText) === "list 3 programming languages" ||
      normalizeText(request.latestUserText).includes("programming languages"),
    respond: () => buildListProgrammingLanguagesReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "permission:plan-refactor") ||
      normalizeText(request.latestUserText) === "how should i refactor this function?",
    respond: () => buildPermissionPlanReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "permission:exec-refactor") ||
      normalizeText(request.latestUserText) === "do it",
    respond: () => buildPermissionExecReply(),
  },
  {
    match: (request) => hasMockMarker(request.latestUserText, "tool:parallel-step"),
    respond: () => buildParallelToolStepReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "tool:file-read") ||
      normalizeText(request.latestUserText) === "what's in readme.md?",
    respond: () => buildToolReadmeReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "tool:list-directory") ||
      normalizeText(request.latestUserText) === "what files are in the current directory?",
    respond: () => buildToolListDirectoryReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "tool:create-test-file") ||
      normalizeText(request.latestUserText).includes("create a file called test.txt"),
    respond: () => buildToolCreateTestFileReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "tool:read-test-file") ||
      normalizeText(request.latestUserText) === "now read that file",
    respond: () => buildToolReadTestFileReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "tool:recall-test-file") ||
      normalizeText(request.latestUserText) === "what did it contain?",
    respond: () => buildToolRecallTestFileReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "tool:notify") ||
      normalizeText(request.latestUserText) === "notify me that the task is complete",
    respond: () => buildToolNotifyReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "reasoning:quicksort") ||
      normalizeText(request.latestUserText) === "explain quicksort algorithm step by step",
    respond: () => buildReasoningQuicksortReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "review:branches") ||
      normalizeText(request.latestUserText) === "let's summarize the current branches.",
    respond: () => buildReviewBranchesReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "review:open-doc") ||
      normalizeText(request.latestUserText) === "open the onboarding doc.",
    respond: () => buildReviewOpenDocErrorReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "review:show-doc") ||
      normalizeText(request.latestUserText) === "show the onboarding doc contents instead.",
    respond: () => buildReviewShowDocReply(),
  },
  {
    match: (request) =>
      !hasCompactionHistory(request.messages) &&
      (hasMockMarker(request.latestUserText, "error:context") ||
        normalizeText(request.latestUserText) === "trigger context error" ||
        normalizeText(request.latestUserText) === "trigger context exceeded error"),
    respond: () => buildContextExceededReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "model-status") ||
      normalizeText(request.latestUserText) ===
        "please confirm which model is currently active for this conversation.",
    respond: () => buildModelStatusReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "error:rate-limit") ||
      normalizeText(request.latestUserText) === "trigger rate limit error",
    respond: () => buildRateLimitErrorReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "error:api") ||
      normalizeText(request.latestUserText) === "trigger api error",
    respond: () => buildApiErrorReply(),
  },
  {
    match: (request) =>
      hasMockMarker(request.latestUserText, "error:network") ||
      normalizeText(request.latestUserText) === "trigger network error",
    respond: () => buildNetworkErrorReply(),
  },
  {
    match: () => true,
    respond: (request) => buildDefaultReply(request.latestUserText),
  },
];

/**
 * Stream-agnostic, pattern-based mock LLM router.
 *
 * IMPORTANT: This module is intentionally *not* aware of stream event semantics
 * (stream-delta, stream-end, etc). It returns a high-level reply which is
 * converted to stream events by a dedicated adapter.
 */
export class MockAiRouter {
  private readonly handlers: MockAiRouterHandler[];

  constructor(handlers: MockAiRouterHandler[] = defaultHandlers) {
    this.handlers = handlers;
  }

  route(request: MockAiRouterRequest): MockAiRouterReply {
    for (const handler of this.handlers) {
      if (handler.match(request)) {
        return applyStreamStartGate(handler.respond(request), request.latestUserText);
      }
    }

    return applyStreamStartGate(buildDefaultReply(request.latestUserText), request.latestUserText);
  }
}
