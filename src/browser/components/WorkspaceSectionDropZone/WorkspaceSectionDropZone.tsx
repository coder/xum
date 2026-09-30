import React from "react";
import { useDrop } from "react-dnd";
import { cn } from "@/common/lib/utils";

const WORKSPACE_DRAG_TYPE = "WORKSPACE_TO_SECTION";

export interface WorkspaceDragItem {
  type: typeof WORKSPACE_DRAG_TYPE;
  workspaceId: string;
  projectPath: string;
  currentSectionId?: string;
  /** Whether the dragged row is pinned; gates pinned-reorder drop targets. */
  pinned?: boolean;
  /**
   * Identifies the visual pinned block the row was dragged from (project +
   * section, or the multi-project section). Pinned reordering only accepts
   * drops within the same block; explicit so multi-project rows (whose
   * projectPath is their primary project, not the shared bucket) still match.
   */
  pinnedReorderGroup?: string;
}

interface WorkspaceSectionDropZoneProps {
  projectPath: string;
  sectionId: string | null; // null for unsectioned
  onDrop: (workspaceId: string, targetSectionId: string | null) => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}

/**
 * Drop zone for dragging workspaces into/out of sections.
 */
export const WorkspaceSectionDropZone: React.FC<WorkspaceSectionDropZoneProps> = ({
  projectPath,
  sectionId,
  onDrop,
  children,
  className,
  testId,
}) => {
  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: WORKSPACE_DRAG_TYPE,
      canDrop: (item: WorkspaceDragItem) => {
        // Can only drop if from same project and moving to different section
        return item.projectPath === projectPath && item.currentSectionId !== sectionId;
      },
      drop: (item: WorkspaceDragItem, monitor) => {
        // A nested row-level drop target (pinned reorder) may have already
        // handled this drop; never double-handle it as a section move.
        if (monitor.didDrop()) return;
        onDrop(item.workspaceId, sectionId);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [projectPath, sectionId, onDrop]
  );

  return (
    <div
      ref={drop}
      className={cn(className, isOver && canDrop && "bg-accent/10")}
      data-testid={testId}
      data-drop-section-id={sectionId ?? "unsectioned"}
    >
      {children}
    </div>
  );
};

export { WORKSPACE_DRAG_TYPE };
