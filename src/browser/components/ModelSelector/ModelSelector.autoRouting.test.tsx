import type React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualRoutingModule from "@/browser/hooks/useRouting";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as ActualSettingsContextModule from "@/browser/contexts/SettingsContext";
import * as ActualPolicyContextModule from "@/browser/contexts/PolicyContext";
import * as ActualTooltipModule from "@/browser/components/Tooltip/Tooltip";
import { installDom } from "../../../../tests/ui/dom";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualRoutingModule = { ...ActualRoutingModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
const actualSettingsContextModule = { ...ActualSettingsContextModule };
const actualPolicyContextModule = { ...ActualPolicyContextModule };
const actualTooltipModule = { ...ActualTooltipModule };

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({ open: () => undefined, close: () => undefined }),
}));
void mock.module("@/browser/contexts/PolicyContext", () => ({
  usePolicy: () => ({ status: { state: "disabled" } }),
}));
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: null, loaded: true }),
}));
void mock.module("@/browser/hooks/useRouting", () => ({
  useRouting: () => ({
    resolveRoute: () => ({ route: "direct" }),
    resolveEffectiveRoute: () => "direct",
  }),
}));
// Tooltips portal through Radix, which happy-dom cannot host; render children inline.
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: () => null,
}));

import { ModelSelector } from "./ModelSelector";

const MODELS = ["openai:gpt-5.5", "anthropic:claude-opus-4-6"];

describe("ModelSelector auto routing", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/hooks/useRouting", () => actualRoutingModule);
    await mock.module("@/browser/hooks/useProvidersConfig", () => actualProvidersConfigModule);
    await mock.module("@/browser/contexts/SettingsContext", () => actualSettingsContextModule);
    await mock.module("@/browser/contexts/PolicyContext", () => actualPolicyContextModule);
    await mock.module("@/browser/components/Tooltip/Tooltip", () => actualTooltipModule);
  });

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function openSelector(container: HTMLElement) {
    fireEvent.click(container.querySelector('[role="combobox"]')!);
  }

  test("renders no Auto row without the prop", () => {
    const { container } = render(
      <ModelSelector value={MODELS[0]} onChange={() => undefined} models={MODELS} />
    );
    openSelector(container);
    expect(container.querySelector("[data-auto-routing-option]")).toBeNull();
  });

  test("selecting Auto calls onSelect without changing the concrete model", () => {
    const onChange = mock((_model: string) => undefined);
    const onSelect = mock(() => undefined);
    const { container } = render(
      <ModelSelector
        value={MODELS[0]}
        onChange={onChange}
        models={MODELS}
        autoRouting={{ active: false, onSelect }}
      />
    );
    openSelector(container);
    fireEvent.click(container.querySelector("[data-auto-routing-option]")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    // The dropdown closes after the pick.
    expect(container.querySelector("[data-auto-routing-option]")).toBeNull();
  });

  // Keyboard reachability of the Auto row (ArrowUp past the first model, Enter) is
  // covered by the ChatInput AutoModelRoutingKeyboard story: React key handlers do not
  // receive fireEvent.keyDown under happy-dom.
  test("while Auto is active the trigger reads Auto and no concrete row is selected", () => {
    const onChange = mock((_model: string) => undefined);
    const { container } = render(
      <ModelSelector
        value={MODELS[0]}
        onChange={onChange}
        models={MODELS}
        autoRouting={{ active: true, onSelect: () => undefined }}
      />
    );
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain("Auto");
    openSelector(container);
    const autoRow = container.querySelector("[data-auto-routing-option]");
    expect(autoRow?.getAttribute("aria-selected")).toBe("true");
    const modelRows = Array.from(container.querySelectorAll('[role="option"]')).filter(
      (row) => !row.hasAttribute("data-auto-routing-option")
    );
    expect(modelRows).toHaveLength(MODELS.length);
    expect(modelRows.every((row) => row.getAttribute("aria-selected") === "false")).toBe(true);

    // Picking a concrete model still goes through onChange (the owner turns Auto off).
    fireEvent.click(modelRows[1]);
    expect(onChange).toHaveBeenCalledWith(MODELS[1]);
  });
});
