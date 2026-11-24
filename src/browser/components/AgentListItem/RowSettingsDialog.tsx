import type React from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { WorkspaceHeartbeatModal } from "../WorkspaceHeartbeatModal";
import { WorkspaceMCPModal } from "../WorkspaceMCPModal/WorkspaceMCPModal";
import { WorkspaceUnrelatedMessagingDialog } from "../WorkspaceUnrelatedMessagingModal/WorkspaceUnrelatedMessagingDialog";

type RowSettingsDialogKind = "heartbeat" | "mcp" | "messaging";

interface DialogProps {
  workspace: FrontendWorkspaceMetadata;
  projectPath: string;
  onOpenChange: (open: boolean) => void;
}

const DIALOGS: Record<RowSettingsDialogKind, (props: DialogProps) => React.ReactNode> = {
  heartbeat: (props) => (
    <WorkspaceHeartbeatModal
      workspaceId={props.workspace.id}
      open
      onOpenChange={props.onOpenChange}
    />
  ),
  mcp: (props) => (
    <WorkspaceMCPModal
      workspaceId={props.workspace.id}
      projectPath={props.projectPath}
      open
      onOpenChange={props.onOpenChange}
    />
  ),
  messaging: (props) => (
    <WorkspaceUnrelatedMessagingDialog
      workspaceId={props.workspace.id}
      runtimeConfig={props.workspace.runtimeConfig}
      workspace={props.workspace}
      open
      onOpenChange={props.onOpenChange}
    />
  ),
};

interface RowSettingsDialogProps {
  kind: RowSettingsDialogKind;
  workspace: FrontendWorkspaceMetadata;
  projectPath: string;
  onClose: () => void;
}

/**
 * The sidebar row's settings dialogs (#6202, heartbeat #6326). AgentListItem loads this module
 * only when one opens: the sidebar is on every page's first load, and these dialogs are not
 * (#6206).
 */
export function RowSettingsDialog(props: RowSettingsDialogProps) {
  const onOpenChange = (open: boolean) => {
    if (!open) props.onClose();
  };
  return DIALOGS[props.kind]({
    workspace: props.workspace,
    projectPath: props.projectPath,
    onOpenChange,
  });
}
