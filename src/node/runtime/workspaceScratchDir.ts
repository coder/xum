import * as path from "path";
import { assert } from "@/common/utils/assert";

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
