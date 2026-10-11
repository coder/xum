import { expect, test } from "bun:test";
import type { MCPSettingsSnapshot } from "@/common/utils/mcpSettings";
import {
  applySavedSettings,
  SettingsRequests,
  type ServerSettingsEntry,
} from "./serverSettingsEntries";

const snapshot = (units: string): MCPSettingsSnapshot => ({
  properties: { units: { type: "string", title: "Units" } },
  values: { units },
  layout: [],
  warnings: [],
  droppedSettingCount: 0,
});

test("settings requests: only a server's latest request in the current open applies", () => {
  const requests = new SettingsRequests();
  const open = requests.startOpen();
  const slowRead = requests.take(open, "cad");
  const newerRead = requests.take(open, "cad");
  const other = requests.take(open, "other");
  // The slow first read settles last: it is not the latest, so it cannot replace the newer one.
  expect(slowRead.isLatest()).toBe(false);
  expect(newerRead.isLatest()).toBe(true);
  expect(other.isLatest()).toBe(true);
  // A save taken later wins over both reads.
  const save = requests.take(requests.current(), "cad");
  expect(newerRead.isLatest()).toBe(false);
  expect(save.isLatest()).toBe(true);
  // A reopen: every earlier request, and one taken in the old open's scope, is stale.
  requests.startOpen();
  expect(save.isLatest()).toBe(false);
  expect(requests.take(open, "cad").isLatest()).toBe(false);
});

test("a save's values become the snapshot's values", () => {
  const entries: Record<string, ServerSettingsEntry> = {
    cad: { fetchId: 2, snapshot: snapshot("in") },
  };
  expect(applySavedSettings(entries, "cad", { units: "mm" }).cad).toEqual({
    fetchId: 2,
    snapshot: snapshot("mm"),
  });
  expect(applySavedSettings({}, "cad", { units: "mm" })).toEqual({});
});
