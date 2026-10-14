import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { ProviderCacheHitRatioItem } from "@/browser/hooks/useAnalytics";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  formatCompactNumber,
  formatPercent,
} from "./analyticsUtils";

interface ProviderCacheHitChartProps {
  data: ProviderCacheHitRatioItem[] | null;
  loading: boolean;
  error: string | null;
}

interface ProviderCacheHitChartRow extends ProviderCacheHitRatioItem {
  providerLabel: string;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  unknown: "Unknown",
};

function formatProviderLabel(provider: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return "Unknown";
  }

  return PROVIDER_DISPLAY_NAMES[normalizedProvider] ?? provider;
}

function isProviderCacheHitChartRow(value: unknown): value is ProviderCacheHitChartRow {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<ProviderCacheHitChartRow>;
  return (
    typeof record.provider === "string" &&
    typeof record.providerLabel === "string" &&
    typeof record.cacheHitRatio === "number" &&
    typeof record.responseCount === "number"
  );
}

function ProviderCacheHitTooltipContent(props: {
  active?: boolean;
  payload?: Array<{ payload?: unknown }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }

  const firstPayload = props.payload[0];
  if (!firstPayload || !isProviderCacheHitChartRow(firstPayload.payload)) {
    return null;
  }

  const row = firstPayload.payload;

  return (
    <div
      className="bg-background-secondary border-border-medium rounded-md border p-2 text-xs"
      style={{ minWidth: 200 }}
    >
      <div className="text-foreground mb-1 font-medium">{row.providerLabel}</div>
      <div className="text-muted flex items-center justify-between gap-2">
        <span>Cache hit ratio</span>
        <span className="text-foreground font-mono">{formatPercent(row.cacheHitRatio)}</span>
      </div>
      <div className="text-muted flex items-center justify-between gap-2">
        {/* Chat turns only: background rows are not counted yet (#5778). */}
        <span>Chat responses</span>
        <span className="text-foreground font-mono">{formatCompactNumber(row.responseCount)}</span>
      </div>
    </div>
  );
}

export function ProviderCacheHitChart(props: ProviderCacheHitChartProps) {
  const rows: ProviderCacheHitChartRow[] = [...(props.data ?? [])]
    .sort((left, right) => right.responseCount - left.responseCount)
    .slice(0, 10)
    .map((row) => ({
      ...row,
      providerLabel: formatProviderLabel(row.provider),
    }));

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <h2 className="text-foreground text-sm font-semibold">Cache hit ratio by provider</h2>
      <p className="text-muted mt-1 text-xs">Prompt cache hit rate grouped by model provider.</p>

      {props.error ? (
        <p className="text-danger mt-3 text-xs">
          Failed to load provider cache hit ratios: {props.error}
        </p>
      ) : props.loading ? (
        <div className="mt-3">
          <Skeleton variant="shimmer" className="h-72 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
          No provider cache hit data available.
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
                domain={[0, 1]}
                tick={CHART_AXIS_TICK}
                tickFormatter={(value: number) => formatPercent(Number(value))}
                stroke={CHART_AXIS_STROKE}
              />
              <YAxis
                type="category"
                dataKey="providerLabel"
                width={120}
                tick={CHART_AXIS_TICK}
                stroke={CHART_AXIS_STROKE}
              />
              <Tooltip
                cursor={{ fill: "var(--color-hover)" }}
                content={(tooltipProps) => <ProviderCacheHitTooltipContent {...tooltipProps} />}
              />
              <Bar dataKey="cacheHitRatio" fill={ANALYTICS_CHART_COLORS[3]} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
