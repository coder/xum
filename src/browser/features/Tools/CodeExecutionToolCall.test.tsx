import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { ComponentProps, ReactNode } from "react";

import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
// The tool registry first, as in the app: a script renders its nested calls through the
// registry, which imports the script component back, and the cycle only resolves in this order.
import "./Shared/getToolComponent";
import { CodeExecutionToolCall } from "./CodeExecutionToolCall";
import { COLLAPSED_NESTED_CALL_LIMIT } from "./codeExecutionViewMode";
import type { NestedToolCall } from "./Shared/codeExecutionTypes";

// Nested bash rows need the background-bash context; the code view highlights with the theme.
function Providers(props: { children: ReactNode }) {
  return (
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider>
        <BackgroundBashProvider workspaceId="ws-test">{props.children}</BackgroundBashProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

type ScriptProps = Partial<ComponentProps<typeof CodeExecutionToolCall>>;

function renderScript(props: ScriptProps) {
  return render(
    <Providers>
      <CodeExecutionToolCall args={{ code: "return run();" }} status="completed" {...props} />
    </Providers>
  );
}

function bashCall(index: number): NestedToolCall {
  return {
    toolCallId: `call-${index}`,
    toolName: "bash",
    input: { script: `echo step-${index}`, display_name: `Step ${index}`, timeout_secs: 30 },
    output: { success: true, output: "", exitCode: 0, wall_duration_ms: 5 },
    state: "output-available",
  };
}

// 1x1 transparent PNG.
const PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let windowInstance: GlobalWindow | null = null;

beforeEach(() => {
  saveDomGlobals();
  windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as Window & typeof globalThis;
  globalThis.document = windowInstance.document as unknown as Document;
});

afterEach(() => {
  cleanup();
  void windowInstance?.happyDOM.abort();
  windowInstance = null;
  restoreDomGlobals();
});

describe("CodeExecutionToolCall result view", () => {
  test("shows the return value as text, or says that there is none", () => {
    const withObject = renderScript({ result: { success: true, result: { files: 2 } } });
    fireEvent.click(withObject.getByRole("button", { name: "Result" }));
    expect(withObject.container.textContent).toContain('"files": 2');
    withObject.unmount();

    // A string is shown as it is, not as a JSON string literal.
    const withString = renderScript({ result: { success: true, result: "all done" } });
    fireEvent.click(withString.getByRole("button", { name: "Result" }));
    expect(withString.getByText("all done")).toBeDefined();
    expect(withString.container.textContent).not.toContain('"all done"');
    withString.unmount();

    const withNothing = renderScript({ result: { success: true, result: undefined } });
    fireEvent.click(withNothing.getByRole("button", { name: "Result" }));
    expect(withNothing.getByText("No return value")).toBeDefined();
  });

  test("a failed script opens on its error without a click", () => {
    const view = renderScript({
      status: "failed",
      result: { success: false, error: "ReferenceError: run is not defined" },
    });
    expect(view.getByText("ReferenceError: run is not defined")).toBeDefined();
    expect(view.getByRole("button", { name: "Result" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("a script that did not finish says how it stopped", () => {
    const interrupted = renderScript({ status: "interrupted", result: undefined });
    fireEvent.click(interrupted.getByRole("button", { name: "Result" }));
    expect(interrupted.getByText("Interrupted")).toBeDefined();
    interrupted.unmount();

    const backgrounded = renderScript({ status: "backgrounded", result: undefined });
    fireEvent.click(backgrounded.getByRole("button", { name: "Result" }));
    expect(backgrounded.getByText("Backgrounded")).toBeDefined();
    backgrounded.unmount();

    // A running script has no result to look at yet.
    const running = renderScript({ status: "executing", result: undefined });
    expect(running.queryByRole("button", { name: "Result" })).toBeNull();
  });
});

describe("CodeExecutionToolCall nested calls", () => {
  function openScript(view: ReturnType<typeof renderScript>) {
    // A settled script that only made routine calls is one closed line.
    const disclosure = view.getByRole("button", { name: /^Script/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
  }

  test("shows the latest calls, and the earlier ones on request", () => {
    const total = COLLAPSED_NESTED_CALL_LIMIT + 2;
    const calls = Array.from({ length: total }, (_, index) => bashCall(index + 1));
    const view = renderScript({ nestedCalls: calls, result: { success: true, result: undefined } });
    openScript(view);

    const shownSteps = () =>
      calls.filter((call) => view.queryByText(`echo step-${call.toolCallId.slice(5)}`) !== null)
        .length;
    expect(shownSteps()).toBe(COLLAPSED_NESTED_CALL_LIMIT);
    expect(view.queryByText("echo step-1")).toBeNull();
    expect(view.getByText(`echo step-${total}`)).toBeDefined();

    fireEvent.click(view.getByRole("button", { name: "Show 2 earlier calls" }));
    expect(shownSteps()).toBe(total);

    fireEvent.click(view.getByRole("button", { name: "Hide earlier calls" }));
    expect(shownSteps()).toBe(COLLAPSED_NESTED_CALL_LIMIT);
  });

  test("offers no cut when every call already shows, and counts one earlier call in the singular", () => {
    const few = renderScript({
      nestedCalls: Array.from({ length: COLLAPSED_NESTED_CALL_LIMIT }, (_, i) => bashCall(i + 1)),
      result: { success: true, result: undefined },
    });
    openScript(few);
    expect(few.queryByRole("button", { name: /earlier call/ })).toBeNull();
    few.unmount();

    const oneMore = renderScript({
      nestedCalls: Array.from({ length: COLLAPSED_NESTED_CALL_LIMIT + 1 }, (_, i) =>
        bashCall(i + 1)
      ),
      result: { success: true, result: undefined },
    });
    openScript(oneMore);
    expect(oneMore.getByRole("button", { name: "Show 1 earlier call" })).toBeDefined();
  });
});

describe("CodeExecutionToolCall carrier attachments", () => {
  test("opens a script that carries attachments and shows each kind", () => {
    const view = renderScript({
      nestedCalls: [bashCall(1)],
      result: {
        success: true,
        result: undefined,
        attachments: [
          { type: "media", mediaType: "image/png", data: PNG_DATA, filename: "shot.png" },
          // The gallery refuses a PDF: it gets a download card.
          { type: "media", mediaType: "application/pdf", data: "JVBERi0=", filename: "report.pdf" },
          { type: "display_file", mediaType: "text/csv", data: "YSxi", filename: "data.csv" },
        ],
      },
    });

    // Attachments are something to look at, so the script is open without a click.
    expect(view.getByRole("button", { name: /^Script/ }).getAttribute("aria-expanded")).toBe(
      "true"
    );
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(view.container.textContent).toContain("report.pdf");
    expect(view.container.textContent).toContain("data.csv");
  });

  test("ignores malformed attachments from replayed history", () => {
    const malformed = ["not a part", { type: "media" }, null] as unknown as NonNullable<
      ScriptProps["result"]
    >["attachments"];
    const view = renderScript({
      nestedCalls: [bashCall(1)],
      result: { success: true, result: undefined, attachments: malformed },
    });
    // Nothing to show, so the routine script stays one closed line.
    expect(view.getByRole("button", { name: /^Script/ }).getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(view.container.querySelector("img")).toBeNull();

    const notAnArray = renderScript({
      nestedCalls: [bashCall(1)],
      result: {
        success: true,
        result: undefined,
        attachments: "oops" as unknown as NonNullable<ScriptProps["result"]>["attachments"],
      },
    });
    expect(notAnArray.getAllByRole("button", { name: /^Script/ })).toHaveLength(2);
  });
});
