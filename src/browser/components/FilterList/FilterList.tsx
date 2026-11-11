import { useId, useState, type ReactNode, type Ref } from "react";
import { Check, Search } from "lucide-react";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import {
  filterListItems,
  splitFilterMatch,
  stepFilterListIndex,
  windowFilterListItems,
  type FilterListItem,
} from "./filterListItems";

/**
 * Rows rendered at once. A repository can have thousands of branches; past this the list asks
 * for a narrower filter instead of mounting them all.
 */
const MAX_RENDERED_ROWS = 200;

/**
 * A filter input over a single-choice list: type to narrow, arrows to move, Enter to pick. The
 * creation page's project switcher and base-branch picker share it, so both filter and move the
 * same way. Focus stays in the input (the rows are reached through aria-activedescendant).
 */
export function FilterList(props: {
  items: readonly FilterListItem[];
  selected: string | null;
  onSelect: (value: string) => void;
  /** Accessible name of the input and the list, e.g. "Select project". */
  label: string;
  placeholder: string;
  /** Plural noun for the empty state: `No ${noun} match "query"`. */
  noun: string;
  disabled?: boolean;
  /** Monospace rows, for branch names. */
  mono?: boolean;
  renderLeading?: (item: FilterListItem) => ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  listClassName?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  // Tracked by value, so the active row survives a filter that moves its index.
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const matches = filterListItems(props.items, query);
  const rows = windowFilterListItems(matches, props.selected, MAX_RENDERED_ROWS);
  const explicitIndex = rows.findIndex((item) => item.value === activeValue);
  const selectedIndex = rows.findIndex((item) => item.value === props.selected);
  // Without an explicit move the selected row is active, else the first match.
  const activeIndex =
    explicitIndex !== -1 ? explicitIndex : selectedIndex !== -1 ? selectedIndex : 0;
  const optionId = (index: number) => `${id}-option-${index}`;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = stepFilterListIndex(
        activeIndex,
        event.key === "ArrowDown" ? 1 : -1,
        rows.length
      );
      if (next === -1) return;
      event.preventDefault();
      stopKeyboardPropagation(event);
      setActiveValue(rows[next].value);
      // The row is already mounted, so it can scroll into view from the handler.
      document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && rows[activeIndex]) {
      // Enter picks the row; it must not reach the composer's send shortcut.
      event.preventDefault();
      stopKeyboardPropagation(event);
      props.onSelect(rows[activeIndex].value);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", props.className)}>
      <div className="border-border-light text-muted flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <input
          ref={props.inputRef}
          type="text"
          role="combobox"
          aria-label={props.label}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={rows[activeIndex] ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveValue(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={props.placeholder}
          disabled={props.disabled}
          className="text-foreground placeholder:text-muted min-w-0 flex-1 bg-transparent text-xs outline-none disabled:opacity-50"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={props.label}
        className={cn("min-h-0 overflow-y-auto p-1", props.listClassName)}
      >
        {rows.length === 0 && (
          <div className="text-muted px-2 py-2 text-xs" role="status">
            {query.trim() === "" ? `No ${props.noun}` : `No ${props.noun} match "${query.trim()}"`}
          </div>
        )}
        {rows.map((item, index) => {
          const selected = item.value === props.selected;
          const label = splitFilterMatch(item.label, query);
          return (
            <button
              key={item.value}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={selected}
              // Focus stays in the input; the rows are pointer targets.
              tabIndex={-1}
              disabled={props.disabled}
              // A click must not take focus from the input, or typing and the arrows would stop
              // filtering and moving while the list stays open (the branch picker does).
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onSelect(item.value)}
              onMouseMove={() => {
                if (activeValue !== item.value) setActiveValue(item.value);
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs disabled:opacity-50",
                index === activeIndex && "bg-hover"
              )}
            >
              {props.renderLeading?.(item)}
              <span
                data-filter-list-label
                className={cn(
                  "min-w-0 truncate",
                  props.mono && "font-mono",
                  // With a match, the rest of the label steps back so the match stands out.
                  label.match === "" ? "text-foreground" : "text-muted"
                )}
              >
                {label.before}
                {label.match !== "" && (
                  <span className="text-foreground font-semibold">{label.match}</span>
                )}
                {label.after}
              </span>
              {item.detail !== undefined && (
                <span className="text-muted ml-auto min-w-0 shrink truncate pl-2 text-[11px]">
                  {item.detail}
                </span>
              )}
              {selected && (
                <Check
                  aria-hidden
                  className={cn(
                    "text-foreground size-3.5 shrink-0",
                    item.detail === undefined && "ml-auto"
                  )}
                />
              )}
            </button>
          );
        })}
        {matches.length > rows.length && (
          <div className="text-muted px-2 py-1.5 text-[11px]" role="status">
            Showing {rows.length} of {matches.length}. Type to narrow the list.
          </div>
        )}
      </div>
    </div>
  );
}
