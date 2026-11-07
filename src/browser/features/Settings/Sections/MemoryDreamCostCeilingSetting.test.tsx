// Keep this first: tests/ui/dom installs the DOM that react-dom reads when it evaluates.
import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushUserPreferences, getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { MemoryDreamCostCeilingSetting } from "./MemoryDreamCostCeilingSetting";

/**
 * Fires the input's React onChange directly: happy-dom's change events do not reach React's
 * onChange for a controlled input (the same workaround AgentResourceLimitsSettings.ui.test uses).
 */
function typeInto(input: HTMLInputElement, value: string) {
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (input as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as { onChange?: (event: { target: { value: string } }) => void } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the input to expose its onChange handler");
  act(() => onChange({ target: { value } }));
}

describe("MemoryDreamCostCeilingSetting", () => {
  let cleanupDom: (() => void) | null = null;
  /** The merge patches the backend received, in order. */
  let writes: unknown[] = [];

  beforeEach(() => {
    cleanupDom = installDom();
    writes = [];
  });

  afterEach(() => {
    getAppConfigStore().setClient(null);
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  async function renderSetting(initial: UserPreferences = {}) {
    const backend = createTestPreferencesConfig(initial);
    getAppConfigStore().setClient(
      createTestApiClient({
        config: {
          ...backend,
          updateUserPreferences: (input: { patches: unknown[] }) => {
            writes.push(...input.patches);
            return backend.updateUserPreferences(input);
          },
        },
      })
    );
    await act(async () => {
      await getAppConfigStore().refresh();
    });
    const view = render(<MemoryDreamCostCeilingSetting />);
    const input = view.getByLabelText("Dream cost ceiling") as HTMLInputElement;
    const saved = () => getAppConfigStore().getSnapshot()?.userPreferences?.memory;
    const type = (value: string) => typeInto(input, value);
    const blur = async () => {
      fireEvent.blur(input);
      await act(async () => {
        await flushUserPreferences();
      });
    };
    return { view, input, saved, type, blur };
  }

  test("is empty, meaning no ceiling, until one is saved", async () => {
    const { input, saved } = await renderSetting();

    expect(input.value).toBe("");
    expect(saved()).toBeUndefined();
  });

  test("saves the typed ceiling when the field loses focus", async () => {
    const { input, saved, type, blur } = await renderSetting();

    type("1.5");
    // Nothing is saved per keystroke: a half-typed number must not become the ceiling.
    expect(writes).toEqual([]);
    await blur();

    expect(writes).toEqual([{ memory: { dreamCostCeilingUsd: 1.5 } }]);
    expect(saved()?.dreamCostCeilingUsd).toBe(1.5);
    expect(input.value).toBe("1.5");
  });

  test("saves the typed ceiling on Enter", async () => {
    const { input, saved, type } = await renderSetting();

    input.focus();
    type("3");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await flushUserPreferences();
    });

    expect(saved()?.dreamCostCeilingUsd).toBe(3);
  });

  test("shows the saved ceiling and clears it when the field is emptied", async () => {
    const { input, saved, type, blur } = await renderSetting({
      memory: { dreamCostCeilingUsd: 2 },
    });
    expect(input.value).toBe("2");

    type("");
    await blur();

    expect(writes).toEqual([{ memory: { dreamCostCeilingUsd: null } }]);
    expect(saved()?.dreamCostCeilingUsd).toBeUndefined();
    expect(input.value).toBe("");
  });

  test("refuses a ceiling under a cent: it shows why, saves nothing and reverts on blur", async () => {
    const { view, input, saved, type, blur } = await renderSetting({
      memory: { dreamCostCeilingUsd: 2 },
    });

    type("0.001");
    expect(view.getByRole("alert").textContent).toContain("at least $0.01");
    await blur();

    expect(writes).toEqual([]);
    expect(saved()?.dreamCostCeilingUsd).toBe(2);
    expect(input.value).toBe("2");
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("does not save a ceiling that is already saved", async () => {
    const { type, blur } = await renderSetting({ memory: { dreamCostCeilingUsd: 2 } });

    type("2");
    await blur();

    expect(writes).toEqual([]);
  });
});
