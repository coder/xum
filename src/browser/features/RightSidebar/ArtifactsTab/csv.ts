/**
 * Small RFC-4180-style parser for CSV/TSV artifacts: quoted fields, "" escapes inside quotes,
 * delimiters and newlines inside quotes, CRLF/LF/CR line endings, and ragged rows (rows keep
 * their own length). Only the first `maxRows` rows are kept; `totalRows` counts all of them.
 */
export interface ParsedDelimited {
  rows: string[][];
  totalRows: number;
  /** Fields in the widest row, counting fields beyond `maxColumns` that were not kept. */
  maxRowWidth: number;
}

export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows: number,
  /** Fields kept per row; the rest are only counted, so a comma-only row cannot hold millions. */
  maxColumns = Number.POSITIVE_INFINITY
): ParsedDelimited {
  if (delimiter.length !== 1) throw new Error("delimiter must be one character");
  if (!Number.isInteger(maxRows) || maxRows < 0) throw new Error("maxRows must be >= 0");
  if (!(maxColumns > 0)) throw new Error("maxColumns must be > 0");

  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let totalRows = 0;
  let maxRowWidth = 0;
  let rowWidth = 0;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once the current row has any content (a field or delimiter), so a trailing newline
  // does not produce an extra empty row.
  let rowStarted = false;

  const endField = () => {
    if (row.length < maxColumns) row.push(field);
    rowWidth += 1;
    field = "";
  };
  const endRow = () => {
    endField();
    if (totalRows < maxRows) rows.push(row);
    totalRows += 1;
    maxRowWidth = Math.max(maxRowWidth, rowWidth);
    rowWidth = 0;
    row = [];
    rowStarted = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      rowStarted = true;
    } else if (ch === delimiter) {
      endField();
      rowStarted = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
      rowStarted = true;
    }
  }
  if (rowStarted || field.length > 0) endRow();
  return { rows, totalRows, maxRowWidth };
}

export function csvDelimiterForPath(path: string): string {
  return path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
}
