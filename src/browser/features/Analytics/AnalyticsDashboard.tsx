import { useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/Dialog/Dialog";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useRouter } from "@/browser/contexts/RouterContext";
import {
  useAnalyticsAgentCostBreakdown,
  useAnalyticsDelegationSummary,
  useAnalyticsProviderCacheHitRatio,
  useAnalyticsSpendByModel,
  useAnalyticsSpendByProject,
  useAnalyticsSpendOverTime,
  useAnalyticsSummary,
  useAnalyticsTimingDistribution,
  useAnalyticsTokensByModel,
  useSavedQueries,
} from "@/browser/hooks/useAnalytics";
import { useModalFocusReturn } from "@/browser/hooks/useModalFocusReturn";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { ToggleGroup } from "@/browser/components/ToggleGroup/ToggleGroup";
import { Button } from "@/browser/components/Button/Button";
import { AgentCostChart } from "./AgentCostChart";
import { DelegationChart } from "./DelegationChart";
import { SavedQueryPanel } from "./SavedQueryPanel";
import { SqlExplorer } from "./SqlExplorer";
import { ProviderCacheHitChart } from "./ProviderCacheHitChart";
import { ModelBreakdown } from "./ModelBreakdown";
import { SpendChart } from "./SpendChart";
import { SummaryCards } from "./SummaryCards";
import { TimingChart } from "./TimingChart";
import { TokensByModelChart } from "./TokensByModelChart";
import { formatProjectDisplayName } from "./analyticsUtils";
import { buildTimeFilterPredicate } from "./sqlTimeFilter";
import {
  ANALYTICS_TIME_RANGE_KEY,
  ANALYTICS_TIMING_METRIC_KEY,
  ANALYTICS_TIME_ZONE_MODE_KEY,
} from "@/common/constants/storage";

type TimeRange = "7d" | "30d" | "90d" | "all";
type TimingMetric = "ttft" | "duration" | "tps";
type TimeZoneMode = "local" | "utc";

const VALID_TIME_RANGES = new Set<string>(["7d", "30d", "90d", "all"]);
const VALID_TIMING_METRICS = new Set<string>(["ttft", "duration", "tps"]);

const VALID_TIME_ZONE_MODES = new Set<string>(["local", "utc"]);

/** Coerce a persisted value to a known TimeRange, falling back to "30d" if stale/corrupted. */
function normalizeTimeRange(value: unknown): TimeRange {
  return typeof value === "string" && VALID_TIME_RANGES.has(value) ? (value as TimeRange) : "30d";
}

/** Coerce a persisted value to a known TimingMetric, falling back to "duration" if stale/corrupted. */
function normalizeTimingMetric(value: unknown): TimingMetric {
  return typeof value === "string" && VALID_TIMING_METRICS.has(value)
    ? (value as TimingMetric)
    : "duration";
}

/** Build a calendar-date boundary for the selected timezone. */
function getDateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (year == null || month == null || day == null) {
    throw new Error(`Unable to format date for timezone ${timeZone}`);
  }

  return `${year}-${month}-${day}`;
}

function dateFromDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function daysAgoInTimeZone(days: number, timeZone: string): Date {
  const dateKey = getDateKeyInTimeZone(new Date(), timeZone);
  const date = dateFromDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function computeDateRange(
  timeRange: TimeRange,
  timeZone: string
): {
  from: Date | null;
  to: Date | null;
  granularity: "hour" | "day" | "week";
} {
  switch (timeRange) {
    case "7d":
      return { from: daysAgoInTimeZone(6, timeZone), to: null, granularity: "day" };
    case "30d":
      return { from: daysAgoInTimeZone(29, timeZone), to: null, granularity: "day" };
    case "90d":
      return { from: daysAgoInTimeZone(89, timeZone), to: null, granularity: "week" };
    case "all":
      return { from: null, to: null, granularity: "week" };
    default:
      // Self-heal: unknown persisted value → safe default.
      return { from: daysAgoInTimeZone(29, timeZone), to: null, granularity: "day" };
  }
}

/** Coerce a persisted value to a supported timezone mode. */
function normalizeTimeZoneMode(value: unknown): TimeZoneMode {
  return typeof value === "string" && VALID_TIME_ZONE_MODES.has(value)
    ? (value as TimeZoneMode)
    : "local";
}

function getBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Analytics renders as a route-backed modal over the page it was opened from (like Settings), so
 * the chat underneath stays mounted and keeps its draft and scroll position.
 */
export function AnalyticsDashboard() {
  const { isAnalyticsOpen, navigateFromAnalytics } = useRouter();
  const focusReturn = useModalFocusReturn(isAnalyticsOpen);

  return (
    <Dialog open={isAnalyticsOpen} onOpenChange={(open) => !open && navigateFromAnalytics()}>
      {/* Phone widths get a full-screen sheet; md+ gets a large centered dialog. */}
      <DialogContent
        showCloseButton={false}
        // Escape in the SQL explorer (or any other text field) stays with that field instead of
        // closing the dialog, which would unmount unsaved query text. This matches Settings and
        // the previous page-level Escape handler, which also ignored editable targets. A focused
        // <select> (the autofocused project filter) still lets Escape close the dialog.
        allowEditableEscape
        aria-describedby={undefined}
        onOpenAutoFocus={focusReturn.onOpenAutoFocus}
        onCloseAutoFocus={focusReturn.onCloseAutoFocus}
        className="top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:top-[50%] md:left-[50%] md:h-[min(880px,88vh)] md:w-[min(1100px,92vw)] md:translate-x-[-50%] md:translate-y-[-50%] md:rounded-lg md:border"
      >
        {/* Mounted only while open, so closed analytics issues no queries. */}
        <AnalyticsDashboardContent />
        <Button
          variant="ghost"
          size="icon"
          onClick={navigateFromAnalytics}
          // Phones get a 44px touch target that still fits the header's pr-12 gutter; md+ keeps
          // the compact Settings-style button.
          className="absolute top-[calc(env(safe-area-inset-top)+0.125rem)] right-1 h-11 w-11 md:top-[calc(env(safe-area-inset-top)+0.75rem)] md:right-4 md:h-6 md:w-6"
          aria-label="Close analytics"
        >
          <X className="h-4 w-4" />
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function AnalyticsDashboardContent() {
  const { userProjects } = useProjectContext();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [rawTimeRange, setTimeRange] = usePersistedState<TimeRange>(
    ANALYTICS_TIME_RANGE_KEY,
    "30d"
  );
  const [rawTimingMetric, setTimingMetric] = usePersistedState<TimingMetric>(
    ANALYTICS_TIMING_METRIC_KEY,
    "duration"
  );
  const [rawTimeZoneMode, setTimeZoneMode] = usePersistedState<TimeZoneMode>(
    ANALYTICS_TIME_ZONE_MODE_KEY,
    "local"
  );

  // Coerce persisted values to known enums — stale/corrupted localStorage
  // entries self-heal to defaults instead of crashing the dashboard.
  const timeRange = normalizeTimeRange(rawTimeRange);
  const timingMetric = normalizeTimingMetric(rawTimingMetric);
  const timeZoneMode = normalizeTimeZoneMode(rawTimeZoneMode);
  const timeZone = timeZoneMode === "utc" ? "UTC" : getBrowserTimeZone();

  const dateRange = computeDateRange(timeRange, "UTC");
  const spendDateRange = computeDateRange(timeRange, timeZone);
  // SQL predicate substituted for the time-filter placeholder in saved panels
  // and the SQL explorer, so user-authored queries can opt into the header's
  // date-range selection.
  const timeFilterSql = buildTimeFilterPredicate(dateRange.from, dateRange.to);

  const summary = useAnalyticsSummary(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendOverTime = useAnalyticsSpendOverTime({
    projectPath,
    granularity: spendDateRange.granularity,
    from: spendDateRange.from,
    to: spendDateRange.to,
    timeZone,
  });
  const spendByProject = useAnalyticsSpendByProject({
    from: dateRange.from,
    to: dateRange.to,
  });
  const spendByModel = useAnalyticsSpendByModel(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const tokensByModel = useAnalyticsTokensByModel(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const timingDistribution = useAnalyticsTimingDistribution(timingMetric, projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const providerCacheHitRatios = useAnalyticsProviderCacheHitRatio(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const agentCosts = useAnalyticsAgentCostBreakdown(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });
  const delegationSummary = useAnalyticsDelegationSummary(projectPath, {
    from: dateRange.from,
    to: dateRange.to,
  });

  const {
    queries: savedQueries,
    save: saveQuery,
    update: updateSavedQuery,
    remove: removeSavedQuery,
  } = useSavedQueries();

  const projectRows = Array.from(userProjects.entries())
    .map(([path]) => ({
      path,
      label: formatProjectDisplayName(path),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <>
      <div
        data-testid="analytics-header"
        // pr-12 keeps the wrapped controls clear of the absolutely positioned close button.
        className="border-border-medium flex shrink-0 flex-wrap items-center gap-2 border-b py-3 pr-12 pl-4"
      >
        <DialogTitle className="text-sm leading-normal tracking-normal">Analytics</DialogTitle>

        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 md:ml-auto md:w-auto">
          {/* Keep the project control labeled on mobile for screen readers while
              keeping the compact mobile header visually uncluttered. */}
          <label
            className="text-muted sr-only text-xs md:not-sr-only md:inline"
            htmlFor="analytics-project-filter"
          >
            Project
          </label>
          <select
            id="analytics-project-filter"
            value={projectPath ?? "__all"}
            onChange={(event) => {
              const nextValue = event.target.value;
              setProjectPath(nextValue === "__all" ? null : nextValue);
            }}
            className="border-border-medium bg-separator text-foreground h-6 min-w-0 flex-1 rounded border px-2 text-xs md:max-w-56 md:flex-none"
          >
            <option value="__all">All projects</option>
            {projectRows.map((project) => (
              <option key={project.path} value={project.path}>
                {project.label}
              </option>
            ))}
          </select>

          <div className="flex shrink-0 items-center gap-1">
            <span className="text-muted text-xs">Timezone</span>
            <ToggleGroup
              options={[
                { value: "local", label: "Local" },
                { value: "utc", label: "UTC" },
              ]}
              value={timeZoneMode}
              onChange={setTimeZoneMode}
            />
          </div>

          <div className="border-border-medium bg-background ml-auto flex shrink-0 items-center gap-1 rounded-md border p-1">
            {(
              [
                ["7d", "7D"],
                ["30d", "30D"],
                ["90d", "90D"],
                ["all", "All"],
              ] as const
            ).map(([range, label]) => (
              <Button
                key={range}
                variant={timeRange === range ? "secondary" : "ghost"}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setTimeRange(range)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
          <SummaryCards data={summary.data} loading={summary.loading} error={summary.error} />
          <SpendChart
            data={spendOverTime.data}
            loading={spendOverTime.loading}
            error={spendOverTime.error}
            granularity={spendDateRange.granularity}
            timeZoneMode={timeZoneMode}
          />
          <ModelBreakdown spendByProject={spendByProject} spendByModel={spendByModel} />
          <TokensByModelChart
            data={tokensByModel.data}
            loading={tokensByModel.loading}
            error={tokensByModel.error}
          />
          <TimingChart
            data={timingDistribution.data}
            loading={timingDistribution.loading}
            error={timingDistribution.error}
            metric={timingMetric}
            onMetricChange={setTimingMetric}
          />
          <ProviderCacheHitChart
            data={providerCacheHitRatios.data}
            loading={providerCacheHitRatios.loading}
            error={providerCacheHitRatios.error}
          />
          <AgentCostChart
            data={agentCosts.data}
            loading={agentCosts.loading}
            error={agentCosts.error}
          />
          <DelegationChart
            data={delegationSummary.data}
            loading={delegationSummary.loading}
            error={delegationSummary.error}
          />
          {savedQueries.length > 0 && (
            <div className="flex flex-col gap-4">
              {savedQueries.map((query) => (
                <SavedQueryPanel
                  key={query.id}
                  query={query}
                  timeFilterSql={timeFilterSql}
                  onDelete={removeSavedQuery}
                  onUpdate={updateSavedQuery}
                />
              ))}
            </div>
          )}
          <SqlExplorer onSaveQuery={saveQuery} timeFilterSql={timeFilterSql} />
        </div>
      </div>
    </>
  );
}
