import { LayoutDashboard, MessageSquare } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import {
  type AgentInterfaceView,
  useAgentInterfaceView,
  writeAgentInterfaceViewChoice,
} from "./agentInterfaceView";

const VIEW_OPTIONS: ReadonlyArray<{
  view: AgentInterfaceView;
  label: string;
  description: string;
  Icon: typeof LayoutDashboard;
}> = [
  {
    view: "status",
    label: "Status",
    description: "Show the agent's status page",
    Icon: LayoutDashboard,
  },
  { view: "chat", label: "Chat", description: "Show the chat transcript", Icon: MessageSquare },
];

/**
 * Status / Chat switch for the workspace menu bar (Agent interface view). Renders nothing until
 * both flags are on and the workspace has a status page.
 */
export function AgentInterfaceViewToggle(props: { workspaceId: string; className?: string }) {
  const { available, view } = useAgentInterfaceView(props.workspaceId);
  if (!available) return null;
  return (
    <div
      role="group"
      aria-label="Main pane view"
      data-testid="agent-interface-view-toggle"
      className={cn(
        "border-border-light flex h-6 shrink-0 items-center overflow-hidden rounded border",
        props.className
      )}
    >
      {VIEW_OPTIONS.map((option) => {
        const selected = view === option.view;
        return (
          <Tooltip key={option.view}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => writeAgentInterfaceViewChoice(props.workspaceId, option.view)}
                className={cn(
                  "focus-visible:ring-accent flex h-full items-center gap-1 px-1.5 text-xs focus-visible:ring-1 focus-visible:ring-inset",
                  selected
                    ? "bg-hover text-foreground"
                    : "text-muted hover:bg-sidebar-hover hover:text-foreground"
                )}
              >
                <option.Icon className="h-3.5 w-3.5 shrink-0" />
                {option.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              {option.description}
              <span className="mobile-hide-shortcut-hints">
                {" "}
                ({formatKeybind(KEYBINDS.TOGGLE_AGENT_INTERFACE_VIEW)})
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
