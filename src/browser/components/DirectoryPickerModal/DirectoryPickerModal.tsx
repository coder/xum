import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/Dialog/Dialog";
import { Button } from "@/browser/components/Button/Button";
import { Checkbox } from "../Checkbox/Checkbox";
import { Input } from "@/browser/components/Input/Input";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { DirectoryTree } from "../DirectoryTree/DirectoryTree";
import { useAPI } from "@/browser/contexts/API";
import { formatKeybind, isMac } from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";

const OPEN_KEYBIND = { key: "o", ctrl: true };

interface DirectoryPickerModalProps {
  isOpen: boolean;
  initialPath: string;
  onClose: () => void;
  onSelectPath: (path: string) => void;
}

export const DirectoryPickerModal: React.FC<DirectoryPickerModalProps> = ({
  isOpen,
  initialPath,
  onClose,
  onSelectPath,
}) => {
  const { api } = useAPI();
  const [root, setRoot] = useState<FileTreeNode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track if we can offer to create the folder (path doesn't exist)
  const [canCreateFolder, setCanCreateFolder] = useState(false);
  const [pathInput, setPathInput] = useState(initialPath || "");
  // Default off (component stays mounted between opens).
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!api) {
        setError("Not connected to server");
        return;
      }
      setIsLoading(true);
      setError(null);
      setCanCreateFolder(false);

      try {
        const result = await api.general.listDirectory({ path });

        if (!result.success) {
          const errorMessage = typeof result.error === "string" ? result.error : "Unknown error";
          // Detect "no such file or directory" to offer folder creation
          const isNotFound =
            errorMessage.includes("ENOENT") || errorMessage.includes("no such file or directory");
          if (isNotFound) {
            setCanCreateFolder(true);
            setError("Folder doesn't exist.");
          } else {
            setError(`Failed to load directory: ${errorMessage}`);
          }
          setRoot(null);
          return;
        }

        setRoot(result.data);
        setPathInput(result.data.path);
        setSelectedIndex(0);
      } catch (err) {
        const message = getErrorMessage(err);
        setError(`Failed to load directory: ${message}`);
        setRoot(null);
      } finally {
        setIsLoading(false);
      }
    },
    [api]
  );

  // Sync pathInput with initialPath when modal opens (component stays mounted)
  useEffect(() => {
    if (!isOpen) return;
    setPathInput(initialPath || "");
    setShowHiddenFiles(false);
    void loadDirectory(initialPath || ".");
  }, [isOpen, initialPath, loadDirectory]);

  const handleNavigateTo = useCallback(
    (path: string) => {
      void loadDirectory(path);
    },
    [loadDirectory]
  );

  const handleNavigateParent = useCallback(() => {
    if (!root) return;
    void loadDirectory(`${root.path}/..`);
  }, [loadDirectory, root]);

  const handleConfirm = useCallback(async () => {
    const trimmedInput = pathInput.trim();

    // If user has typed a different path, try to load it first
    if (trimmedInput && trimmedInput !== root?.path) {
      if (!api) return;
      setIsLoading(true);
      setError(null);
      setCanCreateFolder(false);

      try {
        const result = await api.general.listDirectory({ path: trimmedInput });
        if (!result.success) {
          const errorMessage = typeof result.error === "string" ? result.error : "Unknown error";
          const isNotFound =
            errorMessage.includes("ENOENT") || errorMessage.includes("no such file or directory");
          if (isNotFound) {
            setCanCreateFolder(true);
            setError("Folder doesn't exist.");
          } else {
            setError(`Failed to load directory: ${errorMessage}`);
          }
          setRoot(null);
          return;
        }
        // Success - select this path
        onSelectPath(result.data.path);
        onClose();
      } catch (err) {
        const message = getErrorMessage(err);
        setError(`Failed to load directory: ${message}`);
        setRoot(null);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Otherwise use the current root
    if (!root) {
      return;
    }

    onSelectPath(root.path);
    onClose();
  }, [onClose, onSelectPath, root, pathInput, api]);

  const handleCreateFolder = useCallback(async () => {
    const trimmedPath = pathInput.trim();
    if (!trimmedPath || !api) return;

    setIsLoading(true);
    setError(null);

    try {
      const createResult = await api.general.createDirectory({ path: trimmedPath });
      if (!createResult.success) {
        setError(createResult.error ?? "Failed to create folder");
        setCanCreateFolder(false);
        return;
      }
      // Folder created - now navigate to it
      setCanCreateFolder(false);
      void loadDirectory(createResult.data.normalizedPath);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      setError(`Failed to create folder: ${errorMessage}`);
      setCanCreateFolder(false);
    } finally {
      setIsLoading(false);
    }
  }, [pathInput, api, loadDirectory]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isLoading) {
        onClose();
      }
    },
    [isLoading, onClose]
  );

  const handlePathInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void loadDirectory(pathInput);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        // Focus the tree and start navigation
        const treeContainer = treeRef.current?.querySelector("[tabindex]");
        if (treeContainer instanceof HTMLElement) {
          treeContainer.focus();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        if (!isLoading && root) {
          void handleConfirm();
        }
      }
    },
    [pathInput, loadDirectory, handleConfirm, isLoading, root]
  );

  const entries =
    root?.children
      .filter((child) => child.isDirectory)
      .filter((child) => showHiddenFiles || !child.name.startsWith("."))
      .map((child) => ({ name: child.name, path: child.path })) ?? [];

  const shortcutLabel = isMac() ? "⌘O" : formatKeybind(OPEN_KEYBIND);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Select Project Directory</DialogTitle>
          <DialogDescription>Navigate to select a directory for your project</DialogDescription>
        </DialogHeader>
        <div className="mb-3">
          <Input
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value);
              setCanCreateFolder(false);
            }}
            onKeyDown={handlePathInputKeyDown}
            placeholder="Enter path..."
            className="bg-modal-bg border-border-medium h-9 font-mono text-sm"
          />
        </div>
        <div className="mb-3 flex items-center">
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={showHiddenFiles}
              onCheckedChange={(checked) => {
                const nextShowHiddenFiles = checked === true;
                setShowHiddenFiles(nextShowHiddenFiles);

                // Preserve selection when possible. If hidden entries are inserted/removed ahead
                // of the current selection, keeping the same raw index can jump to the wrong row.
                setSelectedIndex((prev) => {
                  if (!root) return 0;

                  const hasParentEntry = Boolean(root.path);
                  if (hasParentEntry && prev === 0) return 0;

                  const previousVisibleEntries = root.children
                    .filter((child) => child.isDirectory)
                    .filter((child) => showHiddenFiles || !child.name.startsWith("."));

                  const selectedEntryIndex = hasParentEntry ? prev - 1 : prev;
                  const selectedEntryPath = previousVisibleEntries[selectedEntryIndex]?.path;

                  const nextVisibleEntries = root.children
                    .filter((child) => child.isDirectory)
                    .filter((child) => nextShowHiddenFiles || !child.name.startsWith("."));

                  if (selectedEntryPath) {
                    const nextEntryIndex = nextVisibleEntries.findIndex(
                      (child) => child.path === selectedEntryPath
                    );
                    if (nextEntryIndex !== -1) {
                      return hasParentEntry ? nextEntryIndex + 1 : nextEntryIndex;
                    }
                  }

                  // Fallback: clamp to the new bounds.
                  const maxIndex = hasParentEntry
                    ? nextVisibleEntries.length
                    : Math.max(nextVisibleEntries.length - 1, 0);
                  return Math.max(0, Math.min(prev, maxIndex));
                });
              }}
            />
            Show hidden files
          </label>
        </div>
        {error && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className={canCreateFolder ? "text-muted" : "text-error"}>{error}</span>
            {canCreateFolder && (
              <Button
                size="sm"
                onClick={() => void handleCreateFolder()}
                disabled={isLoading}
                className="h-6 px-2 py-0 text-xs"
              >
                Create Folder
              </Button>
            )}
          </div>
        )}
        <div
          ref={treeRef}
          className="bg-modal-bg border-border-medium mb-4 h-80 overflow-hidden rounded border"
        >
          <DirectoryTree
            currentPath={root ? root.path : null}
            entries={entries}
            isLoading={isLoading}
            onNavigateTo={handleNavigateTo}
            onNavigateParent={handleNavigateParent}
            onConfirm={() => void handleConfirm()}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={isLoading || !root}
            title={`Open folder (${shortcutLabel})`}
          >
            Open ({shortcutLabel})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
