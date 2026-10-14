import { AppWindow } from "lucide-react";
import { openArtifact } from "@/browser/features/RightSidebar/ArtifactsTab/openArtifact";
import type { ArtifactInteractionMetadata } from "@/common/types/message";

const pillClassName =
  "bg-muted/20 text-muted flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase";

/**
 * "from artifact" label on a user message sent from an artifact (M5b design C). Shown only for
 * backend-written metadata. Clicking opens the artifact at the version the user interacted with
 * (version 0 means the file had no stored version: open the live file).
 */
export function ArtifactInteractionPill(props: {
  interaction: ArtifactInteractionMetadata;
  /** null outside a workspace shell: the label shows but cannot open anything. */
  workspaceId: string | null;
}) {
  const content = (
    <>
      <AppWindow aria-hidden="true" className="h-3 w-3" />
      from artifact
    </>
  );
  const workspaceId = props.workspaceId;
  if (workspaceId == null) return <span className={pillClassName}>{content}</span>;
  return (
    <button
      type="button"
      onClick={() =>
        openArtifact({
          workspaceId,
          path: props.interaction.artifactPath,
          versionId: props.interaction.version > 0 ? props.interaction.version : null,
        })
      }
      aria-label={`Open ${props.interaction.title} in Artifacts`}
      className={`${pillClassName} hover:text-foreground`}
    >
      {content}
    </button>
  );
}
