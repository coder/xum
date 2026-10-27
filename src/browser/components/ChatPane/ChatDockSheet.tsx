import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { makeOthersInert } from "@/browser/utils/ui/makeOthersInert";
import { cn } from "@/common/lib/utils";

/**
 * Modal focus for the sheet. While it is open the covered page is inert, so Tab cannot leave the
 * sheet for the composer behind it, and focus moves in unless a panel already placed it there
 * (the background-bash chord focuses its first row; the content's effects run before the sheet's).
 * Closing hands focus back to where it was before once the page is interactive again (an inert
 * element cannot take focus). In a passive effect's cleanup: a layout effect's cleanup runs amid
 * the commit's DOM changes, and React then puts focus back on the element that had it before.
 */
function useSheetFocus(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  dialogRef: RefObject<HTMLDivElement | null>
): void {
  // Read in the commit that opens the sheet, before the chord's effect moves focus to its row.
  // Closing reads it too, unused.
  const returnFocusRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    returnFocusRef.current = document.activeElement;
  }, [open]);
  useEffect(() => {
    const root = rootRef.current;
    const dialog = dialogRef.current;
    // mutation-equivalent: both refs attach in the sheet's one commit, so they are null together
    if (!open || root === null || dialog === null) return;
    const returnFocus = returnFocusRef.current;
    const restoreOthers = makeOthersInert(root);
    if (!dialog.contains(document.activeElement)) dialog.focus();
    return () => {
      restoreOthers();
      // No isConnected check: focus() does nothing on an element that left the page meanwhile.
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  }, [open, rootRef, dialogRef]);
}

/**
 * Escape closes the sheet. A DOM listener, not onKeyDown: the tabs and the panel portal into the
 * sheet from their chips, so their React events bubble to the chips and never reach a React
 * handler here. It runs after those handlers, so a panel that handles Escape itself (by
 * preventing default or stopping it) keeps it, and it stops Escape before the window's stream
 * interrupt sees it. Escape from <body> reaches the open panel's chip instead
 * (useCloseChatActivityPanelOnBodyEscape).
 */
function useSheetEscape(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  close: () => void
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!open || root === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      stopKeyboardPropagation(event);
      close();
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [open, rootRef, close]);
}

/**
 * A bottom sheet over the chat on phones: the live line's activity sheet and the "Waiting on
 * you" sheet. It stays mounted (hidden while closed) so slots inside it exist before it opens:
 * content can move in and take focus in the commit that opens it.
 */
export function ChatDockSheet(props: {
  open: boolean;
  onClose: () => void;
  /** The heading, also the sheet's accessible name. */
  title: ReactNode;
  dataComponent: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = props.open;
  const close = props.onClose;
  useSheetFocus(open, rootRef, dialogRef);
  useSheetEscape(open, rootRef, close);

  return createPortal(
    <div
      ref={rootRef}
      className={cn("fixed inset-0 z-[1400]", !open && "hidden")}
      data-component={props.dataComponent}
    >
      <div aria-hidden className="absolute inset-0 bg-black/50" onClick={close} />
      <div
        ref={dialogRef}
        // Only while open: isDialogOpen() looks for an aria-modal dialog anywhere in the DOM.
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-surface-primary border-border-medium absolute inset-x-0 bottom-0 flex max-h-[min(80vh,40rem)] flex-col rounded-t-2xl border-t pb-[env(safe-area-inset-bottom,0px)] shadow-lg outline-none"
      >
        <div aria-hidden className="bg-border-medium mx-auto mt-2 h-1 w-9 shrink-0 rounded-full" />
        <div className="flex shrink-0 items-center gap-2 pt-2 pr-2 pl-4">
          <h2
            id={titleId}
            className="text-foreground flex items-center gap-2 text-base font-semibold"
          >
            {props.title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            // 44px on touch: globals.css sizes touch targets only up to the phone width, and the
            // sheet also opens on a phone in landscape, which is wider (a short viewport).
            className="text-muted hover:text-foreground ml-auto inline-flex size-8 items-center justify-center rounded-md transition-colors pointer-coarse:size-11"
          >
            <X className="size-4" />
          </button>
        </div>
        {props.children}
      </div>
    </div>,
    document.body
  );
}
