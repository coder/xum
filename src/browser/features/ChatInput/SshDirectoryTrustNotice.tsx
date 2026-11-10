import { useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { publishProjectTrustChanged } from "@/browser/utils/workspaceMcpMutations";
import type { ProjectConfig } from "@/common/types/project";
import { buildRuntimeConfig } from "@/common/types/runtime";
import { getErrorMessage } from "@/common/utils/errors";
import { isWorkspaceDirTrustedBy } from "@/common/utils/sshDirectoryTrust";

/**
 * Trust for the SSH+None directory being configured on the creation form. The directory is not
 * the local project, so project trust does not cover it: until the user trusts it, its workspaces
 * run like an untrusted project's. Shown only on a trusted project (an untrusted project's own
 * trust flow governs). Creation is never blocked: an untrusted directory just runs untrusted.
 */
export function SshDirectoryTrustNotice(props: {
  /** Owning (top-level) project path. */
  projectPath: string;
  userProjects: Map<string, ProjectConfig>;
  host: string;
  projectDir: string;
  disabled: boolean;
}) {
  const { api } = useAPI();
  const { refreshProjects } = useProjectContext();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The backend stores projectDir resolved on the host (~ expanded), as workspaces persist it.
  // Remember what the typed value resolved to so a typed "~/app" shows as trusted after the grant.
  const [resolved, setResolved] = useState<{ typed: string; stored: string } | null>(null);

  const host = props.host.trim();
  const typedDir = props.projectDir.trim();
  const project = props.userProjects.get(props.projectPath);
  const owner =
    project?.parentProjectPath !== undefined
      ? props.userProjects.get(project.parentProjectPath)
      : project;
  if (host === "" || typedDir === "" || owner?.trusted !== true) return null;

  const storedDir = resolved?.typed === typedDir ? resolved.stored : typedDir;
  const runtimeConfig = buildRuntimeConfig({
    mode: "ssh",
    host,
    workspaceIsolation: "none",
    projectDir: storedDir,
  });
  const trusted = isWorkspaceDirTrustedBy(owner.trustedSshDirectories, runtimeConfig);

  const setTrust = async (next: boolean) => {
    if (!api || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await api.projects.setSshDirectoryTrust({
        projectPath: props.projectPath,
        host,
        projectDir: storedDir,
        trusted: next,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setResolved({ typed: typedDir, stored: result.data.projectDir });
      publishProjectTrustChanged();
      await refreshProjects();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex w-full basis-full flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {trusted ? (
        <>
          <span className="text-muted-foreground">Trusted directory</span>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0"
            disabled={props.disabled || pending}
            onClick={() => void setTrust(false)}
          >
            Untrust
          </Button>
        </>
      ) : (
        <>
          <span className="text-muted-foreground min-w-0">
            This directory isn&apos;t trusted. Xum won&apos;t run its .xum/init or tool hooks, start
            its MCP servers, or pass project secrets until you trust it.
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={props.disabled || pending}
            onClick={() => void setTrust(true)}
          >
            Trust directory
          </Button>
        </>
      )}
      {error !== null && <span className="text-error w-full">{error}</span>}
    </div>
  );
}
