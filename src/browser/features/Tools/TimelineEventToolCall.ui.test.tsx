import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import { TimelineEventToolCall } from "./TimelineEventToolCall";

const TEST_WORKSPACE_ID = "timeline-event-test";

// ToolIcon renders a Radix Tooltip which requires a TooltipProvider and contexts.
function renderWithProviders(ui: ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="timeline_event">
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

const ROW_PREVIEW = '[data-testid="timeline-row-preview"]';
const NOT_RECORDED = '[data-testid="timeline-not-recorded"]';

describe("TimelineEventToolCall", () => {
  beforeEach(() => {
    saveDomGlobals();
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    restoreDomGlobals();
  });

  test("recorded result renders the feed-row preview", () => {
    const view = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="completed"
        defaultExpanded
        result={{ success: true, recorded: true }}
      />
    );
    expect(view.container.querySelector(ROW_PREVIEW)).not.toBeNull();
    expect(view.container.querySelector(NOT_RECORDED)).toBeNull();
  });

  test("throttled result (recorded: false) suppresses the preview and flags the drop", () => {
    const view = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="completed"
        defaultExpanded
        result={{ success: true, recorded: false }}
      />
    );
    expect(view.container.querySelector(ROW_PREVIEW)).toBeNull();
    expect(view.container.querySelector(NOT_RECORDED)).not.toBeNull();
  });

  test("unwraps the SDK JSON container before reading the result", () => {
    const view = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="completed"
        defaultExpanded
        result={{ type: "json", value: { success: true, recorded: true } }}
      />
    );
    expect(view.container.querySelector(ROW_PREVIEW)).not.toBeNull();
  });

  test("category badge maps underscores to spaces; missing category falls back to Agent", () => {
    const withCategory = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Picked up a review comment.", category: "picked_up" }}
        status="completed"
        defaultExpanded
        result={{ success: true, recorded: true }}
      />
    );
    // Header chip + row badge both derive from the same transform.
    expect(withCategory.queryAllByText("picked up").length).toBe(2);
    cleanup();

    const withoutCategory = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Rebased the feature branch." }}
        status="completed"
        defaultExpanded
        result={{ success: true, recorded: true }}
      />
    );
    expect(withoutCategory.queryAllByText("Agent").length).toBeGreaterThanOrEqual(2);
  });

  test("renders the top-level error shape ({ success: false, error })", () => {
    const view = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "   ", category: "milestone" }}
        status="failed"
        defaultExpanded
        result={{ success: false, error: "timeline_event requires a non-empty description" }}
      />
    );
    expect(view.queryByText("timeline_event requires a non-empty description")).not.toBeNull();
    expect(view.container.querySelector(ROW_PREVIEW)).toBeNull();
  });

  test("renders the nested bare error shape ({ error }) without a success flag", () => {
    const view = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="failed"
        defaultExpanded
        result={{ error: "workspace timeline unavailable" }}
      />
    );
    expect(view.queryByText("workspace timeline unavailable")).not.toBeNull();
    expect(view.container.querySelector(ROW_PREVIEW)).toBeNull();
  });

  test("no result yet renders neither preview, drop note, nor error", () => {
    const view = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="executing"
        defaultExpanded
      />
    );
    expect(view.container.querySelector(ROW_PREVIEW)).toBeNull();
    expect(view.container.querySelector(NOT_RECORDED)).toBeNull();
  });

  test("preview time and day header render only when a call timestamp is available", () => {
    const withTimestamp = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="completed"
        defaultExpanded
        result={{ success: true, recorded: true }}
        toolCallTimestamp={new Date("2026-07-28T09:42:00").getTime()}
      />
    );
    expect(withTimestamp.container.querySelector(`${ROW_PREVIEW} time`)).not.toBeNull();
    cleanup();

    const withoutTimestamp = renderWithProviders(
      <TimelineEventToolCall
        args={{ description: "Opened PR #412 for review.", category: "milestone" }}
        status="completed"
        defaultExpanded
        result={{ success: true, recorded: true }}
      />
    );
    expect(withoutTimestamp.container.querySelector(`${ROW_PREVIEW} time`)).toBeNull();
  });
});
