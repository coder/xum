import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { WorkspaceMCPModal } from "../WorkspaceMCPModal/WorkspaceMCPModal";
import { WorkspaceUnrelatedMessagingDialog } from "../WorkspaceUnrelatedMessagingModal/WorkspaceUnrelatedMessagingDialog";

interface RowSettingsDialogProps {
  kind: "mcp" | "messaging";
  workspace: FrontendWorkspaceMetadata;
  projectPath: string;
  onClose: () => void;
}

/**
 * The sidebar row's settings dialogs (#6202). AgentListItem loads this module only when one
 * opens: the sidebar is on every page's first load, and these dialogs are not (#6206).
 */
export function RowSettingsDialog(props: RowSettingsDialogProps) {
  const onOpenChange = (open: boolean) => {
    if (!open) props.onClose();
  };
  return props.kind === "mcp" ? (
    <WorkspaceMCPModal
      workspaceId={props.workspace.id}
      projectPath={props.projectPath}
      open
      onOpenChange={onOpenChange}
    />
  ) : (
    <WorkspaceUnrelatedMessagingDialog
      workspaceId={props.workspace.id}
      runtimeConfig={props.workspace.runtimeConfig}
      workspace={props.workspace}
      open
      onOpenChange={onOpenChange}
    />
  );
}
