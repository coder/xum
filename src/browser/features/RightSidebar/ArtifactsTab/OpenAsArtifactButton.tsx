import React from "react";
import { PanelRight } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { useOptionalAPI } from "@/browser/contexts/API";
import { useChatHostContext } from "@/browser/contexts/ChatHostContext";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { cn } from "@/common/lib/utils";
import { pinAndOpenArtifact } from "./openArtifact";

/**
 * "Open as artifact" for a checkout file (Review headers, file_read/file_edit cards): pins the
 * file and shows it live in the Artifacts tab. Renders nothing while the experiment is off.
 */
export function OpenAsArtifactButton(props: {
  workspaceId: string | undefined;
  /** Absolute inside the checkout, or relative to it (or to the tool cwd, see `relativeTo`). */
  path: string;
  /**
   * File tool cards pass "tool-cwd": their relative paths resolve from the tool's cwd (a
   * sub-project dir), not the checkout root that Review paths use.
   */
  relativeTo?: "tool-cwd" | "checkout";
  className?: string;
}) {
  // Hosts without an Artifacts surface (VS Code) cannot open it.
  const experimentOn = useExperimentValue(EXPERIMENT_IDS.ARTIFACTS);
  const panelSupported = useChatHostContext().uiSupport.artifactsPanel === "supported";
  const enabled = experimentOn && panelSupported;
  // Optional: tool cards and Review hunks also render in isolated stories and tests.
  const api = useOptionalAPI()?.api;
  const workspaceId = props.workspaceId;
  if (!enabled || !api || !workspaceId || props.path.length === 0) return null;
  return (
    <TooltipIfPresent tooltip="Open as artifact" side="top">
      <button
        type="button"
        aria-label={`Open ${props.path} as artifact`}
        onClick={(event: React.MouseEvent) => {
          // Headers toggle expansion on click; this action must not.
          event.stopPropagation();
          void pinAndOpenArtifact(api, workspaceId, props.path, { relativeTo: props.relativeTo });
        }}
        className={cn(
          "text-muted hover:text-foreground flex shrink-0 cursor-pointer items-center border-none bg-transparent p-0",
          props.className
        )}
      >
        <PanelRight aria-hidden="true" className="h-3 w-3" />
      </button>
    </TooltipIfPresent>
  );
}
