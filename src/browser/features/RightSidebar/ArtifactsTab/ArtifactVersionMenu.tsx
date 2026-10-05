import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Pin } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { cn } from "@/common/lib/utils";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { ArtifactShelfScope, ArtifactVersion } from "@/common/orpc/schemas/artifacts";

/** Label for a stored version: its publish title, or a plain name for turn-end snapshots. */
function versionLabel(version: ArtifactVersion): string {
  if (version.label != null && version.label.length > 0) return version.label;
  return version.source === "turn-end" ? "Turn snapshot" : "Untitled";
}

/**
 * Toolbar version menu ("v<N>"): "Latest (live)" follows the working file, every other entry
 * shows a stored version. Rendered inline (not through a Radix portal) so it opens in
 * happy-dom tests and inside the panel's fullscreen overlay alike.
 */
export function ArtifactVersionMenu(props: {
  /** Newest first; the caller hides the menu when there are none. */
  versions: readonly ArtifactVersion[];
  /** null = Latest (live). */
  selectedVersion: number | null;
  onSelect: (version: number | null) => void;
  /**
   * Shelf pins (M5c): copy the shown version, or the newest stored one while on "Latest", to a
   * shelf. Omitted hides the pin entries.
   */
  onPin?: (scope: ArtifactShelfScope) => void;
  /** False in multi-project workspaces, which have no project shelf. */
  projectShelfAvailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Close when clicking anywhere outside the trigger and its list.
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Keyboard users land on the checked entry when the list opens.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const choose = (version: number | null) => {
    setOpen(false);
    triggerRef.current?.focus();
    props.onSelect(version);
  };

  const pin = (scope: ArtifactShelfScope) => {
    setOpen(false);
    triggerRef.current?.focus();
    props.onPin?.(scope);
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Closing the menu must not also exit fullscreen or interrupt the stream.
      event.preventDefault();
      stopKeyboardPropagation(event);
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ??
        []
    );
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[Math.min(Math.max(next, 0), items.length - 1)]?.focus();
  };

  const triggerText = props.selectedVersion == null ? "Live" : `v${props.selectedVersion}`;
  const itemClassName =
    "hover:bg-hover focus:bg-hover flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none";

  return (
    <div ref={containerRef} className="relative shrink-0">
      <TooltipIfPresent tooltip="Version">
        <button
          ref={triggerRef}
          type="button"
          aria-label={`Version: ${props.selectedVersion == null ? "Latest (live)" : triggerText}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="border-border-light text-muted hover:text-foreground bg-background focus-visible:ring-accent flex h-6 items-center gap-0.5 rounded border pr-1 pl-1.5 text-[11px] focus-visible:ring-1"
        >
          <span className="counter-nums">{triggerText}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </TooltipIfPresent>
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label="Artifact versions"
          onKeyDown={handleListKeyDown}
          className="bg-dark border-border text-foreground absolute top-full right-0 z-[1600] mt-1 max-h-72 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.selectedVersion == null}
            onClick={() => choose(null)}
            className={itemClassName}
          >
            <MenuCheck checked={props.selectedVersion == null} />
            <span className="min-w-0 flex-1 truncate">Latest (live)</span>
          </button>
          {props.versions.map((version) => {
            const checked = props.selectedVersion === version.version;
            return (
              <button
                key={version.version}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => choose(version.version)}
                className={itemClassName}
              >
                <MenuCheck checked={checked} />
                <span className="counter-nums shrink-0 font-medium">v{version.version}</span>
                <span className="min-w-0 flex-1 truncate">{versionLabel(version)}</span>
                <span className="text-muted shrink-0 text-[10px]">
                  {formatRelativeTime(version.createdAtMs)}
                </span>
              </button>
            );
          })}
          {props.onPin != null && (
            <>
              <div role="separator" className="bg-border my-1 h-px" />
              {props.projectShelfAvailable === true && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => pin("project")}
                  className={itemClassName}
                >
                  <Pin className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Pin to project shelf</span>
                  <kbd
                    aria-hidden="true"
                    className="mobile-hide-shortcut-hints text-muted shrink-0 font-sans text-[10px]"
                  >
                    {formatKeybind(KEYBINDS.PIN_ARTIFACT_TO_PROJECT_SHELF)}
                  </kbd>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => pin("global")}
                className={itemClassName}
              >
                <Pin className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Pin to global shelf</span>
                <kbd
                  aria-hidden="true"
                  className="mobile-hide-shortcut-hints text-muted shrink-0 font-sans text-[10px]"
                >
                  {formatKeybind(KEYBINDS.PIN_ARTIFACT_TO_GLOBAL_SHELF)}
                </kbd>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuCheck(props: { checked: boolean }) {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <Check className={cn("h-3 w-3", !props.checked && "invisible")} />
    </span>
  );
}
