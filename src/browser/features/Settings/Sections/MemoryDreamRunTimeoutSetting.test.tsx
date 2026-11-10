// Keep this first: tests/ui/dom installs the DOM that react-dom reads when it evaluates.
import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushUserPreferences, getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { MemoryDreamRunTimeoutSetting } from "./MemoryDreamRunTimeoutSetting";

/**
 * Fires the input's React onChange with the element itself: happy-dom's change events do not reach
 * React's onChange for a controlled input (see MemoryDreamCostCeilingSetting.test).
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

describe("MemoryDreamRunTimeoutSetting", () => {
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
    const view = render(<MemoryDreamRunTimeoutSetting />);
    const input = view.getByLabelText("Dream run timeout") as HTMLInputElement;
    const saved = () => getAppConfigStore().getSnapshot()?.userPreferences?.memory;
    const type = (keys: string) => typeKeys(input, keys);
    const blur = async () => {
      fireEvent.blur(input);
      await act(async () => {
        await flushUserPreferences();
      });
    };
    return { view, input, saved, type, blur };
  }

  test("shows the default 5 minutes when none is saved, and saves nothing on a bare blur", async () => {
    const { input, saved, blur } = await renderSetting();

    expect(input.value).toBe("5");
    await blur();

    expect(writes).toEqual([]);
    expect(saved()).toBeUndefined();
  });

  test("saves the typed minutes on Enter", async () => {
    const { input, saved, type } = await renderSetting();

    input.focus();
    type("30");
    expect(writes).toEqual([]);
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await flushUserPreferences();
    });

    expect(writes).toEqual([{ memory: { dreamRunTimeoutMinutes: 30 } }]);
    expect(saved()?.dreamRunTimeoutMinutes).toBe(30);
  });

  test("saves 0 as no timeout and shows it", async () => {
    const { input, saved, type, blur } = await renderSetting();

    type("0");
    await blur();

    expect(writes).toEqual([{ memory: { dreamRunTimeoutMinutes: 0 } }]);
    expect(saved()?.dreamRunTimeoutMinutes).toBe(0);
    expect(input.value).toBe("0");
  });

  test("clears the saved timeout when the field is emptied, which shows the default again", async () => {
    const { input, saved, type, blur } = await renderSetting({
      memory: { dreamRunTimeoutMinutes: 30 },
    });
    expect(input.value).toBe("30");

    type("");
    await blur();

    expect(writes).toEqual([{ memory: { dreamRunTimeoutMinutes: null } }]);
    expect(saved()?.dreamRunTimeoutMinutes).toBeUndefined();
    expect(input.value).toBe("5");
  });

  test("takes the largest timeout and refuses one past it", async () => {
    const { view, saved, type, blur } = await renderSetting();

    type("1441");
    expect(view.getByRole("alert").textContent).toContain("from 0 to 1440");
    await blur();
    expect(writes).toEqual([]);

    type("1440");
    expect(view.queryByRole("alert")).toBeNull();
    await blur();
    expect(saved()?.dreamRunTimeoutMinutes).toBe(1440);
  });

  test.each(["-1", "2.5", "1e3", "0x10", "+5", "abc"])(
    "keeps the saved timeout when %p is left, and shows why",
    async (keys) => {
      const { view, input, saved, type, blur } = await renderSetting({
        memory: { dreamRunTimeoutMinutes: 30 },
      });

      type(keys);
      expect(view.getByRole("alert").textContent).toContain("whole minutes");
      await blur();

      expect(writes).toEqual([]);
      expect(saved()?.dreamRunTimeoutMinutes).toBe(30);
      expect(input.value).toBe("30");
    }
  );

  test("does not save the timeout that is already saved", async () => {
    const { type, blur } = await renderSetting({ memory: { dreamRunTimeoutMinutes: 30 } });

    type("30");
    await blur();

    expect(writes).toEqual([]);
  });
});
