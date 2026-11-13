import { useLayoutEffect, useRef, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import {
  readRuntimeOptionDefaults,
  updateRuntimeOptionDefaults,
} from "@/browser/utils/runtimeOptionDefaults";
import { cn } from "@/common/lib/utils";
import type { ProjectConfig } from "@/common/types/project";
import {
  resolveSshDirectoryTrustNotice,
  saveSshDirectoryTrust,
  sshDirectoryTrustKey,
  sshDirectoryTrustRowCopy,
  type PendingSshDirectoryTrust,
  type SshDirectoryTrustSelection,
  withResolvedRememberedProjectDir,
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
  const saver = useSshDirectoryTrustSaver({
    projectPath: props.projectPath,
    host: props.host,
    projectDir: props.projectDir,
    applyProjectDir: props.onProjectDirResolved,
  });
  const notice = resolveSshDirectoryTrustNotice(props);
  if (notice === null) return null;
  const key = sshDirectoryTrustKey(props.projectPath, notice);

  return (
    <SshDirectoryTrustRow
      trusted={notice.trusted}
      host={notice.host}
      projectDir={notice.projectDir}
      pending={saver.pending}
      disabled={props.disabled}
      // An error belongs to the directory it was about: editing the host or path clears it.
      error={saver.failure?.key === key ? saver.failure.message : null}
      onSetTrust={(trusted) =>
        void saver.saveTrust(key, {
          projectPath: props.projectPath,
          host: notice.host,
          projectDir: notice.projectDir,
          trusted,
        })
      }
    />
  );
}

function rememberResolvedProjectDir(
  request: { projectPath: string; host: string; projectDir: string },
  resolved: string
) {
  const next = withResolvedRememberedProjectDir(
    readRuntimeOptionDefaults(request.projectPath),
    { host: request.host, typed: request.projectDir },
    resolved
  );
  if (next !== null) updateRuntimeOptionDefaults(request.projectPath, () => next);
}

/** Saves one trust choice at a time and keeps what is pending and the last failure for the row. */
function useSshDirectoryTrustSaver(selection: SshDirectoryTrustSelection) {
  const { api } = useAPI();
  const { refreshProjects } = useProjectContext();
  const [pending, setPending] = useState<PendingSshDirectoryTrust>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
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

  const saveTrust = async (key: string, request: Parameters<typeof saveSshDirectoryTrust>[1]) => {
    if (!api || pending !== null) return;
    setPending(request.trusted ? "trust" : "untrust");
    setFailure(null);
    const message = await saveSshDirectoryTrust(
      {
        api: api.projects,
        refreshProjects,
        currentSelection: () => currentSelectionRef.current,
        rememberResolvedProjectDir,
      },
      request
    );
    setFailure(message === null ? null : { key, message });
    setPending(null);
  };
  return { pending, failure, saveTrust };
}

function SshDirectoryTrustRow(props: {
  trusted: boolean;
  host: string;
  projectDir: string;
  pending: PendingSshDirectoryTrust;
  disabled: boolean;
  error: string | null;
  onSetTrust: (trusted: boolean) => void;
}) {
  const busy = props.pending !== null;
  const copy = sshDirectoryTrustRowCopy(props);
  const StatusIcon = props.trusted ? ShieldCheck : ShieldAlert;
  const ActionIcon = busy ? Loader2 : null;

  // Layout, so the row looks balanced at every width:
  // - Capped at max-w-2xl: a full-width bar put the button ~1,000px from the shield on a wide
  //   screen. A fixed cap (not a content-hugging width) keeps the button still when the copy
  //   changes length between states.
  // - One line from @md up: icon, status, button, with the row as tall as the chip above it (32px).
  // - Narrower (a phone): the title, the detail and the button stack in the text column, with the
  //   shield on the title's line. Side by side they squeezed the copy into a ~180px column.
  // - The error sits in the text column, under the status it explains.
  return (
    <div className="@container w-full">
      <div
        className="border-border-medium grid w-full max-w-2xl grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5 rounded-[7px] border px-2.5 py-1.5 text-xs @md:grid-cols-[auto_minmax(0,1fr)_auto] @md:items-center @md:py-[3px]"
        data-component="SshDirectoryTrust"
        data-trusted={props.trusted}
      >
        <StatusIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            props.trusted ? "text-success-text" : "text-warning-text"
          )}
        />
        {/* Announced when it changes, so a trust or untrust is confirmed without looking. */}
        <span role="status" className="min-w-0">
          <span className="text-foreground block font-medium @md:inline">{copy.title}</span>
          <span className="text-muted">
            <span className="hidden @md:inline"> · </span>
            {copy.detail}
          </span>
        </span>
        <Button
          variant="outline"
          size="xs"
          // One width for every label, so the button does not jump between states; Untrust is
          // outlined too (a bare label read as loose text), but muted, as the quieter action.
          className={cn(
            "col-start-2 min-w-[6.75rem] justify-self-start @md:col-start-3 @md:row-start-1",
            props.trusted && "text-muted hover:text-foreground"
          )}
          disabled={props.disabled || busy}
          aria-busy={busy}
          onClick={() => props.onSetTrust(!props.trusted)}
        >
          {ActionIcon && <ActionIcon aria-hidden className="animate-spin" />}
          {copy.action}
        </Button>
        {props.error !== null && (
          // col-end, not col-span: a span would replace col-start and put the error under the icon.
          <span role="alert" className="text-error col-start-2 @md:col-end-4">
            {props.error}
          </span>
        )}
      </div>
    </div>
  );
}
