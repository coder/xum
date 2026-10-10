/**
 * Plugin hook settings: JSON that a plugin's own MCP server saves in its
 * `PLUGIN_DATA` directory, for example from an MCP Apps settings view. Xum
 * reads it before each hook call and passes it to the hook as `settings`.
 *
 * Views never run hooks and never change requests themselves: they only save
 * data, and the reviewed hooks.js decides what that data does. Two files:
 *
 * - `hook-state.json`: applies to every workspace.
 * - `hook-state/<workspaceId>.json`: one workspace; its top-level keys win.
 *   Plugin stdio servers learn the workspace from `XUM_WORKSPACE_ID`.
 *
 * Failure posture: a missing, oversized, symlinked-out or malformed file is
 * treated as absent. Settings must never block a turn.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { log } from "@/node/services/log";
import { readPluginFileWithinRootCapped } from "./discovery";

export const PLUGIN_HOOK_STATE_FILE = "hook-state.json";
export const PLUGIN_HOOK_STATE_WORKSPACE_DIR = "hook-state";
/** Per file. Hook input is JSON-marshalled into the sandbox on every call. */
export const PLUGIN_HOOK_STATE_MAX_BYTES = 64 * 1024;
/** Env var that tells a plugin stdio server which workspace it serves. */
export const PLUGIN_WORKSPACE_ID_ENV = "XUM_WORKSPACE_ID";

/**
 * A workspace ID becomes a file name. Any single path segment is accepted: migrated
 * workspaces keep legacy `${project}-${workspace}` IDs that can hold dots or spaces, and the
 * plugin server receives that exact ID in XUM_WORKSPACE_ID. Path separators, NUL and control
 * characters are refused (`${id}.json` can never be `.` or `..`), and the read below also
 * checks containment. No length cap: a name too long for the filesystem cannot be written by
 * the server either, and the read treats ENAMETOOLONG like a missing file.
 */

function isSafeWorkspaceIdFileName(workspaceId: string): boolean {
  return (
    workspaceId.length > 0 &&
    // eslint-disable-next-line no-control-regex -- NUL and control characters are the point
    !/[/\\\u0000-\u001f\u007f]/.test(workspaceId)
  );
}

/**
 * Merged settings for one workspace, or null when neither file is usable.
 * Top-level keys of the workspace file override the global file. If either
 * side is not a plain object, the workspace value wins as a whole.
 */
export async function readPluginHookState(dataPath: string, workspaceId: string): Promise<unknown> {
  assert(path.isAbsolute(dataPath), "readPluginHookState: dataPath must be absolute");
  let root: string;
  try {
    root = await fsPromises.realpath(dataPath);
  } catch (error) {
    // The server creates PLUGIN_DATA at launch; before that there is nothing to read.
    if (!hasErrorCode(error, "ENOENT")) {
      log.debug("Plugin hook settings: data path unreadable", { dataPath, error });
    }
    return null;
  }
  const globalState = await readStateFile(root, path.join(root, PLUGIN_HOOK_STATE_FILE));
  if (!isSafeWorkspaceIdFileName(workspaceId)) {
    log.debug("Plugin hook settings: workspace ID is not a safe file name; using global only", {
      workspaceId,
    });
    return globalState;
  }
  const workspaceState = await readStateFile(
    root,
    path.join(root, PLUGIN_HOOK_STATE_WORKSPACE_DIR, `${workspaceId}.json`)
  );
  return mergePluginHookState(globalState, workspaceState);
}

export function mergePluginHookState(globalState: unknown, workspaceState: unknown): unknown {
  if (workspaceState === null) return globalState;
  if (isPlainObject(globalState) && isPlainObject(workspaceState)) {
    return { ...globalState, ...workspaceState };
  }
  return workspaceState;
}

/** null for any unusable file; JSON `null` content also reads as "no settings". */
async function readStateFile(root: string, filePath: string): Promise<unknown> {
  try {
    // open() on a FIFO or device blocks until a writer appears, and this read runs before
    // the hook deadline starts: only regular files may reach the open below. (A swap after
    // this stat is caught by the dev/ino check inside readPluginFileWithinRootCapped once
    // the open returns; only the plugin's own server can write this folder.)
    if (!(await fsPromises.stat(filePath)).isFile()) {
      log.warn(`Plugin hook settings: ignoring ${filePath}: not a regular file`);
      return null;
    }
    const { content } = await readPluginFileWithinRootCapped({
      filePath,
      pluginRoot: root,
      maxBytes: PLUGIN_HOOK_STATE_MAX_BYTES,
      label: "plugin hook settings",
    });
    return JSON.parse(content) as unknown;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENAMETOOLONG")) {
      log.warn(`Plugin hook settings: ignoring ${filePath}`, { error: String(error) });
    }
    return null;
  }
}
