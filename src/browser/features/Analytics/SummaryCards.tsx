import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type { Summary } from "@/browser/hooks/useAnalytics";
import { formatCompactNumber, formatPercent, formatUsd } from "./analyticsUtils";

interface SummaryCardsProps {
  data: Summary | null;
  loading: boolean;
  error: string | null;
}

export function SummaryCards(props: SummaryCardsProps) {
  if (props.error) {
    return (
      <div className="bg-background-secondary border-danger-soft text-danger rounded-lg border px-3 py-2 text-xs">
        Failed to load analytics summary: {props.error}
      </div>
    );
  }

  const totalSpend = props.data ? formatUsd(props.data.totalSpendUsd) : "$0.00";
  const todaySpend = props.data ? formatUsd(props.data.todaySpendUsd) : "$0.00";
  const avgDailySpend = props.data ? formatUsd(props.data.avgDailySpendUsd) : "$0.00";
  const cacheHitRatio = props.data ? formatPercent(props.data.cacheHitRatio) : "0.0%";

  const summaryRows = [
    {
      label: "Total Spend",
      value: totalSpend,
      helper: props.data ? `${formatCompactNumber(props.data.totalTokens)} tokens` : null,
    },
    {
      label: "Today",
      value: todaySpend,
      helper: null,
    },
    {
      label: "Avg / Day",
      value: avgDailySpend,
      helper: null,
    },
    {
      label: "Cache Hit Ratio",
      value: cacheHitRatio,
      // Chat turns only: background rows are not counted yet (#5778).
      helper: props.data
        ? `${formatCompactNumber(props.data.totalResponses)} ${props.data.totalResponses === 1 ? "chat response" : "chat responses"}`
        : null,
    },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {summaryRows.map((row) => (
        <div
          key={row.label}
          className="bg-background-secondary border-border-medium flex min-h-20 flex-col rounded-lg border p-3"
        >
          <div className="text-muted text-xs">{row.label}</div>
          {props.loading ? (
            <Skeleton variant="shimmer" className="mt-1 h-6 w-20" />
          ) : (
            <div className="text-foreground mt-1 font-mono text-lg font-semibold">{row.value}</div>
          )}
          {row.helper && !props.loading && (
            <div className="text-muted mt-1 text-[11px]">{row.helper}</div>
          )}
        </div>
      ))}
    </div>
  );
}
