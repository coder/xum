import { isRemoteRuntime, type Runtime } from "@/node/runtime/Runtime";

/**
 * True when commands run directly on the Xum host. Positive check on purpose:
 * SSH/Docker (RemoteRuntime) and devcontainers (exec inside the container) fail it, so a host
 * path is never reported for a runtime Xum cannot prove shares the host filesystem. A
 * multi-project wrapper passes only when every project's runtime does, because its projects can
 * be SSH or Docker workspaces.
 */
function execsOnHost(runtime: Runtime): boolean {
  const wrapped = runtime.wrappedRuntimes;
  if (wrapped !== undefined) return wrapped.length > 0 && wrapped.every(execsOnHost);
  // "local" is a LocalBaseRuntime that is not a DevcontainerRuntime (see Runtime.location).
  return runtime.location === "local";
}

/**
 * Whether a plugin folder that `sourceRuntime` reads is a valid path where the workspace's own
 * tools (`workspaceRuntime`: bash, file_read) run. One rule for plugin skills (their directory
 * line) and plugin agents (`${CLAUDE_PLUGIN_ROOT}`), so the two cannot drift apart.
 *
 * A shared instance proves a shared filesystem only for remote runtimes, which read and execute on
 * the same machine. A DevcontainerRuntime (or a wrapper around one) reads the host but executes in
 * the container.
 */
export function isPluginPathUsableFrom(sourceRuntime: Runtime, workspaceRuntime: Runtime): boolean {
  const sameRemote = sourceRuntime === workspaceRuntime && isRemoteRuntime(workspaceRuntime);
  const bothOnHost = execsOnHost(sourceRuntime) && execsOnHost(workspaceRuntime);
  return sameRemote || bothOnHost;
}

/** A Windows drive path (`C:\x`, `C:/x`) or UNC path (`\\server\share`). */
const WIN32_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * A plugin folder path as written into an agent body. A remote path is already POSIX. A Xum-host
 * path on Windows is native (`C:\Users\x`): the model passes it to `file_read`, which resolves it
 * with `path.resolve`, and to Git Bash, which accepts `C:/Users/x`. The MSYS form that skill
 * directories use (`/c/Users/x`) would break `file_read`, because `path.resolve` turns it into
 * `C:\c\Users\x`. The Git Bash side of this is unverified on a Windows host (RFC A2).
 * Detected by the path's shape, not `process.platform`: a POSIX path never starts like this.
 */
export function toAgentBodyPath(pluginPath: string, sourceRuntime: Runtime): string {
  if (isRemoteRuntime(sourceRuntime)) return pluginPath;
  return WIN32_ABSOLUTE_PATH.test(pluginPath) ? pluginPath.replaceAll("\\", "/") : pluginPath;
}

/**
 * How a message names the workspace's runtime: its type (`ssh`, `docker`, `devcontainer`) when the
 * runtime gives one, else its location family.
 */
export function describeWorkspaceRuntime(
  runtime: Pick<Runtime, "mode" | "location" | "wrappedRuntimes">
): string {
  const wrapped = runtime.wrappedRuntimes;
  if (wrapped !== undefined) {
    const offHost = wrapped.find((projectRuntime) => !execsOnHost(projectRuntime));
    return offHost === undefined
      ? "multi-project"
      : `multi-project ${describeWorkspaceRuntime(offHost)}`;
  }
  // mutation-equivalent: a runtime's mode and location are never "", so ?? and || agree
  return runtime.mode ?? runtime.location ?? "unknown";
}
