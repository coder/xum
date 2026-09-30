import React from "react";

import { useDragLayer } from "react-dnd";
import {
  WORKSPACE_DRAG_TYPE,
  type WorkspaceDragItem,
} from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import { RuntimeBadge } from "../RuntimeBadge/RuntimeBadge";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Custom drag layer for workspace drag-drop.
 * Renders a clean preview of the workspace being dragged.
 */
export const WorkspaceDragLayer: React.FC = () => {
  const dragState = useDragLayer<{
    isDragging: boolean;
    item: unknown;
    itemType: string | symbol | null;
    currentOffset: { x: number; y: number } | null;
  }>((monitor) => ({
    isDragging: monitor.isDragging(),
    item: monitor.getItem(),
    itemType: monitor.getItemType(),
    currentOffset: monitor.getClientOffset(),
  }));

  const { isDragging, item, itemType, currentOffset } = dragState;

  // Only render for workspace drags
  if (!isDragging || itemType !== WORKSPACE_DRAG_TYPE || !currentOffset) {
    return null;
  }

  const workspaceItem = item as WorkspaceDragItem & {
    displayTitle?: string;
    runtimeConfig?: RuntimeConfig;
  };

  const displayTitle = workspaceItem.displayTitle ?? "Workspace";

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      <div
        style={{
          transform: `translate(${currentOffset.x + 10}px, ${currentOffset.y + 10}px)`,
        }}
      >
        <div
          className={cn(
            "flex max-w-56 items-center gap-1.5 rounded-sm px-2 py-1.5",
            "bg-dark border-border border shadow-lg"
          )}
        >
          <RuntimeBadge runtimeConfig={workspaceItem.runtimeConfig} isWorking={false} />
          <span className="text-foreground truncate text-sm">{displayTitle}</span>
        </div>
      </div>
    </div>
  );
};
