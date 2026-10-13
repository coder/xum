import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../../../../tests/ui/domGlobals";
import type { DevToolsStep, DevToolsStepOutput } from "@/common/types/devtools";
import { DevToolsStepCard } from "../DevToolsStepCard";

// Characterization tests for the expanded card's Input and Output panels and the
// formatters behind them. Step content comes from replayed JSONL without schema
// checks, so the fixtures mix well-formed and malformed parts on purpose.

function makeStep(overrides: Partial<DevToolsStep> = {}): DevToolsStep {
  return {
    id: "step-1",
    runId: "run-1",
    stepNumber: 1,
    type: "stream",
    modelId: "claude-sonnet",
    provider: null,
    startedAt: "2026-10-13T00:00:00.000Z",
    durationMs: null,
    input: null,
    output: null,
    usage: null,
    error: null,
    rawRequest: null,
    requestHeaders: null,
    responseHeaders: null,
    rawResponse: null,
    rawChunks: null,
    inputTransformations: null,
    ...overrides,
  };
}

/** Renders the card expanded and returns the panel under the given heading. */
function openPanel(step: DevToolsStep, heading: "Input" | "Output") {
  const view = render(<DevToolsStepCard step={step} />);
  fireEvent.click(view.getByRole("button", { name: /Step 1/ }));
  const panel = view.getByText(heading).parentElement;
  if (panel == null) throw new Error(`${heading} panel not found`);
  return within(panel);
}

function outputPanel(output: DevToolsStepOutput | null, error: string | null = null) {
  return openPanel(makeStep({ output, error }), "Output");
}

/** The text of the Output panel's Content block, which renders `output.content`. */
function displayedContent(content: unknown): string {
  const panel = outputPanel({ content });
  const block = panel.getByText("Content").parentElement?.querySelector("pre");
  if (block == null) throw new Error("Content block not found");
  return block.textContent ?? "";
}

describe("DevToolsStepCard panels", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  describe("output panel", () => {
    test("reports no output only when nothing at all was captured", () => {
      expect(outputPanel(null).getByText("No output recorded")).toBeTruthy();
      cleanup();
      expect(
        outputPanel({ textParts: [], toolCalls: [] }).getByText("No output recorded")
      ).toBeTruthy();
      cleanup();
      // An error alone is output: the panel shows it instead of the empty message.
      const failed = outputPanel(null, "rate limited");
      expect(failed.queryByText("No output recorded")).toBeNull();
      expect(failed.getByText("Error: rate limited")).toBeTruthy();
    });

    test("shows reasoning, tool calls, text and the finish reason", () => {
      const panel = outputPanel({
        reasoningParts: [{ id: "r1", text: "first idea\nsecond idea" }],
        toolCalls: [
          { toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
          "not-a-record",
        ],
        textParts: [{ id: "t1", text: "Hello there" }],
        content: "ignored when text parts exist",
        finishReason: "tool-calls",
      });

      const thinking = panel.getByRole("button", { name: /Thinking/ });
      // Collapsed cards preview the first line; expanding shows the full text.
      expect(thinking.textContent).toContain("first idea");
      expect(thinking.textContent).not.toContain("second idea");
      fireEvent.click(thinking);
      expect(panel.getByText(/second idea/)).toBeTruthy();

      expect(panel.getByRole("button", { name: /bash/ }).textContent).toContain("command: ls");
      expect(panel.getByRole("button", { name: /unknown/ })).toBeTruthy();
      expect(panel.getByText("Hello there")).toBeTruthy();
      expect(panel.queryByText("Content")).toBeNull();
      expect(panel.getByText("Finish reason: tool-calls")).toBeTruthy();
    });

    test("previews tool call arguments compactly", () => {
      const cases: Array<[unknown, string]> = [
        [{}, "{}"],
        [{ a: 1, b: true, c: null, d: "x" }, "a: 1, b: true, c: null, …"],
        [{ path: "p".repeat(40) }, `path: ${"p".repeat(30)}…`],
        [{ nested: { deep: [1, 2] } }, 'nested: { "deep": [ 1, 2 ] }'],
        ["q".repeat(90), `${"q".repeat(80)}…`],
        [undefined, "undefined"],
      ];
      for (const [args, preview] of cases) {
        const panel = outputPanel({ toolCalls: [{ toolName: "tool", args }] });
        const card = panel.getByRole("button", { name: /tool/ });
        expect(card.textContent).toBe(`tool${preview}`);
        cleanup();
      }
    });
  });

  describe("content display", () => {
    test("joins the readable parts of a content array", () => {
      const text = displayedContent([
        "plain",
        { type: "text", text: "hello" },
        { type: "text", text: "" },
        { type: "reasoning", text: "pondering" },
        { type: "tool-result", toolName: "bash", output: { type: "json", value: { ok: true } } },
        { type: "tool-result", toolName: "read", output: "file body" },
        { providerOptions: { anthropic: {} } },
        { type: "image" },
        { note: 1 },
        42,
      ]);
      expect(text.split("\n")).toEqual([
        "plain",
        "hello",
        "[Thinking] pondering",
        "[Tool Result: bash]",
        "{",
        '  "ok": true',
        "}",
        "[Tool Result: read]",
        "file body",
        "[image]",
        "{",
        '  "note": 1',
        "}",
        "42",
      ]);
    });

    test("shows a single part directly and falls back to JSON for an empty one", () => {
      expect(displayedContent("just text")).toBe("just text");
      cleanup();
      expect(displayedContent({ type: "text", text: "single" })).toBe("single");
      cleanup();
      expect(displayedContent({ type: "text", text: "" })).toBe(
        JSON.stringify({ type: "text", text: "" }, null, 2)
      );
      cleanup();
      // A provider-options-only part has nothing to show, so the raw JSON is shown.
      expect(displayedContent({ providerOptions: {} })).toBe(
        JSON.stringify({ providerOptions: {} }, null, 2)
      );
    });
  });

  describe("input panel", () => {
    test("shows the latest two prompt messages until asked for all", () => {
      const panel = openPanel(
        makeStep({
          input: {
            prompt: [
              { role: "system", content: "be brief" },
              { role: "user", content: [{ type: "text", text: "hi" }] },
              { role: "Assistant", content: "hello" },
            ],
          },
        }),
        "Input"
      );
      expect(panel.queryByText("system")).toBeNull();
      expect(panel.getByText("user")).toBeTruthy();
      // Roles are lowercased for display.
      expect(panel.getByText("assistant")).toBeTruthy();

      fireEvent.click(panel.getByRole("button", { name: "Show all 3 messages" }));
      expect(panel.getByText("system")).toBeTruthy();
      expect(panel.getByRole("button", { name: /system/ }).textContent).toContain("be brief");

      fireEvent.click(panel.getByRole("button", { name: "Show latest 2 messages" }));
      expect(panel.queryByText("system")).toBeNull();
    });

    test("labels a message that is not a record unknown and previews it as is", () => {
      const panel = openPanel(makeStep({ input: { prompt: ["raw string message"] } }), "Input");
      expect(panel.getByRole("button", { name: /unknown/ }).textContent).toContain(
        "raw string message"
      );
    });

    test("shows the raw input when the prompt is not a message list", () => {
      const panel = openPanel(makeStep({ input: { prompt: "a bare prompt" } }), "Input");
      expect(panel.getByText(/"prompt": "a bare prompt"/)).toBeTruthy();
      cleanup();
      expect(openPanel(makeStep(), "Input").getByText("No input recorded")).toBeTruthy();
      cleanup();
      expect(
        openPanel(makeStep({ input: { prompt: [] } }), "Input").getByText("No prompt messages")
      ).toBeTruthy();
    });
  });
});
