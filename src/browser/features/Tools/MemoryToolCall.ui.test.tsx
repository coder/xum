import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { MemoryToolCall } from "./MemoryToolCall";

const TEST_WORKSPACE_ID = "memory-tool-test";

// ToolIcon renders a Radix Tooltip which requires a TooltipProvider and contexts.
function renderWithProviders(ui: ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="memory">
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

describe("MemoryToolCall", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("shows the command and path in the header", () => {
    const view = renderWithProviders(
      <MemoryToolCall
        args={{ command: "create", path: "/memories/global/prefs.md", file_text: "x" }}
        result={{ success: true, output: "Created /memories/global/prefs.md" }}
        status="completed"
      />
    );
    expect(view.queryByText("create")).not.toBeNull();
    expect(view.queryByText("/memories/global/prefs.md")).not.toBeNull();
  });

  test("shows rename as old → new in the header", () => {
    const view = renderWithProviders(
      <MemoryToolCall
        args={{
          command: "rename",
          old_path: "/memories/global/a.md",
          new_path: "/memories/global/b.md",
        }}
        result={{ success: true, output: "Renamed" }}
        status="completed"
      />
    );
    expect(view.queryByText("/memories/global/a.md → /memories/global/b.md")).not.toBeNull();
  });

  test("reveals the error when a failed call is expanded", () => {
    const view = renderWithProviders(
      <MemoryToolCall
        args={{ command: "delete", path: "/memories/global/missing.md" }}
        result={{
          success: false,
          error: "No memory file or directory at /memories/global/missing.md",
        }}
        status="failed"
      />
    );
    fireEvent.click(view.getByText("delete"));
    expect(
      view.queryByText("No memory file or directory at /memories/global/missing.md")
    ).not.toBeNull();
  });

  test("renders memory content as plain text (no HTML injection)", () => {
    const view = renderWithProviders(
      <MemoryToolCall
        args={{ command: "view", path: "/memories/project/evil.md" }}
        result={{ success: true, output: '1\t<img src=x onerror="alert(1)">' }}
        status="completed"
      />
    );
    fireEvent.click(view.getByText("view"));
    // The markup must appear as literal text, not as a parsed element.
    // (textContent comparison: getByText normalizes tabs/whitespace.)
    expect(view.container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(view.container.querySelector("img")).toBeNull();
  });
});
