import { getOwn } from "@/common/utils/getOwn";
import {
  validateMCPSettingValue,
  type MCPSettingsSnapshot,
  type MCPSettingValue,
} from "@/common/utils/mcpSettings";

/** One server's settings in the workspace MCP dialog. `fetchId` is the read's request ID. */
export type ServerSettingsEntry =
  | { fetchId: number; snapshot: MCPSettingsSnapshot }
  | { error: string }
  | { notConnected: true };

/** The requests of one dialog open: the latest request ID per server name. */
export type SettingsRequestScope = Map<string, number>;

/**
 * Latest-request-wins for settings, per server: a read or save takes the next ID before it is
 * sent, and its result applies only while that ID is still the server's latest in the current
 * open. Each open starts a new scope, so a request taken under an earlier open or workspace
 * (by a load or Fetch Tools that began before the reopen) never applies.
 */
export class SettingsRequests {
  private scope: SettingsRequestScope = new Map();
  private count = 0;

  /** Starts a new open; requests of earlier opens stop being latest. */
  startOpen(): SettingsRequestScope {
    this.scope = new Map();
    return this.scope;
  }

  current(): SettingsRequestScope {
    return this.scope;
  }

  take(scope: SettingsRequestScope, serverName: string): { id: number; isLatest: () => boolean } {
    const id = ++this.count;
    scope.set(serverName, id);
    return { id, isLatest: () => this.scope === scope && scope.get(serverName) === id };
  }
}

/** Keep a save's returned values as the snapshot's values (the caller checked it is latest). */
export function applySavedSettings(
  entries: Record<string, ServerSettingsEntry>,
  serverName: string,
  values: Record<string, MCPSettingValue>
): Record<string, ServerSettingsEntry> {
  const current = getOwn(entries, serverName);
  if (current === undefined || !("snapshot" in current)) return entries;
  return { ...entries, [serverName]: { ...current, snapshot: { ...current.snapshot, values } } };
}

/** Validation errors of a settings draft, by setting name. */
export function settingsErrors(
  properties: MCPSettingsSnapshot["properties"],
  draft: MCPSettingsSnapshot["values"]
): Record<string, string> {
  // Null prototype: on a plain object, `errors["__proto__"] = ...` sets the prototype instead
  // of an own key, so an invalid `__proto__` setting showed no error and Save stayed enabled.
  const errors = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(draft)) {
    const schema = getOwn(properties, name);
    const message = schema && validateMCPSettingValue(schema, value);
    if (message) errors[name] = `${schema.title} ${message}`;
  }
  return errors;
}

/** Saves in flight per server, after one starts (+1) or settles (-1). A server at 0 has no key. */
export function countSettingsSave(
  counts: Record<string, number>,
  serverName: string,
  delta: 1 | -1
): Record<string, number> {
  const next = (getOwn(counts, serverName) ?? 0) + delta;
  const { [serverName]: _previous, ...rest } = counts;
  return next > 0 ? { ...rest, [serverName]: next } : rest;
}
