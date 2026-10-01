import React from "react";
import { ArrowUpRight, Workflow } from "lucide-react";
import type { DisplayedMessage } from "@/common/types/message";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import {
  toWorkspaceSelection,
  useOptionalWorkspaceContext,
} from "@/browser/contexts/WorkspaceContext";
import { useWorkspaceState } from "@/browser/stores/WorkspaceStore";

/**
 * Owner of the delegated turn this workspace is running, or null. The turn belongs to the
 * newest user row: once someone types here, their message starts the next turn, so the banner
 * hides (the owner is still told via its redirected handle).
 */
export function getActiveDelegatedTurnOwnerId(
  messages: readonly DisplayedMessage[],
  turnActive: boolean
): string | null {
  if (!turnActive) return null;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === "user") return message.delegatedByWorkspaceId ?? null;
  }
  return null;
}

/**
 * Self-gating composer decoration: while another workspace's delegated turn (task
 * kind="workspace") runs here, link to that workspace. Product decision: a simple link in v1,
 * with no send options; new input here is followed and reported back to the owner.
 */
export const DelegatedTurnBanner: React.FC<{ workspaceId: string }> = (props) => {
  const state = useWorkspaceState(props.workspaceId);
  const workspaceContext = useOptionalWorkspaceContext();
  const ownerId = getActiveDelegatedTurnOwnerId(
    state.messages,
    state.canInterrupt || state.isStreamStarting
  );
  const owner = ownerId != null ? workspaceContext?.workspaceMetadata?.get(ownerId) : undefined;
  // Link only to workspaces this frontend knows; an unknown owner gets no banner.
  if (owner == null || workspaceContext == null) return null;
  const ownerName = owner.title ?? owner.name;
  return (
    <ChatInputDecoration
      expanded={false}
      dataComponent="DelegatedTurnBanner"
      onToggle={() => workspaceContext.setSelectedWorkspace(toWorkspaceSelection(owner))}
      summaryClassName="min-w-0"
      summary={
        <>
          <Workflow className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors" />
          <span className="text-muted group-hover:text-secondary min-w-0 truncate transition-colors">
            {"This turn was started by "}
            <span className="font-medium">{ownerName}</span>
          </span>
        </>
      }
      trailingIcon={
        <ArrowUpRight className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
      }
    />
  );
};
