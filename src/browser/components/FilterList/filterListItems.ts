/** One row of a {@link FilterList}. */
export interface FilterListItem {
  value: string;
  label: string;
  /** Secondary text (a path, a hint). Searched along with the label. */
  detail?: string;
  /** A small outlined tag after the label ("default" on the default branch). Not searched. */
  badge?: string;
  /** Muted text at the row's right edge ("No project"). Not searched. */
  aside?: string;
  /**
   * The group this row belongs to ("Recent"). A caption is drawn above the first shown row of
   * each group; the items arrive already ordered by group.
   */
  section?: string;
  /** Draws a separator above this row unless it is the first one shown. */
  divider?: boolean;
}

/** Case-insensitive substring filter over label and detail; an empty query keeps every item. */
export function filterListItems<T extends FilterListItem>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) ||
      (item.detail?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Splits text around the first match of the query, so the row can emphasise it with React nodes
 * (never HTML: labels are repository-controlled branch and project names).
 */
export function splitFilterMatch(
  text: string,
  query: string
): { before: string; match: string; after: string } {
  const needle = query.trim().toLowerCase();
  const index = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (index === -1) return { before: text, match: "", after: "" };
  return {
    before: text.slice(0, index),
    match: text.slice(index, index + needle.length),
    after: text.slice(index + needle.length),
  };
}

/** The next active row for an arrow key, wrapping at both ends; -1 when the list is empty. */
export function stepFilterListIndex(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * The rows to render: at most `max`, always including the selected item when it matches. A long
 * list would otherwise cut the selection off, and the first row would then look like (and act as)
 * the current choice.
 */
export function windowFilterListItems<T extends FilterListItem>(
  matches: readonly T[],
  selected: string | null,
  max: number
): T[] {
  const rows = matches.slice(0, max);
  const selectedItem = matches.find((item) => item.value === selected);
  if (selectedItem === undefined || rows.includes(selectedItem)) return rows;
  // Lead with the selection so it is the active row; the last windowed row makes room for it.
  // Moved out of its place, it also leaves its group: under its group's caption it would put
  // that caption above the ungrouped rows that follow it (the default branch).
  return [{ ...selectedItem, section: undefined }, ...rows.slice(0, Math.max(0, max - 1))];
}
