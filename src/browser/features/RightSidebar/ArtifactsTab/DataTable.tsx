/** Rows rendered by table views (CSV and JSON table hints); the rest are counted only. */
export const ARTIFACT_TABLE_MAX_ROWS = 1000;
/** Columns rendered by table views: a CSV row or a JSON `columns` array can be arbitrarily wide. */
export const ARTIFACT_TABLE_MAX_COLUMNS = 200;

/**
 * Plain read-only table for CSV and JSON table artifacts. Cells are React text, so artifact
 * content is always escaped. Sorting and filtering are intentionally out of scope.
 */
export function DataTable(props: {
  columns: string[];
  rows: string[][];
  totalRows: number;
  /** Source width when the parser already dropped columns past the cap. */
  totalColumns?: number;
}) {
  const totalColumns = Math.max(
    props.totalColumns ?? 0,
    props.columns.length,
    ...props.rows.map((row) => row.length)
  );
  const columnCount = Math.min(totalColumns, ARTIFACT_TABLE_MAX_COLUMNS);
  const columns = Array.from({ length: columnCount }, (_, i) => props.columns[i] ?? "");
  return (
    <div className="flex min-h-0 flex-col">
      {props.totalRows > props.rows.length && (
        <div className="text-muted border-border-light border-b px-3 py-1.5 text-[11px]">
          Showing first {props.rows.length} of {props.totalRows} rows
        </div>
      )}
      {totalColumns > columnCount && (
        <div className="text-muted border-border-light border-b px-3 py-1.5 text-[11px]">
          Showing first {columnCount} of {totalColumns} columns
        </div>
      )}
      <div className="overflow-auto">
        <table className="text-foreground w-max min-w-full border-collapse text-xs">
          <thead className="bg-sidebar sticky top-0">
            <tr>
              {columns.map((column, i) => (
                <th
                  key={i}
                  className="border-border-light border-b px-2 py-1 text-left font-medium whitespace-nowrap"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-hover">
                {columns.map((_, i) => (
                  <td
                    key={i}
                    className="border-border-light max-w-[320px] border-b px-2 py-1 align-top break-words whitespace-pre-wrap"
                  >
                    {row[i] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
