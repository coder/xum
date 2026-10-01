import React, { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { APIContext } from "@/browser/contexts/API";
import * as ActualRoutingModule from "@/browser/hooks/useRouting";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as ActualTooltipModule from "@/browser/components/Tooltip/Tooltip";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIReasoningMode } from "@/common/types/thinking";
import { installDom } from "../../../../tests/ui/dom";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualRoutingModule = { ...ActualRoutingModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
const actualTooltipModule = { ...ActualTooltipModule };

let providersConfig: ProvidersConfigMap | null = null;

void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({
    config: providersConfig,
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
// Tooltips portal through Radix, which happy-dom cannot host; render children inline.
void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: () => null,
}));

import { ThinkingSelectorControl } from "./ThinkingSelector";

const CYBER_MODEL = "openai:gpt-6.1-sol";
const NON_CYBER_MODEL = "openai:gpt-6-luna";

function directOpenAIConfig(cyberModelEnabled: boolean): ProvidersConfigMap {
  return {
    openai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      ...(cyberModelEnabled ? { cyberModelEnabled: true } : {}),
    },
  };
}

function NoBackendAPIWrapper(props: { children: React.ReactNode }) {
  return (
    <APIContext.Provider
      value={{
        api: null,
        status: "connecting",
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      }}
    >
      {props.children}
    </APIContext.Provider>
  );
}

function StatefulSelector(props: {
  modelString?: string;
  initialMode?: OpenAIReasoningMode;
  modelCapabilitiesDeferred?: boolean;
}) {
  const [mode, setMode] = useState<OpenAIReasoningMode>(props.initialMode ?? "standard");
  return (
    <ThinkingSelectorControl
      modelString={props.modelString}
      modelCapabilitiesDeferred={props.modelCapabilitiesDeferred}
      thinkingLevel="medium"
      onThinkingLevelChange={() => undefined}
      reasoningMode={mode}
      onReasoningModeChange={setMode}
    />
  );
}

function renderSelector(ui: React.ReactElement) {
  const view = render(ui, { wrapper: NoBackendAPIWrapper });
  fireEvent.click(view.container.querySelector("[data-thinking-selector-trigger]")!);
  return view;
}

function toggle(container: HTMLElement, component: "ProModeToggle" | "CyberModeToggle") {
  return container.querySelector<HTMLElement>(`[data-component="${component}"]`);
}

describe("ThinkingSelector reasoning modes", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/hooks/useRouting", () => actualRoutingModule);
    await mock.module("@/browser/hooks/useProvidersConfig", () => actualProvidersConfigModule);
    await mock.module("@/browser/components/Tooltip/Tooltip", () => actualTooltipModule);
  });

  beforeEach(() => {
    cleanupDom = installDom();
    providersConfig = directOpenAIConfig(true);
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test.each([
    { name: "supported model with the setting on", model: CYBER_MODEL, enabled: true, shown: true },
    { name: "unsupported model", model: NON_CYBER_MODEL, enabled: true, shown: false },
    { name: "setting off", model: CYBER_MODEL, enabled: false, shown: false },
  ])("offers Cyber: $name", (testCase) => {
    providersConfig = directOpenAIConfig(testCase.enabled);
    const { container } = renderSelector(<StatefulSelector modelString={testCase.model} />);

    expect(toggle(container, "ProModeToggle")).not.toBeNull();
    expect(toggle(container, "CyberModeToggle") != null).toBe(testCase.shown);
  });

  test("deferred model capabilities offer Pro but not Cyber", () => {
    const { container } = renderSelector(
      <StatefulSelector modelString={CYBER_MODEL} modelCapabilitiesDeferred />
    );

    expect(toggle(container, "ProModeToggle")).not.toBeNull();
    expect(toggle(container, "CyberModeToggle")).toBeNull();
  });

  test("Cyber and Pro replace each other as the single reasoning mode", () => {
    const { container } = renderSelector(<StatefulSelector modelString={CYBER_MODEL} />);
    const trigger = container.querySelector<HTMLElement>("[data-thinking-selector-trigger]")!;

    fireEvent.click(toggle(container, "CyberModeToggle")!);
    expect(toggle(container, "CyberModeToggle")!.getAttribute("aria-pressed")).toBe("true");
    expect(toggle(container, "ProModeToggle")!.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-thinking-cyber-status]")).not.toBeNull();
    expect(trigger.getAttribute("aria-label")).toContain("cyber mode");

    fireEvent.click(toggle(container, "ProModeToggle")!);
    expect(toggle(container, "ProModeToggle")!.getAttribute("aria-pressed")).toBe("true");
    expect(toggle(container, "CyberModeToggle")!.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-thinking-cyber-status]")).toBeNull();
    expect(container.querySelector("[data-thinking-pro-status]")).not.toBeNull();

    fireEvent.click(toggle(container, "CyberModeToggle")!);
    expect(container.querySelector("[data-thinking-pro-status]")).toBeNull();
    expect(container.querySelector("[data-thinking-cyber-status]")).not.toBeNull();
  });

  test("a stale Cyber selection displays as standard until Cyber is available again", () => {
    providersConfig = directOpenAIConfig(false);
    const view = renderSelector(<StatefulSelector modelString={CYBER_MODEL} initialMode="cyber" />);
    const trigger = () =>
      view.container.querySelector<HTMLElement>("[data-thinking-selector-trigger]")!;

    expect(view.container.querySelector("[data-thinking-cyber-status]")).toBeNull();
    expect(trigger().getAttribute("aria-label")).not.toContain("cyber");
    expect(toggle(view.container, "ProModeToggle")!.getAttribute("aria-pressed")).toBe("false");

    providersConfig = directOpenAIConfig(true);
    view.rerender(<StatefulSelector modelString={CYBER_MODEL} initialMode="cyber" />);

    expect(view.container.querySelector("[data-thinking-cyber-status]")).not.toBeNull();
    expect(toggle(view.container, "CyberModeToggle")!.getAttribute("aria-pressed")).toBe("true");
  });
});
