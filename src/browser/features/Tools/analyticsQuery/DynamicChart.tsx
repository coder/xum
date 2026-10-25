import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { renderLegendLabel } from "@/browser/features/Analytics/chartLegend";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  formatCompactNumber,
  formatUsd,
} from "@/browser/features/Analytics/analyticsUtils";
import type { ChartType, DrillDownContext } from "./types";

interface DynamicChartProps {
  chartType: Exclude<ChartType, "table">;
  data: Array<Record<string, unknown>>;
  xAxis: string;
  yAxes: string[];
  onDrillDown?: (context: DrillDownContext) => void;
}

type ChartRow = Record<string, string | number | null>;

function normalizeChartRows(data: Array<Record<string, unknown>>, yAxes: string[]): ChartRow[] {
  const rows: ChartRow[] = [];

  for (const row of data) {
    const normalized: ChartRow = {};

    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number") {
        normalized[key] = Number.isFinite(value) ? value : 0;
      } else if (typeof value === "string") {
        normalized[key] = value;
      } else if (typeof value === "boolean" || typeof value === "bigint") {
        normalized[key] = String(value);
      } else if (value === null || value === undefined) {
        normalized[key] = "";
      } else {
        try {
          normalized[key] = JSON.stringify(value);
        } catch {
          normalized[key] = "[unserializable value]";
        }
      }
    }

    // DuckDB sometimes returns numeric-looking values as strings. Normalize Y axes to numbers
    // so recharts can scale them reliably while preserving NULLs as gaps.
    for (const yAxis of yAxes) {
      const raw = row[yAxis];
      if (raw === null || raw === undefined) {
        normalized[yAxis] = null;
        continue;
      }

      const numericValue = typeof raw === "number" ? raw : Number(raw);
      normalized[yAxis] = Number.isFinite(numericValue) ? numericValue : null;
    }

    rows.push(normalized);
  }

  return rows;
}

function formatMetricValue(metricName: string, value: number): string {
  const normalizedMetricName = metricName.toLowerCase();
  if (normalizedMetricName.includes("cost") || normalizedMetricName.includes("usd")) {
    return formatUsd(value);
  }

  if (normalizedMetricName.includes("token")) {
    return value.toLocaleString();
  }

  return formatCompactNumber(value);
}

function extractPayload(rowLike: unknown): Record<string, unknown> | null {
  if (!rowLike || typeof rowLike !== "object") {
    return null;
  }

  const withPayload = rowLike as { payload?: unknown };
  if (withPayload.payload && typeof withPayload.payload === "object") {
    return withPayload.payload as Record<string, unknown>;
  }

  return rowLike as Record<string, unknown>;
}

// Shared tooltip formatter for all chart types — converts raw recharts values to
// human-readable strings using metric-name heuristics (cost → USD, tokens → locale, etc.).
function formatTooltipValue(value: unknown, name: string): [string, string] {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue)) {
    return [formatMetricValue(name, numericValue), name];
  }
  return [String(value), name];
}

function getDrillDownValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

export function DynamicChart(props: DynamicChartProps): JSX.Element {
  if (props.data.length === 0 || props.xAxis.length === 0 || props.yAxes.length === 0) {
    return (
      <div className="border-border-medium text-muted rounded border border-dashed px-2 py-3 text-[11px]">
        Not enough structured data to render a chart.
      </div>
    );
  }

  const chartRows = normalizeChartRows(props.data, props.yAxes);

  const handlePointClick = (rowLike: unknown) => {
    if (!props.onDrillDown) {
      return;
    }

    const payload = extractPayload(rowLike);
    if (!payload) {
      return;
    }

    const clickedValue = payload[props.xAxis];
    if (clickedValue === null || clickedValue === undefined) {
      return;
    }

    props.onDrillDown({
      clickedValue: getDrillDownValue(clickedValue),
      columnName: props.xAxis,
      chartType: props.chartType,
    });
  };

  if (props.chartType === "pie") {
    const primaryYAxis = props.yAxes[0];

    return (
      <div className="h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip formatter={formatTooltipValue} contentStyle={CHART_TOOLTIP_CONTENT_STYLE} />
            <Legend wrapperStyle={{ fontSize: "11px" }} formatter={renderLegendLabel} />
            <Pie
              data={chartRows}
              nameKey={props.xAxis}
              dataKey={primaryYAxis}
              outerRadius={90}
              onClick={(sliceData: unknown) => handlePointClick(sliceData)}
            >
              {chartRows.map((row, index) => (
                <Cell
                  key={`pie-cell-${String(row[props.xAxis])}`}
                  fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const commonChartProps = {
    data: chartRows,
    margin: { top: 8, right: 12, left: 4, bottom: 0 },
  };

  const sharedAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke={CHART_AXIS_STROKE} />
      <XAxis
        dataKey={props.xAxis}
        minTickGap={24}
        tick={CHART_AXIS_TICK}
        stroke={CHART_AXIS_STROKE}
      />
      <YAxis
        tick={CHART_AXIS_TICK}
        tickFormatter={(value: number) => formatCompactNumber(Number(value))}
        stroke={CHART_AXIS_STROKE}
      />
      <Tooltip
        formatter={formatTooltipValue}
        cursor={{ fill: "var(--color-hover)" }}
        contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
      />
      <Legend wrapperStyle={{ fontSize: "11px" }} formatter={renderLegendLabel} />
    </>
  );

  const seriesBars = props.yAxes.map((yAxis, index) => (
    <Bar
      key={yAxis}
      dataKey={yAxis}
      fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
      onClick={(barData: unknown) => handlePointClick(barData)}
      stackId={props.chartType === "stacked_bar" ? "stacked-values" : undefined}
    />
  ));

  const seriesLines = props.yAxes.map((yAxis, index) => (
    <Line
      key={yAxis}
      dataKey={yAxis}
      stroke={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
      strokeWidth={2}
      dot={{ r: 2 }}
      activeDot={{ r: 4 }}
      onClick={(lineData: unknown) => handlePointClick(lineData)}
    />
  ));

  const seriesAreas = props.yAxes.map((yAxis, index) => (
    <Area
      key={yAxis}
      dataKey={yAxis}
      stroke={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
      fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
      fillOpacity={0.28}
      onClick={(areaData: unknown) => handlePointClick(areaData)}
    />
  ));

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        {props.chartType === "bar" || props.chartType === "stacked_bar" ? (
          <BarChart {...commonChartProps}>
            {sharedAxes}
            {seriesBars}
          </BarChart>
        ) : props.chartType === "line" ? (
          <LineChart {...commonChartProps}>
            {sharedAxes}
            {seriesLines}
          </LineChart>
        ) : props.chartType === "area" ? (
          <AreaChart {...commonChartProps}>
            {sharedAxes}
            {seriesAreas}
          </AreaChart>
        ) : (
          (() => {
            const exhaustiveCheck: never = props.chartType;
            return exhaustiveCheck;
          })()
        )}
      </ResponsiveContainer>
    </div>
  );
}
