import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { restoreDomGlobals, saveDomGlobals } from "../../../tests/ui/domGlobals";

import { LayoutPresetsConfigSchema } from "@/common/orpc/schemas/uiLayouts";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import { normalizeLayoutPresetsConfig, type LayoutPreset } from "@/common/types/uiLayouts";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import { createPresetFromCurrentWorkspace } from "./uiLayouts";

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

/** What the stored config yields after a save: the backend normalizer plus the IPC schema. */
function roundTrip(preset: LayoutPreset): LayoutPreset | undefined {
  const config = normalizeLayoutPresetsConfig({ version: 2, slots: [{ slot: 1, preset }] });
  LayoutPresetsConfigSchema.parse(config);
  return config.slots[0]?.preset;
}

test("a saved preset keeps every tool tab and the New tab, not just Stats and Review", () => {
  seedLayout(
    {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["goal", "output"], activeTab: "output" },
        { type: "tabset", id: "tabset-2", tabs: ["new"], activeTab: "new" },
      ],
    },
    "tabset-2"
  );

  const saved = roundTrip(createPresetFromCurrentWorkspace(WORKSPACE_ID, "Mine"));

  expect(saved?.rightSidebar.layout).toMatchObject({
    focusedTabsetId: "tabset-2",
    root: {
      type: "split",
      children: [
        { tabs: ["goal", "output"], activeTab: "output" },
        { tabs: ["new"], activeTab: "new" },
      ],
    },
  });
});

test("a layout holding only side chats saves as the New tab", () => {
  // Side chats are discarded on restart, so a preset cannot restore them.
  seedLayout(
    { type: "tabset", id: "tabset-1", tabs: ["side:sc"], activeTab: "side:sc" },
    "tabset-1"
  );

  const saved = roundTrip(createPresetFromCurrentWorkspace(WORKSPACE_ID, "Side only"));

  expect(saved?.rightSidebar.layout.root).toMatchObject({ tabs: ["new"], activeTab: "new" });
});
