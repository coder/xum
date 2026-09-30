/**
 * FileTree - Displays file hierarchy with diff statistics
 */

import React from "react";
import { extractNewPath, type FileTreeNode } from "@/common/utils/git/numstatParser";
import type { FileChangeType } from "@/common/types/review";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { trimRecordToChars, withRecordEntry } from "@/browser/utils/boundedPersistedValue";
import {
  getFileTreeExpandStateKey,
  REVIEW_FILE_TREE_VIEW_MODE_KEY,
  FILE_TREE_EXPAND_STATE_MAX_CHARS,
} from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import { ToggleGroup, type ToggleOption } from "@/browser/components/ToggleGroup/ToggleGroup";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipIfPresent,
} from "@/browser/components/Tooltip/Tooltip";
import { FileIcon } from "@/browser/components/FileIcon/FileIcon";

/**
 * Compute read status for a directory by recursively checking all descendant files
 * Returns "fully-read" if all files are fully read, "unknown" if any file has unknown status, null otherwise
 */
function computeDirectoryReadStatus(
  node: FileTreeNode,
  getFileReadStatus?: (filePath: string) => { total: number; read: number } | null
): "fully-read" | "unknown" | null {
  if (!node.isDirectory || !getFileReadStatus) return null;

  let hasUnknown = false;
  let fileCount = 0;
  let fullyReadCount = 0;

  const checkNode = (n: FileTreeNode) => {
    if (n.isDirectory) {
      // Recurse into children
      n.children.forEach(checkNode);
    } else {
      // Check file status
      fileCount++;
      const status = getFileReadStatus(extractNewPath(n.path));
      if (status === null) {
        // Some diff entries (renames, binary changes, mode-only edits) have no hunks.
        // Only treat this as "unknown" when numstat indicates there's actual +/− content.
        if ((n.stats?.additions ?? 0) > 0 || (n.stats?.deletions ?? 0) > 0) {
          hasUnknown = true;
        }
      } else if (status.read === status.total && status.total > 0) {
        fullyReadCount++;
      }
    }
  };

  checkNode(node);

  // If any file has unknown state, directory is unknown
  if (hasUnknown) return "unknown";

  // If all files are fully read, directory is fully read
  if (fileCount > 0 && fullyReadCount === fileCount) return "fully-read";

  // Otherwise, directory has partial/no read state
  return null;
}

function getFileChangeBadge(
  changeType: FileChangeType,
  oldPath?: string
): {
  label: string;
  className: string;
  title: string;
} {
  switch (changeType) {
    case "added":
      return { label: "A", className: "text-success-light", title: "Added" };
    case "deleted":
      return { label: "D", className: "text-danger", title: "Deleted" };
    case "renamed":
      return {
        label: "R",
        className: "text-muted",
        title: oldPath ? `Renamed from ${oldPath}` : "Renamed",
      };
    case "modified":
      return {
        label: "M",
        className: "text-warning-light",
        title: "Modified",
      };
  }
}

type FileTreeViewMode = "structured" | "flat";

type FileLabelMode = "name" | "path";

const FILE_TREE_VIEW_MODE_OPTIONS: Array<ToggleOption<FileTreeViewMode>> = [
  { value: "structured", label: "Structured" },
  { value: "flat", label: "Flat" },
];

function collectLeafFileNodes(node: FileTreeNode): FileTreeNode[] {
  if (!node.isDirectory) {
    return [node];
  }

  const files: FileTreeNode[] = [];
  for (const child of node.children) {
    files.push(...collectLeafFileNodes(child));
  }
  return files;
}

const TreeNodeContent: React.FC<{
  node: FileTreeNode;
  depth: number;
  fileLabelMode?: FileLabelMode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  getFileReadStatus?: (filePath: string) => { total: number; read: number } | null;
  expandStateMap: Record<string, boolean>;
  setExpandStateMap: (
    value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)
  ) => void;
}> = ({
  node,
  depth,
  fileLabelMode = "name",
  selectedPath,
  onSelectFile,
  getFileReadStatus,
  expandStateMap,
  setExpandStateMap,
}) => {
  // Check if user has manually set expand state for this directory
  const hasManualState = node.path in expandStateMap;
  const isOpen = hasManualState ? expandStateMap[node.path] : depth < 2; // Default: auto-expand first 2 levels

  const setIsOpen = (open: boolean) => {
    // Store only overrides of the default expansion, newest last, so FileTree can persist the
    // newest ones that fit the key budget. The live map itself is not trimmed.
    setExpandStateMap((prev) =>
      withRecordEntry(prev, node.path, open === depth < 2 ? undefined : open, Infinity)
    );
  };

  const handleClick = (e: React.MouseEvent) => {
    if (node.isDirectory) {
      // Check if clicked on the toggle icon area (first 20px)
      const target = e.target as HTMLElement;
      const isToggleClick = target.closest("[data-toggle]");

      if (isToggleClick) {
        // Just toggle expansion
        setIsOpen(!isOpen);
      } else {
        // Clicking on folder name/stats selects the folder for filtering
        // Use full path (with prefix) for selection
        onSelectFile(selectedPath === node.path ? null : node.path);
      }
    } else {
      // Toggle selection: if already selected, clear filter
      // Use full path (with prefix) for selection
      onSelectFile(selectedPath === node.path ? null : node.path);
    }
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const canonicalFilePath = node.isDirectory ? node.path : extractNewPath(node.path);
  const fallbackFileName = canonicalFilePath.split("/").pop() ?? "";
  const fileDirPath = canonicalFilePath.split("/").slice(0, -1).join("/");
  const fileNameForIcon = fallbackFileName;
  const isSelected = selectedPath === node.path;

  const changeType = !node.isDirectory ? (node.stats?.changeType ?? "modified") : null;
  const isDeletedFile = changeType === "deleted";
  const isRenamedFile = changeType === "renamed" && !!node.stats?.oldPath;
  const oldFileName = node.stats?.oldPath?.split("/").pop() ?? node.stats?.oldPath ?? "";
  const shouldShowRenameArrow = isRenamedFile && oldFileName !== fallbackFileName;

  // Compute read status for files and directories
  let isFullyRead = false;
  let isUnknownState = false;

  if (node.isDirectory) {
    const dirStatus = computeDirectoryReadStatus(node, getFileReadStatus);
    isFullyRead = dirStatus === "fully-read";
    isUnknownState = dirStatus === "unknown";
  } else if (getFileReadStatus) {
    const readStatus = getFileReadStatus(canonicalFilePath);
    isFullyRead = readStatus ? readStatus.read === readStatus.total && readStatus.total > 0 : false;

    // Some diff entries (renames, binary changes, mode-only edits) have no hunks.
    // Only treat this as "unknown" when numstat indicates there's actual +/− content.
    isUnknownState =
      readStatus === null && ((node.stats?.additions ?? 0) > 0 || (node.stats?.deletions ?? 0) > 0);
  }

  const iconOpacity = isFullyRead ? 0.45 : isUnknownState && !isFullyRead ? 0.7 : 1;

  const fileChangeBadge =
    !node.isDirectory && node.stats
      ? getFileChangeBadge(node.stats.changeType ?? "modified", node.stats.oldPath)
      : null;

  const fileLabelTitle =
    !node.isDirectory && fileLabelMode === "path"
      ? isRenamedFile
        ? `${node.stats?.oldPath ?? ""} -> ${canonicalFilePath}`
        : canonicalFilePath
      : undefined;

  return (
    <>
      <div
        className={cn(
          "cursor-pointer select-none flex items-center gap-1.5 rounded py-0.5 px-1.5",
          isSelected ? "bg-code-keyword-overlay" : "bg-transparent hover:bg-white/5"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClick}
      >
        {node.isDirectory ? (
          <>
            <span
              className="text-muted inline-flex h-3 w-3 shrink-0 items-center justify-center text-[8px] transition-transform duration-200"
              style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}
              data-toggle
              onClick={handleToggleClick}
            >
              ▶
            </span>
            <span
              className={cn(
                "flex-1",
                isFullyRead &&
                  "text-dim line-through [text-decoration-color:var(--color-read)] [text-decoration-thickness:2px]",
                isUnknownState && !isFullyRead && "text-dim",
                !isFullyRead && !isUnknownState && "text-muted"
              )}
            >
              {node.name || "/"}
            </span>
            {node.totalStats &&
              (node.totalStats.additions > 0 || node.totalStats.deletions > 0) && (
                <span
                  className="flex gap-2 text-[11px] opacity-70"
                  style={{ color: isOpen ? "var(--color-dim)" : "inherit" }}
                >
                  {node.totalStats.additions > 0 &&
                    (isOpen ? (
                      <span>+{node.totalStats.additions}</span>
                    ) : (
                      <span className="text-success-light">+{node.totalStats.additions}</span>
                    ))}
                  {node.totalStats.deletions > 0 &&
                    (isOpen ? (
                      <span>-{node.totalStats.deletions}</span>
                    ) : (
                      <span className="text-warning-light">-{node.totalStats.deletions}</span>
                    ))}
                </span>
              )}
          </>
        ) : (
          <>
            <FileIcon
              fileName={fileNameForIcon}
              filePath={node.path}
              className="shrink-0"
              style={{ opacity: iconOpacity }}
            />
            <TooltipIfPresent tooltip={fileLabelTitle} side="top" align="start">
              <span
                className={cn(
                  "flex-1",
                  fileLabelMode === "path" && "min-w-0",
                  isDeletedFile && "line-through",
                  isFullyRead &&
                    "text-dim line-through [text-decoration-color:var(--color-read)] [text-decoration-thickness:2px]",
                  isUnknownState && !isFullyRead && "text-dim",
                  !isFullyRead && !isUnknownState && "text-foreground"
                )}
              >
                {fileLabelMode === "path" ? (
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className={cn("min-w-0 truncate", fileDirPath && "max-w-[60%]")}>
                      {shouldShowRenameArrow ? (
                        <>
                          <span className="text-muted">{oldFileName}</span>
                          <span className="text-muted">{" -> "}</span>
                          <span>{fallbackFileName}</span>
                        </>
                      ) : (
                        fallbackFileName
                      )}
                    </span>
                    {fileDirPath ? (
                      <span className="text-muted min-w-0 flex-1 truncate">{fileDirPath}</span>
                    ) : null}
                  </span>
                ) : shouldShowRenameArrow ? (
                  <>
                    <span className="text-muted">{oldFileName}</span>
                    <span className="text-muted">{" -> "}</span>
                    <span>{fallbackFileName}</span>
                  </>
                ) : (
                  node.name
                )}
              </span>
            </TooltipIfPresent>
            <span className="ml-auto flex items-center gap-2 text-[11px]">
              {node.stats?.additions ? (
                <span className="text-success-light">+{node.stats.additions}</span>
              ) : null}
              {node.stats?.deletions ? (
                <span className="text-warning-light">-{node.stats.deletions}</span>
              ) : null}
              {fileChangeBadge ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn("shrink-0 font-semibold", fileChangeBadge.className)}
                      style={{ opacity: iconOpacity }}
                    >
                      {fileChangeBadge.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left" align="center">
                    {fileChangeBadge.title}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          </>
        )}
      </div>

      {node.isDirectory &&
        isOpen &&
        node.children.map((child) => (
          <TreeNodeContent
            key={child.path}
            node={child}
            depth={depth + 1}
            fileLabelMode={fileLabelMode}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            getFileReadStatus={getFileReadStatus}
            expandStateMap={expandStateMap}
            setExpandStateMap={setExpandStateMap}
          />
        ))}
    </>
  );
};

interface FileTreeExternalProps {
  root: FileTreeNode | null;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  isLoading?: boolean;
  getFileReadStatus?: (filePath: string) => { total: number; read: number } | null;
  workspaceId: string;
}

export const FileTree: React.FC<FileTreeExternalProps> = ({
  root,
  selectedPath,
  onSelectFile,
  isLoading = false,
  getFileReadStatus,
  workspaceId,
}) => {
  // Use persisted state for expand/collapse per workspace (lifted to parent to avoid O(n) re-renders).
  // The live map keeps every toggle of this session; the persisted copy keeps the newest overrides
  // that fit the key budget, so a large tree never collapses directories on its own while in use,
  // and a reload restores the most recent ones.
  const expandStateKey = getFileTreeExpandStateKey(workspaceId);
  const [persistedExpandStateMap, setPersistedExpandStateMap] = usePersistedState<
    Record<string, boolean>
  >(expandStateKey, {}, { listener: true });
  // `persisted` is the trimmed copy this window wrote; once the stored value differs (another
  // window changed it), the stored value wins again so cross-window updates are not masked.
  const [liveExpandState, setLiveExpandState] = React.useState<{
    key: string;
    value: Record<string, boolean>;
    persisted: string;
  } | null>(null);
  const expandStateMap =
    liveExpandState?.key === expandStateKey &&
    liveExpandState.persisted === JSON.stringify(persistedExpandStateMap)
      ? liveExpandState.value
      : persistedExpandStateMap;
  const setExpandStateMap = (
    value: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)
  ) => {
    const next = typeof value === "function" ? value(expandStateMap) : value;
    const persisted = trimRecordToChars(next, FILE_TREE_EXPAND_STATE_MAX_CHARS);
    setLiveExpandState({ key: expandStateKey, value: next, persisted: JSON.stringify(persisted) });
    setPersistedExpandStateMap(persisted);
  };

  const [viewMode, setViewMode] = usePersistedState<FileTreeViewMode>(
    REVIEW_FILE_TREE_VIEW_MODE_KEY,
    "structured",
    { listener: true }
  );

  // Extract display name for filter indicator
  const filterDisplayName = selectedPath ? (selectedPath.split("/").pop() ?? selectedPath) : null;

  return (
    <>
      <div className="border-border-light text-muted font-primary flex items-center gap-2 border-b px-2 py-1 text-[11px]">
        <span>Files</span>
        <div className="ml-auto flex items-center gap-2">
          <div data-testid="review-file-tree-view-mode">
            <ToggleGroup
              options={FILE_TREE_VIEW_MODE_OPTIONS}
              value={viewMode}
              onChange={(mode) => setViewMode(mode)}
            />
          </div>
          {selectedPath && (
            <TooltipIfPresent
              tooltip={`Filtering: ${selectedPath}\nClick to clear`}
              side="bottom"
              align="end"
            >
              <button
                className="bg-code-keyword-overlay text-foreground hover:bg-code-keyword-overlay/80 flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors"
                onClick={() => onSelectFile(null)}
              >
                <span className="max-w-[120px] truncate">{filterDisplayName}</span>
                <span className="text-muted">✕</span>
              </button>
            </TooltipIfPresent>
          )}
        </div>
      </div>
      <div
        className="font-monospace min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-1 text-[11px]"
        data-testid="review-file-tree"
      >
        {isLoading && !root ? (
          <div className="text-muted py-5 text-center">Loading file tree...</div>
        ) : root ? (
          viewMode === "flat" ? (
            collectLeafFileNodes(root).map((fileNode) => (
              <TreeNodeContent
                key={fileNode.path}
                node={fileNode}
                depth={0}
                fileLabelMode="path"
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                getFileReadStatus={getFileReadStatus}
                expandStateMap={expandStateMap}
                setExpandStateMap={setExpandStateMap}
              />
            ))
          ) : (
            root.children.map((child) => (
              <TreeNodeContent
                key={child.path}
                node={child}
                depth={0}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                getFileReadStatus={getFileReadStatus}
                expandStateMap={expandStateMap}
                setExpandStateMap={setExpandStateMap}
              />
            ))
          )
        ) : (
          <div className="text-muted py-5 text-center">No files changed</div>
        )}
      </div>
    </>
  );
};
