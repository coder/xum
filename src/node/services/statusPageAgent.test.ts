import { describe, expect, it } from "bun:test";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { STATUS_PAGE_AGENT_MAX_PAGE_BYTES } from "@/common/constants/artifacts";
import { runStatusPageAgent } from "./statusPageAgent";

/**
 * Behavior under test: the status page runner applies the model's page tool calls to an
 * in-memory draft only, reports rule violations back to the model, and returns the new page
 * (or null when nothing changed or the stream failed).
 */

type ScriptStep = Array<{ toolName: string; input: Record<string, unknown> }> | string;

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

/** Emits one scripted step per model call and records each call's tool messages. */
function scriptedModel(steps: ScriptStep[]): {
  model: MockLanguageModelV3;
  toolMessages: string[];
} {
  const toolMessages: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: (options: LanguageModelV3CallOptions) => {
      toolMessages.push(
        JSON.stringify(options.prompt.filter((message) => message.role === "tool"))
      );
      const step = steps[Math.min(call, steps.length - 1)];
      call++;
      const chunks: LanguageModelV3StreamPart[] =
        typeof step === "string"
          ? [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
            ]
          : [
              ...step.map(
                (toolCall, index): LanguageModelV3StreamPart => ({
                  type: "tool-call",
                  toolCallId: `call-${call}-${index}`,
                  toolName: toolCall.toolName,
                  input: JSON.stringify(toolCall.input),
                })
              ),
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: USAGE,
              },
            ];
      return Promise.resolve({ stream: simulateReadableStream({ chunks }) });
    },
  });
  return { model, toolMessages };
}

const PAGE = "<main><h1>Status</h1><p>Waiting</p><p>Waiting</p><p>Idle</p></main>";

async function run(steps: ScriptStep[], recorded?: unknown[]) {
  const { model, toolMessages } = scriptedModel(steps);
  const result = await runStatusPageAgent({
    model,
    agentBody: "Keep the page current.",
    currentPage: PAGE,
    updates: [{ text: "Started the build", atMs: 0 }],
    recordUsage: (usage) => {
      recorded?.push(usage);
      return Promise.resolve();
    },
  });
  return { result, toolMessages };
}

describe("runStatusPageAgent", () => {
  it("applies an edit_page call that matches exactly once", async () => {
    const recorded: unknown[] = [];
    const { result } = await run(
      [
        [{ toolName: "edit_page", input: { old_string: "Idle", new_string: "Building" } }],
        "Set the state to building",
      ],
      recorded
    );

    expect(result.page).toBe(PAGE.replace("Idle", "Building"));
    expect(result.summary).toBe("Set the state to building");
    expect(recorded).toHaveLength(1);
  });

  it("reports missing and ambiguous edit_page matches to the model and keeps the draft", async () => {
    const { result, toolMessages } = await run([
      [{ toolName: "edit_page", input: { old_string: "Absent", new_string: "x" } }],
      [{ toolName: "edit_page", input: { old_string: "Waiting", new_string: "x" } }],
      "Nothing applied",
    ]);

    expect(toolMessages[1]).toContain("not found");
    expect(toolMessages[2]).toContain("more than once");
    expect(result.page).toBeNull();
  });

  it("replaces the page with write_page and refuses an oversized page", async () => {
    const replaced = await run([
      [{ toolName: "write_page", input: { html: "<p>Done</p>" } }],
      "Rewrote the page",
    ]);
    expect(replaced.result.page).toBe("<p>Done</p>");

    const oversized = await run([
      [
        {
          toolName: "write_page",
          input: { html: "x".repeat(STATUS_PAGE_AGENT_MAX_PAGE_BYTES + 1) },
        },
      ],
      "Tried a huge page",
    ]);
    expect(oversized.toolMessages[1]).toContain("limit");
    expect(oversized.result.page).toBeNull();
  });

  it("returns the stream error, no page and records no usage when the provider fails", async () => {
    const recorded: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            pull(controller) {
              controller.error(new Error("provider exploded"));
            },
          }),
        }),
    });

    const result = await runStatusPageAgent({
      model,
      agentBody: "Keep the page current.",
      currentPage: PAGE,
      updates: [{ text: "Started", atMs: 0 }],
      recordUsage: (usage) => {
        recorded.push(usage);
        return Promise.resolve();
      },
    });

    expect(result.streamError).toContain("provider exploded");
    expect(result.page).toBeNull();
    expect(recorded).toHaveLength(0);
  });
});
