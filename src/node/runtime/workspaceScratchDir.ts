import * as fsPromises from "fs/promises";
import * as path from "path";
import { assert } from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";

/**
 * Durable, Xum-owned scratch dir for a workspace's helper scripts, logs and evidence.
 *
 * Agents used to put such files in `~/<name>` or `~/.cache/<name>` because /tmp is wiped
 * on restart and the checkout is the wrong place for them; nothing ever cleaned those up.
 * Living inside the session dir gives this dir the session lifecycle for free: it survives
 * restarts and archive, is not copied on fork, and is deleted when the workspace is removed.
 * (`<root>/scratch/<id>` is taken by scratch-chat workdirs and swept as orphans at startup.)
 */
export function getWorkspaceScratchDir(sessionsDir: string, workspaceId: string): string {
  assert(path.isAbsolute(sessionsDir), "sessionsDir must be an absolute path");
  assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
  return path.join(sessionsDir, workspaceId, "scratch");
}

/**
 * Create the scratch dir if needed and return it. Returns undefined (and logs) when it cannot be
 * created, so callers never advertise a directory that does not exist.
 */
export async function ensureWorkspaceScratchDir(
  sessionsDir: string,
  workspaceId: string
): Promise<string | undefined> {
  const scratchDir = getWorkspaceScratchDir(sessionsDir, workspaceId);
  try {
    await fsPromises.mkdir(scratchDir, { recursive: true });
    return scratchDir;
  } catch (error) {
    log.warn(`Could not create workspace scratch dir ${scratchDir}: ${getErrorMessage(error)}`);
    return undefined;
  }
}
