import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useNarrowViewport, useShortViewport } from "@/browser/hooks/useNarrowViewport";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { isDialogOpen } from "@/browser/utils/ui/keybinds";
import { makeOthersInert } from "@/browser/utils/ui/makeOthersInert";
import { cn } from "@/common/lib/utils";

/**
 * The activity summaries that share the composer's live line as chips: the streaming status row
 * carries them, so the dock spends one row on activity instead of one row per kind.
 */
export type ChatActivityId =
  | "todo"
  | "sub-agents"
  | "background-bashes"
  | "reviews"
  | "chat-instructions";

/**
 * The line's chip order, which the activity sheet's tabs follow too: a tab portals into the sheet
 * when its chip mounts, so a chip that appears later would otherwise land at the end.
 */
export const CHAT_ACTIVITY_ORDER: Record<ChatActivityId, number> = {
  todo: 0,
  "sub-agents": 1,
  "background-bashes": 2,
  reviews: 3,
  "chat-instructions": 4,
};

/** What the line's one panel slot can hold: a chip's panel, or the "+N" chip's list of hidden chips. */
export type ChatActivityPanelId = ChatActivityId | "more";

type OpenIdUpdate = (current: ChatActivityPanelId | null) => ChatActivityPanelId | null;

/** Where chips render their tab and open panel on phones: the activity sheet. */
export interface ChatActivitySheetSlots {
  tabs: HTMLElement;
  body: HTMLElement;
}

interface ChatActivityPanelsValue {
  openId: ChatActivityPanelId | null;
  setOpenId: (update: OpenIdUpdate) => void;
  /** Set on phones, where every panel opens in one bottom sheet with a tab per chip. */
  sheet: ChatActivitySheetSlots | null;
  /** The chips the line has no room for, in line order; the "+N" chip stands in for them. */
  overflow: readonly ChatActivityId[];
  /** Where hidden chips render their entry while the "+N" chip's list is open, else null. */
  moreList: HTMLElement | null;
  setMoreList: (element: HTMLElement | null) => void;
}

const ChatActivityPanelsContext = createContext<ChatActivityPanelsValue | null>(null);

/** True inside the live line, where ChatInputDecoration renders a chip instead of a full row. */
export function useInChatActivityLine(): boolean {
  return useContext(ChatActivityPanelsContext) !== null;
}

/** The activity sheet's slots while the line opens its panels in the sheet, else null. */
export function useChatActivitySheet(): ChatActivitySheetSlots | null {
  return useContext(ChatActivityPanelsContext)?.sheet ?? null;
}

const NO_OVERFLOW: readonly ChatActivityId[] = [];

/** The line's overflow state, for the "+N" chip and the chips it stands in for. */
export function useChatActivityOverflow() {
  const panels = useContext(ChatActivityPanelsContext);
  return {
    overflow: panels?.overflow ?? NO_OVERFLOW,
    moreList: panels?.moreList ?? null,
    setMoreList: panels?.setMoreList,
    openId: panels?.openId ?? null,
    setOpenId: panels?.setOpenId,
  };
}

type SetExpanded = (next: boolean | ((current: boolean) => boolean)) => void;

/**
 * Expanded state of one activity summary. Inside the live line every chip shares one panel slot,
 * so opening one closes the others; outside it (tests, hosts without the line) each summary keeps
 * its own state. The setter reads the current slot, so stale closures cannot reopen a closed panel.
 */
export function useChatActivityPanel(id: ChatActivityId): [boolean, SetExpanded] {
  const panels = useContext(ChatActivityPanelsContext);
  const [localExpanded, setLocalExpanded] = useState(false);
  if (panels === null) {
    return [localExpanded, setLocalExpanded];
  }
  // Capture the state setter, not the context value (a new object whenever a panel opens or
  // closes), so the compiler keeps this setter stable and effects can list it as a dependency.
  const { openId, setOpenId } = panels;
  const setExpanded: SetExpanded = (next) =>
    setOpenId((current) => {
      const wasOpen = current === id;
      const open = typeof next === "function" ? next(wasOpen) : next;
      if (open) return id;
      return wasOpen ? null : current;
    });
  return [openId === id, setExpanded];
}

/**
 * Releases the shared slot when a chip unmounts while its panel is open (its last bash exits, the
 * TODO list clears), so the panel does not pop open again when the chip comes back later.
 */
export function useReleaseChatActivityPanelOnUnmount(id: ChatActivityId | undefined): void {
  const panels = useContext(ChatActivityPanelsContext);
  const setOpenId = panels?.setOpenId;
  useEffect(() => {
    if (setOpenId === undefined || id === undefined) return;
    return () => setOpenId((current) => (current === id ? null : current));
  }, [setOpenId, id]);
}

/**
 * Escape from <body> closes the open panel, popover or sheet. Focus lands there when a focused row
 * leaves (a stopped bash) or a dialog opened from a row closes (bash output), where the panel's
 * own Escape handling never sees the key, and the window's stream interrupt would take it while
 * the panel stays open. On <body>, so it runs before that interrupt.
 */
export function useCloseChatActivityPanelOnBodyEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.target !== document.body) {
        return;
      }
      event.preventDefault();
      stopKeyboardPropagation(event);
      close();
    };
    document.body.addEventListener("keydown", onKeyDown);
    return () => document.body.removeEventListener("keydown", onKeyDown);
  }, [open, close]);
}

/**
 * Owns the live line's single open panel. A press outside the line closes it, except inside a
 * modal opened from a panel (the background bash output dialog portals outside the line).
 *
 * On phones the panels open in one bottom sheet instead of a popover above the line, as in the
 * approved phone design: the sheet carries a tab per chip, so every list is one tap away even when
 * the chip strip has scrolled a chip out of view.
 */
export function ChatActivityPanelsProvider(props: {
  children: ReactNode;
  className?: string;
  dataComponent?: string;
}) {
  const [openId, setOpenIdState] = useState<ChatActivityPanelId | null>(null);
  const [moreList, setMoreList] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sheetViewport = useSheetViewport();
  const { sheet, setSheetTabs, setSheetBody } = useSheetSlots(sheetViewport);
  const overflow = useChipOverflow(rootRef, setOpenIdState);

  useEffect(() => {
    if (openId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (isDialogOpen()) return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenIdState(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openId]);

  return (
    <ChatActivityPanelsContext.Provider
      value={{ openId, setOpenId: setOpenIdState, sheet, overflow, moreList, setMoreList }}
    >
      <div ref={rootRef} className={props.className} data-component={props.dataComponent}>
        {props.children}
      </div>
      {sheetViewport && (
        <ChatActivitySheet
          // The "+N" chip's list opens above the line on phones too: it holds chips without a
          // panel (Chat Instructions), which the sheet has no tab for.
          open={openId !== null && openId !== "more"}
          onClose={() => setOpenIdState(null)}
          tabsRef={setSheetTabs}
          bodyRef={setSheetBody}
        />
      )}
    </ChatActivityPanelsContext.Provider>
  );
}

/**
 * The width the TODO chip keeps before a chip after it moves into the "+N" chip, so the current
 * step stays readable on a phone (the approved phone design shows its first words).
 */
const PLAIN_CHIP_RESERVE_PX = 104;

/** A chip's width without truncation: its width plus what its truncating text cuts off. */
function naturalChipWidth(chip: HTMLElement): number {
  const text = chip.querySelector<HTMLElement>("[data-chip-truncates]");
  const cut = text === null ? 0 : text.scrollWidth - text.clientWidth;
  return chip.getBoundingClientRect().width + cut;
}

/**
 * The bordered chips that do not fit the strip, from the end of the line. The TODO chip
 * (plain) never hides: it yields width down to its reserve first. A hidden chip stays laid out
 * out of the flow (ChatActivityChipButton), so its width is known when room comes back.
 */
export function measureChipOverflow(strip: HTMLElement): ChatActivityId[] {
  const chips = [...strip.querySelectorAll<HTMLElement>("[data-activity-chip][data-activity-id]")];
  const plain = chips.filter((chip) => chip.dataset.chipVariant === "plain");
  const bordered = chips
    .filter((chip) => chip.dataset.chipVariant !== "plain")
    .sort(
      (a, b) =>
        CHAT_ACTIVITY_ORDER[a.dataset.activityId as ChatActivityId] -
        CHAT_ACTIVITY_ORDER[b.dataset.activityId as ChatActivityId]
    );
  const more = strip.querySelector<HTMLElement>("[data-activity-overflow-chip]");
  const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
  const plainWidth = plain.reduce(
    (sum, chip) => sum + Math.min(naturalChipWidth(chip), PLAIN_CHIP_RESERVE_PX),
    0
  );
  const widths = bordered.map((chip) => chip.getBoundingClientRect().width);
  const moreWidth = more?.getBoundingClientRect().width ?? 0;
  // Flex items: the plain chips, the spacer between them and the rest, the chips shown, and the
  // "+N" chip once any hides. One gap between each pair.
  const needed = (shown: number) => {
    const hides = shown < bordered.length;
    const items = plain.length + 1 + shown + (hides ? 1 : 0);
    const chipsWidth = widths.slice(0, shown).reduce((sum, width) => sum + width, 0);
    return plainWidth + chipsWidth + (hides ? moreWidth : 0) + gap * (items - 1);
  };
  let shown = bordered.length;
  // Sub-pixel layout: a chip that fits to within half a pixel stays.
  while (shown > 0 && needed(shown) > strip.clientWidth + 0.5) shown--;
  return bordered.slice(shown).map((chip) => chip.dataset.activityId as ChatActivityId);
}

function sameIds(a: readonly ChatActivityId[], b: readonly ChatActivityId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Which chips the line has no room for. Measured from the DOM, not computed in render: the chips
 * render themselves (each decides whether it has anything to show), and only layout knows their
 * widths. Re-measured when the strip or a chip resizes, and when chips mount or unmount.
 */
function useChipOverflow(
  rootRef: RefObject<HTMLDivElement | null>,
  setOpenId: (update: OpenIdUpdate) => void
): readonly ChatActivityId[] {
  const [overflow, setOverflow] = useState<readonly ChatActivityId[]>(NO_OVERFLOW);
  useLayoutEffect(() => {
    const root = rootRef.current;
    // mutation-equivalent: the ref attaches in the provider's commit, before its layout effects
    if (root === null) return;
    let strip: HTMLElement | null = null;
    const update = () => {
      const next = strip === null ? NO_OVERFLOW : measureChipOverflow(strip);
      setOverflow((current) => (sameIds(current, next) ? current : next));
      // Nothing left to list: the "+N" chip went away with its list open.
      if (next.length === 0) setOpenId((current) => (current === "more" ? null : current));
    };
    const resizes = new ResizeObserver(update);
    const observe = () => {
      resizes.disconnect();
      strip = root.querySelector<HTMLElement>("[data-activity-strip]");
      if (strip === null) return;
      resizes.observe(strip);
      for (const chip of strip.querySelectorAll("[data-activity-chip], [data-activity-overflow-chip]")) {
        resizes.observe(chip);
      }
    };
    const mutations = new MutationObserver(() => {
      observe();
      update();
    });
    mutations.observe(root, { childList: true, subtree: true });
    observe();
    update();
    return () => {
      resizes.disconnect();
      mutations.disconnect();
    };
  }, [rootRef, setOpenId]);
  return overflow;
}

/**
 * True where the panels open in the sheet: phone widths, and viewports too short for a popover
 * above the line (a phone in landscape), which would run off the top of the screen.
 */
function useSheetViewport(): boolean {
  const narrow = useNarrowViewport();
  const short = useShortViewport();
  return narrow || short;
}

/**
 * The activity sheet's slots, set only where the sheet renders. Callback refs into state, not
 * refs: chips portal into the slots, and need them on the render after the sheet mounts.
 */
function useSheetSlots(sheetViewport: boolean) {
  const [tabs, setSheetTabs] = useState<HTMLElement | null>(null);
  const [body, setSheetBody] = useState<HTMLElement | null>(null);
  const sheet: ChatActivitySheetSlots | null =
    sheetViewport && tabs !== null && body !== null ? { tabs, body } : null;
  return { sheet, setSheetTabs, setSheetBody };
}

/**
 * Modal focus for the sheet. While it is open the covered page is inert, so Tab cannot leave the
 * sheet for the composer behind it, and focus moves in unless a panel already placed it there
 * (the background-bash chord focuses its first row; the line's effects run before the sheet's).
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
 * The phone sheet. It stays mounted (hidden while closed) so its slots exist before a panel
 * opens: the background-bash chord opens the panel and focuses its first row in one commit, which
 * needs the row in the DOM on that commit.
 */
function ChatActivitySheet(props: {
  open: boolean;
  onClose: () => void;
  tabsRef: (element: HTMLElement | null) => void;
  bodyRef: (element: HTMLElement | null) => void;
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
      data-component="ChatActivitySheet"
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
          <h2 id={titleId} className="text-foreground text-base font-semibold">
            Activity
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
        <div
          ref={props.tabsRef}
          role="tablist"
          aria-label="Activity"
          className="bg-surface-secondary mx-4 mt-2 flex shrink-0 scroll-px-1 scrollbar-none gap-1 overflow-x-auto rounded-lg p-1"
        />
        <div ref={props.bodyRef} className="flex min-h-0 flex-1 flex-col" />
      </div>
    </div>,
    document.body
  );
}
