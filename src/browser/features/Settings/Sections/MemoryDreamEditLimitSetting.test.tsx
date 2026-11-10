// Keep this first: tests/ui/dom installs the DOM that react-dom reads when it evaluates.
import { installDom } from "../../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flushUserPreferences, getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { createTestApiClient, createTestPreferencesConfig } from "@/browser/testUtils";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import { MemoryDreamEditLimitSetting } from "./MemoryDreamEditLimitSetting";

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

describe("MemoryDreamEditLimitSetting", () => {
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
    const view = render(<MemoryDreamEditLimitSetting />);
    const input = view.getByLabelText("Dream edit limit") as HTMLInputElement;
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

  test("shows the default 8 when no limit is saved, and saves nothing on a bare blur", async () => {
    const { input, saved, blur } = await renderSetting();

    expect(input.value).toBe("8");
    await blur();

    expect(writes).toEqual([]);
    expect(saved()).toBeUndefined();
  });

  test("saves the typed limit when the field loses focus, not per keystroke", async () => {
    const { input, saved, type, blur } = await renderSetting();

    type("24");
    expect(writes).toEqual([]);
    await blur();

    expect(writes).toEqual([{ memory: { dreamEditLimit: 24 } }]);
    expect(saved()?.dreamEditLimit).toBe(24);
    expect(input.value).toBe("24");
  });

  test("saves the typed limit on Enter", async () => {
    const { input, saved, type } = await renderSetting();

    input.focus();
    type("40");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => {
      await flushUserPreferences();
    });

    expect(saved()?.dreamEditLimit).toBe(40);
  });

  // A merge patch with null deletes the key, which reads as the default 8 again: an emptied field
  // must store 0 so it stays unlimited.
  test("stores 0 for an emptied field and shows it empty, as unlimited", async () => {
    const { view, input, saved, type, blur } = await renderSetting({
      memory: { dreamEditLimit: 24 },
    });

    type("");
    await blur();

    expect(writes).toEqual([{ memory: { dreamEditLimit: 0 } }]);
    expect(saved()?.dreamEditLimit).toBe(0);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Unlimited");
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("shows a saved 0 as an empty field", async () => {
    const { input } = await renderSetting({ memory: { dreamEditLimit: 0 } });

    expect(input.value).toBe("");
  });

  test("saves a typed 0 as unlimited", async () => {
    const { input, saved, type, blur } = await renderSetting();

    type("0");
    await blur();

    expect(writes).toEqual([{ memory: { dreamEditLimit: 0 } }]);
    expect(saved()?.dreamEditLimit).toBe(0);
    expect(input.value).toBe("");
  });

  // Each parses as a number in JavaScript or is half typed; only whole digits are a limit.
  test.each(["-1", "2.5", "1e3", "0x10", "+5", "abc", "99999999999999999"])(
    "keeps the saved limit when %p is left, and shows why",
    async (keys) => {
      const { view, input, saved, type, blur } = await renderSetting({
        memory: { dreamEditLimit: 24 },
      });

      type(keys);
      expect(view.getByRole("alert").textContent).toContain("whole number");
      await blur();

      expect(writes).toEqual([]);
      expect(saved()?.dreamEditLimit).toBe(24);
      expect(input.value).toBe("24");
    }
  );

  // A saved 0 is the limit the run uses, not "no value": comparing with the default instead would
  // write 0 again on every blur of the empty field.
  test("does not save unlimited again when the field stays empty", async () => {
    const { input, blur } = await renderSetting({ memory: { dreamEditLimit: 0 } });

    input.focus();
    await blur();

    expect(writes).toEqual([]);
  });

  test("does not save the limit that is already saved", async () => {
    const { type, blur } = await renderSetting({ memory: { dreamEditLimit: 24 } });

    type("24");
    await blur();

    expect(writes).toEqual([]);
  });
});
