import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../../../../tests/ui/domGlobals";
import type { DevToolsStep } from "@/common/types/devtools";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { DevToolsStepCard } from "../DevToolsStepCard";

// Characterization tests for the step card header, its metadata pills, and the
// sections the pills open. Steps come from replayed JSONL, so several inputs are
// deliberately malformed: the card must render them instead of crashing.

function makeStep(overrides: Partial<DevToolsStep> = {}): DevToolsStep {
  return {
    id: "step-1",
    runId: "run-1",
    stepNumber: 3,
    type: "stream",
    modelId: "claude-sonnet",
    provider: "anthropic",
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

function renderExpanded(step: DevToolsStep, toolPolicy?: ToolPolicy) {
  const view = render(<DevToolsStepCard step={step} toolPolicy={toolPolicy} />);
  fireEvent.click(view.getByRole("button", { name: /Step 3/ }));
  return view;
}

function pillLabels(view: ReturnType<typeof render>): string[] {
  const names = [
    "available tools",
    "Provider options",
    "Usage",
    "Dropped thinking",
    "policy rules",
  ];
  return view
    .getAllByRole("button")
    .map((button) => button.textContent ?? "")
    .filter((text) => names.some((name) => text.includes(name)));
}

describe("DevToolsStepCard", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  describe("collapsed header", () => {
    test("summarizes input and output token totals, with ? for a missing side", () => {
      const both = render(
        <DevToolsStepCard
          step={makeStep({
            usage: { inputTokens: { total: 1200, cacheRead: 200 }, outputTokens: 34 },
          })}
        />
      );
      expect(both.getByRole("button", { name: /Step 3/ }).textContent).toContain("1,200→34 tok");
      cleanup();

      const inputOnly = render(<DevToolsStepCard step={makeStep({ usage: { inputTokens: 5 } })} />);
      expect(inputOnly.getByRole("button", { name: /Step 3/ }).textContent).toContain("5→? tok");
      cleanup();

      const outputOnly = render(
        <DevToolsStepCard step={makeStep({ usage: { outputTokens: 8 } })} />
      );
      expect(outputOnly.getByRole("button", { name: /Step 3/ }).textContent).toContain("?→8 tok");
    });

    test("shows no token summary when usage has neither side", () => {
      const view = render(<DevToolsStepCard step={makeStep({ usage: { totalTokens: 9 } })} />);
      expect(view.getByRole("button", { name: /Step 3/ }).textContent).not.toContain("tok");
    });

    test("keeps the details hidden until the header is clicked, and toggles them", () => {
      const view = render(<DevToolsStepCard step={makeStep()} />);
      expect(view.queryByText("Input")).toBeNull();

      const header = view.getByRole("button", { name: /Step 3/ });
      fireEvent.click(header);
      expect(view.getByText("Input")).toBeTruthy();
      expect(view.getByText("Output")).toBeTruthy();

      fireEvent.click(header);
      expect(view.queryByText("Input")).toBeNull();
    });
  });

  describe("metadata bar", () => {
    test("lists max tokens and the formatted tool choice", () => {
      const cases: Array<[unknown, string]> = [
        ["auto", "tool choice: auto"],
        [{ type: "tool", toolName: "bash" }, "tool choice: tool (bash)"],
        [{ type: "required" }, "tool choice: required"],
        [{ name: "file_read" }, "tool choice: file_read"],
        [{ other: 1 }, 'tool choice: { "other": 1 }'],
        [7, "tool choice: 7"],
        ["x".repeat(70), `tool choice: ${"x".repeat(64)}…`],
      ];
      for (const [toolChoice, expected] of cases) {
        const view = renderExpanded(
          makeStep({ input: { prompt: [], toolChoice, maxOutputTokens: 4096 } })
        );
        expect(view.getByText("max tokens: 4,096")).toBeTruthy();
        // JSON output keeps newlines; the label text collapses them for comparison.
        const label = view.getByText(/^tool choice:/).textContent?.replace(/\s+/g, " ");
        expect(label).toBe(expected);
        cleanup();
      }
    });

    test("shows no pills for a step without tools, options, usage, thinking or policy", () => {
      const view = renderExpanded(makeStep({ input: { prompt: [] } }));
      expect(pillLabels(view)).toEqual([]);
      expect(view.getByText("anthropic")).toBeTruthy();
    });

    test("shows one pill per kind of captured metadata", () => {
      const view = renderExpanded(
        makeStep({
          input: { prompt: [], tools: { bash: {}, read: {} }, providerOptions: { a: 1 } },
          usage: { inputTokens: 1 },
          inputTransformations: [
            { type: "thinking_dropped", path: "messages[1]" },
            { type: "thinking_mismatch_allowed", path: "messages[3]" },
          ],
        }),
        [{ regex_match: "bash", action: "disable" }]
      );
      expect(pillLabels(view)).toEqual([
        "2 available tools",
        "Provider options",
        "Usage",
        // Only thinking_dropped entries count: mismatch-allowed blocks reached the model.
        "Dropped thinking · 1",
        "1 policy rules",
      ]);
    });
  });

  describe("metadata sections", () => {
    test("a pill opens its section and a second click closes it", () => {
      const view = renderExpanded(makeStep({ input: { prompt: [], providerOptions: { k: "v" } } }));
      const pill = view.getByRole("button", { name: "Provider options" });

      fireEvent.click(pill);
      expect(view.getByText(/"k": "v"/)).toBeTruthy();

      fireEvent.click(pill);
      expect(view.queryByText(/"k": "v"/)).toBeNull();
    });

    test("lists tools from an array or a record, with fallback names and parameters", () => {
      const fromArray = renderExpanded(
        makeStep({
          input: {
            prompt: [],
            tools: [
              { name: "bash", description: "Run a command", inputSchema: { type: "object" } },
              { toolName: "read", schema: { q: 1 } },
              "raw-tool",
            ],
          },
        })
      );
      fireEvent.click(fromArray.getByRole("button", { name: "3 available tools" }));
      expect(fromArray.getByText("bash")).toBeTruthy();
      expect(fromArray.getByText("Run a command")).toBeTruthy();
      expect(fromArray.getByText(/"type": "object"/)).toBeTruthy();
      expect(fromArray.getByText("read")).toBeTruthy();
      expect(fromArray.getByText(/"q": 1/)).toBeTruthy();
      // A non-object entry keeps its position-based name and shows itself as parameters.
      expect(fromArray.getByText("tool-3")).toBeTruthy();
      expect(fromArray.getByText("raw-tool")).toBeTruthy();
      cleanup();

      const fromRecord = renderExpanded(
        makeStep({ input: { prompt: [], tools: { web_fetch: { parameters: { url: "string" } } } } })
      );
      fireEvent.click(fromRecord.getByRole("button", { name: "1 available tools" }));
      expect(fromRecord.getByText("web_fetch")).toBeTruthy();
      expect(fromRecord.getByText(/"url": "string"/)).toBeTruthy();
    });

    test("drops malformed policy rules and hides the pill when none survive", () => {
      const malformed = [
        { regex_match: "bash", action: "disable" },
        { regex_match: 5, action: "enable" },
        { regex_match: "x", action: "bogus" },
        "not-a-rule",
        null,
      ] as unknown as ToolPolicy;
      const view = renderExpanded(makeStep({ input: { prompt: [] } }), malformed);
      fireEvent.click(view.getByRole("button", { name: "1 policy rules" }));
      expect(view.getByText("bash")).toBeTruthy();
      expect(view.getByText("disable")).toBeTruthy();
      expect(view.queryByText("bogus")).toBeNull();
      cleanup();

      const allBad = [{ regex_match: 1, action: "enable" }] as unknown as ToolPolicy;
      const empty = renderExpanded(makeStep({ input: { prompt: [] } }), allBad);
      expect(pillLabels(empty)).toEqual([]);
    });

    test("usage shows the breakdowns, the total and the raw provider usage", () => {
      const view = renderExpanded(
        makeStep({
          usage: {
            inputTokens: { total: 1500, noCache: 1000, cacheRead: 500 },
            outputTokens: { total: 40, reasoning: 30 },
            raw: { provider_field: 7 },
          },
        })
      );
      fireEvent.click(view.getByRole("button", { name: "Usage" }));
      expect(view.getByText("No cache: 1,000")).toBeTruthy();
      expect(view.getByText("Cache read: 500")).toBeTruthy();
      expect(view.queryByText(/Cache write/)).toBeNull();
      expect(view.getByText("Reasoning: 30")).toBeTruthy();
      // Without totalTokens, the total is the sum of both sides.
      expect(view.getByText("Total: 1,540")).toBeTruthy();
      expect(view.getByText(/"provider_field": 7/)).toBeTruthy();
    });

    test("usage prefers the reported total and shows a dash for a missing side", () => {
      const view = renderExpanded(makeStep({ usage: { inputTokens: 10, totalTokens: 99 } }));
      fireEvent.click(view.getByRole("button", { name: "Usage" }));
      expect(view.getByText("Total: 99")).toBeTruthy();
      const outputCard = view.getByText("Output Tokens").parentElement;
      if (outputCard == null) throw new Error("Output Tokens card not found");
      expect(within(outputCard).getByText("—")).toBeTruthy();
    });

    test("dropped thinking lists each entry, naming types other than thinking_dropped", () => {
      const view = renderExpanded(
        makeStep({
          inputTransformations: [
            { type: "thinking_dropped", path: "messages[1]", reason: "signature_invalid" },
            { type: "thinking_dropped", path: "messages[2]" },
            { type: "thinking_mismatch_allowed", path: "messages[3]", reason: "binding" },
          ],
        })
      );
      fireEvent.click(view.getByRole("button", { name: "Dropped thinking · 2" }));
      expect(view.getByText("messages[1] · signature_invalid")).toBeTruthy();
      expect(view.getByText("messages[2] · thinking_dropped")).toBeTruthy();
      expect(view.getByText("messages[3] · thinking_mismatch_allowed · binding")).toBeTruthy();
    });
  });
});
