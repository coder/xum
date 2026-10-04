import React, { useEffect, useRef, useState } from "react";
import { FileInput, Loader2 } from "lucide-react";
import { ChatDockSurface } from "@/browser/components/ChatPane/chatDockColumn";
import { useAPI } from "@/browser/contexts/API";
import { useOptionalCommandRegistry } from "@/browser/contexts/CommandRegistryContext";
import { useOptionalWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { isSSHRuntime } from "@/common/types/runtime";

export interface LegacyPlanImportNoticeProps {
  workspaceId: string;
  /** The shared pre-#5174 plan path on the SSH host (workspace.getImportableLegacyPlan). */
  legacyPlanPath: string;
  /** Called once the offer is settled (imported, or a plan is already in place). */
  onSettled: () => void;
}

/**
 * Offers the explicit import of an SSH workspace's plan from an older Xum (#5174, Option B).
 * That file sits at a path every installation on the host shared, so another installation can own
 * it: Xum never imports it on its own, only when the user asks here or in the command palette.
 * The backend copies it (never replacing an existing plan) and leaves the legacy file in place.
 */
export const LegacyPlanImportNotice: React.FC<LegacyPlanImportNoticeProps> = (props) => {
  const { api } = useAPI();
  const registerSource = useOptionalCommandRegistry()?.registerSource;
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard: a click and the palette action can both land before the disabled state.
  const inFlightRef = useRef(false);

  const importPlan = async () => {
    if (inFlightRef.current) return;
    if (!api) {
      setError("Not connected to the backend");
      return;
    }
    inFlightRef.current = true;
    setImporting(true);
    setError(null);
    try {
      const result = await api.workspace.importLegacyPlan({ workspaceId: props.workspaceId });
      if (!result.success) {
        setError(result.error);
      } else if (result.data.status === "nothing_to_import") {
        setError("The plan from an older Xum is no longer there.");
      } else {
        props.onSettled();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlightRef.current = false;
      setImporting(false);
    }
  };
  // The palette entry calls the latest render's handler (as WorkflowRunToolCall's actions do).
  const importPlanRef = useRef(importPlan);
  importPlanRef.current = importPlan;

  // Keyboard path (every operation has one): a command palette action while the offer is shown.
  // Registering with the palette's registry is a subscription to an external store.
  useEffect(() => {
    if (!registerSource) return;
    return registerSource(() => [
      {
        id: `workspace:${props.workspaceId}:import-legacy-plan`,
        title: "Import plan from an older Xum",
        subtitle: props.legacyPlanPath,
        section: "Workspaces",
        keywords: ["plan", "import", "legacy", "older", "ssh"],
        run: () => importPlanRef.current(),
      },
    ]);
  }, [registerSource, props.workspaceId, props.legacyPlanPath]);

  return (
    <ChatDockSurface>
      <div className="py-1.5" data-component="LegacyPlanImportBanner">
        <div className="border-border-medium bg-background-secondary rounded-md border">
          <div role="status" className="text-secondary flex items-start gap-2 px-3 py-2 text-xs">
            <FileInput className="text-muted mt-px size-3.5 shrink-0" />
            <div className="min-w-0">
              <div>
                A plan from an older Xum is on the host. Older Xum installations on this host share
                its path, so check that it is yours before you import it.
              </div>
              <div className="text-muted mt-0.5 font-mono text-[11px] break-all">
                {props.legacyPlanPath}
              </div>
            </div>
          </div>
          {error && (
            <div
              role="alert"
              className="border-toast-error-border/50 bg-toast-error-bg/50 text-toast-error-text border-t px-3 py-2 text-xs break-words"
            >
              {error}
            </div>
          )}
          <div className="flex justify-end px-2 pb-2 text-[11px]">
            <button
              type="button"
              disabled={importing}
              onClick={() => void importPlan()}
              className="text-secondary bg-muted/10 hover:bg-hover hover:text-foreground flex h-6 items-center gap-1 rounded-md px-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <FileInput className="size-3" />
              )}
              Import plan
            </button>
          </div>
        </div>
      </div>
    </ChatDockSurface>
  );
};

/**
 * Self-gating ChatPane decoration: asks the backend once per workspace whether an SSH workspace
 * has a plan from an older Xum to offer, and renders nothing otherwise (every non-SSH workspace
 * skips the request).
 */
export const LegacyPlanImportBanner: React.FC<{ workspaceId: string }> = (props) => {
  const { api } = useAPI();
  const runtimeConfig = useOptionalWorkspaceMetadata()?.workspaceMetadata.get(
    props.workspaceId
  )?.runtimeConfig;
  const isSSH = runtimeConfig != null && isSSHRuntime(runtimeConfig);
  const [legacyPlanPath, setLegacyPlanPath] = useState<string | null>(null);

  // Fetching the offer is synchronization with the backend for this workspace.
  useEffect(() => {
    if (!api || !isSSH) return;
    let cancelled = false;
    api.workspace.getImportableLegacyPlan({ workspaceId: props.workspaceId }).then(
      (result) => {
        if (!cancelled) setLegacyPlanPath(result.success ? result.data : null);
      },
      () => {
        // Unreachable backend: no offer (the next mount asks again).
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, isSSH, props.workspaceId]);

  if (legacyPlanPath === null) return null;
  return (
    <LegacyPlanImportNotice
      workspaceId={props.workspaceId}
      legacyPlanPath={legacyPlanPath}
      onSettled={() => setLegacyPlanPath(null)}
    />
  );
};
