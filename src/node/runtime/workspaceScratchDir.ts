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
  assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
  // XUM_ROOT may be relative (e.g. XUM_ROOT=.xum-test); the exported value must be absolute
  // because agent commands run with a different cwd.
  return path.resolve(sessionsDir, workspaceId, "scratch");
}

/**
 * Create the scratch dir if needed and return it. Creation is best-effort: the path is returned
 * even when mkdir fails (logged), because the environment prompt always tells local/worktree
 * agents to use $XUM_SCRATCH_DIR. An unset variable would turn `mkdir -p "$XUM_SCRATCH_DIR/logs"`
 * into `/logs`; a set-but-missing dir just makes the agent's own `mkdir -p` create it.
 */
export async function ensureWorkspaceScratchDir(
  sessionsDir: string,
  workspaceId: string
): Promise<string> {
  const scratchDir = getWorkspaceScratchDir(sessionsDir, workspaceId);
  try {
    await fsPromises.mkdir(scratchDir, { recursive: true });
  } catch (error) {
    log.warn(`Could not create workspace scratch dir ${scratchDir}: ${getErrorMessage(error)}`);
  }
  return scratchDir;
}
