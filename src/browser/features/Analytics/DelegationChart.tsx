import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { renderLegendLabel } from "./chartLegend";
import { capitalize } from "@/common/utils/capitalize";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { DelegationSummary } from "@/browser/hooks/useAnalytics";
import {
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  TOKEN_CATEGORY_COLORS,
  formatCompactNumber,
  formatUsd,
} from "./analyticsUtils";

interface DelegationChartProps {
  data: DelegationSummary | null;
  loading: boolean;
  error: string | null;
}

interface DelegationChartRow {
  label: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
}

const DELEGATION_TOKEN_CATEGORIES: Array<{
  key: keyof Omit<DelegationChartRow, "label" | "totalTokens">;
  label: string;
  color: string;
}> = [
  { key: "inputTokens", label: "Input", color: TOKEN_CATEGORY_COLORS.inputTokens },
  { key: "cachedTokens", label: "Cached", color: TOKEN_CATEGORY_COLORS.cachedTokens },
  {
    key: "cacheCreateTokens",
    label: "Cache write",
    color: TOKEN_CATEGORY_COLORS.cacheCreateTokens,
  },
  { key: "outputTokens", label: "Output", color: TOKEN_CATEGORY_COLORS.outputTokens },
  { key: "reasoningTokens", label: "Reasoning", color: TOKEN_CATEGORY_COLORS.reasoningTokens },
];

function formatCompressionRatio(compressionRatio: number): string {
  if (!Number.isFinite(compressionRatio) || compressionRatio <= 0) {
    return "N/A";
  }

  return `${compressionRatio.toFixed(1)}x`;
}

function isDelegationChartRow(value: unknown): value is DelegationChartRow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<DelegationChartRow>;
  return (
    typeof record.label === "string" &&
    typeof record.inputTokens === "number" &&
    typeof record.cachedTokens === "number" &&
    typeof record.cacheCreateTokens === "number" &&
    typeof record.outputTokens === "number" &&
    typeof record.reasoningTokens === "number" &&
    typeof record.totalTokens === "number"
  );
}

function DelegationTooltipContent(props: {
  active?: boolean;
  payload?: Array<{ payload?: unknown }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }

  const firstPayload = props.payload[0];
  if (!firstPayload || !isDelegationChartRow(firstPayload.payload)) {
    return null;
  }

  const row = firstPayload.payload;
  const categoriesWithData = DELEGATION_TOKEN_CATEGORIES.filter(
    (category) => row[category.key] > 0
  );

  return (
    <div
      className="bg-background-secondary border-border-medium rounded-md border p-2 text-xs"
      style={{ minWidth: 200 }}
    >
      <div className="text-foreground mb-1 font-medium">{row.label}</div>
      {categoriesWithData.map((category) => (
        <div key={category.key} className="text-muted flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: category.color }}
            />
            {category.label}
          </span>
          <span className="text-foreground font-mono">
            {formatCompactNumber(row[category.key])}
          </span>
        </div>
      ))}
      <div className="border-border-light text-muted mt-1 flex items-center justify-between gap-4 border-t pt-1">
        <span>Total</span>
        <span className="text-foreground font-mono font-medium">
          {formatCompactNumber(row.totalTokens)}
        </span>
      </div>
    </div>
  );
}

export function DelegationChart(props: DelegationChartProps) {
  const rows: DelegationChartRow[] = (props.data?.byAgentType ?? []).map((agent) => {
    const row: DelegationChartRow = {
      label: `${capitalize(agent.agentType)} (${formatCompactNumber(agent.count)})`,
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
      reasoningTokens: agent.reasoningTokens,
      cachedTokens: agent.cachedTokens,
      cacheCreateTokens: agent.cacheCreateTokens,
      totalTokens: agent.totalTokens,
    };

    const categorySum =
      row.inputTokens +
      row.outputTokens +
      row.reasoningTokens +
      row.cachedTokens +
      row.cacheCreateTokens;
    if (categorySum < row.totalTokens) {
      // Legacy data: assign uncategorized tokens to inputTokens as fallback.
      // This handles both fully-legacy rows (all categories 0) and mixed
      // legacy/new rows where GROUP BY aggregates old (0s) + new (populated) rows.
      row.inputTokens += row.totalTokens - categorySum;
    }

    return row;
  });

  const chartHeight = Math.max(256, rows.length * 64);

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-semibold">Delegation insights</h2>
      <p className="text-muted mt-1 text-sm">
        Sub-agent delegation volume, compression, and token usage by agent type.
      </p>

      {props.error ? (
        <p className="text-danger mt-3 text-xs">Failed to load delegation data: {props.error}</p>
      ) : props.loading ? (
        <div className="mt-3 space-y-3">
          <Skeleton variant="shimmer" className="h-20 w-full" />
          <Skeleton variant="shimmer" className="h-64 w-full" />
        </div>
      ) : !props.data || props.data.totalChildren === 0 || rows.length === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No delegation data available.
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="border-border-medium rounded border p-3">
              <p className="text-muted text-xs">Total Delegations</p>
              <p className="text-foreground mt-1 font-mono text-lg font-semibold">
                {props.data.totalChildren}
              </p>
            </div>
            <div className="border-border-medium rounded border p-3">
              <p className="text-muted text-xs">Compression Ratio</p>
              <p className="text-foreground mt-1 font-mono text-lg font-semibold">
                {formatCompressionRatio(props.data.compressionRatio)}
              </p>
            </div>
            <div className="border-border-medium rounded border p-3">
              <p className="text-muted text-xs">Cost Delegated</p>
              <p className="text-foreground mt-1 font-mono text-lg font-semibold">
                {formatUsd(props.data.totalCostDelegated)}
              </p>
            </div>
          </div>

          <div className="mt-3 w-full" style={{ height: chartHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_AXIS_STROKE} />
                <XAxis
                  type="number"
                  tick={CHART_AXIS_TICK}
                  tickFormatter={(value: number) => formatCompactNumber(Number(value))}
                  stroke={CHART_AXIS_STROKE}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={170}
                  tick={CHART_AXIS_TICK}
                  stroke={CHART_AXIS_STROKE}
                />
                <Tooltip
                  cursor={{ fill: "var(--color-hover)" }}
                  content={(tooltipProps) => <DelegationTooltipContent {...tooltipProps} />}
                />
                <Legend wrapperStyle={{ fontSize: "11px" }} formatter={renderLegendLabel} />
                <Bar
                  dataKey="inputTokens"
                  stackId="tokens"
                  fill={TOKEN_CATEGORY_COLORS.inputTokens}
                  name="Input"
                />
                <Bar
                  dataKey="cachedTokens"
                  stackId="tokens"
                  fill={TOKEN_CATEGORY_COLORS.cachedTokens}
                  name="Cached"
                />
                <Bar
                  dataKey="cacheCreateTokens"
                  stackId="tokens"
                  fill={TOKEN_CATEGORY_COLORS.cacheCreateTokens}
                  name="Cache write"
                />
                <Bar
                  dataKey="outputTokens"
                  stackId="tokens"
                  fill={TOKEN_CATEGORY_COLORS.outputTokens}
                  name="Output"
                />
                <Bar
                  dataKey="reasoningTokens"
                  stackId="tokens"
                  fill={TOKEN_CATEGORY_COLORS.reasoningTokens}
                  name="Reasoning"
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
