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

/**
 * Saves the user's trust choice for an SSH+None directory and refreshes what depends on it.
 * Returns the error to show, or null on success; never throws.
 *
 * The backend stores the directory resolved on the host (~ expanded), as workspaces persist it.
 * Writing that back through onProjectDirResolved keeps the field, the remembered directory and the
 * stored trust entry identical, so a typed "~/app" still shows as trusted after a restart.
 */
export async function saveSshDirectoryTrust(
  deps: {
    api: Pick<APIClient["projects"], "setSshDirectoryTrust">;
    refreshProjects: () => Promise<void>;
    onProjectDirResolved: (projectDir: string) => void;
  },
  request: { projectPath: string; host: string; projectDir: string; trusted: boolean }
): Promise<string | null> {
  try {
    const result = await deps.api.setSshDirectoryTrust(request);
    if (!result.success) {
      return result.error;
    }
    if (result.data.projectDir !== request.projectDir) {
      deps.onProjectDirResolved(result.data.projectDir);
    }
    publishProjectTrustChanged();
    await deps.refreshProjects();
    return null;
  } catch (err) {
    return getErrorMessage(err);
  }
}
