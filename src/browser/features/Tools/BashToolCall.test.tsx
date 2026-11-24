import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import type { BashToolResult } from "@/common/types/tools";
import { BashToolCall } from "./BashToolCall";

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

function renderExpanded(result: unknown) {
  const view = render(
    <TooltipProvider>
      <BackgroundBashProvider workspaceId="ws-test">
        <BashToolCall
          workspaceId="ws-test"
          toolCallId="call-1"
          args={{
            script: "rm -rf build",
            run_in_background: false,
            timeout_secs: 30,
            display_name: "Clean",
          }}
          // The runtime shape a blocking hook returns; the static type does not admit it (#6044).
          result={result as BashToolResult}
          status="failed"
        />
      </BackgroundBashProvider>
    </TooltipProvider>
  );
  fireEvent.click(view.getByText("rm -rf build"));
  return view;
}

function renderCollapsed(result: BashToolResult) {
  return render(
    <TooltipProvider>
      <BackgroundBashProvider workspaceId="ws-test">
        <BashToolCall
          workspaceId="ws-test"
          toolCallId="call-sandboxed"
          args={{
            script: "make install",
            run_in_background: false,
            timeout_secs: 30,
            display_name: "Install",
          }}
          result={result}
          status="failed"
        />
      </BackgroundBashProvider>
    </TooltipProvider>
  );
}

function sandboxedResult(sandboxDenials?: string[]): BashToolResult {
  return {
    success: false,
    error: "Command exited with code 1",
    output: "",
    exitCode: 1,
    wall_duration_ms: 5,
    ...(sandboxDenials ? { sandboxDenials } : {}),
  };
}

describe("BashToolCall", () => {
  test("a sandbox denial shows the badge and a line naming what was blocked, even collapsed", () => {
    const lines = [
      ["write /Users/me/.zshrc", "/Users/me/.zshrc"],
      ["read /Users/me/.ssh/id_rsa", "/Users/me/.ssh/id_rsa"],
      ["network paste.example.net", "paste.example.net"],
      ["mach-lookup com.apple.foo", "mach-lookup com.apple.foo"],
    ].map(([denial, target]) => {
      const view = renderCollapsed(sandboxedResult([denial, "write /tmp/other"]));
      expect(view.getByText("Sandbox")).toBeDefined();
      const line = view.getByText(
        (_, element) =>
          element?.textContent?.includes(target) === true && element.childElementCount === 0
      );
      // The first denial is named; the others are counted, not listed.
      expect(line.textContent).toContain("1 more");
      expect(line.textContent).not.toContain("/tmp/other");
      cleanup();
      return line.textContent?.replace(target, "<target>");
    });
    // Each kind explains itself in its own words.
    expect(new Set(lines).size).toBe(lines.length);
  });

  test("a command the sandbox did not block shows no badge", () => {
    for (const denials of [undefined, []]) {
      expect(renderCollapsed(sandboxedResult(denials)).queryByText("Sandbox")).toBeNull();
      cleanup();
    }
  });

  test("shows why a hook blocked the call: { error } without success (#6044)", () => {
    const view = renderExpanded({ error: "Blocked by hook: rm is not allowed here" });
    expect(view.getByText("Error")).toBeDefined();
    expect(view.getByText("Blocked by hook: rm is not allowed here")).toBeDefined();
  });

  test("a failed command still shows its error; an empty error shows no box", () => {
    const failed = renderExpanded({
      success: false,
      error: "Command exited with code 1",
      output: "",
      exitCode: 1,
      wall_duration_ms: 5,
    });
    expect(failed.getByText("Command exited with code 1")).toBeDefined();
    cleanup();
    expect(renderExpanded({ error: "" }).queryByText("Error")).toBeNull();
  });

  test("a primitive result (0, false) renders without throwing", () => {
    for (const result of [0, false]) {
      const view = renderExpanded(result);
      expect(view.getByText("Script")).toBeDefined();
      expect(view.queryByText("Error")).toBeNull();
      cleanup();
    }
  });

  test("the SDK JSON container shape still shows the hook's reason", () => {
    const view = renderExpanded({ type: "json", value: { error: "Blocked by hook: wrapped" } });
    expect(view.getByText("Blocked by hook: wrapped")).toBeDefined();
  });
});
