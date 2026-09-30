import React, { useMemo, useState } from "react";
import { ChevronRight, FileText, ExternalLink, Eye, EyeOff, Info } from "lucide-react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import type { RuntimeConfig } from "@/common/types/runtime";
import { PlanFileDialog } from "./PlanFileDialog";
import {
  POST_COMPACTION_COLLAPSED_KEY,
  POST_COMPACTION_FILES_EXPANDED_KEY,
} from "@/common/constants/storage";

interface PostCompactionSectionProps {
  workspaceId: string;
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: Set<string>;
  onToggleExclusion: (itemId: string) => Promise<void>;
  runtimeConfig?: RuntimeConfig;
}

/** Extract just the filename from a full path */
function getFileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

/**
 * Displays what context will be injected after compaction.
 * Collapsible section in the right sidebar below the context usage bar.
 */
export const PostCompactionSection: React.FC<PostCompactionSectionProps> = (props) => {
  const openInEditor = useOpenInEditor();
  const [collapsed, setCollapsed] = usePersistedState(POST_COMPACTION_COLLAPSED_KEY, true);
  const [filesExpanded, setFilesExpanded] = usePersistedState(
    POST_COMPACTION_FILES_EXPANDED_KEY,
    false
  );
  const [isPlanDialogOpen, setIsPlanDialogOpen] = useState(false);

  const handleOpenPlan = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!props.planPath) return;
    void openInEditor(props.workspaceId, props.planPath, props.runtimeConfig, { isFile: true });
  };

  // Derive values from props
  const planExists = props.planPath !== null;
  const trackedFilesCount = props.trackedFilePaths.length;
  const isPlanExcluded = props.excludedItems.has("plan");

  // Format file names for display - show just filename, with parent dir if duplicates
  const formattedFiles = useMemo(() => {
    const nameCount = new Map<string, number>();
    props.trackedFilePaths.forEach((p) => {
      const name = getFileName(p);
      nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    });

    return props.trackedFilePaths.map((fullPath) => {
      const name = getFileName(fullPath);
      const needsContext = (nameCount.get(name) ?? 0) > 1;
      const parts = fullPath.split("/");
      const displayName = needsContext && parts.length > 1 ? parts.slice(-2).join("/") : name;
      const itemId = `file:${fullPath}`;
      const isExcluded = props.excludedItems.has(itemId);
      return { fullPath, displayName, itemId, isExcluded };
    });
  }, [props.trackedFilePaths, props.excludedItems]);

  // Count how many items are included (not excluded)
  const includedFilesCount = formattedFiles.filter((f) => !f.isExcluded).length;

  // Don't render if nothing will be injected
  if (!planExists && trackedFilesCount === 0) {
    return null;
  }

  return (
    <div className="mt-2">
      <button
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center justify-between text-left"
        type="button"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-muted text-xs font-medium">Artifacts</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted hover:text-foreground inline-flex items-center">
                <Info className="h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" showArrow={false}>
              After compaction, included artifacts in this list (plan + selected file diffs) are
              attached to your next message so the agent keeps important earlier context.
            </TooltipContent>
          </Tooltip>
        </div>
        <ChevronRight
          className={`text-muted h-3.5 w-3.5 transition-transform duration-200 ${
            collapsed ? "" : "rotate-90"
          }`}
        />
      </button>

      {!collapsed && (
        <div className="mt-2 flex flex-col gap-2">
          {planExists && props.planPath && (
            <>
              <div className={`flex items-center gap-1 ${isPlanExcluded ? "opacity-50" : ""}`}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => void props.onToggleExclusion("plan")}
                      className="text-subtle hover:text-foreground p-0.5 transition-colors"
                      type="button"
                    >
                      {isPlanExcluded ? (
                        <EyeOff className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow={false}>
                    {isPlanExcluded ? "Include in context" : "Exclude from context"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setIsPlanDialogOpen(true)}
                      className={`text-subtle hover:text-foreground flex items-center gap-2 text-left text-xs transition-colors ${isPlanExcluded ? "line-through" : ""}`}
                      type="button"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>Plan file</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow={false}>
                    View plan
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleOpenPlan}
                      className="text-subtle hover:text-foreground p-0.5 transition-colors"
                      type="button"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow={false}>
                    Open in editor
                  </TooltipContent>
                </Tooltip>
              </div>
              <PlanFileDialog
                open={isPlanDialogOpen}
                onOpenChange={setIsPlanDialogOpen}
                workspaceId={props.workspaceId}
              />
            </>
          )}

          {trackedFilesCount > 0 && (
            <div className="flex flex-col">
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // Toggle all files: if any included, exclude all; otherwise include all
                        const shouldExclude = includedFilesCount > 0;
                        void (async () => {
                          for (const file of formattedFiles) {
                            if (shouldExclude !== file.isExcluded) {
                              await props.onToggleExclusion(file.itemId);
                            }
                          }
                        })();
                      }}
                      className="text-subtle hover:text-foreground p-0.5 transition-colors"
                      type="button"
                    >
                      {includedFilesCount === 0 ? (
                        <EyeOff className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow={false}>
                    {includedFilesCount === 0 ? "Include all files" : "Exclude all files"}
                  </TooltipContent>
                </Tooltip>
                <button
                  onClick={() => setFilesExpanded((prev) => !prev)}
                  className="text-subtle hover:text-foreground flex items-center gap-2 text-left text-xs transition-colors"
                  type="button"
                >
                  <ChevronRight
                    className={`h-3 w-3 transition-transform duration-200 ${filesExpanded ? "rotate-90" : ""}`}
                  />
                  <span>
                    {includedFilesCount}/{trackedFilesCount} file diff
                    {trackedFilesCount !== 1 ? "s" : ""}
                  </span>
                </button>
              </div>

              {filesExpanded && formattedFiles.length > 0 && (
                <div className="mt-1 ml-5 flex flex-col gap-0.5">
                  {formattedFiles.map((file) => (
                    <div
                      key={file.fullPath}
                      className={`flex items-center gap-1 ${file.isExcluded ? "opacity-50" : ""}`}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => void props.onToggleExclusion(file.itemId)}
                            className="text-subtle hover:text-foreground p-0.5 transition-colors"
                            type="button"
                          >
                            {file.isExcluded ? (
                              <EyeOff className="h-2.5 w-2.5" />
                            ) : (
                              <Eye className="h-2.5 w-2.5" />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" showArrow={false}>
                          {file.isExcluded ? "Include in context" : "Exclude from context"}
                        </TooltipContent>
                      </Tooltip>
                      <span
                        className={`text-muted text-[10px] ${file.isExcluded ? "line-through" : ""}`}
                      >
                        {file.displayName}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-muted mt-1 text-[10px] italic">
            Keeps agent aligned with your plan and prior edits
          </p>
        </div>
      )}
    </div>
  );
};
