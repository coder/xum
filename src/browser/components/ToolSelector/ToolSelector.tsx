import React from "react";
import { Checkbox } from "@/browser/components/Checkbox/Checkbox";
import { Button } from "@/browser/components/Button/Button";

interface ToolSelectorProps {
  /** All available tools for this server */
  availableTools: string[];
  /** Currently allowed tools (empty = none allowed) */
  allowedTools: string[];
  /** Called when tool selection changes */
  onToggle: (toolName: string, allowed: boolean) => void;
  /** Called to select all tools */
  onSelectAll: () => void;
  /** Called to deselect all tools */
  onSelectNone: () => void;
  /** Whether controls are disabled */
  disabled?: boolean;
}

/**
 * Reusable tool selector grid with All/None buttons.
 * Used by both project-level and workspace-level MCP config UIs.
 */
export const ToolSelector: React.FC<ToolSelectorProps> = ({
  availableTools,
  allowedTools,
  onToggle,
  onSelectAll,
  onSelectNone,
  disabled = false,
}) => {
  const allAllowed = allowedTools.length === availableTools.length;
  const noneAllowed = allowedTools.length === 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-content-secondary text-xs">Select tools to expose:</span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs"
            onClick={onSelectAll}
            disabled={disabled || allAllowed}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs"
            onClick={onSelectNone}
            disabled={disabled || noneAllowed}
          >
            None
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {availableTools.map((tool) => (
          <label key={tool} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
            <Checkbox
              checked={allowedTools.includes(tool)}
              onCheckedChange={(checked) => onToggle(tool, checked === true)}
              disabled={disabled}
            />
            <span className="truncate font-mono" title={tool}>
              {tool}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
};
