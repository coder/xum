import { useSyncExternalStore } from "react";
import { getOwn } from "@/common/utils/getOwn";

/** A settings tool action's text result (or error), shown under its row. */
export interface SettingsToolRunResult {
  text: string;
  isError: boolean;
}

/** One server's settings tool actions: the tools of runs in flight, and each tool's last result. */
export interface ServerSettingsToolRuns {
  /** One entry per run in flight (a tool can appear twice: two dialogs of one workspace). */
  running: readonly string[];
  results: Readonly<Record<string, SettingsToolRunResult>>;
}

type WorkspaceSettingsToolRuns = Readonly<Record<string, ServerSettingsToolRuns>>;

/**
 * Settings tool action runs, per workspace and server, outside the dialog. Closing the workspace
 * MCP dialog unmounts its settings sections (the sidebar row even unmounts the dialog), and a
 * reopen used to forget a run still in flight: Run and Save settings were enabled while it ran.
 * Results live here too, so a section remounted by a reopen or re-read still shows the result.
 * Module-level and in memory only: a reload ends every run anyway. A removed workspace's
 * entries go with it (forgetSettingsToolRuns).
 */
const runsByWorkspace = new Map<string, WorkspaceSettingsToolRuns>();
const listeners = new Set<() => void>();
const NO_RUNS: WorkspaceSettingsToolRuns = {};
export const NO_SERVER_RUNS: ServerSettingsToolRuns = { running: [], results: {} };

function update(
  workspaceId: string,
  serverName: string,
  change: (runs: ServerSettingsToolRuns) => ServerSettingsToolRuns
): void {
  const workspace = runsByWorkspace.get(workspaceId) ?? NO_RUNS;
  const { [serverName]: previous, ...rest } = workspace;
  const next = change(previous ?? NO_SERVER_RUNS);
  const empty = next.running.length === 0 && Object.keys(next.results).length === 0;
  const nextWorkspace = empty ? rest : { ...rest, [serverName]: next };
  if (Object.keys(nextWorkspace).length === 0) runsByWorkspace.delete(workspaceId);
  else runsByWorkspace.set(workspaceId, nextWorkspace);
  for (const listener of listeners) listener();
}

function withoutResult(runs: ServerSettingsToolRuns, toolName: string) {
  const { [toolName]: _previous, ...results } = runs.results;
  return results;
}

/**
 * A run of `toolName` starts (it clears the tool's last result). The returned callback ends it,
 * once, with the result to show (null: none, as for an app that opened).
 */
export function startSettingsToolRun(
  workspaceId: string,
  serverName: string,
  toolName: string
): (result: SettingsToolRunResult | null) => void {
  update(workspaceId, serverName, (runs) => ({
    running: [...runs.running, toolName],
    results: withoutResult(runs, toolName),
  }));
  let ended = false;
  return (result) => {
    if (ended) return;
    ended = true;
    endSettingsToolRun(workspaceId, serverName, toolName, result);
  };
}

/** One run of `toolName` ends: it leaves `running`, and its result (if any) shows. */
function endSettingsToolRun(
  workspaceId: string,
  serverName: string,
  toolName: string,
  result: SettingsToolRunResult | null
): void {
  const runs = serverSettingsToolRuns(settingsToolRunsOf(workspaceId), serverName);
  const index = runs.running.indexOf(toolName);
  // Forgotten (its workspace was removed): a late end must not bring the entry back.
  if (index === -1) return;
  update(workspaceId, serverName, (current) => ({
    running: current.running.filter((_, i) => i !== index),
    results:
      result === null
        ? withoutResult(current, toolName)
        : { ...current.results, [toolName]: result },
  }));
}

/** A new dialog open starts without the results of earlier opens (runs in flight stay). */
export function clearSettingsToolResults(workspaceId: string): void {
  const workspace = runsByWorkspace.get(workspaceId);
  if (workspace === undefined) return;
  for (const serverName of Object.keys(workspace))
    update(workspaceId, serverName, (runs) => ({ running: runs.running, results: {} }));
}

/** The workspace was removed: drop its runs and results. */
export function forgetSettingsToolRuns(workspaceId: string): void {
  if (!runsByWorkspace.delete(workspaceId)) return;
  for (const listener of listeners) listener();
}

/**
 * A metadata snapshot (a reconnect) lists the backend's active workspaces: drop the idle
 * entries (results only) of the others. Another Xum instance can remove a workspace while this
 * renderer is offline. A workspace with a run in flight keeps its entry: the snapshot leaves
 * out archived workspaces too, and an unarchived one must still wait for its run. That run's
 * end leaves only its result behind. An empty snapshot proves nothing: the backend lists none
 * when its metadata read fails, so it keeps every entry (WorkspaceContext treats an empty
 * snapshot the same way).
 */
export function forgetSettingsToolRunsExcept(workspaceIds: ReadonlySet<string>): void {
  if (workspaceIds.size === 0) return;
  for (const [workspaceId, servers] of [...runsByWorkspace])
    if (!workspaceIds.has(workspaceId) && !Object.values(servers).some((r) => r.running.length > 0))
      forgetSettingsToolRuns(workspaceId);
}

export function settingsToolRunsOf(workspaceId: string): WorkspaceSettingsToolRuns {
  return runsByWorkspace.get(workspaceId) ?? NO_RUNS;
}

/** Mounted workspace MCP dialogs: each reads a server's settings again after a writing run. */
const writeListeners = new Set<{
  workspaceId: string;
  reread: (serverName: string) => Promise<void>;
}>();

/**
 * A dialog listens for writing runs of its workspace. The run can outlive the dialog that
 * started it (a close and reopen): the reopened dialog read the values before the write, so the
 * run's end must reach the dialog mounted now, not the one that started it.
 */
export function subscribeSettingsToolWrites(
  workspaceId: string,
  reread: (serverName: string) => Promise<void>
): () => void {
  const listener = { workspaceId, reread };
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

/**
 * A tool that can write ran on `serverName`: the mounted dialogs read its settings again. With
 * no dialog of the workspace open, `readWithoutDialog` reads them: the backend's read refreshes
 * the settings cache that plugin hooks use, which otherwise keeps the pre-run values.
 */
export async function publishSettingsToolWrite(
  workspaceId: string,
  serverName: string,
  readWithoutDialog: () => Promise<unknown>
): Promise<void> {
  const rereads = [...writeListeners]
    .filter((listener) => listener.workspaceId === workspaceId)
    .map((listener) => listener.reread(serverName));
  await Promise.allSettled(rereads.length > 0 ? rereads : [readWithoutDialog()]);
}

/** One server's runs (NO_SERVER_RUNS when it has none). */
export function serverSettingsToolRuns(
  runs: WorkspaceSettingsToolRuns,
  serverName: string
): ServerSettingsToolRuns {
  return getOwn(runs, serverName) ?? NO_SERVER_RUNS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The workspace's settings tool runs; re-renders when they change. */
export function useSettingsToolRuns(workspaceId: string): WorkspaceSettingsToolRuns {
  return useSyncExternalStore(subscribe, () => settingsToolRunsOf(workspaceId));
}
