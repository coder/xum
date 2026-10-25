import { csvDelimiterForPath, parseDelimited } from "./csv";
import { ARTIFACT_TABLE_MAX_COLUMNS, ARTIFACT_TABLE_MAX_ROWS, DataTable } from "./DataTable";

export function CsvArtifact(props: { content: string; path: string }) {
  // +1 for the header row.
  const parsed = parseDelimited(
    props.content,
    csvDelimiterForPath(props.path),
    ARTIFACT_TABLE_MAX_ROWS + 1,
    ARTIFACT_TABLE_MAX_COLUMNS
  );
  if (parsed.rows.length === 0) {
    return <div className="text-muted p-4 text-xs">This file is empty.</div>;
  }
  const [header, ...rows] = parsed.rows;
  return (
    <DataTable
      columns={header}
      rows={rows}
      totalRows={parsed.totalRows - 1}
      totalColumns={parsed.maxRowWidth}
    />
  );
}
