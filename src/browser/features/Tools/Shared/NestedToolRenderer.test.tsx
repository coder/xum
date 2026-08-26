import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { NestedToolRenderer } from "./NestedToolRenderer";

// BashToolCall requires the background-bash actions context.
function Providers(props: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <BackgroundBashProvider workspaceId="ws-test">{props.children}</BackgroundBashProvider>
    </TooltipProvider>
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

describe("NestedToolRenderer", () => {
  test("renders hook output for nested tool results", () => {
    const { getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "echo hook" }}
          output={{ success: true, hook_output: "post hook ran", hook_duration_ms: 42 }}
          status="completed"
        />
      </Providers>
    );

    expect(getByText("hook output")).toBeDefined();
  });

  test("kernel-mode suppressed summaries render no duration or exit-code detail", () => {
    const { queryByText, getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "ls", display_name: "List", timeout_secs: 60 }}
          output={{ suppressed: true, ok: true, bytes: 12345 }}
          status="completed"
        />
      </Providers>
    );

    // The summary is not a BashToolResult: without stripping it, the card
    // renders "took —" and an empty exit-code pill.
    expect(getByText(/timeout: 60s/)).toBeDefined();
    expect(queryByText(/took/)).toBeNull();
    expect(queryByText(/—/)).toBeNull();
  });

  test("reconstructed failure shape skips missing duration/exit-code fields", () => {
    const { queryByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "ls", display_name: "List", timeout_secs: 60 }}
          output={{ success: false, error: "boom" }}
          status="failed"
        />
      </Providers>
    );

    expect(queryByText(/took/)).toBeNull();
    expect(queryByText(/—/)).toBeNull();
  });

  test("full bash results keep the duration and exit-code badge", () => {
    const { getByText } = render(
      <Providers>
        <NestedToolRenderer
          toolName="bash"
          input={{ script: "ls", display_name: "List", timeout_secs: 60 }}
          output={{ success: true, output: "a", exitCode: 0, wall_duration_ms: 1500 }}
          status="completed"
        />
      </Providers>
    );

    expect(getByText(/took 2s/)).toBeDefined();
    expect(getByText("0")).toBeDefined();
  });
});
