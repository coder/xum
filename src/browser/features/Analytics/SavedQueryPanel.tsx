import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Code, RefreshCw, Trash2, X } from "lucide-react";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { Button } from "@/browser/components/Button/Button";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { useAnalyticsRawQuery } from "@/browser/hooks/useAnalytics";
import { DynamicChart } from "@/browser/features/Tools/analyticsQuery/DynamicChart";
import { ResultTable } from "@/browser/features/Tools/analyticsQuery/ResultTable";
import { inferAxes, inferChartType } from "@/browser/features/Tools/analyticsQuery/chartHeuristics";
import type { ChartType } from "@/browser/features/Tools/analyticsQuery/types";
import { cn } from "@/common/lib/utils";
import type { SavedQuery } from "@/common/types/savedQueries";
import { getErrorMessage } from "@/common/utils/errors";
import { ChartTypePicker } from "./ChartTypePicker";
import { SavedQuerySqlDialog } from "./SavedQuerySqlDialog";
import { substituteTimeFilter } from "./sqlTimeFilter";

interface SavedQueryPanelProps {
  query: SavedQuery;
  /** Predicate for the dashboard's date-range selection, substituted for the
   *  time-filter placeholder before the saved SQL is executed. */
  timeFilterSql: string;
  onDelete: (id: string) => Promise<void> | void;
  onUpdate: (input: {
    id: string;
    label?: string;
    sql?: string;
    chartType?: string | null;
  }) => Promise<unknown> | void;
}

interface EditableLabelProps {
  label: string;
  onCommit: (nextLabel: string) => Promise<void> | void;
}

const VALID_CHART_TYPES = new Set<ChartType>([
  "table",
  "bar",
  "line",
  "area",
  "pie",
  "stacked_bar",
]);

function normalizeChartType(value: string | null): ChartType | null {
  if (!value) {
    return null;
  }

  return VALID_CHART_TYPES.has(value as ChartType) ? (value as ChartType) : null;
}

function EditableLabel(props: EditableLabelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(props.label);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isEditing) {
      setDraftLabel(props.label);
    }
  }, [props.label, isEditing]);

  const cancelEdit = () => {
    setDraftLabel(props.label);
    setIsEditing(false);
  };

  const commitEdit = async () => {
    const trimmedLabel = draftLabel.trim();
    setIsEditing(false);

    if (!trimmedLabel || trimmedLabel === props.label) {
      setDraftLabel(props.label);
      return;
    }

    setSaving(true);
    try {
      await props.onCommit(trimmedLabel);
    } finally {
      setSaving(false);
    }
  };

  if (isEditing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <input
          value={draftLabel}
          onChange={(event) => setDraftLabel(event.target.value)}
          onBlur={() => {
            void commitEdit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitEdit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          autoFocus
          className="border-border-medium bg-background text-foreground h-7 min-w-[18ch] rounded border px-2 text-sm font-semibold focus:outline-none"
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            void commitEdit();
          }}
          className="text-muted hover:text-foreground h-7 w-7"
          aria-label="Save panel title"
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancelEdit}
          className="text-muted hover:text-foreground h-7 w-7"
          aria-label="Cancel renaming panel"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <TooltipIfPresent tooltip="Double-click to rename panel" side="top" align="start">
      <button
        type="button"
        className="min-w-0 border-none bg-transparent p-0 text-left"
        onDoubleClick={() => {
          setIsEditing(true);
        }}
      >
        <h3 className="text-foreground truncate text-sm font-semibold">{props.label}</h3>
      </button>
    </TooltipIfPresent>
  );
}

export function SavedQueryPanel(props: SavedQueryPanelProps) {
  const { data, loading, error, executeQuery } = useAnalyticsRawQuery();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSqlDialogOpen, setIsSqlDialogOpen] = useState(false);
  const [draftSql, setDraftSql] = useState(props.query.sql);
  const [sqlDialogError, setSqlDialogError] = useState<string | null>(null);
  const [savingSql, setSavingSql] = useState(false);
  const executeQueryRef = useRef(executeQuery);
  const normalizedSavedSql = props.query.sql.trim();
  const normalizedDraftSql = draftSql.trim();
  const saveSqlDisabled =
    savingSql || normalizedDraftSql.length === 0 || normalizedDraftSql === normalizedSavedSql;

  // SQL actually executed for this panel: the saved SQL with the dashboard's
  // active date-range predicate substituted in. Using the resolved string as
  // the effect dependency means only panels that use the placeholder re-run
  // when the header range changes.
  const resolvedSql = substituteTimeFilter(props.query.sql, props.timeFilterSql).trim();

  useEffect(() => {
    executeQueryRef.current = executeQuery;
  }, [executeQuery]);

  useEffect(() => {
    if (!resolvedSql) {
      return;
    }

    void executeQueryRef.current(resolvedSql);
  }, [resolvedSql]);

  const inferredChartType = data ? inferChartType(data.columns, data.rows) : "table";
  const explicitChartType = normalizeChartType(props.query.chartType);
  const effectiveChartType = explicitChartType ?? inferredChartType;
  const axes = data ? inferAxes(data.columns) : { xAxis: "", yAxes: [] };

  const openSqlDialog = () => {
    setDraftSql(props.query.sql);
    setSqlDialogError(null);
    setIsSqlDialogOpen(true);
  };

  const closeSqlDialog = () => {
    if (savingSql) {
      return;
    }

    setDraftSql(props.query.sql);
    setSqlDialogError(null);
    setIsSqlDialogOpen(false);
  };

  const handleRefresh = () => {
    if (loading) {
      return;
    }

    if (!resolvedSql) {
      return;
    }

    void executeQuery(resolvedSql);
  };

  const handleDelete = async () => {
    setActionError(null);
    try {
      await props.onDelete(props.query.id);
    } catch (deleteError) {
      setActionError(getErrorMessage(deleteError));
    }
  };

  const handleRename = async (nextLabel: string) => {
    setActionError(null);
    try {
      await props.onUpdate({ id: props.query.id, label: nextLabel });
    } catch (updateError) {
      setActionError(getErrorMessage(updateError));
    }
  };

  const handleChartTypeChange = async (nextType: ChartType) => {
    setActionError(null);
    try {
      await props.onUpdate({ id: props.query.id, chartType: nextType });
    } catch (updateError) {
      setActionError(getErrorMessage(updateError));
    }
  };

  const handleSaveSql = async () => {
    const normalizedSavedQueryId = props.query.id.trim();

    if (!normalizedSavedQueryId) {
      setSqlDialogError("This saved panel is missing its ID and cannot be updated.");
      return;
    }

    if (!normalizedDraftSql) {
      setSqlDialogError("SQL cannot be empty.");
      return;
    }

    if (normalizedDraftSql === normalizedSavedSql) {
      closeSqlDialog();
      return;
    }

    setSavingSql(true);
    setSqlDialogError(null);
    try {
      await props.onUpdate({ id: normalizedSavedQueryId, sql: normalizedDraftSql });
      closeSqlDialog();
    } catch (updateError) {
      setSqlDialogError(getErrorMessage(updateError));
    } finally {
      setSavingSql(false);
    }
  };

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <EditableLabel label={props.query.label} onCommit={handleRename} />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={openSqlDialog}
            aria-label="View or edit SQL"
            className="text-muted hover:text-foreground h-7 w-7"
          >
            <Code className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={loading}
            aria-label="Refresh saved query"
            className="text-muted hover:text-foreground h-7 w-7"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void handleDelete();
            }}
            aria-label="Delete saved query"
            className="text-muted hover:text-danger h-7 w-7"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="border-border-light mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <ChartTypePicker
          activeType={effectiveChartType}
          onSelect={(type) => void handleChartTypeChange(type)}
        />
        {data && (
          <div className="text-muted text-[10px]">
            {data.rowCount.toLocaleString()}
            {data.rowCountExact ? "" : "+"} rows · {data.durationMs}ms
            {data.truncated && " · Results truncated"}
          </div>
        )}
      </div>

      {actionError && (
        <div className="border-danger-soft bg-danger-soft/10 text-danger mt-3 flex items-start gap-2 rounded-lg border p-3 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex-1 font-mono whitespace-pre-wrap">{actionError}</div>
        </div>
      )}

      {error ? (
        <div className="border-danger-soft bg-danger-soft/10 text-danger mt-3 flex items-start gap-2 rounded-lg border p-3 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex-1 font-mono whitespace-pre-wrap">{error}</div>
        </div>
      ) : loading && !data ? (
        <div className="mt-3">
          <Skeleton variant="shimmer" className="h-72 w-full" />
        </div>
      ) : data ? (
        <div className="bg-background border-border-light mt-3 min-h-[300px] overflow-hidden rounded-lg border">
          {effectiveChartType === "table" || axes.yAxes.length === 0 || axes.xAxis.length === 0 ? (
            <ResultTable columns={data.columns} rows={data.rows} chartType={effectiveChartType} />
          ) : (
            <div className="p-4">
              <DynamicChart
                chartType={effectiveChartType}
                data={data.rows}
                xAxis={axes.xAxis}
                yAxes={axes.yAxes}
              />
            </div>
          )}
        </div>
      ) : (
        <p className="text-muted mt-3 text-xs">Run the saved query to view results.</p>
      )}

      <SavedQuerySqlDialog
        open={isSqlDialogOpen}
        label={props.query.label}
        sql={draftSql}
        saving={savingSql}
        saveDisabled={saveSqlDisabled}
        error={sqlDialogError}
        onSqlChange={setDraftSql}
        onOpenChange={(open) => {
          if (open) {
            openSqlDialog();
            return;
          }

          closeSqlDialog();
        }}
        onSave={() => {
          void handleSaveSql();
        }}
      />
    </div>
  );
}
