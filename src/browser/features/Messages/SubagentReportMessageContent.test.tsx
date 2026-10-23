import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
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
    providersConfig = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "team-sol", mappedToModel: "openai:gpt-5.6-sol" }],
      },
    };

    const view = render(
      <TooltipProvider>
        <SubagentReportMessageContent
          report={{
            taskId: "task-1",
            agentType: "explore",
            status: "completed",
            title: "Explore task",
            reportMarkdown: "Done.",
            model: "openai:team-sol",
            thinkingLevel: "max",
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText("thinking: max")).toBeTruthy();
  });
});
