import type { AnalyticsTimeRange } from "@/common/config/schemas/userPreferences";

interface AnalyticsDateRange {
  from: Date | null;
  to: Date | null;
  granularity: "hour" | "day" | "week";
  /** The zone whose calendar dates `from` and `to` bound. */
  filterTimeZone: string;
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

export function computeDateRange(
  timeRange: AnalyticsTimeRange,
  timeZone: string
): AnalyticsDateRange {
  switch (timeRange) {
    case "7d":
      return {
        from: daysAgoInTimeZone(6, timeZone),
        to: null,
        granularity: "day",
        filterTimeZone: timeZone,
      };
    case "30d":
      return {
        from: daysAgoInTimeZone(29, timeZone),
        to: null,
        granularity: "day",
        filterTimeZone: timeZone,
      };
    case "90d":
      return {
        from: daysAgoInTimeZone(89, timeZone),
        to: null,
        granularity: "week",
        filterTimeZone: timeZone,
      };
    case "month-utc": {
      // AI Gateway budgets run on the UTC calendar month, so this range covers UTC dates from the
      // 1st in both time zone modes; only the spend chart's day buckets follow the zone.
      const now = new Date();
      return {
        from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        to: null,
        granularity: "day",
        filterTimeZone: "UTC",
      };
    }
    case "all":
      return { from: null, to: null, granularity: "week", filterTimeZone: timeZone };
    default:
      // Self-heal: unknown persisted value → safe default.
      return {
        from: daysAgoInTimeZone(29, timeZone),
        to: null,
        granularity: "day",
        filterTimeZone: timeZone,
      };
  }
}
