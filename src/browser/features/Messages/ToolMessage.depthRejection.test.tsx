import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { NestedToolRenderer } from "@/browser/features/Tools/Shared/NestedToolRenderer";
import { MAX_TOOL_PAYLOAD_JSON_DEPTH } from "@/constants/json";
import { createMuxMessage, type DisplayedMessage, type MuxMessage } from "@/common/types/message";
import {
  TOOL_PAYLOAD_DEPTH_REJECTION,
  boundToolPayloadDepth,
} from "@/common/utils/tools/toolPayloadDepth";
import { ToolMessage } from "./ToolMessage";

// BashToolCall requires the background-bash actions context; expanded generic cards highlight
// JSON, which requires the theme context.
function Providers(props: { children: ReactNode }) {
  return (
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider>
        <BackgroundBashProvider workspaceId="ws-test">{props.children}</BackgroundBashProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

let windowInstance: GlobalWindow | null = null;

beforeEach(() => {
  windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as Window & typeof globalThis;
  globalThis.document = windowInstance.document as unknown as Document;
});

afterEach(() => {
  cleanup();
  void windowInstance?.happyDOM.abort();
  windowInstance = null;
  delete (globalThis as { window?: Window }).window;
  delete (globalThis as { document?: Document }).document;
});

function overDeep(): unknown {
  let value: unknown = "leaf";
  for (let depth = 0; depth <= MAX_TOOL_PAYLOAD_JSON_DEPTH; depth++) value = { next: value };
  return value;
}

type ToolRow = Extract<DisplayedMessage, { type: "tool" }>;

/**
 * Persisted rows exactly as history reads them: over-deep outputs are bounded to the rejection
 * placeholder (the same boundToolPayloadDepth that normalizePersistedMessage applies), then
 * replayed through the aggregator that builds the transcript's tool rows.
 */
function replayToolRows(): Map<string, ToolRow> {
  const assistant = createMuxMessage("assistant-1", "assistant", "", {
    historySequence: 2,
    timestamp: 2,
  });
  const bashArgs = (script: string) => ({
    script,
    timeout_secs: 60,
    run_in_background: false,
    display_name: script,
  });
  assistant.parts = [
    {
      type: "dynamic-tool",
      toolCallId: "deep-bash",
      toolName: "bash",
      state: "output-available",
      input: bashArgs("cat huge.json"),
      output: overDeep(),
    },
    {
      type: "dynamic-tool",
      toolCallId: "deep-plan",
      toolName: "propose_plan",
      state: "output-available",
      input: {},
      output: overDeep(),
    },
    {
      type: "dynamic-tool",
      toolCallId: "ptc",
      toolName: "code_execution",
      state: "output-available",
      input: { code: "await mux.bash({ script: 'cat huge.json' })" },
      output: { success: true, result: "done", toolCalls: [] },
      nestedCalls: [
        {
          toolCallId: "nested-deep",
          toolName: "bash",
          input: bashArgs("cat huge.json"),
          output: overDeep(),
          state: "output-available",
        },
        {
          toolCallId: "nested-ok",
          toolName: "bash",
          input: bashArgs("echo nested"),
          output: { success: true, output: "nested", exitCode: 0, wall_duration_ms: 3 },
          state: "output-available",
        },
      ],
    },
    {
      type: "dynamic-tool",
      toolCallId: "ok-bash",
      toolName: "bash",
      state: "output-available",
      input: bashArgs("echo ok"),
      output: { success: true, output: "ok", exitCode: 0, wall_duration_ms: 5 },
    },
  ] as MuxMessage["parts"];
  const rows = [
    createMuxMessage("user-1", "user", "Dump the file", { historySequence: 1, timestamp: 1 }),
    assistant,
  ].map((row) => boundToolPayloadDepth(row));

  const aggregator = new StreamingMessageAggregator("2026-09-23T00:00:00.000Z");
  aggregator.loadHistoricalMessages(rows, false);
  const tools = new Map<string, ToolRow>();
  for (const message of aggregator.getDisplayedMessages()) {
    if (message.type === "tool") tools.set(message.toolCallId, message);
  }
  return tools;
}

function renderTool(message: ToolRow) {
  return render(
    <Providers>
      <ToolMessage message={message} workspaceId="ws-test" />
    </Providers>
  );
}

async function expectGenericPlaceholderCard(view: ReturnType<typeof render>, toolName: string) {
  // The generic card names the tool in its header; expanding it shows the placeholder result.
  fireEvent.click(view.getByText(toolName));
  await waitFor(() => {
    expect(view.container.textContent).toContain(TOOL_PAYLOAD_DEPTH_REJECTION);
  });
}

describe("ToolMessage with depth-rejected persisted payloads", () => {
  test("renders a rejected output on the generic card instead of crashing the transcript", async () => {
    const tools = replayToolRows();
    const bash = tools.get("deep-bash");
    const plan = tools.get("deep-plan");
    expect(bash?.result).toBe(TOOL_PAYLOAD_DEPTH_REJECTION);
    expect(plan?.result).toBe(TOOL_PAYLOAD_DEPTH_REJECTION);

    await expectGenericPlaceholderCard(renderTool(bash!), "bash");
    cleanup();
    await expectGenericPlaceholderCard(renderTool(plan!), "propose_plan");
  });

  test("keeps a healthy code_execution card and isolates a rejected nested call", async () => {
    const ptc = replayToolRows().get("ptc");
    const nested = ptc?.nestedCalls ?? [];
    expect(nested.map((call) => call.output === TOOL_PAYLOAD_DEPTH_REJECTION)).toEqual([
      true,
      false,
    ]);

    // The parent card renders (its own output is healthy).
    const view = renderTool(ptc!);
    expect(view.container.textContent).not.toBe("");
    cleanup();

    const rejected = render(
      <Providers>
        <NestedToolRenderer
          toolName={nested[0].toolName}
          input={nested[0].input}
          output={nested[0].output}
          status="completed"
        />
      </Providers>
    );
    await expectGenericPlaceholderCard(rejected, "bash");
    cleanup();

    // Its healthy sibling keeps the specialized bash card (script in the header).
    const healthy = render(
      <Providers>
        <NestedToolRenderer
          toolName={nested[1].toolName}
          input={nested[1].input}
          output={nested[1].output}
          status="completed"
        />
      </Providers>
    );
    expect(healthy.container.textContent).toContain("echo nested");
  });

  test("ordinary results keep their specialized cards", () => {
    const view = renderTool(replayToolRows().get("ok-bash")!);
    expect(view.container.textContent).toContain("echo ok");
    expect(view.container.textContent).not.toContain(TOOL_PAYLOAD_DEPTH_REJECTION);
  });
});
