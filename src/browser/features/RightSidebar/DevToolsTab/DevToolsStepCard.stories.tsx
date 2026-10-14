import { waitFor, within } from "@storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DevToolsStep } from "@/common/types/devtools";
import { PIXEL_DISABLED, StoryUiShell } from "@/browser/stories/meta";
import { DevToolsStepCard } from "./DevToolsStepCard";

const MIN_RIGHT_SIDEBAR_WIDTH = 300;
const DEVTOOLS_TAB_INLINE_PADDING = 16;
const DEVTOOLS_RUN_CARD_BODY_INLINE_PADDING = 16;
const DEVTOOLS_RUN_CARD_INLINE_BORDER = 2;
const NARROW_DEBUG_CARD_WIDTH =
  MIN_RIGHT_SIDEBAR_WIDTH -
  DEVTOOLS_TAB_INLINE_PADDING -
  DEVTOOLS_RUN_CARD_BODY_INLINE_PADDING -
  DEVTOOLS_RUN_CARD_INLINE_BORDER;
const LONG_POLICY_REGEX =
  "server:GOOGLE_SEARCH_WEB_WITH_A_VERY_LONG_UNBROKEN_POLICY_REGEX_THAT_MUST_WRAP_IN_NARROW_DEBUG_CARDS";

const meta = {
  title: "Features/RightSidebar/DevToolsStepCard",
  component: DevToolsStepCard,
  parameters: {
    layout: "fullscreen",
    pixel: PIXEL_DISABLED,
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-surface-primary text-foreground p-3">
          <div
            data-testid="narrow-debug-card"
            className="overflow-hidden"
            style={{ width: NARROW_DEBUG_CARD_WIDTH }}
          >
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof DevToolsStepCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const debugStep: DevToolsStep = {
  id: "step-2",
  runId: "run-1",
  stepNumber: 2,
  type: "stream",
  modelId: "gemini-3.5-flash",
  provider: "google.generative-ai",
  startedAt: "2026-06-09T12:00:00.000Z",
  durationMs: 8400,
  input: {
    maxOutputTokens: 65_536,
    toolChoice: "auto",
    providerOptions: {
      google: {
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }],
      },
    },
    tools: Array.from({ length: 26 }, (_, index) => ({
      name: `tool_${index + 1}`,
      description: "A tool available to the agent.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    })),
    prompt: [
      { role: "system", content: "You are Xum." },
      { role: "user", content: "Find the latest information about evaluations." },
      { role: "assistant", content: "I will search the web and summarize the results." },
      {
        role: "tool",
        content:
          "Search results included https://example.com/engineering/demystifying-evals-for-ai-agents",
      },
    ],
  },
  output: {
    finishReason: "SAFETY",
    reasoningParts: [
      {
        id: "reasoning-1",
        text: "Summarizing the request and selecting the best follow-up tool call.",
      },
    ],
    toolCalls: [
      {
        toolCallId: "tool-call-1",
        toolName: "server:GOOGLE_SEARCH_WEB",
        args: {
          query: "site:example.com engineering demystifying evals for ai agents",
        },
      },
    ],
    textParts: [
      {
        id: "text-1",
        text: "The provider blocked this response for safety policy reasons.",
      },
    ],
  },
  usage: {
    inputTokens: 14_450,
    outputTokens: 807,
    totalTokens: 15_257,
    raw: { promptTokenCount: 14_450, candidatesTokenCount: 807 },
  },
  error: null,
  rawRequest: {
    body: { model: "gemini-3.5-flash", tools: ["server:GOOGLE_SEARCH_WEB"] },
  },
  requestHeaders: null,
  responseHeaders: null,
  rawResponse: { finishReason: "SAFETY" },
  rawChunks: null,
  inputTransformations: null,
};

export const NarrowExpanded: Story = {
  tags: ["devtools-overflow"],
  args: {
    step: debugStep,
    toolPolicy: Array.from({ length: 12 }, (_, index) => ({
      regex_match: index === 0 ? LONG_POLICY_REGEX : `server:policy_${index + 1}`,
      action: index % 2 === 0 ? "enable" : "disable",
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: /Step 2/ }).click();

    await waitFor(() => canvas.getByText("server:GOOGLE_SEARCH_WEB"));

    const container = canvas.getByTestId("narrow-debug-card");
    assertNoDebugCardOverflow(container);
    // No input_transformations reported, so no dropped-thinking pill.
    if (canvas.queryByRole("button", { name: /Dropped thinking/ }) != null) {
      throw new Error("Dropped thinking pill rendered for a step without entries");
    }

    canvas.getByRole("button", { name: /12 policy rules/ }).click();
    await waitFor(() => canvas.getByText(LONG_POLICY_REGEX));
    assertNoDebugCardOverflow(container);
  },
};

const anthropicStep: DevToolsStep = {
  ...debugStep,
  id: "step-3",
  stepNumber: 3,
  modelId: "claude-fable-5-1",
  provider: "anthropic.messages",
  output: { finishReason: "stop", textParts: [{ id: "text-1", text: "Done." }] },
  usage: { inputTokens: 9_200, outputTokens: 410, totalTokens: 9_610 },
  inputTransformations: [
    { type: "thinking_dropped", path: "messages.3.content.0", reason: "prefix_binding_mismatch" },
    { type: "thinking_dropped", path: "messages.11.content.0", reason: "model_binding_mismatch" },
    {
      type: "thinking_mismatch_allowed",
      path: "messages.15.content.2",
      reason: "prefix_binding_mismatch",
    },
  ],
};

/** Anthropic preserved thinking: each replayed block the API dropped is listed by path. */
export const DroppedThinking: Story = {
  args: { step: anthropicStep },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: /Step 3/ }).click();
    const pill = await waitFor(() => canvas.getByRole("button", { name: "Dropped thinking · 2" }));
    pill.click();
    await waitFor(() => canvas.getByText("messages.3.content.0 · prefix_binding_mismatch"));
    canvas.getByText("messages.15.content.2 · thinking_mismatch_allowed · prefix_binding_mismatch");
    assertNoDebugCardOverflow(canvas.getByTestId("narrow-debug-card"));
  },
};

function assertNoDebugCardOverflow(container: HTMLElement): void {
  if (container.scrollWidth > container.clientWidth + 1) {
    throw new Error(
      `Debug step card overflowed narrow container by ${container.scrollWidth - container.clientWidth}px`
    );
  }
}
