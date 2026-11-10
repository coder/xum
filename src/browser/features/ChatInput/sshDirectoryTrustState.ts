import type { APIClient } from "@/browser/contexts/API";
import { publishProjectTrustChanged } from "@/browser/utils/workspaceMcpMutations";
import type { ProjectConfig } from "@/common/types/project";
import { buildRuntimeConfig } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { isWorkspaceDirTrustedBy } from "@/common/utils/sshDirectoryTrust";

/** What the creation form's SSH+None trust notice shows for the directory being configured. */
export interface SshDirectoryTrustNoticeState {
  host: string;
  projectDir: string;
  trusted: boolean;
}

/**
 * The trust notice for an SSH+None directory on the creation form, or null when none shows: the
 * host or directory is still blank, or the project (its trust owner, for a sub-project) is not
 * trusted. An untrusted project's own trust flow governs, and directory trust only counts while
 * the project is trusted.
 */
export function resolveSshDirectoryTrustNotice(input: {
  /** Owning (top-level) project path. */
  projectPath: string;
  userProjects: Map<string, ProjectConfig>;
  host: string;
  projectDir: string;
}): SshDirectoryTrustNoticeState | null {
  const host = input.host.trim();
  const projectDir = input.projectDir.trim();
  const project = input.userProjects.get(input.projectPath);
  const owner =
    project?.parentProjectPath !== undefined
      ? input.userProjects.get(project.parentProjectPath)
      : project;
  if (host === "" || projectDir === "" || owner?.trusted !== true) return null;

  const runtimeConfig = buildRuntimeConfig({
    mode: "ssh",
    host,
    workspaceIsolation: "none",
    projectDir,
  });
  return {
    host,
    projectDir,
    trusted: isWorkspaceDirTrustedBy(owner.trustedSshDirectories, runtimeConfig),
  };
}

/** The trust change a row is saving, if any. */
export type PendingSshDirectoryTrust = "trust" | "untrust" | null;

/**
 * What the trust row says: its status and its button's label. While a trust saves, the label
 * names the host when the host must resolve the path (~ or relative) over SSH, which can take
 * seconds; otherwise the row would just sit there greyed out.
 */
export function sshDirectoryTrustRowCopy(input: {
  trusted: boolean;
  pending: PendingSshDirectoryTrust;
  host: string;
  projectDir: string;
}): { title: string; detail: string; action: string } {
  const status = input.trusted
    ? { title: "Trusted directory", detail: "Hooks, MCP servers and project secrets run here." }
    : {
        title: "Untrusted directory",
        detail: "Hooks, MCP servers and project secrets stay off until you trust it.",
      };
  const actions: Record<NonNullable<PendingSshDirectoryTrust> | "idle", string> = {
    trust: input.projectDir.startsWith("/") ? "Trusting…" : `Checking ${input.host}…`,
    untrust: "Untrusting…",
    idle: input.trusted ? "Untrust" : "Trust directory",
  };
  return { ...status, action: actions[input.pending ?? "idle"] };
}

/** Identifies the directory a trust row is about, so its last error shows only for that one. */
export function sshDirectoryTrustKey(
  projectPath: string,
  notice: Pick<SshDirectoryTrustNoticeState, "host" | "projectDir">
): string {
  return JSON.stringify([projectPath, notice.host, notice.projectDir]);
}

/** The SSH+None directory the creation form shows right now, and how to write a new path into it. */
export interface SshDirectoryTrustSelection {
  projectPath: string;
  host: string;
  projectDir: string;
  applyProjectDir: (projectDir: string) => void;
}

/**
 * Writes the host-resolved directory into the selection only while it still shows the directory
 * the request trusted. The trust controls stay usable while a request runs, so by the time it
 * returns the user may have picked another host, directory, isolation or project (current is null
 * once the SSH+None controls unmount); writing then would overwrite that newer choice.
 */
export function applyResolvedProjectDir(
  current: SshDirectoryTrustSelection | null,
  request: { projectPath: string; host: string; projectDir: string },
  resolvedProjectDir: string
): boolean {
  const stillShown =
    current !== null &&
    current.projectPath === request.projectPath &&
    current.host.trim() === request.host &&
    current.projectDir.trim() === request.projectDir;
  if (!stillShown || resolvedProjectDir === request.projectDir) return false;
  current.applyProjectDir(resolvedProjectDir);
  return true;
}

/**
 * Saves the user's trust choice for an SSH+None directory and refreshes what depends on it.
 * Returns the error to show, or null on success; never throws.
 *
 * The backend stores the directory resolved on the host (~ expanded), as workspaces persist it.
 * Writing that back into the selection keeps the field, the remembered directory and the stored
 * trust entry identical, so a typed "~/app" still shows as trusted after a restart.
 */
export async function saveSshDirectoryTrust(
  deps: {
    api: Pick<APIClient["projects"], "setSshDirectoryTrust">;
    refreshProjects: () => Promise<void>;
    /** Read after the request returns, so the write-back sees the latest selection. */
    currentSelection: () => SshDirectoryTrustSelection | null;
  },
  request: { projectPath: string; host: string; projectDir: string; trusted: boolean }
): Promise<string | null> {
  try {
    const result = await deps.api.setSshDirectoryTrust(request);
    if (!result.success) {
      return result.error;
    }
    applyResolvedProjectDir(deps.currentSelection(), request, result.data.projectDir);
    publishProjectTrustChanged();
    await deps.refreshProjects();
    return null;
  } catch (err) {
    return getErrorMessage(err);
  }
}
