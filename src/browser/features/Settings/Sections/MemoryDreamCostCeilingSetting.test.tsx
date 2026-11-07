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

/**
 * Types through the DOM element, so the field's own value rules apply: a `type=number` input
 * reports "" for a half-typed `-`, which a faked `{ target: { value } }` event never shows.
 */
function typeKeys(input: HTMLInputElement, keys: string) {
  input.value = keys;
  const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps"));
  const reactProps = (
    reactPropsKey ? (input as unknown as Record<string, unknown>)[reactPropsKey] : null
  ) as { onChange?: (event: { target: HTMLInputElement }) => void } | null;
  const onChange = reactProps?.onChange;
  if (!onChange) throw new Error("Expected the input to expose its onChange handler");
  act(() => onChange({ target: input }));
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

  // The first three are what a browser's number field reports as "" (no ceiling). The next three
  // parse as numbers in JavaScript (16, 1000, 5), so only the field's own pattern turns them away.
  // The last two have a second separator.
  test.each(["-", "1e", "abc", "0x10", "1e3", "+5", "1,2,3", "1.5,5"])(
    "keeps the saved ceiling when %p is left, and shows why",
    async (keys) => {
      const { view, input, saved, blur } = await renderSetting({
        memory: { dreamCostCeilingUsd: 2 },
      });

      typeKeys(input, keys);
      expect(view.getByRole("alert").textContent).toContain("at least $0.01");
      await blur();

      expect(writes).toEqual([]);
      expect(saved()?.dreamCostCeilingUsd).toBe(2);
      expect(input.value).toBe("2");
    }
  );

  test.each([
    ["0,5", 0.5],
    ["1,5", 1.5],
    [".5", 0.5],
    [",5", 0.5],
    ["5.", 5],
    ["12", 12],
    ["99999,99", 99_999.99],
    // A leading zero or none means three digits after a comma are decimals, not thousands.
    ["0,500", 0.5],
    [",500", 0.5],
    // Four digits are no thousands group either.
    ["1,5000", 1.5],
  ])("reads %p as %d, a comma standing for the decimal point", async (keys, ceiling) => {
    const { view, saved, type, blur } = await renderSetting();

    type(keys);
    expect(view.queryByRole("alert")).toBeNull();
    await blur();

    expect(writes).toEqual([{ memory: { dreamCostCeilingUsd: ceiling } }]);
    expect(saved()?.dreamCostCeilingUsd).toBe(ceiling);
  });

  // "1,000" is one thousand where a comma groups digits and 1.000 where it marks the decimals.
  // Reading it either way would save a ceiling a thousand times off, so it is refused.
  test.each(["1,000", "12,345", "100,500"])(
    "refuses %p, as a comma and three digits could be a thousands separator",
    async (keys) => {
      const { view, input, saved, type, blur } = await renderSetting({
        memory: { dreamCostCeilingUsd: 2 },
      });

      type(keys);
      expect(view.getByRole("alert").textContent).toContain("decimal point");
      await blur();

      expect(writes).toEqual([]);
      expect(saved()?.dreamCostCeilingUsd).toBe(2);
      expect(input.value).toBe("2");
    }
  );

  // The refusal prints the ceiling to the cent, and an estimate over a ceiling of 0.019 would
  // print as 0.02 too, "over the 0.02 USD ceiling". A ceiling in whole cents never reads so.
  test.each([
    ["0.019", 0.02],
    ["0.014", 0.01],
    ["1.499", 1.5],
  ])("rounds %p to the cent, %d, and shows the rounded ceiling", async (keys, ceiling) => {
    const { view, input, saved, type, blur } = await renderSetting();

    type(keys);
    expect(view.queryByRole("alert")).toBeNull();
    await blur();

    expect(writes).toEqual([{ memory: { dreamCostCeilingUsd: ceiling } }]);
    expect(saved()?.dreamCostCeilingUsd).toBe(ceiling);
    expect(input.value).toBe(String(ceiling));
  });

  test("takes a ceiling up to the largest one, and shows it in plain digits", async () => {
    const { view, input, saved, type, blur } = await renderSetting({
      memory: { dreamCostCeilingUsd: 2 },
    });

    type("100000");
    expect(view.queryByRole("alert")).toBeNull();
    await blur();

    expect(saved()?.dreamCostCeilingUsd).toBe(100_000);
    // `String(1e21)` is "1e+21", which the field would read as invalid at rest.
    expect(input.value).toBe("100000");
  });

  test("refuses a ceiling over the largest one, with the limit in the message", async () => {
    const { view, input, saved, type, blur } = await renderSetting({
      memory: { dreamCostCeilingUsd: 2 },
    });

    type("100000.01");
    expect(view.getByRole("alert").textContent).toContain("at most $100000");
    await blur();

    expect(writes).toEqual([]);
    expect(saved()?.dreamCostCeilingUsd).toBe(2);
    expect(input.value).toBe("2");
  });

  test("does not save a ceiling that is already saved", async () => {
    const { type, blur } = await renderSetting({ memory: { dreamCostCeilingUsd: 2 } });

    type("2");
    await blur();

    expect(writes).toEqual([]);
  });
});
