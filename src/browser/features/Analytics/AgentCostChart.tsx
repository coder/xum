import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { AgentCostItem } from "@/browser/hooks/useAnalytics";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  formatCompactNumber,
  formatUsd,
  formatUsdAxisTick,
} from "./analyticsUtils";

interface AgentCostChartProps {
  data: AgentCostItem[] | null;
  loading: boolean;
  error: string | null;
}

function isAgentCostItem(value: unknown): value is AgentCostItem {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<AgentCostItem>;
  return (
    typeof record.agentId === "string" &&
    typeof record.costUsd === "number" &&
    typeof record.tokenCount === "number" &&
    typeof record.responseCount === "number"
  );
}

function AgentCostTooltipContent(props: {
  active?: boolean;
  payload?: Array<{ payload?: unknown }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }

  const firstPayload = props.payload[0];
  if (!firstPayload || !isAgentCostItem(firstPayload.payload)) {
    return null;
  }

  const row = firstPayload.payload;

  return (
    <div
      className="bg-background-secondary border-border-medium rounded-md border p-2 text-xs"
      style={{ minWidth: 180 }}
    >
      <div className="text-foreground mb-1 font-medium">{row.agentId}</div>
      <div className="text-muted flex items-center justify-between gap-2">
        <span>Cost</span>
        <span className="text-foreground font-mono">{formatUsd(row.costUsd)}</span>
      </div>
      <div className="text-muted flex items-center justify-between gap-2">
        <span>Tokens</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.tokenCount)}</span>
      </div>
      <div className="text-muted flex items-center justify-between gap-2">
        <span>Responses</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.responseCount)}</span>
      </div>
    </div>
  );
}

export function AgentCostChart(props: AgentCostChartProps) {
  const rows = [...(props.data ?? [])].sort((a, b) => b.costUsd - a.costUsd).slice(0, 10);

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-semibold">Agent cost breakdown</h2>
      <p className="text-muted mt-1 text-xs">Top agents by cumulative spend.</p>

      {props.error ? (
        <p className="text-danger mt-3 text-xs">Failed to load agent breakdown: {props.error}</p>
      ) : props.loading ? (
        <div className="mt-3">
          <Skeleton variant="shimmer" className="h-72 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No agent-level spend data available.
        </div>
      ) : (
        <div className="mt-3 h-72 w-full">
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
                tickFormatter={(value: number) => formatUsdAxisTick(Number(value))}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis
                type="category"
                dataKey="agentId"
                width={140}
                tick={CHART_AXIS_TICK}
                stroke={CHART_AXIS_STROKE}
              />
              <Tooltip
                cursor={{ fill: "var(--color-hover)" }}
                content={(tooltipProps) => <AgentCostTooltipContent {...tooltipProps} />}
              />
              <Bar dataKey="costUsd" fill={ANALYTICS_CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
