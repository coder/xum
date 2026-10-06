/**
 * BaseSelectorPopover - Dropdown for selecting diff base (similar to BranchSelector)
 *
 * Uses conditional rendering (not Radix Portal) to enable testing in happy-dom.
 * Pattern follows AgentModePicker.
 */

import React, { useState, useRef, useEffect } from "react";
import { Check } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { useOptionalAPI } from "@/browser/contexts/API";
import { runWithCatch } from "@/browser/utils/compilerSafeControlFlow";
import { listExistingRevisions } from "./reviewBaseRefs";

const BASE_SUGGESTIONS = [
  "HEAD",
  "--staged",
  "main",
  "origin/main",
  "HEAD~1",
  "HEAD~2",
  "develop",
  "origin/develop",
] as const;

/** Not a revision (it diffs the index), so it needs no existence check. */
const STAGED_SUGGESTION = "--staged";

interface BaseSelectorPopoverProps {
  value: string;
  /**
   * When set, the list offers only suggestions that exist in this workspace's repository
   * (#5682: a repo without `origin` was offered `origin/main`). Typed bases still go through.
   */
  workspaceId?: string;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  "data-testid"?: string;
}

export function BaseSelectorPopover({
  value,
  workspaceId,
  onChange,
  onOpenChange,
  className,
  "data-testid": testId,
}: BaseSelectorPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const apiState = useOptionalAPI();
  const api = apiState?.api ?? null;
  // Suggestions confirmed to exist, keyed by workspace. `refs: null` means the check failed.
  const [existing, setExisting] = useState<{
    workspaceId: string;
    refs: Set<string> | null;
  } | null>(null);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    onOpenChange?.(open);
  };

  // Sync input with external value changes
  useEffect(() => {
    setInputValue(value);
  }, [value]);

  // Clear search and focus input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setInputValue(""); // Clear to show all suggestions
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Re-check on every open: refs come and go (fetches, new remotes, new commits).
  useEffect(() => {
    if (!isOpen || workspaceId == null || api == null) return;
    let cancelled = false;
    const candidates = BASE_SUGGESTIONS.filter((s) => s !== STAGED_SUGGESTION);
    void runWithCatch(
      async () => {
        const refs = await listExistingRevisions(api, workspaceId, candidates);
        if (!cancelled) setExisting({ workspaceId, refs });
      },
      () => {
        if (!cancelled) setExisting({ workspaceId, refs: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspaceId, api]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        onOpenChange?.(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onOpenChange]);

  const handleSelect = (selected: string) => {
    onChange(selected);
    setInputValue(selected);
    handleOpenChange(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const trimmed = inputValue.trim();
      if (trimmed) {
        onChange(trimmed);
        handleOpenChange(false);
      }
    } else if (e.key === "Escape") {
      setInputValue(value);
      handleOpenChange(false);
    }
  };

  // Filter suggestions based on input
  const searchLower = inputValue.toLowerCase();
  // Before the first check answers, offer only --staged rather than refs that may not exist.
  // When the check cannot run (no API, or it failed), offer the full list as before.
  const checked = existing?.workspaceId === workspaceId ? existing : null;
  const canCheck = workspaceId != null && api != null;
  const isAvailable = (suggestion: string): boolean => {
    if (suggestion === STAGED_SUGGESTION || !canCheck) return true;
    if (checked == null) return false;
    return checked.refs == null || checked.refs.has(suggestion);
  };
  const filteredSuggestions = BASE_SUGGESTIONS.filter(
    (s) => s.toLowerCase().includes(searchLower) && isAvailable(s)
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        className={cn(
          "text-muted-light hover:bg-hover hover:text-foreground flex items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] transition-colors",
          className
        )}
        data-testid={testId}
        onClick={() => handleOpenChange(!isOpen)}
        aria-expanded={isOpen}
      >
        <span className="truncate">{value}</span>
      </button>

      {isOpen && (
        <div className="bg-dark border-border absolute top-full left-0 z-[10001] mt-1 w-[160px] overflow-hidden rounded-md border shadow-md">
          {/* Search/edit input */}
          <div className="border-border border-b px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Enter base..."
              className="text-foreground placeholder:text-muted w-full bg-transparent font-mono text-[11px] outline-none"
            />
          </div>

          <div className="max-h-[200px] overflow-y-auto p-1">
            {filteredSuggestions.length === 0 ? (
              <div className="text-muted py-2 text-center text-[10px]">
                Press Enter to use &ldquo;{inputValue}&rdquo;
              </div>
            ) : (
              filteredSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  data-testid={`base-suggestion-${suggestion}`}
                  onMouseDown={(e) => e.preventDefault()} // Prevent input blur before click
                  onClick={() => handleSelect(suggestion)}
                  className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                >
                  <Check
                    className={cn(
                      "h-3 w-3 shrink-0",
                      suggestion === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{suggestion}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
