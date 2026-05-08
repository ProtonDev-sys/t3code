import type { OrchestrationThreadActivity, ServerProvider } from "@t3tools/contracts";

import {
  addProviderTokenUsageTotals,
  deriveProviderUsageSnapshots,
  EMPTY_PROVIDER_TOKEN_USAGE_TOTALS,
  hasProviderTokenUsageTotals,
  type ProviderModelTokenUsage,
  type ProviderTokenUsageSnapshot,
  type ProviderTokenUsageTotals,
  type ProviderUsageSnapshot,
} from "./providerUsage";

export type ProviderStatisticsPeriodId = "24h" | "7d" | "30d" | "all";

export interface ProviderStatisticsPeriod {
  readonly id: ProviderStatisticsPeriodId;
  readonly label: string;
  readonly days: number | null;
  readonly trendBucket: "day" | "hour";
}

export interface ProviderUsageTrendBucket {
  readonly key: string;
  readonly label: string;
  readonly totals: ProviderTokenUsageTotals;
}

export interface ProviderStatisticsSnapshot {
  readonly period: ProviderStatisticsPeriod;
  readonly providerUsages: ReadonlyArray<ProviderUsageSnapshot>;
  readonly tokenUsage: ProviderTokenUsageSnapshot;
  readonly trend: ReadonlyArray<ProviderUsageTrendBucket>;
  readonly activityCount: number;
}

export const PROVIDER_STATISTICS_PERIODS: ReadonlyArray<ProviderStatisticsPeriod> = [
  { id: "24h", label: "Last 24h", days: 1, trendBucket: "hour" },
  { id: "7d", label: "Last 7d", days: 7, trendBucket: "day" },
  { id: "30d", label: "Last 30d", days: 30, trendBucket: "day" },
  { id: "all", label: "All", days: null, trendBucket: "day" },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function addModelUsage(
  usageByModel: Map<string, ProviderTokenUsageTotals>,
  model: ProviderModelTokenUsage,
) {
  usageByModel.set(
    model.model,
    addProviderTokenUsageTotals(
      usageByModel.get(model.model) ?? EMPTY_PROVIDER_TOKEN_USAGE_TOTALS,
      model.totals,
    ),
  );
}

export function aggregateProviderTokenUsage(
  snapshots: ReadonlyArray<ProviderUsageSnapshot>,
): ProviderTokenUsageSnapshot {
  const usageByModel = new Map<string, ProviderTokenUsageTotals>();
  const totals = snapshots.reduce((current, snapshot) => {
    for (const model of snapshot.tokenUsage.models) {
      addModelUsage(usageByModel, model);
    }
    return addProviderTokenUsageTotals(current, snapshot.tokenUsage.totals);
  }, EMPTY_PROVIDER_TOKEN_USAGE_TOTALS);

  return {
    totals,
    models: Array.from(usageByModel.entries())
      .map(([model, totals]) => ({ model, totals }))
      .toSorted((left, right) => right.totals.totalTokens - left.totals.totalTokens),
  };
}

export function getProviderStatisticsPeriod(
  id: ProviderStatisticsPeriodId,
): ProviderStatisticsPeriod {
  return (
    PROVIDER_STATISTICS_PERIODS.find((period) => period.id === id) ??
    PROVIDER_STATISTICS_PERIODS[1]!
  );
}

function parseActivityTime(activity: OrchestrationThreadActivity): number | null {
  const time = Date.parse(activity.createdAt);
  return Number.isFinite(time) ? time : null;
}

function getPeriodStartMs(period: ProviderStatisticsPeriod, nowMs: number): number | null {
  return period.days === null ? null : nowMs - period.days * DAY_MS;
}

export function filterProviderStatisticsActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  period: ProviderStatisticsPeriod,
  now: Date = new Date(),
): ReadonlyArray<OrchestrationThreadActivity> {
  const startMs = getPeriodStartMs(period, now.getTime());
  if (startMs === null) {
    return activities;
  }

  return activities.filter((activity) => {
    const activityTime = parseActivityTime(activity);
    return activityTime !== null && activityTime >= startMs;
  });
}

function bucketKeyForTime(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

function hourBucketKeyForTime(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 13);
}

function floorToHour(timeMs: number): number {
  return Math.floor(timeMs / HOUR_MS) * HOUR_MS;
}

function formatTrendBucketLabel(key: string): string {
  if (key.includes("T")) {
    return new Date(`${key}:00:00.000Z`).toLocaleTimeString(undefined, {
      hour: "numeric",
    });
  }
  const date = new Date(`${key}T00:00:00.000Z`);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function makeTrendBucket(
  key: string,
  providers: ReadonlyArray<ServerProvider>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderUsageTrendBucket {
  return {
    key,
    label: formatTrendBucketLabel(key),
    totals: aggregateProviderTokenUsage(deriveProviderUsageSnapshots(providers, activities)).totals,
  };
}

function deriveUsageTrend(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly period: ProviderStatisticsPeriod;
  readonly now: Date;
}): ReadonlyArray<ProviderUsageTrendBucket> {
  const byBucket = new Map<string, OrchestrationThreadActivity[]>();
  for (const activity of input.activities) {
    const activityTime = parseActivityTime(activity);
    if (activityTime === null) {
      continue;
    }
    const key =
      input.period.trendBucket === "hour"
        ? hourBucketKeyForTime(activityTime)
        : bucketKeyForTime(activityTime);
    const bucket = byBucket.get(key) ?? [];
    bucket.push(activity);
    byBucket.set(key, bucket);
  }

  if (input.period.days === null) {
    return Array.from(byBucket.entries())
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, activities]) => makeTrendBucket(key, input.providers, activities));
  }

  if (input.period.trendBucket === "hour") {
    const currentHourMs = floorToHour(input.now.getTime());
    const startMs = currentHourMs - 23 * HOUR_MS;
    return Array.from({ length: 24 }, (_, index) => {
      const key = hourBucketKeyForTime(startMs + index * HOUR_MS);
      return makeTrendBucket(key, input.providers, byBucket.get(key) ?? []);
    });
  }

  const startMs = input.now.getTime() - (input.period.days - 1) * DAY_MS;
  return Array.from({ length: input.period.days }, (_, index) => {
    const key = bucketKeyForTime(startMs + index * DAY_MS);
    return makeTrendBucket(key, input.providers, byBucket.get(key) ?? []);
  });
}

export function deriveProviderStatisticsSnapshot(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly periodId: ProviderStatisticsPeriodId;
  readonly now?: Date;
}): ProviderStatisticsSnapshot {
  const period = getProviderStatisticsPeriod(input.periodId);
  const now = input.now ?? new Date();
  const periodActivities = filterProviderStatisticsActivities(input.activities, period, now);
  const providerUsages = deriveProviderUsageSnapshots(input.providers, periodActivities);
  return {
    period,
    providerUsages,
    tokenUsage: aggregateProviderTokenUsage(providerUsages),
    trend: deriveUsageTrend({
      providers: input.providers,
      activities: periodActivities,
      period,
      now,
    }).filter((bucket) => period.id !== "all" || hasProviderTokenUsageTotals(bucket.totals)),
    activityCount: periodActivities.length,
  };
}
