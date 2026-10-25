import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import { createSelectPrimitiveDouble } from "../../../../../tests/ui/selectPrimitiveDouble";
import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { ProvidersConfigMap } from "@/common/orpc/types";

// Snapshot the real exports before the mock below replaces them: the namespace import is a live
// binding, so restoring from it would republish the mock into later test files.
const actualSelectPrimitiveModule = { ...ActualSelectPrimitiveModule };
restoreModulesAfterSuite([
  ["@/browser/components/SelectPrimitive/SelectPrimitive", actualSelectPrimitiveModule],
]);

// Radix Select portals its dropdown content, which happy-dom cannot render;
// swap in the conditional-rendering double so the options can be read.
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
  createSelectPrimitiveDouble()
);

import { ModelRow } from "./ModelRow";

describe("ModelRow minimum thinking", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("labels a mapped alias's xhigh and max floors from its target model", () => {
    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "team-sol", mappedToModel: "openai:gpt-5.6-sol" }],
      },
    };
    const view = render(
      <TooltipProvider>
        <table>
          <tbody>
            <ModelRow
              provider="openai"
              modelId="team-sol"
              fullId="openai:team-sol"
              isCustom
              isDefault={false}
              isEditing={false}
              mappedToModel="openai:gpt-5.6-sol"
              providersConfig={providersConfig}
              onSetDefault={() => undefined}
              onSetMinThinkingLevel={() => undefined}
            />
          </tbody>
        </table>
      </TooltipProvider>
    );

    fireEvent.pointerDown(view.getByRole("combobox"));

    expect(view.queryAllByRole("button", { name: "xhigh" })).toHaveLength(1);
    expect(view.queryAllByRole("button", { name: "max" })).toHaveLength(1);
  });
});
