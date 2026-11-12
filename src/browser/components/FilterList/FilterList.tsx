import { Fragment, useId, useState, type ReactNode, type Ref } from "react";
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

/** One row: a pointer target for the option; keyboard focus stays in the filter input. */
function FilterListRow(props: {
  id: string;
  item: FilterListItem;
  query: string;
  selected: boolean;
  active: boolean;
  disabled: boolean | undefined;
  mono: boolean | undefined;
  twoLine: boolean | undefined;
  leading: ReactNode;
  onSelect: (value: string) => void;
  onHover: (value: string) => void;
}) {
  const { item } = props;
  const label = splitFilterMatch(item.label, props.query);
  const labelNode = (
    <span
      data-filter-list-label
      className={cn(
        "min-w-0 truncate",
        props.mono ? "font-mono text-xs" : "font-medium",
        // With a match, the rest of the label steps back so the match stands out.
        label.match === "" ? "text-foreground" : "text-muted"
      )}
    >
      {label.before}
      {label.match !== "" && <span className="text-foreground font-semibold">{label.match}</span>}
      {label.after}
    </span>
  );
  return (
    <button
      id={props.id}
      type="button"
      role="option"
      aria-selected={props.selected}
      tabIndex={-1}
      disabled={props.disabled}
      // A click must not take focus from the input, or typing and the arrows would stop
      // filtering and moving while the list stays open (the branch picker does).
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onSelect(item.value)}
      onMouseMove={() => {
        if (!props.active) props.onHover(item.value);
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        props.active && "bg-hover"
      )}
    >
      {props.leading}
      {props.twoLine && item.detail !== undefined ? (
        // Name over path: a path beside the name squeezed the name down to one letter.
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          {labelNode}
          {/* A path is told apart by its end, so it is cut at the start: the rtl box puts the
              ellipsis on the left and <bdi> keeps the path itself left-to-right. */}
          <span className="text-muted truncate text-left font-mono text-[11px] [direction:rtl]">
            <bdi>{item.detail}</bdi>
          </span>
        </span>
      ) : (
        <>
          {labelNode}
          {item.detail !== undefined && (
            <span className="text-muted min-w-0 shrink truncate text-[11px]">{item.detail}</span>
          )}
        </>
      )}
      {item.badge !== undefined && (
        <span className="border-border-medium text-muted shrink-0 rounded-[4px] border px-1.5 font-sans text-[10.5px] font-medium">
          {item.badge}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {item.aside !== undefined && <span className="text-muted text-xs">{item.aside}</span>}
        {props.selected && <Check aria-hidden className="text-foreground size-3.5" />}
      </span>
    </button>
  );
}

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
  /** Rows show the detail under the label (a project's path) instead of beside it. */
  twoLine?: boolean;
  /** The filter is a bordered box inside a column, not a header row across a popover. */
  boxedFilter?: boolean;
  /** Shown at the end of the filter row (a key hint). */
  filterHint?: ReactNode;
  /** Rows below the list that are not options (an "Add…" action). */
  footer?: ReactNode;
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
      <div
        className={cn(
          "text-muted flex shrink-0 items-center gap-2",
          props.boxedFilter
            ? "border-border-medium bg-background focus-within:border-accent mx-1 mt-0.5 mb-1 rounded-md border px-[9px] py-1.5"
            : "border-border-light border-b px-3 py-2.5"
        )}
      >
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
          className="text-foreground placeholder:text-muted min-w-0 flex-1 bg-transparent text-[13px] outline-none disabled:opacity-50"
        />
        {props.filterHint}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={props.label}
        className={cn("min-h-0 overflow-y-auto p-1", props.listClassName)}
      >
        {rows.length === 0 && (
          <div className="text-muted px-2.5 py-2 text-xs" role="status">
            {query.trim() === "" ? `No ${props.noun}` : `No ${props.noun} match "${query.trim()}"`}
          </div>
        )}
        {rows.map((item, index) => (
          <Fragment key={item.value}>
            {item.divider && index > 0 && (
              <div role="presentation" className="border-border-light -mx-1 my-1 border-t" />
            )}
            {item.section !== undefined && item.section !== rows[index - 1]?.section && (
              <div
                role="presentation"
                className="text-muted-light px-2.5 pt-2 pb-1 font-mono text-[10.5px] font-medium tracking-[0.06em] uppercase"
              >
                {item.section}
              </div>
            )}
            <FilterListRow
              id={optionId(index)}
              item={item}
              query={query}
              selected={item.value === props.selected}
              active={index === activeIndex}
              disabled={props.disabled}
              mono={props.mono}
              twoLine={props.twoLine}
              leading={props.renderLeading?.(item)}
              onSelect={props.onSelect}
              onHover={setActiveValue}
            />
          </Fragment>
        ))}
        {matches.length > rows.length && (
          <div className="text-muted px-2.5 py-1.5 text-[11px]" role="status">
            Showing {rows.length} of {matches.length}. Type to narrow the list.
          </div>
        )}
      </div>
      {props.footer != null && (
        <div className="border-border-light shrink-0 border-t p-1">{props.footer}</div>
      )}
    </div>
  );
}
