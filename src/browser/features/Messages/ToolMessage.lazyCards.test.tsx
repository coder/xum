import "../../../../tests/ui/dom";

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useSyncExternalStore } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as RealStore from "@/browser/features/Tools/Shared/toolCardsStore";
import * as RealLoader from "@/browser/features/Tools/Shared/toolCardsLoader";
import { getToolComponent } from "@/browser/features/Tools/Shared/getToolComponent";
import { ProposePlanToolCall } from "@/browser/features/Tools/ProposePlanToolCall";
import type { DisplayedMessage } from "@/common/types/message";
import { ToolMessage } from "./ToolMessage";

// tests/ui/dom loads the real cards, so a fake store stands in for "not loaded yet".
const realStore = { ...RealStore };
let fakeCards: RealStore.ToolCards | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
restoreModulesAfterSuite([["@/browser/features/Tools/Shared/toolCardsStore", realStore]]);
void mock.module("@/browser/features/Tools/Shared/toolCardsStore", () => ({
  ...realStore,
  useToolCards: () => useSyncExternalStore(subscribe, () => fakeCards),
}));
const realLoader = { ...RealLoader };
restoreModulesAfterSuite([["@/browser/features/Tools/Shared/toolCardsLoader", realLoader]]);

const bashRow = {
  type: "tool",
  id: "tool-1",
  historyId: "assistant-1",
  toolCallId: "call-1",
  toolName: "bash",
  args: { script: "echo lazy", timeout_secs: 5, run_in_background: false, display_name: "Echo" },
  result: { success: true, output: "lazy", exitCode: 0, wall_duration_ms: 3 },
  status: "completed",
  isPartial: false,
  historySequence: 2,
  timestamp: 2,
} as unknown as Extract<DisplayedMessage, { type: "tool" }>;

function renderRow() {
  return render(
    <ThemeProvider forcedTheme="dark">
      <TooltipProvider>
        <BackgroundBashProvider workspaceId="ws-test">
          <ToolMessage message={bashRow} workspaceId="ws-test" className="row" />
        </BackgroundBashProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

describe("ToolMessage with lazy tool cards", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
    fakeCards = null;
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  test("shows the card header while loading, then the card in the same row", () => {
    const view = renderRow();
    const row = view.container.querySelector(".row");
    // Not an empty (0-height) row: the collapsed header names the tool and its status.
    expect(view.getByTestId("tool-card-fallback").textContent).toContain("bash");
    expect(view.queryByText("echo lazy")).toBeNull();

    act(() => {
      fakeCards = { getToolComponent, ProposePlanToolCall };
      for (const listener of listeners) listener();
    });
    expect(view.queryByTestId("tool-card-fallback")).toBeNull();
    expect(view.getByText("echo lazy")).toBeTruthy();
    // The row's own node stays, so scroll anchoring keeps the rows around it.
    expect(view.container.querySelector(".row")).toBe(row);
  });

  test("offers a page reload when the cards' chunk fails to load", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    // React.lazy reads the chunk's default export at render, so this fails whether or not the
    // chunk loaded before. LazyFeature's boundary treats a chunk that fails to evaluate like one
    // that fails to fetch.
    void mock.module("@/browser/features/Tools/Shared/toolCardsLoader", () => ({
      default: () => {
        throw new Error("Failed to fetch dynamically imported module");
      },
    }));
    try {
      const view = renderRow();
      expect((await view.findByRole("alert")).textContent).toContain("Tool cards failed to load");
      expect(view.getByRole("button", { name: "Reload" })).toBeTruthy();
      // The header still holds the row's place next to the alert.
      expect(view.getByTestId("tool-card-fallback").textContent).toContain("bash");
    } finally {
      void mock.module("@/browser/features/Tools/Shared/toolCardsLoader", () => realLoader);
      consoleError.mockRestore();
    }
  });
});
