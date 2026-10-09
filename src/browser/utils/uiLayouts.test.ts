import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";

import { createTestApiClient } from "@/browser/testUtils";
import { LayoutPresetsConfigSchema } from "@/common/orpc/schemas/uiLayouts";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import { normalizeLayoutPresetsConfig, type LayoutPreset } from "@/common/types/uiLayouts";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { readRightSidebarLayout } from "@/browser/utils/rightSidebarTabFocus";
import {
  applyLayoutPresetToWorkspace,
  createPresetFromCurrentWorkspace,
  LAYOUT_PRESET_NO_SAVEABLE_TABS_MESSAGE,
} from "./uiLayouts";

const WORKSPACE_ID = "ws-preset";

beforeEach(() => {
  saveDomGlobals();
  const happyWindow = new GlobalWindow();
  globalThis.window = happyWindow as unknown as Window & typeof globalThis;
  globalThis.document = happyWindow.document as unknown as Document;
});

afterEach(() => {
  restoreDomGlobals();
});

function seedLayout(root: RightSidebarLayoutState["root"], focusedTabsetId: string): void {
  updatePersistedState<RightSidebarLayoutState>(getRightSidebarLayoutKey(WORKSPACE_ID), {
    version: 1,
    openTabsOnly: true,
    nextId: 5,
    focusedTabsetId,
    root,
  });
}

function capture(name: string): LayoutPreset {
  const result = createPresetFromCurrentWorkspace(WORKSPACE_ID, name, "preset-1");
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/** What the stored config yields after a save: the backend normalizer plus the IPC schema. */
function roundTrip(preset: LayoutPreset): LayoutPreset | undefined {
  const config = normalizeLayoutPresetsConfig({ version: 2, slots: [{ slot: 1, preset }] });
  LayoutPresetsConfigSchema.parse(config);
  return config.slots[0]?.preset;
}

test("refuses to save a layout with no Stats, Review or terminal tab", () => {
  // Presets store only the tabs older builds accept, so saving a substitute (e.g. Stats) would
  // silently record a layout the user never had.
  seedLayout(
    {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["goal", "side:sc"], activeTab: "goal" },
        { type: "tabset", id: "tabset-2", tabs: ["new"], activeTab: "new" },
      ],
    },
    "tabset-2"
  );

  expect(createPresetFromCurrentWorkspace(WORKSPACE_ID, "Nothing")).toEqual({
    success: false,
    error: LAYOUT_PRESET_NO_SAVEABLE_TABS_MESSAGE,
  });
});

test("a partial layout keeps its saveable tabs and drops panes left empty", () => {
  seedLayout(
    {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["goal", "output"], activeTab: "output" },
        {
          type: "tabset",
          id: "tabset-2",
          tabs: ["review", "new", "terminal:abc"],
          activeTab: "new",
        },
      ],
    },
    "tabset-1"
  );

  expect(roundTrip(capture("Partial"))?.rightSidebar.layout).toEqual({
    version: 1,
    nextId: 5,
    focusedTabsetId: "tabset-2",
    root: {
      type: "tabset",
      id: "tabset-2",
      tabs: ["review", "terminal_new:t1"],
      activeTab: "review",
    },
  });
});

test("a Stats/Review/terminal layout keeps the encoding older builds read", () => {
  seedLayout(
    {
      type: "split",
      id: "split-1",
      direction: "vertical",
      sizes: [40, 60],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs", "review"], activeTab: "review" },
        { type: "tabset", id: "tabset-2", tabs: ["terminal:abc"], activeTab: "terminal:abc" },
      ],
    },
    "tabset-2"
  );

  const preset = capture("Classic");
  expect(roundTrip(preset)).toEqual(preset);
  expect(preset.rightSidebar.layout).toEqual({
    version: 1,
    nextId: 5,
    focusedTabsetId: "tabset-2",
    root: {
      type: "split",
      id: "split-1",
      direction: "vertical",
      sizes: [40, 60],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs", "review"], activeTab: "review" },
        {
          type: "tabset",
          id: "tabset-2",
          tabs: ["terminal_new:t1"],
          activeTab: "terminal_new:t1",
        },
      ],
    },
  });
});

test("applying a preset saved by an older build restores its tabs", async () => {
  const preset: LayoutPreset = {
    id: "old",
    name: "Old",
    leftSidebarCollapsed: false,
    rightSidebar: {
      collapsed: false,
      width: { mode: "px", value: 400 },
      layout: {
        version: 1,
        nextId: 3,
        focusedTabsetId: "tabset-1",
        root: {
          type: "tabset",
          id: "tabset-1",
          tabs: ["stats", "review", "terminal_new:t1"],
          activeTab: "review",
        },
      },
    },
  };
  const api = createTestApiClient({
    terminal: { listSessions: () => Promise.resolve(["sess-1"]) },
  });

  await applyLayoutPresetToWorkspace(api, WORKSPACE_ID, preset);

  expect(readRightSidebarLayout(WORKSPACE_ID).root).toEqual({
    type: "tabset",
    id: "tabset-1",
    tabs: ["costs", "review", "terminal:sess-1"],
    activeTab: "review",
  });
});
