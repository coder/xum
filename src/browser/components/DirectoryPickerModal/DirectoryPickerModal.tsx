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
import { useLiveAPI } from "@/browser/contexts/API";
import { formatKeybind, isMac } from "@/browser/utils/ui/keybinds";
import { getErrorMessage } from "@/common/utils/errors";

const OPEN_KEYBIND = { key: "o", ctrl: true };

/** What a failed listDirectory shows. A missing folder offers to create it. */
function listDirectoryFailure(error: unknown): { error: string; canCreateFolder: boolean } {
  const errorMessage = typeof error === "string" ? error : "Unknown error";
  // Detect "no such file or directory" to offer folder creation
  if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file or directory")) {
    return { error: "Folder doesn't exist.", canCreateFolder: true };
  }
  return { error: `Failed to load directory: ${errorMessage}`, canCreateFolder: false };
}

/**
 * The selected row: its index, and the entry path on it (null for the ".." row). The path keeps
 * the selection on the same directory when the visible entries change (hidden files toggled, or a
 * reconnect reload that lists other directories); the index is the fallback when it is gone.
 */
interface Selection {
  index: number;
  path: string | null;
}

interface DirectoryEntry {
  name: string;
  path: string;
}

/** The row index to show for `selection` among `entries` (row 0 is ".." with a parent). */
function resolveSelectedIndex(
  selection: Selection,
  entries: DirectoryEntry[],
  hasParentEntry: boolean
): number {
  const offset = hasParentEntry ? 1 : 0;
  const found = entries.findIndex((entry) => entry.path === selection.path);
  if (selection.path != null && found !== -1) return found + offset;
  // Fallback: clamp to the new bounds.
  const maxIndex = hasParentEntry ? entries.length : Math.max(entries.length - 1, 0);
  return Math.max(0, Math.min(selection.index, maxIndex));
}

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
  const liveApi = useLiveAPI();
  const [root, setRoot] = useState<FileTreeNode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track if we can offer to create the folder (path doesn't exist)
  const [canCreateFolder, setCanCreateFolder] = useState(false);
  const [pathInput, setPathInput] = useState(initialPath || "");
  // Default off (component stays mounted between opens).
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [selection, setSelection] = useState<Selection>({ index: 0, path: null });
  const treeRef = useRef<HTMLDivElement>(null);
  // The directory shown (set on a successful load only): a reconnect reloads it (#6383). A click
  // while offline loads nothing, so it must not move this.
  const currentPathRef = useRef(initialPath || ".");
  // Whether this open ran its setup, so it runs once per open (#6383): a reconnect (a new client)
  // or a new initialPath while open (Add Project loads its clone default late) must not redo it.
  const isSetUpRef = useRef(false);
  // The client the shown directory was loaded with: a new one reloads it.
  const loadedClientRef = useRef<typeof liveApi>(null);
  // Only the latest load may show its result: a reconnect reload that answers after a later
  // navigation must not move the tree back.
  const loadSeqRef = useRef(0);

  // `keepSelection`: a reload of the same directory, which keeps the typed path and selection.
  const loadDirectory = useCallback(
    async (path: string, keepSelection = false) => {
      const seq = ++loadSeqRef.current;
      if (!liveApi) {
        setError("Not connected to server");
        return;
      }
      setIsLoading(true);
      setError(null);
      setCanCreateFolder(false);

      try {
        const result = await liveApi.general.listDirectory({ path });
        if (seq !== loadSeqRef.current) return;

        if (!result.success) {
          const failure = listDirectoryFailure(result.error);
          setCanCreateFolder(failure.canCreateFolder);
          setError(failure.error);
          setRoot(null);
          return;
        }

        setRoot(result.data);
        currentPathRef.current = result.data.path;
        if (keepSelection) return;
        setPathInput(result.data.path);
        setSelection({ index: 0, path: null });
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        const message = getErrorMessage(err);
        setError(`Failed to load directory: ${message}`);
        setRoot(null);
      } finally {
        if (seq === loadSeqRef.current) setIsLoading(false);
      }
    },
    [liveApi]
  );

  // Sync pathInput with initialPath when modal opens (component stays mounted)
  useEffect(() => {
    if (!isOpen) {
      isSetUpRef.current = false;
      return;
    }
    const isNewClient = loadedClientRef.current !== liveApi;
    loadedClientRef.current = liveApi;
    if (!isSetUpRef.current) {
      isSetUpRef.current = true;
      // Opened offline, the reconnect loads the initial directory.
      currentPathRef.current = initialPath || ".";
      setPathInput(initialPath || "");
      setShowHiddenFiles(false);
      void loadDirectory(initialPath || ".");
      return;
    }
    // A new client (reconnect) while open: reload the shown directory, and keep what the user
    // typed or selected. While offline (no client), keep the shown directory as it is.
    if (isNewClient && liveApi) void loadDirectory(currentPathRef.current, true);
  }, [isOpen, initialPath, liveApi, loadDirectory]);

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
      if (!liveApi) {
        setError("Not connected to server");
        return;
      }
      setIsLoading(true);
      setError(null);
      setCanCreateFolder(false);

      try {
        const result = await liveApi.general.listDirectory({ path: trimmedInput });
        if (!result.success) {
          const failure = listDirectoryFailure(result.error);
          setCanCreateFolder(failure.canCreateFolder);
          setError(failure.error);
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
  }, [onClose, onSelectPath, root, pathInput, liveApi]);

  const handleCreateFolder = useCallback(async () => {
    const trimmedPath = pathInput.trim();
    if (!trimmedPath) return;
    if (!liveApi) {
      setError("Not connected to server");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const createResult = await liveApi.general.createDirectory({ path: trimmedPath });
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
  }, [pathInput, liveApi, loadDirectory]);

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
  const hasParentEntry = Boolean(root?.path);
  const selectedIndex = resolveSelectedIndex(selection, entries, hasParentEntry);
  const handleSelectedIndexChange = (index: number) => {
    const entryIndex = hasParentEntry ? index - 1 : index;
    setSelection({ index, path: entries[entryIndex]?.path ?? null });
  };

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
                // The selection follows its directory (see Selection).
                setShowHiddenFiles(checked === true);
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
            onSelectedIndexChange={handleSelectedIndexChange}
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
