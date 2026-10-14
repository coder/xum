// Bootstrap Happy DOM before react-dom evaluates.
import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "./connection.testHarness";
import type { TestApiOverrides } from "@/browser/testUtils";
import { normalizeLayoutPresetsConfig, type LayoutPresetsConfig } from "@/common/types/uiLayouts";
import { UILayoutsProvider, useUILayouts } from "./UILayoutsContext";

/** A config with one slot (a keybind override), so it differs from the defaults (no slots). */
function configWithSlot(slot: number): LayoutPresetsConfig {
  const config = normalizeLayoutPresetsConfig({
    version: 2,
    slots: [{ slot, keybindOverride: { key: "F1", ctrl: true } }],
  });
  // Setup guard: the slot survives normalization, so the assertions below see it.
  expect(config.slots.map((entry) => entry.slot)).toEqual([slot]);
  return config;
}

let harness: ConnectionHarness;
/** What the next server answers for uiLayouts.getAll: a config, or a promise of one. */
let serverConfig: LayoutPresetsConfig | Promise<LayoutPresetsConfig>;
let shownSlots: number[] | null = null;

function SlotsProbe() {
  const layouts = useUILayouts();
  shownSlots = layouts.loaded ? layouts.layoutPresets.slots.map((entry) => entry.slot) : null;
  return null;
}

// A reconnect (null-gap: a gap without a client) must keep the shown layouts until the new
// client's reload answers.
describe.each([...GAP_MODES])("UILayoutsProvider across a reconnect (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    shownSlots = null;
    serverConfig = configWithSlot(1);
    harness = createConnectionHarness(mode, (): TestApiOverrides<APIClient> => {
      const answer = serverConfig;
      return { uiLayouts: { getAll: () => Promise.resolve(answer) } };
    });
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps the loaded layouts while offline and until the reload answers", async () => {
    render(
      <harness.Wrapper>
        <UILayoutsProvider>
          <SlotsProbe />
        </UILayoutsProvider>
      </harness.Wrapper>
    );
    await waitFor(() => expect(shownSlots).toEqual([1]));

    let answer: ((config: LayoutPresetsConfig) => void) | null = null;
    serverConfig = new Promise((resolve) => (answer = resolve));
    await harness.drop();
    expect(shownSlots).toEqual([1]);
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(shownSlots).toEqual([1]);

    act(() => answer?.(configWithSlot(2)));
    await waitFor(() => expect(shownSlots).toEqual([2]));
  });
});
