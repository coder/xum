import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import type { ProjectConfig } from "@/common/types/project";
import {
  resolveSshDirectoryTrustNotice,
  saveSshDirectoryTrust,
  type SshDirectoryTrustSelection,
} from "./sshDirectoryTrustState";

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
  /**
   * The backend stores the directory resolved on the host (~ expanded), as workspaces persist it.
   * Writing that back into the selection keeps the field, the remembered directory and the stored
   * trust entry identical, so a typed "~/app" still shows as trusted after a restart.
   */
  onProjectDirResolved: (projectDir: string) => void;
}) {
  const { pending, error, saveTrust } = useSshDirectoryTrustSaver({
    projectPath: props.projectPath,
    host: props.host,
    projectDir: props.projectDir,
    applyProjectDir: props.onProjectDirResolved,
  });
  const notice = resolveSshDirectoryTrustNotice(props);
  if (notice === null) return null;

  return (
    <SshDirectoryTrustRow
      trusted={notice.trusted}
      disabled={props.disabled || pending}
      error={error}
      onSetTrust={(trusted) =>
        void saveTrust({
          projectPath: props.projectPath,
          host: notice.host,
          projectDir: notice.projectDir,
          trusted,
        })
      }
    />
  );
}

/** Saves one trust choice at a time and keeps its pending state and last error for the row. */
function useSshDirectoryTrustSaver(selection: SshDirectoryTrustSelection) {
  const { api } = useAPI();
  const { refreshProjects } = useProjectContext();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The selection the form shows now, or null once these controls unmount. A request's
  // resolved-path write-back reads it after the await, so it never restores a selection the
  // user has since changed (see applyResolvedProjectDir).
  const currentSelectionRef = useRef<SshDirectoryTrustSelection | null>(null);
  useLayoutEffect(() => {
    currentSelectionRef.current = selection;
    return () => {
      currentSelectionRef.current = null;
    };
  });

  const saveTrust = async (request: Parameters<typeof saveSshDirectoryTrust>[1]) => {
    if (!api || pending) return;
    setPending(true);
    setError(null);
    setError(
      await saveSshDirectoryTrust(
        {
          api: api.projects,
          refreshProjects,
          currentSelection: () => currentSelectionRef.current,
        },
        request
      )
    );
    setPending(false);
  };
  return { pending, error, saveTrust };
}

function SshDirectoryTrustRow(props: {
  trusted: boolean;
  disabled: boolean;
  error: string | null;
  onSetTrust: (trusted: boolean) => void;
}) {
  return (
    <div className="flex w-full basis-full flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {props.trusted ? (
        <>
          <span className="text-muted-foreground">Trusted directory</span>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0"
            disabled={props.disabled}
            onClick={() => props.onSetTrust(false)}
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
            disabled={props.disabled}
            onClick={() => props.onSetTrust(true)}
          >
            Trust directory
          </Button>
        </>
      )}
      {props.error !== null && <span className="text-error w-full">{props.error}</span>}
    </div>
  );
}
