import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { makeOthersInert } from "@/browser/utils/ui/makeOthersInert";
import { cn } from "@/common/lib/utils";

/** Maps what had focus when the sheet opened to what takes it back on close. */
export type ChatDockSheetReturnFocus = (opener: Element | null) => Element | null;

/**
 * Modal focus for the sheet. While it is open the covered page is inert, so Tab cannot leave the
 * sheet for the composer behind it, and focus moves in unless a panel already placed it there
 * (the background-bash chord focuses its first row; the content's effects run before the sheet's).
 *
 * The page is interactive again before the layout effects of the commit that closes the sheet:
 * content that leaves the sheet in that commit puts its focus back in a layout effect
 * (WaitingOnYouSlot), and an inert element cannot take focus. Then focus goes back to where it was
 * when the sheet opened, or where `returnFocusRef` maps that. In a passive effect's cleanup: a
 * layout effect's cleanup runs amid the commit's DOM changes, and React then puts focus back on
 * the element that had it before.
 */
function useSheetFocus(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  dialogRef: RefObject<HTMLDivElement | null>,
  returnFocus: ChatDockSheetReturnFocus | undefined
): void {
  // Read in the commit that opens the sheet, before the chord's effect moves focus to its row.
  // Closing reads it too, unused.
  const openerRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
  }, [open]);
  // The latest one, read as the sheet closes: it maps by what the page shows at that point.
  const returnFocusRef = useRef(returnFocus);
  useLayoutEffect(() => {
    returnFocusRef.current = returnFocus;
  });
  useLayoutEffect(() => {
    const root = rootRef.current;
    // mutation-equivalent: the sheet always renders its root, so the ref is set before its effects
    if (!open || root === null) return;
    return makeOthersInert(root);
  }, [open, rootRef]);
  useEffect(() => {
    const dialog = dialogRef.current;
    // mutation-equivalent: the sheet always renders its dialog, so the ref is set before its effects
    if (!open || dialog === null) return;
    const opener = openerRef.current;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    return () => {
      const target = returnFocusRef.current?.(opener) ?? opener;
      // No isConnected check: focus() does nothing on an element that left the page meanwhile.
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, dialogRef]);
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
  /**
   * What takes focus back on close, given what had it when the sheet opened (by default, that
   * element). For openers that can hide while the sheet is open, as the live line's chips do.
   */
  returnFocus?: ChatDockSheetReturnFocus;
  children: ReactNode;
}) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = props.open;
  const close = props.onClose;
  useSheetFocus(open, rootRef, dialogRef, props.returnFocus);
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
