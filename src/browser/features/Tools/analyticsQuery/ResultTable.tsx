import { useState } from "react";
import { cn } from "@/common/lib/utils";
import { formatResultNumber } from "@/browser/features/Analytics/analyticsUtils";
import { HeaderButton } from "../Shared/ToolPrimitives";
import { isNumericType } from "./chartHeuristics";
import type { ChartType, ColumnMeta, DrillDownContext } from "./types";

const INITIAL_ROW_LIMIT = 50;

interface ResultTableProps {
  columns: ColumnMeta[];
  rows: Array<Record<string, unknown>>;
  onDrillDown?: (context: DrillDownContext) => void;
  chartType: ChartType;
}

function stringifyCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "—";
  }

  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

function formatCellValue(column: ColumnMeta, value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "—";
    }

    return formatResultNumber(column.name, value);
  }

  return stringifyCellValue(value);
}

export function ResultTable(props: ResultTableProps): JSX.Element {
  const [showAllRows, setShowAllRows] = useState(false);

  if (props.columns.length === 0) {
    return (
      <div className="border-border-medium text-muted rounded border border-dashed px-2 py-3 text-[11px]">
        Query returned no columns.
      </div>
    );
  }

  if (props.rows.length === 0) {
    return (
      <div className="border-border-medium text-muted rounded border border-dashed px-2 py-3 text-[11px]">
        Query returned no rows.
      </div>
    );
  }

  const visibleRows = showAllRows ? props.rows : props.rows.slice(0, INITIAL_ROW_LIMIT);

  return (
    <div>
      <div className="border-border-light overflow-auto rounded border">
        <table className="w-full border-collapse text-[11px]">
          <thead className="bg-background-secondary sticky top-0 z-10">
            <tr>
              {props.columns.map((column) => {
                const rightAligned = isNumericType(column.type);

                return (
                  <th
                    key={column.name}
                    className={cn(
                      "text-muted border-border-light border-b px-2 py-1 text-left font-medium",
                      rightAligned && "text-right"
                    )}
                  >
                    {column.name}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`} className="border-border-light border-b last:border-b-0">
                {props.columns.map((column) => {
                  const rawValue = row[column.name];
                  const rightAligned = isNumericType(column.type);
                  const formattedValue = formatCellValue(column, rawValue);
                  const isDrillDownEnabled =
                    props.onDrillDown !== undefined && rawValue !== null && rawValue !== undefined;

                  return (
                    <td
                      key={`${rowIndex}:${column.name}`}
                      className={cn("px-2 py-1.5 align-top", rightAligned && "text-right")}
                    >
                      {isDrillDownEnabled ? (
                        <button
                          type="button"
                          className={cn(
                            "hover:bg-hover w-full rounded px-1 py-0.5 text-left transition-colors",
                            rightAligned && "text-right"
                          )}
                          onClick={() => {
                            props.onDrillDown?.({
                              clickedValue: stringifyCellValue(rawValue),
                              columnName: column.name,
                              chartType: props.chartType,
                            });
                          }}
                        >
                          {formattedValue}
                        </button>
                      ) : (
                        <span>{formattedValue}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!showAllRows && props.rows.length > INITIAL_ROW_LIMIT && (
        <div className="mt-2">
          <HeaderButton type="button" onClick={() => setShowAllRows(true)}>
            Show all {props.rows.length.toLocaleString()} rows
          </HeaderButton>
        </div>
      )}
    </div>
  );
}
