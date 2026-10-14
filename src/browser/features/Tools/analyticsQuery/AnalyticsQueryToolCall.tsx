import { lazy, useEffect, useState, type ComponentType } from "react";
import {
  AlertTriangle,
  AreaChart as AreaChartIcon,
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Table,
} from "lucide-react";
import { LazyFeature } from "@/browser/components/LazyFeature/LazyFeature";
import { useRouter } from "@/browser/contexts/RouterContext";
import { useSavedQueries } from "@/browser/hooks/useAnalytics";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";
import {
  DetailContent,
  DetailSection,
  ErrorBox,
  ExpandIcon,
  HeaderButton,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "../Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
  useToolExpansion,
} from "../Shared/toolUtils";
import { inferAxes, inferChartType } from "./chartHeuristics";
import { ResultTable } from "./ResultTable";
import type {
  AnalyticsQueryArgs,
  AnalyticsQueryResult,
  AnalyticsQueryToolResult,
  ChartType,
  DrillDownContext,
} from "./types";

// Lazy so `recharts` stays off the first load (T3, #5971): charts render only in analytics cards.
const DynamicChart = lazy(() =>
  import("./DynamicChart").then((m) => ({ default: m.DynamicChart }))
);

interface AnalyticsQueryToolCallProps {
  args: AnalyticsQueryArgs;
  result?: AnalyticsQueryToolResult;
  status?: ToolStatus;
}

interface ChartTypeOption {
  type: ChartType;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; chartType: ChartType }
  | { status: "error"; message: string }
  | { status: "unavailable" };

const SAVED_QUERY_UNAVAILABLE_MESSAGE = "Analytics dashboard saving is unavailable in this build.";

const CHART_TYPE_OPTIONS: ChartTypeOption[] = [
  { type: "table", icon: Table, label: "Table" },
  { type: "bar", icon: BarChart3, label: "Bar" },
  { type: "line", icon: LineChartIcon, label: "Line" },
  { type: "area", icon: AreaChartIcon, label: "Area" },
  { type: "pie", icon: PieChartIcon, label: "Pie" },
  { type: "stacked_bar", icon: BarChart3, label: "Stacked" },
];

function isAnalyticsQuerySuccessResult(result: unknown): result is AnalyticsQueryResult {
  if (!result || typeof result !== "object") {
    return false;
  }

  const parsedResult = result as Record<string, unknown>;

  return (
    parsedResult.success === true &&
    Array.isArray(parsedResult.columns) &&
    Array.isArray(parsedResult.rows) &&
    typeof parsedResult.rowCount === "number" &&
    typeof parsedResult.durationMs === "number"
  );
}

function escapeDoubleQuotes(value: string): string {
  return value.replaceAll('"', '\\"');
}

export function AnalyticsQueryToolCall(props: AnalyticsQueryToolCallProps): JSX.Element {
  const { expanded, toggleExpanded } = useToolExpansion(true);
  // Rationale: chat cards only use save(), so skip the saved-query preload until the user opts in.
  const { save } = useSavedQueries({ skipLoad: true });
  const { navigateToAnalytics } = useRouter();
  const [chartTypeOverride, setChartTypeOverride] = useState<ChartType | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });

  const status = props.status ?? "pending";
  const errorResult = isToolErrorResult(props.result) ? props.result : null;
  const successResult = isAnalyticsQuerySuccessResult(props.result) ? props.result : null;

  const inferredChartType = successResult
    ? inferChartType(successResult.columns, successResult.rows)
    : "table";
  // Rationale: user override should always win, then model hint, then local heuristic fallback.
  const effectiveChartType = chartTypeOverride ?? successResult?.visualization ?? inferredChartType;

  const axes = successResult
    ? inferAxes(successResult.columns, successResult.x_axis, successResult.y_axis)
    : { xAxis: "", yAxes: [] };

  const title = props.args.title ?? successResult?.title ?? "Query results";
  const isRowCountLowerBound = successResult?.rowCountExact === false;

  useEffect(() => {
    if (saveState.status === "saved" && saveState.chartType !== effectiveChartType) {
      setSaveState({ status: "idle" });
    }
  }, [effectiveChartType, saveState]);

  const handleDrillDown = (context: DrillDownContext) => {
    if (typeof window === "undefined") {
      return;
    }

    const escapedValue = escapeDoubleQuotes(context.clickedValue);
    const text = `Drill down into rows where ${context.columnName} = "${escapedValue}" from the previous query`;

    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.UPDATE_CHAT_INPUT, {
        text,
        mode: "replace",
      })
    );
  };

  const handleSaveToAnalyticsDashboard = async () => {
    if (saveState.status === "saving") {
      return;
    }

    const chartTypeToSave = effectiveChartType;
    setSaveState({ status: "saving" });

    try {
      const savedQuery = await save({
        // Rationale: reuse the exact label already rendered in chat so the saved panel matches
        // the message the user is looking at.
        label: title,
        sql: props.args.sql,
        chartType: chartTypeToSave,
      });

      if (!savedQuery) {
        setSaveState({ status: "unavailable" });
        return;
      }

      setSaveState({ status: "saved", chartType: chartTypeToSave });
    } catch (error) {
      setSaveState({ status: "error", message: getErrorMessage(error) });
    }
  };

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="analytics_query" />
        <ToolName>{title}</ToolName>
        {successResult && (
          <span className="text-muted text-[10px] whitespace-nowrap">
            {successResult.rowCount.toLocaleString()}
            {isRowCountLowerBound ? "+" : ""} rows · {successResult.durationMs}ms
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {errorResult && (
            <>
              <ErrorBox>{errorResult.error}</ErrorBox>
              <DetailSection>
                <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">SQL</div>
                <DetailContent className="px-2 py-1.5">{props.args.sql}</DetailContent>
              </DetailSection>
            </>
          )}

          {successResult && (
            <>
              {successResult.truncated && (
                <div className="text-warning mb-2 flex items-center gap-1 text-[10px]">
                  <AlertTriangle className="size-3" />
                  Showing {successResult.rows.length.toLocaleString()} of{" "}
                  {successResult.rowCount.toLocaleString()}
                  {isRowCountLowerBound ? "+" : ""} rows (results truncated).
                </div>
              )}

              <div className="mb-2 flex flex-wrap gap-1">
                {CHART_TYPE_OPTIONS.map((option) => (
                  <HeaderButton
                    key={option.type}
                    type="button"
                    active={effectiveChartType === option.type}
                    onClick={() => setChartTypeOverride(option.type)}
                    className={cn("inline-flex items-center gap-1")}
                  >
                    <option.icon className="size-3" />
                    {option.label}
                  </HeaderButton>
                ))}
              </div>

              <div className="mb-2 flex flex-wrap items-center gap-2">
                {saveState.status === "saved" ? (
                  <>
                    <span className="text-success text-[10px]" role="status">
                      Added to analytics dashboard.
                    </span>
                    <HeaderButton
                      type="button"
                      onClick={navigateToAnalytics}
                      className="disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Open dashboard
                    </HeaderButton>
                  </>
                ) : (
                  <HeaderButton
                    type="button"
                    onClick={() => {
                      void handleSaveToAnalyticsDashboard();
                    }}
                    disabled={saveState.status === "saving"}
                    className="disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saveState.status === "saving" ? "Adding..." : "Add to analytics dashboard"}
                  </HeaderButton>
                )}

                {saveState.status === "error" && (
                  <span className="text-danger text-[10px]" role="alert">
                    {saveState.message}
                  </span>
                )}

                {saveState.status === "unavailable" && (
                  <span className="text-warning text-[10px]" role="status">
                    {SAVED_QUERY_UNAVAILABLE_MESSAGE}
                  </span>
                )}
              </div>

              {effectiveChartType === "table" ||
              axes.yAxes.length === 0 ||
              axes.xAxis.length === 0 ? (
                <ResultTable
                  columns={successResult.columns}
                  rows={successResult.rows}
                  onDrillDown={handleDrillDown}
                  chartType={effectiveChartType}
                />
              ) : (
                // The fallback reserves the chart's own 300px box, so the chunk's arrival does not
                // shift the card. Only DynamicChart's rare "Not enough structured data" notice is
                // shorter, so that case shifts once.
                <LazyFeature name="Chart" fallback={<div className="h-[300px] w-full" />}>
                  <DynamicChart
                    chartType={effectiveChartType}
                    data={successResult.rows}
                    xAxis={axes.xAxis}
                    yAxes={axes.yAxes}
                    onDrillDown={handleDrillDown}
                  />
                </LazyFeature>
              )}

              <button
                type="button"
                onClick={() => setShowSql(!showSql)}
                className="text-muted hover:text-foreground mt-2 text-[10px] transition-colors"
              >
                {showSql ? "Hide SQL" : "Show SQL"}
              </button>

              {showSql && (
                <DetailSection>
                  <DetailContent className="px-2 py-1.5">{props.args.sql}</DetailContent>
                </DetailSection>
              )}
            </>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
