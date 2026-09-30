import React, { useState, useCallback, useEffect, useRef } from "react";
import { GitBranch, Loader2, Check, Copy, Globe, ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";
import { Popover, PopoverContent, PopoverTrigger } from "../Popover/Popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { clearGitStatus, invalidateGitStatus, useGitStatus } from "@/browser/stores/GitStatusStore";
import { createLRUCache } from "@/browser/utils/lruCache";
import {
  BRANCH_CACHE_ENTRY_PREFIX,
  BRANCH_CACHE_INDEX_KEY,
  BRANCH_CACHE_MAX_ENTRIES,
} from "@/common/constants/storage";
import { buildCheckoutCommand, buildRemoteBranchListCommand } from "./branchCommands";
import { repoRootBashOptions } from "@/browser/utils/executeBash";

// LRU cache for persisting branch names across app restarts
const branchCache = createLRUCache<string>({
  entryPrefix: BRANCH_CACHE_ENTRY_PREFIX,
  indexKey: BRANCH_CACHE_INDEX_KEY,
  maxEntries: BRANCH_CACHE_MAX_ENTRIES,
  // No TTL - cached branch info seeds the selector until passive git status refreshes arrive.
});

interface BranchSelectorProps {
  workspaceId: string;
  /** Fallback name to display if not in a git repo (workspace name) */
  workspaceName: string;
  className?: string;
}

// Max branches to fetch
const MAX_LOCAL_BRANCHES = 100;
const MAX_REMOTE_BRANCHES = 50;

interface RemoteState {
  branches: string[];
  isLoading: boolean;
  fetched: boolean;
  truncated: boolean;
}

/**
 * Displays the current git branch with a searchable popover for switching.
 * If not in a git repo, shows the workspace name without interactive features.
 * Remotes appear as expandable groups that lazy-load their branches.
 */
export function BranchSelector({ workspaceId, workspaceName, className }: BranchSelectorProps) {
  const { api } = useAPI();
  // null = branch is not known yet (for example a stopped runtime with no passive git data),
  // false = explicitly confirmed not a git repo, string = current branch.
  // Initialize from localStorage cache for instant display on app restart.
  const [currentBranch, setCurrentBranch] = useState<string | null | false>(() =>
    branchCache.get(workspaceId)
  );
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [localBranchesTruncated, setLocalBranchesTruncated] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteState>>({});
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copyToClipboard } = useCopyToClipboard();

  // Subscribe to GitStatusStore for branch changes detected during periodic refresh
  // (e.g., focus events, file-modifying tools). This keeps the branch selector in sync
  // when the user or mux changes the branch outside of the branch selector UI.
  const gitStatus = useGitStatus(workspaceId);
  const gitStatusBranch = gitStatus?.branch;
  useEffect(() => {
    if (!gitStatusBranch) return;
    setCurrentBranch((prev) => {
      if (prev === gitStatusBranch) return prev;
      branchCache.set(workspaceId, gitStatusBranch);
      return gitStatusBranch;
    });
  }, [gitStatusBranch, workspaceId]);

  // Track if we're refreshing with a cached value (for optimistic UI pulse effect)
  const isRefreshing = currentBranch !== null && currentBranch !== false && isSwitching;

  const fetchLocalBranches = useCallback(async () => {
    if (!api || currentBranch === false) return;

    setIsLoading(true);

    try {
      // Explicit opens are allowed to wake the runtime, so determine whether the
      // workspace is a git repo first and only then load branch/remotes data.
      const repoProbeResult = await api.workspace.executeBash({
        workspaceId,
        // Keep stderr intact here so explicit opens can distinguish a definitive
        // "not a git repository" result from transient runtime/IPC failures.
        script: `git rev-parse --is-inside-work-tree`,
        options: repoRootBashOptions(5),
      });
      const repoProbeOutput =
        repoProbeResult.success && repoProbeResult.data.success
          ? (repoProbeResult.data.output?.trim() ?? "")
          : "";
      let repoProbeError = "";
      if (!repoProbeResult.success) {
        repoProbeError = repoProbeResult.error ?? "";
      } else if (!repoProbeResult.data.success) {
        repoProbeError = `${repoProbeResult.data.error ?? ""}\n${repoProbeResult.data.output ?? ""}`;
      }
      const repoState =
        repoProbeOutput === "true"
          ? "git"
          : /not a git repository/i.test(repoProbeError)
            ? "non-git"
            : "unknown";
      if (repoState === "non-git") {
        branchCache.remove(workspaceId);
        clearGitStatus(workspaceId);
        setCurrentBranch(false);
        setLocalBranches([]);
        setLocalBranchesTruncated(false);
        setRemotes([]);
        return;
      }
      if (repoState !== "git") {
        return;
      }

      // Once we know the repo exists, resolve the active branch with an untruncated
      // command and keep the branch list separately capped for the popover.
      const [currentBranchResult, branchResult, remoteResult] = await Promise.all([
        api.workspace.executeBash({
          workspaceId,
          script: `git branch --show-current 2>/dev/null`,
          options: repoRootBashOptions(5),
        }),
        api.workspace.executeBash({
          workspaceId,
          script: `git branch --sort=-committerdate --format='%(refname:short)' 2>/dev/null | head -${MAX_LOCAL_BRANCHES + 1}`,
          options: repoRootBashOptions(5),
        }),
        api.workspace.executeBash({
          workspaceId,
          script: `git remote 2>/dev/null`,
          options: repoRootBashOptions(5),
        }),
      ]);

      const currentBranchCommandSucceeded =
        currentBranchResult.success && currentBranchResult.data.success;
      const branchCommandSucceeded = branchResult.success && branchResult.data.success;
      const remoteCommandSucceeded = remoteResult.success && remoteResult.data.success;
      const fetchedCurrentBranch =
        currentBranchCommandSucceeded && currentBranchResult.data.output
          ? currentBranchResult.data.output.trim() || null
          : null;
      const branchList =
        branchCommandSucceeded && branchResult.data.output
          ? branchResult.data.output
              .split("\n")
              .map((branchLine) => branchLine.trim())
              .filter((branchLine) => branchLine.length > 0)
          : [];
      const displayBranchList =
        fetchedCurrentBranch && !branchList.includes(fetchedCurrentBranch)
          ? [fetchedCurrentBranch, ...branchList]
          : branchList;
      if (displayBranchList.length > 0) {
        const truncated = displayBranchList.length > MAX_LOCAL_BRANCHES;
        setLocalBranches(
          truncated ? displayBranchList.slice(0, MAX_LOCAL_BRANCHES) : displayBranchList
        );
        setLocalBranchesTruncated(truncated);
      }
      if (fetchedCurrentBranch) {
        setCurrentBranch((prev) => {
          if (prev === fetchedCurrentBranch) return prev;
          branchCache.set(workspaceId, fetchedCurrentBranch);
          return fetchedCurrentBranch;
        });
      }

      const remoteList =
        remoteCommandSucceeded && remoteResult.data.output
          ? remoteResult.data.output
              .split("\n")
              .map((remote) => remote.trim())
              .filter((remote) => remote.length > 0)
          : [];
      setRemotes(remoteList);

      if (
        currentBranchCommandSucceeded &&
        branchCommandSucceeded &&
        remoteCommandSucceeded &&
        !fetchedCurrentBranch &&
        branchList.length === 0 &&
        remoteList.length === 0
      ) {
        setCurrentBranch(false);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [api, workspaceId, currentBranch]);

  const fetchRemoteBranches = useCallback(
    async (remote: string) => {
      if (!api || remoteStates[remote]?.fetched) return;

      setRemoteStates((prev) => ({
        ...prev,
        [remote]: { branches: [], isLoading: true, fetched: false, truncated: false },
      }));

      try {
        // Fetch one extra to detect truncation
        const { command, args } = buildRemoteBranchListCommand(remote, MAX_REMOTE_BRANCHES);
        const result = await api.workspace.executeBash({
          workspaceId,
          script: "",
          command,
          args,
          options: { timeout_secs: 5 },
        });

        if (result.success && result.data.success && result.data.output) {
          // `for-each-ref refs/remotes/<remote>` includes the remote symref (`<remote>`)
          // and may include `<remote>/HEAD`; hide those pseudo-refs from selectable branches.
          const branches = result.data.output
            .split("\n")
            .map((b) => b.trim())
            .filter((b) => b.length > 0 && b !== remote && b !== `${remote}/HEAD`);
          const truncated = branches.length > MAX_REMOTE_BRANCHES;
          setRemoteStates((prev) => ({
            ...prev,
            [remote]: {
              branches: truncated ? branches.slice(0, MAX_REMOTE_BRANCHES) : branches,
              isLoading: false,
              fetched: true,
              truncated,
            },
          }));
        } else {
          setRemoteStates((prev) => ({
            ...prev,
            [remote]: { branches: [], isLoading: false, fetched: true, truncated: false },
          }));
        }
      } catch {
        setRemoteStates((prev) => ({
          ...prev,
          [remote]: { branches: [], isLoading: false, fetched: true, truncated: false },
        }));
      }
    },
    [api, workspaceId, remoteStates]
  );

  const switchBranch = useCallback(
    async (targetBranch: string, isRemote = false) => {
      if (!api) return;

      const checkoutTarget = isRemote ? targetBranch.replace(/^[^/]+\//, "") : targetBranch;

      if (checkoutTarget === currentBranch) {
        setIsOpen(false);
        return;
      }

      setIsSwitching(true);
      setError(null);
      setIsOpen(false);
      // Invalidate git status immediately to prevent stale data flash
      invalidateGitStatus(workspaceId);

      try {
        const { command, args } = buildCheckoutCommand(checkoutTarget);
        const result = await api.workspace.executeBash({
          workspaceId,
          script: "",
          command,
          args,
          options: { timeout_secs: 30 },
        });

        if (!result.success) {
          setError(result.error ?? "Checkout failed");
          // Re-fetch status since checkout failed (restore accurate state)
          invalidateGitStatus(workspaceId);
        } else if (!result.data.success) {
          const errorMsg = result.data.output?.trim() ?? result.data.error ?? "Checkout failed";
          setError(errorMsg);
          // Re-fetch status since checkout failed
          invalidateGitStatus(workspaceId);
        } else {
          // Update current branch on successful checkout
          setCurrentBranch(checkoutTarget);
          // Persist to localStorage for instant display on app restart
          branchCache.set(workspaceId, checkoutTarget);
          // Refresh git status with new branch state
          invalidateGitStatus(workspaceId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Checkout failed");
      } finally {
        setIsSwitching(false);
      }
    },
    [api, workspaceId, currentBranch]
  );

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  useEffect(() => {
    if (isOpen) {
      void fetchLocalBranches();
    }
  }, [isOpen, fetchLocalBranches]);

  useEffect(() => {
    if (!isOpen) {
      setRemoteStates({});
      setExpandedRemotes(new Set());
      setSearch("");
    }
  }, [isOpen]);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when popover opens
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure popover is rendered
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof currentBranch === "string") {
      void copyToClipboard(currentBranch);
    }
  };

  // Display name: actual git branch if available, otherwise workspace name
  const displayName = typeof currentBranch === "string" ? currentBranch : workspaceName;

  const toggleRemote = (remote: string) => {
    setExpandedRemotes((prev) => {
      const next = new Set(prev);
      if (next.has(remote)) {
        next.delete(remote);
      } else {
        next.add(remote);
        // Fetch branches when expanding
        void fetchRemoteBranches(remote);
      }
      return next;
    });
  };

  // Filter branches by search
  const searchLower = search.toLowerCase();
  const filteredLocalBranches = localBranches.filter((b) => b.toLowerCase().includes(searchLower));

  // For remotes, filter branches within each remote
  const getFilteredRemoteBranches = (remote: string) => {
    const state = remoteStates[remote];
    if (!state?.branches) return [];
    return state.branches.filter((b) => b.toLowerCase().includes(searchLower));
  };

  // Check if any remote has matching branches (for showing remotes section)
  const hasMatchingRemoteBranches = remotes.some((remote) => {
    const state = remoteStates[remote];
    if (!state?.fetched) return true; // Show unfetched remotes
    return getFilteredRemoteBranches(remote).length > 0;
  });

  // Non-git repo: just show workspace name, no interactive features
  if (currentBranch === false) {
    return (
      <div className={cn("group flex items-center gap-0.5", className)}>
        <div className="text-muted-light flex max-w-[180px] min-w-0 items-center gap-1 px-1 py-0.5 font-mono text-[11px]">
          <span className="truncate">{workspaceName}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group flex items-center gap-0.5", className)}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <button
            disabled={isSwitching}
            className={cn(
              "text-muted-light hover:bg-hover hover:text-foreground flex min-w-0 max-w-[180px] items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] transition-colors",
              isRefreshing && "animate-pulse" // Show pulse during switch instead of replacing content
            )}
          >
            <GitBranch className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate">{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[220px] p-0">
          {/* Search input */}
          <div className="border-border border-b px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search branches..."
              className="text-foreground placeholder:text-muted w-full bg-transparent font-mono text-[11px] outline-none"
            />
          </div>

          <div className="max-h-[280px] overflow-y-auto p-1">
            {/* Remotes as expandable groups */}
            {remotes.length > 0 && hasMatchingRemoteBranches && (
              <>
                {remotes.map((remote) => {
                  const state = remoteStates[remote];
                  const isExpanded = expandedRemotes.has(remote);
                  const isRemoteLoading = state?.isLoading ?? false;
                  const remoteBranches = getFilteredRemoteBranches(remote);

                  // Hide remote if fetched and no matching branches
                  if (state?.fetched && remoteBranches.length === 0 && search) {
                    return null;
                  }

                  return (
                    <div key={remote}>
                      <button
                        onClick={() => toggleRemote(remote)}
                        className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                      >
                        <ChevronRight
                          className={cn(
                            "text-muted h-3 w-3 shrink-0 transition-transform",
                            isExpanded && "rotate-90"
                          )}
                        />
                        <Globe className="text-muted h-3 w-3 shrink-0" />
                        <span>{remote}</span>
                      </button>

                      {isExpanded && (
                        <div className="ml-3">
                          {isRemoteLoading ? (
                            <div className="text-muted flex items-center justify-center py-2">
                              <Loader2 className="h-3 w-3 animate-spin" />
                            </div>
                          ) : remoteBranches.length === 0 ? (
                            <div className="text-muted py-1.5 pl-2 text-[10px]">No branches</div>
                          ) : (
                            <>
                              {remoteBranches.map((branch) => {
                                const displayName = branch.replace(`${remote}/`, "");
                                return (
                                  <button
                                    key={branch}
                                    onClick={() => void switchBranch(branch, true)}
                                    className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                                  >
                                    <Check
                                      className={cn(
                                        "h-3 w-3 shrink-0",
                                        displayName === currentBranch ? "opacity-100" : "opacity-0"
                                      )}
                                    />
                                    <span className="truncate">{displayName}</span>
                                  </button>
                                );
                              })}
                              {state?.truncated && !search && (
                                <div className="text-muted px-2 py-1 text-[10px] italic">
                                  +more branches (use search)
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {filteredLocalBranches.length > 0 && <div className="bg-border my-1 h-px" />}
              </>
            )}

            {/* Local branches */}
            {isLoading && localBranches.length <= 1 ? (
              <div className="text-muted flex items-center justify-center py-2">
                <Loader2 className="h-3 w-3 animate-spin" />
              </div>
            ) : filteredLocalBranches.length === 0 ? (
              <div className="text-muted py-2 text-center text-[10px]">No matching branches</div>
            ) : (
              <>
                {filteredLocalBranches.map((branch) => (
                  <button
                    key={branch}
                    onClick={() => void switchBranch(branch)}
                    className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                  >
                    <Check
                      className={cn(
                        "h-3 w-3 shrink-0",
                        branch === currentBranch ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{branch}</span>
                  </button>
                ))}
                {localBranchesTruncated && !search && (
                  <div className="text-muted px-2 py-1 text-[10px] italic">
                    +more branches (use search)
                  </div>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Copy button - only show on hover once the real branch name is known. */}
      {typeof currentBranch === "string" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleCopy}
              className="text-muted hover:text-foreground flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Copy branch name"
            >
              {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{copied ? "Copied!" : "Copy branch name"}</TooltipContent>
        </Tooltip>
      )}

      {error && <span className="text-danger-soft truncate text-[10px]">{error}</span>}
    </div>
  );
}
