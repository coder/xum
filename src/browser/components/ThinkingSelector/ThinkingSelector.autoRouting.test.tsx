import type React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualApiModule from "@/browser/contexts/API";
import * as ActualRoutingModule from "@/browser/hooks/useRouting";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as ActualThinkingLevelModule from "@/browser/hooks/useThinkingLevel";
import * as ActualReasoningModeModule from "@/browser/hooks/useReasoningMode";
import * as ActualTooltipModule from "@/browser/components/Tooltip/Tooltip";
import type { ThinkingLevel } from "@/common/types/thinking";
import { installDom } from "../../../../tests/ui/dom";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualApiModule = { ...ActualApiModule };
const actualRoutingModule = { ...ActualRoutingModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
const actualThinkingLevelModule = { ...ActualThinkingLevelModule };
const actualReasoningModeModule = { ...ActualReasoningModeModule };
const actualTooltipModule = { ...ActualTooltipModule };

const setThinkingLevel = mock((_level: ThinkingLevel) => undefined);

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null }),
  useOptionalAPI: () => null,
}));
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    config: null,
    loaded: true,
    refresh: () => Promise.resolve(),
    updateOptimistically: () => undefined,
  }),
}));
void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({
    resolveRoute: () => ({ route: "direct" }),
    resolveEffectiveRoute: () => "direct",
  }),
}));
void mock.module("@/browser/hooks/useThinkingLevel", () => ({
  useThinkingLevel: () => ["medium", setThinkingLevel] as const,
}));
void mock.module("@/browser/hooks/useReasoningMode", () => ({
  useReasoningMode: () => ["standard", () => undefined] as const,
}));
// Tooltips portal through Radix, which happy-dom cannot host; render children inline.
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: () => null,
}));

import { ThinkingSelector, ThinkingSelectorControl } from "./ThinkingSelector";

const MODEL = "anthropic:claude-opus-4-6";

function openSelector(container: HTMLElement) {
  fireEvent.click(container.querySelector("[data-thinking-selector-trigger]")!);
}

function levelRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).filter(
    (row) => !row.hasAttribute("data-auto-routing-option")
  );
}

describe("ThinkingSelector auto routing", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/contexts/API", () => actualApiModule);
    await mock.module("@/browser/hooks/useRouting", () => actualRoutingModule);
    await mock.module("@/browser/hooks/useProvidersConfig", () => actualProvidersConfigModule);
    await mock.module("@/browser/hooks/useThinkingLevel", () => actualThinkingLevelModule);
    await mock.module("@/browser/hooks/useReasoningMode", () => actualReasoningModeModule);
    await mock.module("@/browser/components/Tooltip/Tooltip", () => actualTooltipModule);
  });

  beforeEach(() => {
    cleanupDom = installDom();
    setThinkingLevel.mockClear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders no Auto row without the prop", () => {
    const { container } = render(
      <ThinkingSelectorControl
        modelString={MODEL}
        thinkingLevel="medium"
        onThinkingLevelChange={() => undefined}
        reasoningMode="standard"
        onReasoningModeChange={() => undefined}
      />
    );
    openSelector(container);
    expect(container.querySelector("[data-auto-routing-option]")).toBeNull();
  });

  test("selecting Auto calls onSelect without changing the concrete level", () => {
    const onThinkingLevelChange = mock((_level: ThinkingLevel) => undefined);
    const onSelect = mock(() => undefined);
    const { container } = render(
      <ThinkingSelectorControl
        modelString={MODEL}
        thinkingLevel="medium"
        onThinkingLevelChange={onThinkingLevelChange}
        reasoningMode="standard"
        onReasoningModeChange={() => undefined}
        autoRouting={{ active: false, onSelect }}
      />
    );
    openSelector(container);
    const autoRow = container.querySelector("[data-auto-routing-option]")!;
    expect(autoRow.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(autoRow);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onThinkingLevelChange).not.toHaveBeenCalled();
    // Like the level rows, the Auto row keeps the menu open.
    expect(container.querySelector('[data-component="ThinkingSelectorMenu"]')).not.toBeNull();
  });

  test("while Auto is active the trigger reads Auto and no level row is selected", () => {
    const onThinkingLevelChange = mock((_level: ThinkingLevel) => undefined);
    const { container } = render(
      <ThinkingSelectorControl
        modelString={MODEL}
        thinkingLevel="medium"
        onThinkingLevelChange={onThinkingLevelChange}
        reasoningMode="standard"
        onReasoningModeChange={() => undefined}
        autoRouting={{ active: true, onSelect: () => undefined }}
      />
    );
    expect(container.querySelector("[data-thinking-label]")?.textContent).toBe("Auto");
    openSelector(container);
    expect(
      container.querySelector("[data-auto-routing-option]")?.getAttribute("aria-selected")
    ).toBe("true");
    const rows = levelRows(container);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.getAttribute("aria-selected") === "false")).toBe(true);

    // Picking a concrete level still goes through the change handler (the owner turns Auto off).
    fireEvent.click(rows.find((row) => row.getAttribute("aria-label") === "High")!);
    expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
  });

  test("composer wrapper: Auto selects the flag, a concrete pick reaches the context", () => {
    const onSelect = mock(() => undefined);
    const { container } = render(
      <ThinkingSelector modelString={MODEL} autoRouting={{ active: false, onSelect }} />
    );
    openSelector(container);
    fireEvent.click(container.querySelector("[data-auto-routing-option]")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(setThinkingLevel).not.toHaveBeenCalled();

    // Leaving Auto on a concrete pick is ThinkingContext.setThinkingLevel's job.
    fireEvent.click(levelRows(container).find((row) => row.getAttribute("aria-label") === "High")!);
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
