import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import type {
  AsyncState,
  SpendByModelItem,
  SpendByProjectItem,
} from "@/browser/hooks/useAnalytics";
import {
  ANALYTICS_CHART_COLORS,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE,
  formatProjectDisplayName,
  formatUsd,
  formatUsdAxisTick,
} from "./analyticsUtils";

interface ModelBreakdownProps {
  spendByProject: AsyncState<SpendByProjectItem[]>;
  spendByModel: AsyncState<SpendByModelItem[]>;
}

interface ProjectChartRow extends SpendByProjectItem {
  label: string;
}

export function ModelBreakdown(props: ModelBreakdownProps) {
  const projectRows: ProjectChartRow[] = (props.spendByProject.data ?? [])
    .map((row) => ({
      ...row,
      label:
        row.projectName.trim().length > 0
          ? row.projectName
          : formatProjectDisplayName(row.projectPath),
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8);

  const modelRows = [...(props.spendByModel.data ?? [])]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 8);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
        <h2 className="text-foreground text-sm font-semibold">Spend by project</h2>

        {props.spendByProject.error ? (
          <p className="text-danger mt-2 text-xs">{props.spendByProject.error}</p>
        ) : props.spendByProject.loading ? (
          <div className="mt-3">
            <Skeleton variant="shimmer" className="h-72 w-full" />
          </div>
        ) : projectRows.length === 0 ? (
          <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
            No project spend data yet.
          </div>
        ) : (
          <div className="mt-3 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={projectRows}
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
                  dataKey="label"
                  width={120}
                  tick={CHART_AXIS_TICK}
                  stroke={CHART_AXIS_STROKE}
                />
                <Tooltip
                  formatter={(value: number) => [formatUsd(Number(value)), "Spend"]}
                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                />
                <Bar dataKey="costUsd" fill={ANALYTICS_CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
        <h2 className="text-foreground text-sm font-semibold">Spend by model</h2>

        {props.spendByModel.error ? (
          <p className="text-danger mt-2 text-xs">{props.spendByModel.error}</p>
        ) : props.spendByModel.loading ? (
          <div className="mt-3">
            <Skeleton variant="shimmer" className="h-72 w-full" />
          </div>
        ) : modelRows.length === 0 ? (
          <div className="text-muted mt-3 rounded border border-dashed px-3 py-10 text-center text-sm">
            No model spend data yet.
          </div>
        ) : (
          <div className="mt-3 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={modelRows}
                  dataKey="costUsd"
                  nameKey="model"
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={94}
                  paddingAngle={2}
                >
                  {modelRows.map((row, index) => (
                    <Cell
                      key={row.model}
                      fill={ANALYTICS_CHART_COLORS[index % ANALYTICS_CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number, key: string) => [formatUsd(Number(value)), key]}
                  contentStyle={{
                    ...CHART_TOOLTIP_CONTENT_STYLE,
                    color: "var(--color-foreground)",
                  }}
                  labelStyle={{ color: "var(--color-foreground)" }}
                  itemStyle={{ color: "var(--color-foreground)" }}
                />
                <Legend
                  wrapperStyle={{ fontSize: "11px" }}
                  formatter={(value) => (
                    <span style={{ color: "var(--color-foreground)" }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
