import React, { useRef, useState } from "react";
import { Check, Loader2, TriangleAlert, Trash2 } from "lucide-react";
import { ChatDockSurface } from "@/browser/components/ChatPane/chatDockColumn";
import { useAPI } from "@/browser/contexts/API";
import {
  useConfirmDialog,
  type ConfirmDialogOptions,
} from "@/browser/contexts/ConfirmDialogContext";
import {
  useOptionalWorkspaceMetadata,
  useWorkspaceActionsOptional,
} from "@/browser/contexts/WorkspaceContext";
import {
  removeWorkspaceConfirmOptions,
  type RemovableWorkspace,
} from "@/browser/utils/commands/removeWorkspaceConfirm";

/**
 * Copy stays neutral about the cause: a crash, a failed rollback and a failed cleanup all land
 * here. What the backend proved is that the creating handle never persisted (#4983).
 */
export const DELEGATED_CREATION_INTERRUPTED_MESSAGE =
  "The delegated task that created this workspace did not finish setting it up. The task never started here, and its owner can no longer reach this workspace.";

type BannerAction = "remove" | "keep";

export interface DelegatedCreationInterruptedNoticeProps {
  workspaceId: string;
  /** Names what the removal deletes on this workspace's runtime (#5204). */
  workspace: RemovableWorkspace;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  /** The normal user removal: never forced, so a dirty checkout or a busy workspace refuses. */
  removeWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Offers the two outcomes for a flagged delegated workspace: remove it through the same
 * confirmation and non-forced removal as the command palette, or keep it as an ordinary
 * workspace. Nothing is removed without the user's confirmation.
 */
export const DelegatedCreationInterruptedNotice: React.FC<
  DelegatedCreationInterruptedNoticeProps
> = (props) => {
  const { api } = useAPI();
  const [pendingAction, setPendingAction] = useState<BannerAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Synchronous guard: a second click can land before the disabled state renders.
  const actionInFlightRef = useRef(false);

  const run = (action: BannerAction, perform: () => Promise<string | null>) => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionError(null);
    setPendingAction(action);
    // On success the backend's metadata update (or the removal) unmounts this banner.
    perform().then(
      (error) => {
        actionInFlightRef.current = false;
        setActionError(error);
        setPendingAction(null);
      },
      (error: unknown) => {
        actionInFlightRef.current = false;
        setActionError(error instanceof Error ? error.message : String(error));
        setPendingAction(null);
      }
    );
  };

  const remove = () =>
    run("remove", async () => {
      const confirmed = await props.confirm(
        removeWorkspaceConfirmOptions("Remove current workspace?", props.workspace)
      );
      if (!confirmed) return null;
      const result = await props.removeWorkspace(props.workspaceId);
      return result.success ? null : (result.error ?? "Failed to remove workspace");
    });

  const keep = () =>
    run("keep", async () => {
      if (!api) return "Not connected to the backend";
      const result = await api.workspace.keepInterruptedDelegatedWorkspace({
        workspaceId: props.workspaceId,
      });
      return result.success ? null : result.error;
    });

  const buttonClass =
    "flex h-6 items-center gap-1 rounded-md px-2 font-medium transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <ChatDockSurface>
      <div className="py-1.5" data-component="DelegatedCreationInterruptedBanner">
        <div className="border-warning/30 bg-background-secondary rounded-md border">
          <div role="status" className="text-secondary flex items-start gap-2 px-3 py-2 text-xs">
            <TriangleAlert className="text-warning mt-px size-3.5 shrink-0" />
            <span className="min-w-0">{DELEGATED_CREATION_INTERRUPTED_MESSAGE}</span>
          </div>
          {actionError && (
            <div
              role="alert"
              className="border-toast-error-border/50 bg-toast-error-bg/50 text-toast-error-text border-t px-3 py-2 text-xs break-words"
            >
              {actionError}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-1 px-2 pb-2 text-[11px]">
            <button
              type="button"
              disabled={pendingAction != null}
              onClick={keep}
              className={`text-muted ${buttonClass}`}
            >
              {pendingAction === "keep" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              Keep workspace
            </button>
            <button
              type="button"
              disabled={pendingAction != null}
              onClick={remove}
              className={`text-secondary bg-muted/10 ${buttonClass}`}
            >
              {pendingAction === "remove" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              Remove workspace…
            </button>
          </div>
        </div>
      </div>
    </ChatDockSurface>
  );
};

/** Wires the notice to the app's confirmation dialog and workspace removal. */
export const DelegatedCreationInterruptedBanner: React.FC<{
  workspaceId: string;
  workspaceName: string;
}> = (props) => {
  const { confirm } = useConfirmDialog();
  const removeWorkspace = useWorkspaceActionsOptional()?.removeWorkspace;
  const meta = useOptionalWorkspaceMetadata()?.workspaceMetadata.get(props.workspaceId);
  if (removeWorkspace == null) return null;
  return (
    <DelegatedCreationInterruptedNotice
      workspaceId={props.workspaceId}
      workspace={{
        name: props.workspaceName,
        runtimeConfig: meta?.runtimeConfig,
        projects: meta?.projects,
        kind: meta?.kind,
      }}
      confirm={confirm}
      removeWorkspace={(workspaceId) => removeWorkspace(workspaceId)}
    />
  );
};
