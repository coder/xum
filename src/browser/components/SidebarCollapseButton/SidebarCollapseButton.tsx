import React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { requestMainRegionFocus } from "@/browser/hooks/useFocusMainRegion";

interface SidebarCollapseButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Direction the sidebar expands toward (left sidebar expands right, right sidebar expands left) */
  side: "left" | "right";
  /** Optional keyboard shortcut to show in tooltip */
  shortcut?: string;
}

/**
 * Collapse/expand toggle button for sidebars.
 * Renders at the bottom of the sidebar with « » chevrons.
 */
export const SidebarCollapseButton: React.FC<SidebarCollapseButtonProps> = ({
  collapsed,
  onToggle,
  side,
  shortcut,
}) => {
  // Left sidebar: collapsed shows », expanded shows «
  // Right sidebar: collapsed shows «, expanded shows »
  const chevron = side === "left" ? (collapsed ? "»" : "«") : collapsed ? "«" : "»";

  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";

  const handleClick = () => {
    onToggle();
    if (collapsed) {
      return;
    }

    requestMainRegionFocus();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleClick}
          aria-label={label}
          className={
            collapsed
              ? "text-muted hover:bg-hover hover:text-foreground flex w-full flex-1 cursor-pointer items-center justify-center bg-transparent p-0 text-xs transition-all duration-200"
              : "text-muted border-dark hover:bg-hover hover:text-foreground mt-auto flex h-6 w-full cursor-pointer items-center justify-center border-t border-none bg-transparent p-0 text-xs transition-all duration-200"
          }
        >
          {chevron}
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        {label}
        {shortcut && ` (${shortcut})`}
      </TooltipContent>
    </Tooltip>
  );
};
