import { getOwn } from "@/common/utils/getOwn";
import type { MCPSettingsSnapshot, MCPSettingValue } from "@/common/utils/mcpSettings";

/** One server's settings in the workspace MCP dialog. `fetchId` identifies the read. */
export type ServerSettingsEntry =
  | { fetchId: number; snapshot: MCPSettingsSnapshot }
  | { error: string }
  | { notConnected: true };

/**
 * Keep a save's returned values as the snapshot's values, but only for the read the saving
 * section was drawn from. A save that settles after the dialog was reopened or refreshed (a
 * newer `fetchId`, or no entry) must not overwrite the newer read.
 */
export function applySavedSettings(
  entries: Record<string, ServerSettingsEntry>,
  serverName: string,
  fetchId: number,
  values: Record<string, MCPSettingValue>
): Record<string, ServerSettingsEntry> {
  const current = getOwn(entries, serverName);
  if (current === undefined || !("snapshot" in current) || current.fetchId !== fetchId)
    return entries;
  return { ...entries, [serverName]: { ...current, snapshot: { ...current.snapshot, values } } };
}
