import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { getAutoExpandPrefsKey } from "@/common/constants/storage";
import { buildDiffLineDeltaPreview, FileEditToolCall } from "./FileEditToolCall";

const TEST_WORKSPACE_ID = "file-edit-tool-test";
const TEST_TOOL_NAME = "file_edit_replace_string";

function renderWithProviders(ui: ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        {/* useStickyExpand keys the tool preference by tool name (from ToolNameContext). */}
        <ToolNameProvider toolName={TEST_TOOL_NAME}>
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

describe("buildDiffLineDeltaPreview", () => {
  test("counts unified diff payload additions and deletions without file headers", () => {
    const diff = [
      "--- src/example.ts",
      "+++ src/example.ts",
      "@@ -1,3 +1,4 @@",
      " import { keep } from './keep';",
      "+import { added } from './added';",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      " const unchanged = true;",
    ].join("\n");

    expect(buildDiffLineDeltaPreview(diff)).toEqual({
      additions: 2,
      deletions: 1,
      additionsLabel: "+2",
      deletionsLabel: "-1",
      title: "2 lines added, 1 line removed",
    });
  });

  test("counts payload changes whose content looks like file headers", () => {
    const diff = [
      "--- README.md",
      "+++ README.md",
      "@@ -1,1 +1,1 @@",
      "---- old horizontal rule",
      "++++ new heading",
    ].join("\n");

    expect(buildDiffLineDeltaPreview(diff)).toMatchObject({
      additions: 1,
      deletions: 1,
      additionsLabel: "+1",
      deletionsLabel: "-1",
    });
  });

  test("returns null when a diff has no changed payload lines", () => {
    const diff = [
      "--- src/example.ts",
      "+++ src/example.ts",
      "@@ -1,1 +1,1 @@",
      " const unchanged = true;",
    ].join("\n");

    expect(buildDiffLineDeltaPreview(diff)).toBeNull();
  });
});

describe("FileEditToolCall expansion", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("keeps the line delta visible in a collapsed successful edit", () => {
    globalThis.window.localStorage.setItem(
      getAutoExpandPrefsKey(TEST_WORKSPACE_ID),
      JSON.stringify({ tools: { [TEST_TOOL_NAME]: false } })
    );
    const diff = [
      "--- src/example.ts",
      "+++ src/example.ts",
      "@@ -1,2 +1,3 @@",
      "+const first = true;",
      "+const second = true;",
      "-const old = true;",
      " const unchanged = true;",
    ].join("\n");

    const view = renderWithProviders(
      <FileEditToolCall
        toolName="file_edit_replace_string"
        args={{ path: "src/example.ts", old_string: "old", new_string: "new" }}
        result={{ success: true, diff, edits_applied: 1 }}
        status="completed"
      />
    );

    expect(view.queryByText("const unchanged = true;")).toBeNull();
    expect(view.getByTitle("2 lines added, 1 line removed").textContent).toBe("+2, -1");
  });

  test("does not mutate a present edit's expand state when the result arrives later", () => {
    // Expand state is seeded once at mount (no workspace preference here) and must not
    // be mutated when the result later arrives — that would be a layout flash. A row
    // that mounted expanded (pending) stays expanded, so the failure is shown
    // immediately instead of being auto-collapsed behind a second click.
    const view = renderWithProviders(
      <FileEditToolCall
        toolName="file_edit_replace_string"
        args={{ path: "src/example.ts", old_string: "old", new_string: "new" }}
        result={undefined}
        status="executing"
      />
    );

    expect(view.queryByText("Waiting for result")).not.toBeNull();

    view.rerender(
      <ThemeProvider forcedTheme="dark">
        <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
          {/* Mirror renderWithProviders' tree so the row instance is reused, not remounted. */}
          <ToolNameProvider toolName={TEST_TOOL_NAME}>
            <TooltipProvider>
              <FileEditToolCall
                toolName="file_edit_replace_string"
                args={{ path: "src/example.ts", old_string: "old", new_string: "new" }}
                result={{ success: false, error: "edit failed" }}
                status="failed"
              />
            </TooltipProvider>
          </ToolNameProvider>
        </MessageListProvider>
      </ThemeProvider>
    );

    // Still expanded — the failure is visible without re-expanding.
    expect(view.queryByText("edit failed")).not.toBeNull();

    // The user can still collapse it manually.
    fireEvent.click(view.getByText("src/example.ts"));
    expect(view.queryByText("edit failed")).toBeNull();
  });
});
