import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import { createMappedAliasProvidersConfig, MAPPED_ALIAS_MODEL } from "@/browser/testUtils";
import type { ProvidersConfigMap } from "@/common/orpc/types";

// Snapshot the real exports before the mock below replaces the live namespace binding.
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
restoreModulesAfterSuite([["@/browser/hooks/useProvidersConfig", actualProvidersConfigModule]]);

let providersConfig: ProvidersConfigMap | null = null;
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  ...actualProvidersConfigModule,
  useProvidersConfig: () => ({
    ...actualProvidersConfigModule.useProvidersConfig(),
    config: providersConfig,
  }),
}));

import { SubagentReportMessageContent } from "./SubagentReportMessageContent";

describe("SubagentReportMessageContent", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    providersConfig = null;
  });

  test("labels a mapped alias's thinking from its target model", () => {
    providersConfig = createMappedAliasProvidersConfig();

    const view = render(
      <TooltipProvider>
        <SubagentReportMessageContent
          report={{
            taskId: "task-1",
            agentType: "explore",
            status: "completed",
            title: "Explore task",
            reportMarkdown: "Done.",
            model: MAPPED_ALIAS_MODEL,
            thinkingLevel: "max",
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("thinking: max")).toBeTruthy();
  });

  test("reveals unicode tags in the collapsed header, not only in the expanded report", () => {
    // The whole envelope reaches the parent model, so a tag payload in the header is provider-visible
    // text; the header is also what the user sees without clicking, so it must not stay invisible.
    const tagRun = (ascii: string) =>
      [...ascii].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");

    const view = render(
      <TooltipProvider>
        <SubagentReportMessageContent
          report={{
            taskId: "task-1",
            agentType: `explore${tagRun("ab")}`,
            status: "completed",
            title: `Audit${tagRun("cd")} auth`,
            reportMarkdown: "Done.",
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("Audit<U+E0063><U+E0064> auth")).toBeTruthy();
    expect(view.getByText("explore<U+E0061><U+E0062>")).toBeTruthy();
    expect(view.container.textContent).not.toContain(tagRun("cd"));
  });
});
