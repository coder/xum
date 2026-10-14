import type { ChatInputAPI } from "@/browser/features/ChatInput/types";
import { ChatPaneContent } from "@/browser/components/ChatPane/ChatPane";
import { WorkspaceModeAISync } from "@/browser/components/WorkspaceModeAISync/WorkspaceModeAISync";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { ChatPaneScopeProvider } from "@/browser/contexts/ChatPaneScopeContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { usePinnedWorkspaceChat } from "@/browser/stores/WorkspaceStore";
import { SIDE_CHAT_PANE_ATTR } from "@/browser/utils/ui/keybinds";

interface SideChatPanelProps {
  onInputReady: (workspaceId: string, api: ChatInputAPI) => void;
  sideChatWorkspaceId: string;
}

/**
 * A /side chat as a right-sidebar tab: a second live chat pane (transcript + composer) next to
 * the main chat, so both can be followed at once. The user asked for this instead of Codex's
 * full-screen takeover; the takeover remains the fallback where the sidebar is hidden.
 *
 * - Each mounted panel retains its own live transcript subscription alongside the routed chat,
 *   so multiple split-visible side chats do not replace each other's subscriptions.
 * - The scope provider and the pane attribute keep window-level chat shortcuts (Esc interrupt,
 *   focus, model/agent/thinking cycling) on the pane that has focus.
 * - The agent/thinking/background-bash providers are per workspace, like AIView's.
 */
export function SideChatPanel(props: SideChatPanelProps) {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const openTerminalPopout = useOpenTerminal();
  const metadata = workspaceMetadata.get(props.sideChatWorkspaceId);
  // Only once the store knows the workspace: subscribing to (or reading) an unregistered one
  // asserts. Metadata lands in the store before it reaches this context.
  usePinnedWorkspaceChat(metadata != null ? props.sideChatWorkspaceId : null);

  if (metadata == null) {
    return <div className="text-muted p-3 text-xs">Starting side chat…</div>;
  }

  return (
    <ChatPaneScopeProvider scope={`side:${metadata.id}`}>
      <div
        {...{ [SIDE_CHAT_PANE_ATTR]: metadata.id }}
        // Focusable so a click on non-focusable transcript space keeps keyboard focus (and with
        // it the chat shortcuts) in this pane instead of falling back to <body>, the main pane.
        tabIndex={-1}
        className="bg-surface-primary relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <AgentProvider workspaceId={metadata.id} projectPath={metadata.projectPath}>
          <WorkspaceModeAISync workspaceId={metadata.id} />
          <ThinkingProvider workspaceId={metadata.id}>
            <BackgroundBashProvider workspaceId={metadata.id}>
              <ChatPaneContent
                onChatInputReady={(api) => props.onInputReady(metadata.id, api)}
                embedded
                workspaceId={metadata.id}
                projectPath={metadata.projectPath}
                projectName={metadata.projectName}
                workspaceName={metadata.name}
                namedWorkspacePath={metadata.namedWorkspacePath}
                runtimeConfig={metadata.runtimeConfig}
                // The sidebar is already showing this tab; a terminal opens in its own window.
                onOpenTerminal={(options) =>
                  void openTerminalPopout(metadata.id, metadata.runtimeConfig, options)
                }
              />
            </BackgroundBashProvider>
          </ThinkingProvider>
        </AgentProvider>
      </div>
    </ChatPaneScopeProvider>
  );
}
