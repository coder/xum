import { useAPI } from "@/browser/contexts/API";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import {
  isLocalProjectRuntime,
  isWorktreeRuntime,
  type RuntimeConfig,
} from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
// The package index, not the file: test doubles replace the modal on the index module.
import { WorkspaceUnrelatedMessagingModal } from ".";

interface WorkspaceUnrelatedMessagingDialogProps {
  workspaceId: string;
  runtimeConfig: RuntimeConfig | undefined;
  workspace:
    | Pick<FrontendWorkspaceMetadata, "unrelatedWorkspaceConsent" | "agentMessageDispatchMode">
    | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The "Messages from other workspaces" dialog wired to the backend, for both menus (#6202). */
export function WorkspaceUnrelatedMessagingDialog(props: WorkspaceUnrelatedMessagingDialogProps) {
  const { api } = useAPI();
  const { workspaceId } = props;
  // Mirrors TaskService.isLocalUnrelatedMessagingEndpoint: unrelated delivery requires local or
  // worktree runtimes on both endpoints, so remote/container workspaces get no consent switch —
  // a grant there could never be honoured. The dialog itself stays reachable everywhere because
  // its hold-until-turn-end preference also covers same-tree senders, which work on any runtime.
  // An unset config resolves to the same canonical default the backend applies.
  const runtime = props.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
  return (
    <WorkspaceUnrelatedMessagingModal
      open={props.open}
      onOpenChange={props.onOpenChange}
      consentSupported={isLocalProjectRuntime(runtime) || isWorktreeRuntime(runtime)}
      // Read straight from published metadata: the switch moves only after the backend
      // commits and republishes, never on the local ack alone.
      enabled={props.workspace?.unrelatedWorkspaceConsent != null}
      onSetEnabled={(enabled) =>
        api
          ? api.workspace.setUnrelatedWorkspaceConsent({ workspaceId, enabled })
          : Promise.resolve({ success: false as const, error: "Not connected to server" })
      }
      holdUntilTurnEnd={props.workspace?.agentMessageDispatchMode === "turn-end"}
      onSetHoldUntilTurnEnd={(hold) =>
        api
          ? api.workspace.setAgentMessageDispatchMode({
              workspaceId,
              mode: hold ? "turn-end" : "tool-end",
            })
          : Promise.resolve({ success: false as const, error: "Not connected to server" })
      }
    />
  );
}
