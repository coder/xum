/**
 * Integration test for thinking level persistence across model switches.
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CUSTOM_EVENTS } from "@/common/constants/events";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

import { shouldRunIntegrationTests } from "../../testUtils";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const OPENAI_MODEL = KNOWN_MODELS.GPT.id;
// Use Haiku 4.5 as the model that caps at HIGH (4 levels, no xhigh).
// Opus 4.6 and Sonnet 4.6 support xhigh so they can't be used to test clamping behavior.
const CAPPED_MODEL = "anthropic:claude-haiku-4-5";

async function openModelSelector(container: HTMLElement): Promise<HTMLInputElement> {
  window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR));

  return await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search [provider:model-name]"]'
    );
    if (!input) {
      throw new Error("Model selector input not found");
    }
    return input;
  });
}

async function selectModel(
  container: HTMLElement,
  workspaceId: string,
  model: string
): Promise<void> {
  const input = await openModelSelector(container);

  const user = userEvent.setup({ document: container.ownerDocument });
  await user.clear(input);
  await user.type(input, model);

  const modelName = model.split(":")[1] ?? model;
  const modelDisplayName = formatModelDisplayName(modelName);

  const option = await waitFor(() => {
    const match = within(container).getByText(modelDisplayName);
    if (!match) {
      throw new Error("Model option not found");
    }
    return match;
  });

  fireEvent.click(option);

  await waitFor(() => {
    const persisted = readPersistedState(getModelKey(workspaceId), "");
    if (persisted !== model) {
      throw new Error(`Expected model ${model} but got ${persisted}`);
    }
  });

  // Wait for the UI to reflect the new model. This guards against race conditions
  // where backend metadata updates can temporarily revert localStorage (and thus
  // the displayed model) when switching models rapidly.
  // Use the exact display name that the UI will show.
  const expectedDisplayName = modelDisplayName.toLowerCase();
  await waitFor(
    () => {
      const modelGroup = container.querySelector('[data-component="ModelSelectorGroup"]');
      const displayedModel = (modelGroup?.textContent ?? "").toLowerCase();
      if (!displayedModel.includes(expectedDisplayName)) {
        throw new Error(
          `Waiting for UI to show "${expectedDisplayName}", currently shows "${displayedModel}"`
        );
      }
    },
    { timeout: 3000 }
  );

  // Wait for UI to stabilize - ensure thinking controls are present and not in flux.
  // Backend metadata updates can cause re-renders; waiting for a stable state
  // prevents races when the test immediately interacts with thinking controls.
  await waitFor(
    () => {
      const group = container.querySelector('[data-component="ThinkingSelectorGroup"]');
      const thinkingLabel = group?.querySelector("[data-thinking-label]");
      if (!thinkingLabel?.textContent) {
        throw new Error("Waiting for thinking controls to stabilize");
      }
    },
    { timeout: 2000 }
  );
}

async function setThinkingToXHigh(container: HTMLElement): Promise<void> {
  const trigger = await waitFor(() => {
    const match = container.querySelector<HTMLButtonElement>("[data-thinking-selector-trigger]");
    if (!match) {
      throw new Error("Thinking selector trigger not found");
    }
    return match;
  });
  fireEvent.click(trigger);

  const option = await waitFor(() => {
    const menu = container.querySelector<HTMLElement>('[data-component="ThinkingSelectorMenu"]');
    if (!menu) {
      throw new Error("Thinking selector menu not found");
    }
    return within(menu).getByRole("option", { name: "Extra High" });
  });
  fireEvent.click(option);
}

async function expectThinkingLabel(container: HTMLElement, expected: string): Promise<void> {
  await waitFor(
    () => {
      const group = container.querySelector('[data-component="ThinkingSelectorGroup"]');
      const label = group?.querySelector("[data-thinking-label]");
      const text = label?.textContent?.trim();
      if (text !== expected) {
        throw new Error(`Expected thinking label ${expected} but got ${text ?? "<missing>"}`);
      }
    },
    { timeout: 3000 }
  );
}

describeIntegration("Thinking level persistence", () => {
  test("keeps XHIGH preference when switching away and back", async () => {
    const harness = await createAppHarness({ branchPrefix: "thinking" });

    try {
      await selectModel(harness.view.container, harness.workspaceId, OPENAI_MODEL);
      await setThinkingToXHigh(harness.view.container);
      await expectThinkingLabel(harness.view.container, "XHIGH");

      await selectModel(harness.view.container, harness.workspaceId, CAPPED_MODEL);
      await expectThinkingLabel(harness.view.container, "HIGH");

      await selectModel(harness.view.container, harness.workspaceId, OPENAI_MODEL);
      await expectThinkingLabel(harness.view.container, "XHIGH");
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});
