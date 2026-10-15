import React from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";

interface SidebarCollapseButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

/**
 * Left sidebar toggle icon, mirroring the right sidebar's: the expanded sidebar's header shows it
 * as "Collapse sidebar", and page headers show it as the reopen affordance while the sidebar is
 * collapsed (at phone widths that opens the drawer, hence the "menu" label).
 */
export const SidebarCollapseButton: React.FC<SidebarCollapseButtonProps> = (props) => {
  const label = props.collapsed ? "Open sidebar" : "Collapse sidebar";
  const Icon = props.collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onToggle}
          aria-label={props.collapsed ? "Open sidebar menu" : label}
          className={cn(
            "text-muted hover:text-foreground h-6 w-6 shrink-0",
            isDesktopMode() && "titlebar-no-drag",
            props.className
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} ({formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})
      </TooltipContent>
    </Tooltip>
  );
};
