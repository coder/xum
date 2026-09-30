import assert from "@/common/utils/assert";

/**
 * Placeholder users can embed in saved-panel / SQL-explorer queries so the
 * dashboard's date-range selection (7D/30D/90D/All) applies to their own SQL.
 * Before execution it is substituted with a boolean predicate on the events
 * `date` column (e.g. `(date >= DATE '2026-06-05')`), or `TRUE` when "All"
 * is selected, so the query stays valid for every range selection.
 */
export const TIME_FILTER_PLACEHOLDER = "{{time_filter}}";

// Tolerate whitespace inside the braces and any casing, e.g. `{{ TIME_FILTER }}`.
const TIME_FILTER_PATTERN = /\{\{\s*time_filter\s*\}\}/gi;

function toUtcDateLiteral(date: Date): string {
  assert(Number.isFinite(date.getTime()), "Time filter boundary must be a valid date");
  return `DATE '${date.toISOString().slice(0, 10)}'`;
}

/** Build the SQL predicate for the dashboard's active date range. */
export function buildTimeFilterPredicate(from: Date | null, to: Date | null): string {
  const conditions: string[] = [];
  if (from) {
    conditions.push(`date >= ${toUtcDateLiteral(from)}`);
  }
  if (to) {
    conditions.push(`date <= ${toUtcDateLiteral(to)}`);
  }

  // "All" has no boundaries; substitute a tautology so a bare
  // `WHERE <placeholder>` clause remains valid SQL.
  if (conditions.length === 0) {
    return "TRUE";
  }

  return `(${conditions.join(" AND ")})`;
}

/** Replace every time-filter placeholder in user SQL with the active predicate. */
export function substituteTimeFilter(sql: string, timeFilterSql: string): string {
  assert(timeFilterSql.trim().length > 0, "timeFilterSql must be a non-empty predicate");
  return sql.replace(TIME_FILTER_PATTERN, timeFilterSql);
}
