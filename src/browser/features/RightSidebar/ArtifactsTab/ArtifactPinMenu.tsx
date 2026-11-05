import React, { useEffect, useRef, useState } from "react";
import { Pin } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { ArtifactShelfScope } from "@/common/orpc/schemas/artifacts";

/**
 * Rendered inline (not through a Radix portal) so it opens in happy-dom tests and inside the
 * panel's fullscreen overlay alike.
 */
export function ArtifactPinMenu(props: {
  onPin: (scope: ArtifactShelfScope) => void;
  /** False in multi-project workspaces, which have no project shelf. */
  projectShelfAvailable: boolean;
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

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const pin = (scope: ArtifactShelfScope) => {
    setOpen(false);
    triggerRef.current?.focus();
    props.onPin(scope);
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
      listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
    );
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[Math.min(Math.max(next, 0), items.length - 1)]?.focus();
  };

  const itemClassName =
    "hover:bg-hover focus:bg-hover flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none";

  return (
    <div ref={containerRef} className="relative shrink-0">
      <TooltipIfPresent tooltip="Pin to shelf">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Pin to shelf"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="border-border-light text-muted hover:text-foreground bg-background focus-visible:ring-accent flex h-6 w-6 items-center justify-center rounded border focus-visible:ring-1"
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
      </TooltipIfPresent>
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label="Pin to shelf"
          onKeyDown={handleListKeyDown}
          className="bg-dark border-border text-foreground absolute top-full right-0 z-[1600] mt-1 w-56 max-w-[calc(100vw-1rem)] rounded-md border p-1 shadow-md"
        >
          {props.projectShelfAvailable && (
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
        </div>
      )}
    </div>
  );
}
