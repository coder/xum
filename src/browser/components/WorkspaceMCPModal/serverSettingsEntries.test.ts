import { expect, test } from "bun:test";
import type { MCPSettingsSnapshot } from "@/common/utils/mcpSettings";
import { applySavedSettings, type ServerSettingsEntry } from "./serverSettingsEntries";

const snapshot = (units: string): MCPSettingsSnapshot => ({
  properties: { units: { type: "string", title: "Units" } },
  values: { units },
  layout: [],
  warnings: [],
  droppedSettingCount: 0,
});

test("a save applies only to the read its section was drawn from", () => {
  const entries: Record<string, ServerSettingsEntry> = {
    cad: { fetchId: 2, snapshot: snapshot("in") },
  };
  // Same read: the saved values become the base.
  expect(applySavedSettings(entries, "cad", 2, { units: "mm" }).cad).toEqual({
    fetchId: 2,
    snapshot: snapshot("mm"),
  });
  // A save that settles after a reopen or refresh (newer read) is dropped.
  expect(applySavedSettings(entries, "cad", 1, { units: "mm" })).toBe(entries);
  expect(applySavedSettings({}, "cad", 2, { units: "mm" })).toEqual({});
});
