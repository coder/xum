import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ChevronUp, type LucideIcon } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { ChatDockSheet } from "./ChatDockSheet";
import { useSheetViewport } from "./chatActivityPanels";
import { ChatDockInsetProvider, ChatDockSurface } from "./chatDockColumn";

/**
 * What can wait on the user above the composer. Two or more at once fold into one "Waiting on
 * you" card (desktop: a tab each; phones: one summary row that opens a sheet) instead of a banner
 * per kind stacking up over the transcript. The queued message is not counted: it sends by
 * itself. On desktop it stays a row of its own under the card; on phones the sheet lists it.
 */
export type WaitingOnYouId =
  | "question"
  | "context-switch"
  | "held-inputs"
  | "delegated-creation"
  | "legacy-plan"
  | "queued";

/** Tab and sheet order: what blocks the agent first. */
const WAITING_ORDER: Record<WaitingOnYouId, number> = {
  question: 0,
  "context-switch": 1,
  "held-inputs": 2,
  "delegated-creation": 3,
  "legacy-plan": 4,
  queued: 5,
};

export interface WaitingOnYouEntry {
  icon: LucideIcon;
  /** Short tab label on desktop, e.g. "2 unsent". */
  tab: string;
  /** Its row on phones, and the summary row while it is first, e.g. "2 unsent messages". */
  title: string;
  /** The row's second line, e.g. "Interrupted before they ran · Send or Discard". */
  detail: string;
  /** Drawn in the danger tone: the agent cannot go on (or a send fails) until the user acts. */
  urgent?: boolean;
}

type Entries = ReadonlyMap<WaitingOnYouId, WaitingOnYouEntry>;

interface WaitingOnYouValue {
  /** True while two or more items wait: they render in the card (or sheet), not inline. */
  consolidated: boolean;
  /** Whether slot `id` waits on the user now (it has an entry). */
  waits: (id: WaitingOnYouId) => boolean;
  /** Where a slot's content goes while consolidated; null keeps it in the slot. */
  hostFor: (id: WaitingOnYouId) => HTMLElement | null;
}

const WaitingOnYouContext = createContext<WaitingOnYouValue | null>(null);
// Apart from the value above, which changes whenever an item comes or goes: the setter is
// stable, so registering never re-renders the items that register.
const WaitingOnYouRegisterContext = createContext<Dispatch<SetStateAction<Entries>> | null>(null);
const WaitingOnYouSlotIdContext = createContext<WaitingOnYouId | null>(null);
interface WaitingOnYouCardState {
  entries: ReadonlyArray<[WaitingOnYouId, WaitingOnYouEntry]>;
  selected: WaitingOnYouId | null;
  select: (id: WaitingOnYouId) => void;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  phone: boolean;
  setBodyHost: (element: HTMLElement | null) => void;
  setAfterHost: (element: HTMLElement | null) => void;
  setSheetHost: (element: HTMLElement | null) => void;
}

const WaitingOnYouCardContext = createContext<WaitingOnYouCardState | null>(null);

function sameEntry(
  a: WaitingOnYouEntry | null | undefined,
  b: WaitingOnYouEntry | null | undefined
): boolean {
  if (a == null || b == null) return a === b;
  return (
    a.icon === b.icon &&
    a.tab === b.tab &&
    a.title === b.title &&
    a.detail === b.detail &&
    a.urgent === b.urgent
  );
}

function registerEntry(
  setEntries: Dispatch<SetStateAction<Entries>>,
  id: WaitingOnYouId,
  entry: WaitingOnYouEntry | null
): void {
  setEntries((current) => {
    if (sameEntry(current.get(id), entry)) return current;
    const copy = new Map(current);
    if (entry === null) {
      copy.delete(id);
    } else {
      copy.set(id, entry);
    }
    return copy;
  });
}

/** Registers `entry` for slot `id` while mounted; `undefined` leaves it to the slot's content. */
function useEntryRegistration(
  id: WaitingOnYouId | null,
  entry: WaitingOnYouEntry | null | undefined
): void {
  const setEntries = useContext(WaitingOnYouRegisterContext);
  // Callers build the entry on every render: keep one object while its content stays the same,
  // so the effect below runs only when the entry really changes.
  const [stable, setStable] = useState(entry);
  if (!sameEntry(stable, entry)) setStable(entry);
  // A layout effect: the card takes the items in before the first paint, so they never flash
  // inline first.
  useLayoutEffect(() => {
    if (setEntries === null || id === null || stable === undefined) return;
    registerEntry(setEntries, id, stable);
    return () => registerEntry(setEntries, id, null);
  }, [setEntries, id, stable]);
}

/**
 * For content that decides by itself whether it shows (an open question, an old plan): reports
 * that it waits on the user while `entry` is set. Outside a slot it does nothing.
 */
export function useWaitingOnYou(entry: WaitingOnYouEntry | null): void {
  useEntryRegistration(useContext(WaitingOnYouSlotIdContext), entry);
}

interface WaitingArrangement {
  /** The card's tabs (desktop) or the sheet's items (phones), in WAITING_ORDER. */
  listed: ReadonlyArray<[WaitingOnYouId, WaitingOnYouEntry]>;
  selected: WaitingOnYouId | null;
  consolidated: boolean;
}

/** Which items the card lists, which one it shows, and whether there is a card at all. */
export function arrangeWaiting(
  entries: Entries,
  chosen: WaitingOnYouId | null,
  phone: boolean
): WaitingArrangement {
  const ordered = [...entries].sort(([a], [b]) => WAITING_ORDER[a] - WAITING_ORDER[b]);
  const waiting = ordered.filter(([id]) => id !== "queued");
  // Phones list the queued message in the sheet; desktop keeps it under the card.
  const listed = phone ? ordered : waiting;
  const selected = (listed.find(([id]) => id === chosen) ?? listed.at(0))?.[0] ?? null;
  return { listed, selected, consolidated: waiting.length >= 2 };
}

/**
 * Where a slot's content goes: the card's body (desktop, the chosen tab), under the card (desktop,
 * the queued message), the open sheet (phones, the chosen item), or null to stay in its slot.
 */
export function waitingHost(
  id: WaitingOnYouId,
  arranged: WaitingArrangement,
  phone: boolean,
  hosts: { body: HTMLElement | null; after: HTMLElement | null; sheet: HTMLElement | null }
): HTMLElement | null {
  if (!arranged.consolidated) return null;
  if (!phone && id === "queued") return hosts.after;
  if (id !== arranged.selected) return null;
  return phone ? hosts.sheet : hosts.body;
}

/**
 * Owns the items waiting on the user; wraps the composer's decoration stack, whose items include
 * the slots and the card.
 */
export function WaitingOnYouProvider(props: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entries>(() => new Map());
  const [chosen, setChosen] = useState<WaitingOnYouId | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bodyHost, setBodyHost] = useState<HTMLElement | null>(null);
  const [afterHost, setAfterHost] = useState<HTMLElement | null>(null);
  const [sheetHost, setSheetHost] = useState<HTMLElement | null>(null);
  const phone = useSheetViewport();

  const arranged = arrangeWaiting(entries, chosen, phone);
  const sheetShown = sheetOpen && arranged.consolidated && phone;
  if (sheetOpen && !sheetShown) {
    // Adjust during render: down to one item (or onto a wide screen), nothing is left to list.
    setSheetOpen(false);
  }
  const hosts = { body: bodyHost, after: afterHost, sheet: sheetShown ? sheetHost : null };
  const consolidated = arranged.consolidated;
  const hostFor = (id: WaitingOnYouId) => waitingHost(id, arranged, phone, hosts);
  const waits = (id: WaitingOnYouId) => entries.has(id);

  return (
    <WaitingOnYouRegisterContext.Provider value={setEntries}>
      <WaitingOnYouContext.Provider value={{ consolidated, waits, hostFor }}>
        <WaitingOnYouCardContext.Provider
          value={{
            entries: arranged.listed,
            selected: arranged.selected,
            select: setChosen,
            collapsed,
            setCollapsed,
            sheetOpen: sheetShown,
            setSheetOpen,
            phone,
            setBodyHost,
            setAfterHost,
            setSheetHost,
          }}
        >
          {props.children}
        </WaitingOnYouCardContext.Provider>
      </WaitingOnYouContext.Provider>
    </WaitingOnYouRegisterContext.Provider>
  );
}

/**
 * One item that can wait on the user. Its content renders through a portal into a container
 * this slot owns, and the container moves between the slot (inline) and the card or sheet. The
 * content never remounts when the card forms or breaks up, so a half-answered question or a
 * pending action keeps its state when another item arrives.
 *
 * `entry` describes the item for the card; leave it undefined when the content reports itself
 * with useWaitingOnYou (it decides whether it shows).
 */
export function WaitingOnYouSlot(props: {
  id: WaitingOnYouId;
  entry?: WaitingOnYouEntry | null;
  children: ReactNode;
}) {
  const waiting = useContext(WaitingOnYouContext);
  useEntryRegistration(props.id, props.entry);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.dataset.waitingOnYouSlot = props.id;
    return element;
  });
  const slotRef = useRef<HTMLDivElement>(null);
  const host = waiting?.hostFor(props.id) ?? null;
  useLayoutEffect(() => {
    const target = host ?? slotRef.current;
    if (target !== null && container.parentNode !== target) target.appendChild(container);
  }, [host, container]);
  useLayoutEffect(() => () => container.remove(), [container]);

  if (waiting === null) {
    return <>{props.children}</>;
  }
  return (
    <WaitingOnYouSlotIdContext.Provider value={props.id}>
      {/* While consolidated, waiting items not shown in the card wait here, hidden. Content
          that no longer waits (an old-plan notice that found nothing to import) stays inline,
          so its message stays visible next to the card. */}
      <div
        ref={slotRef}
        className={waiting.consolidated && waiting.waits(props.id) ? "hidden" : "contents"}
      >
        {createPortal(
          <ChatDockInsetProvider value={waiting.consolidated}>
            {props.children}
          </ChatDockInsetProvider>,
          container
        )}
      </div>
    </WaitingOnYouSlotIdContext.Provider>
  );
}

function WaitingCountBadge(props: { count: number; label?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "counter-nums inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] font-medium text-[var(--color-danger)]",
        props.className
      )}
    >
      {props.label === true && (
        <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-danger)]" />
      )}
      {props.count}
      {props.label === true && " waiting on you"}
    </span>
  );
}

/** Left/Right move between the tabs (the tablist keyboard pattern). */
function moveTabFocus(event: KeyboardEvent<HTMLElement>): void {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const index = tabs.findIndex((tab) => tab === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const next = tabs[(index + step + tabs.length) % tabs.length];
  next.focus();
  next.click();
}

/**
 * The card above the composer while two or more items wait: a tab per item and the chosen one's
 * content (desktop), or a summary row that opens the "Waiting on you" sheet (phones).
 */
export function WaitingOnYouCard() {
  const waiting = useContext(WaitingOnYouContext);
  const card = useContext(WaitingOnYouCardContext);
  const panelId = useId();
  if (waiting === null || card === null || !waiting.consolidated) return null;
  return card.phone ? (
    <WaitingOnYouSummary card={card} />
  ) : (
    <WaitingOnYouTabs card={card} panelId={panelId} />
  );
}

function WaitingTab(props: {
  label: string;
  selected: boolean;
  collapsed: boolean;
  panelId: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      aria-controls={props.selected ? props.panelId : undefined}
      tabIndex={props.selected ? 0 : -1}
      onClick={props.onSelect}
      className={cn(
        "h-7 shrink-0 rounded-md px-2 text-xs whitespace-nowrap transition-colors",
        props.selected && !props.collapsed
          ? "bg-hover text-foreground font-medium"
          : "text-secondary hover:text-foreground"
      )}
    >
      {props.label}
    </button>
  );
}

function WaitingOnYouTabs(props: { card: WaitingOnYouCardState; panelId: string }) {
  const card = props.card;
  const count = card.entries.length;
  return (
    <ChatDockSurface>
      <div className="py-1.5">
        <section
          aria-label="Waiting on you"
          data-component="WaitingOnYouCard"
          className="bg-surface-primary rounded-lg border border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)]"
        >
          <div
            className={cn(
              "flex min-h-10 items-center gap-1.5 px-2 py-1.5",
              !card.collapsed && "border-border-light border-b"
            )}
          >
            <WaitingCountBadge count={count} label className="h-7 px-2 text-xs" />
            <div
              role="tablist"
              aria-label="Waiting on you"
              onKeyDown={moveTabFocus}
              className="flex min-w-0 scrollbar-none gap-0.5 overflow-x-auto"
            >
              {card.entries.map(([id, entry]) => (
                <WaitingTab
                  key={id}
                  label={entry.tab}
                  selected={id === card.selected}
                  collapsed={card.collapsed}
                  panelId={props.panelId}
                  onSelect={() => {
                    card.select(id);
                    card.setCollapsed(false);
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              aria-label={card.collapsed ? "Show what is waiting" : "Hide what is waiting"}
              aria-expanded={!card.collapsed}
              aria-controls={props.panelId}
              onClick={() => card.setCollapsed(!card.collapsed)}
              className="text-muted hover:text-foreground ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors"
            >
              {card.collapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </button>
          </div>
          {/* Bounded so a long question set never pushes the composer off a short screen. */}
          <div
            ref={card.setBodyHost}
            id={props.panelId}
            role="tabpanel"
            aria-label={card.entries.find(([id]) => id === card.selected)?.[1].tab}
            hidden={card.collapsed}
            className="max-h-[50vh] overflow-y-auto px-2 py-1"
          />
        </section>
      </div>
      <div ref={card.setAfterHost} />
    </ChatDockSurface>
  );
}

function WaitingOnYouSummary(props: { card: WaitingOnYouCardState }) {
  const card = props.card;
  const waiting = card.entries.filter(([id]) => id !== "queued");
  const queued = card.entries.some(([id]) => id === "queued");
  // Headed by what waits, not by the queued message even while the sheet shows it.
  const first = waiting.find(([id]) => id === card.selected) ?? waiting[0];
  const detail = [
    first[1].detail,
    `${waiting.length - 1} more waiting`,
    ...(queued ? ["1 queued"] : []),
  ].join(" · ");
  const others = card.entries.filter(([id]) => id !== card.selected);
  const sheetHostRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <ChatDockSurface>
        <div className="py-1.5">
          <button
            type="button"
            data-component="WaitingOnYouSummary"
            aria-haspopup="dialog"
            aria-expanded={card.sheetOpen}
            onClick={() => card.setSheetOpen(true)}
            className="flex w-full items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_8%,transparent)] px-3 py-2 text-left"
          >
            <WaitingCountBadge count={waiting.length} className="size-8 text-sm" />
            <span className="min-w-0 flex-1">
              <span className="text-foreground block truncate text-sm font-medium">
                {first[1].title}
              </span>
              <span className="text-muted block truncate text-xs">{detail}</span>
            </span>
            <ChevronUp className="text-muted size-4 shrink-0" />
          </button>
        </div>
      </ChatDockSurface>
      <ChatDockSheet
        open={card.sheetOpen}
        onClose={() => card.setSheetOpen(false)}
        title={
          <>
            Waiting on you
            <WaitingCountBadge count={waiting.length} className="h-6 min-w-6 px-1.5 text-xs" />
          </>
        }
        dataComponent="WaitingOnYouSheet"
      >
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <div
            ref={(element) => {
              sheetHostRef.current = element;
              card.setSheetHost(element);
            }}
            // A chosen row leaves the list: focus moves to what it opened, not to the page.
            tabIndex={-1}
            className="px-4 pt-2 outline-none"
          />
          {others.length > 0 && (
            <ul aria-label="Also waiting" className="border-border-light mt-2 border-t">
              {others.map(([id, entry]) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => {
                      card.select(id);
                      sheetHostRef.current?.focus();
                    }}
                    className="hover:bg-hover flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
                  >
                    <span
                      className={cn(
                        "inline-flex size-8 shrink-0 items-center justify-center rounded-md",
                        entry.urgent === true
                          ? "bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-[var(--color-danger)]"
                          : "bg-surface-secondary text-secondary"
                      )}
                    >
                      <entry.icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-sm">{entry.title}</span>
                      <span className="text-muted block truncate text-xs">{entry.detail}</span>
                    </span>
                    <ChevronRight className="text-muted size-4 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ChatDockSheet>
    </>
  );
}
