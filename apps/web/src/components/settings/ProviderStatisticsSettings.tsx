import { BarChart3Icon, CoinsIcon, DatabaseIcon, GaugeIcon } from "lucide-react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useEffect, useMemo, useState, type PointerEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { prewarmThreadDetailSubscriptions } from "../../environments/runtime/service";
import { selectProviderUsageActivities } from "../../hooks/useCodexUsage";
import { useProviderStatisticsCachedActivities } from "../../hooks/useProviderStatisticsCache";
import { getProviderStatisticsCacheHighWaterMark } from "../../lib/providerStatisticsCache";
import {
  deriveProviderStatisticsSnapshot,
  getProviderStatisticsPeriod,
  PROVIDER_STATISTICS_PERIODS,
  type ProviderStatisticsPeriodId,
  type ProviderUsageTrendBucket,
} from "../../lib/providerStatistics";
import {
  hasProviderTokenUsageTotals,
  type ProviderTokenUsageSnapshot,
  type ProviderTokenUsageTotals,
} from "../../lib/providerUsage";
import { useServerProviders } from "../../rpc/serverState";
import { selectThreadShellsAcrossEnvironments, useStore } from "../../store";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { cn } from "../../lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_THREAD_PREWARM_LIMIT = 64;

function formatUsageTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatUsageCost(value: number): string {
  if (value <= 0) {
    return "-";
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}

function formatCacheDescription(totals: ProviderTokenUsageTotals): string {
  const cachedTokens = totals.cachedInputTokens + totals.cacheCreationInputTokens;
  if (cachedTokens <= 0 || totals.inputTokens <= 0) {
    return "No cached input reported";
  }
  const cacheRate = Math.round((cachedTokens / totals.inputTokens) * 100);
  return `${formatUsageTokens(cachedTokens)} cached input tokens (${cacheRate}%)`;
}

function usageDescription(totals: ProviderTokenUsageTotals): string {
  return [
    `In ${formatUsageTokens(totals.inputTokens)}`,
    `Out ${formatUsageTokens(totals.outputTokens + totals.reasoningOutputTokens)}`,
    formatCacheDescription(totals),
  ].join(" · ");
}

function parseThreadTimeMs(thread: {
  readonly updatedAt?: string | undefined;
  readonly createdAt: string;
}) {
  const updatedAt = thread.updatedAt ? Date.parse(thread.updatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(thread.createdAt);
  return Number.isFinite(createdAt) ? createdAt : null;
}

function useStatisticsThreadPrewarm(
  periodId: ProviderStatisticsPeriodId,
  cachedActivities: ReadonlyArray<OrchestrationThreadActivity>,
) {
  const period = getProviderStatisticsPeriod(periodId);
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const refs = useMemo(() => {
    const nowMs = Date.now();
    const periodStartMs = period.days === null ? null : nowMs - period.days * DAY_MS;
    const cacheHighWaterMark = getProviderStatisticsCacheHighWaterMark(cachedActivities);
    const startMs =
      cacheHighWaterMark === null
        ? periodStartMs
        : periodStartMs === null
          ? cacheHighWaterMark
          : Math.max(periodStartMs, cacheHighWaterMark);
    return threads
      .flatMap((thread) => {
        const threadTimeMs = parseThreadTimeMs(thread);
        if (threadTimeMs === null || (startMs !== null && threadTimeMs < startMs)) {
          return [];
        }
        return [{ environmentId: thread.environmentId, threadId: thread.id, threadTimeMs }];
      })
      .toSorted((left, right) => right.threadTimeMs - left.threadTimeMs)
      .slice(0, BACKGROUND_THREAD_PREWARM_LIMIT)
      .map(({ environmentId, threadId }) => ({ environmentId, threadId }));
  }, [cachedActivities, period.days, threads]);

  useEffect(() => {
    return prewarmThreadDetailSubscriptions(refs, {
      initialDelayMs: 1_000,
      intervalMs: 260,
      retainMs: 12_000,
    });
  }, [refs]);

  return refs.length;
}

function StatisticsSection({
  children,
  className,
  icon,
  title,
}: {
  children: ReactNode;
  className?: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section
      className={cn(
        "mx-auto flex w-full max-w-3xl min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/45",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-border/60 border-b px-3 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <h2 className="min-w-0 truncate font-medium text-foreground text-sm">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function HiddenRowsNotice({ hiddenCount }: { hiddenCount: number }) {
  if (hiddenCount <= 0) {
    return null;
  }
  return (
    <div className="border-border/60 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
      +{hiddenCount} more in this period
    </div>
  );
}

function SummaryTile({
  description,
  title,
  value,
}: {
  description: string;
  title: string;
  value: string;
}) {
  return (
    <div className="min-w-0 border-border/60 border-b px-3 py-3 sm:border-r sm:last:border-r-0">
      <div className="truncate text-muted-foreground text-xs">{title}</div>
      <div className="mt-1 truncate font-semibold text-foreground text-lg tabular-nums">
        {value}
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground/80">
        {description}
      </div>
    </div>
  );
}

function PeriodPicker({
  periodId,
  onChange,
}: {
  periodId: ProviderStatisticsPeriodId;
  onChange: (periodId: ProviderStatisticsPeriodId) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-1 rounded-lg border border-border/70 bg-card/45 p-1">
      {PROVIDER_STATISTICS_PERIODS.map((period) => (
        <Button
          key={period.id}
          type="button"
          size="xs"
          variant={period.id === periodId ? "default" : "ghost"}
          className="h-7 flex-1 rounded-md px-2 text-xs"
          onClick={() => onChange(period.id)}
        >
          {period.label}
        </Button>
      ))}
    </div>
  );
}

function TrendChart({ buckets }: { buckets: ReadonlyArray<ProviderUsageTrendBucket> }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const maxTokens = Math.max(1, ...buckets.map((bucket) => bucket.totals.totalTokens));
  const width = 720;
  const height = 150;
  const chartTop = 12;
  const chartBottom = 108;
  const chartLeft = 18;
  const chartRight = width - 18;
  const points = buckets.map((bucket, index) => {
    const x =
      buckets.length <= 1
        ? width / 2
        : (index / (buckets.length - 1)) * (chartRight - chartLeft) + chartLeft;
    const y = chartBottom - (bucket.totals.totalTokens / maxTokens) * (chartBottom - chartTop);
    return { bucket, x, y: Number.isFinite(y) ? y : chartBottom };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath =
    points.length > 0
      ? `${path} L ${points.at(-1)!.x.toFixed(2)} ${chartBottom} L ${points[0]!.x.toFixed(
          2,
        )} ${chartBottom} Z`
      : "";
  const hoveredPoint = hoveredIndex === null ? null : (points[hoveredIndex] ?? null);
  const labelStep = buckets.length > 18 ? 4 : buckets.length > 10 ? 2 : 1;
  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      const distance = Math.abs(points[index]!.x - relativeX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    setHoveredIndex(nearestIndex);
  };

  return (
    <div className="relative px-3 py-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-40 w-full text-foreground"
        role="img"
        aria-label="Token usage line graph"
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        <defs>
          <linearGradient id="token-trend-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((mark) => {
          const y = chartTop + (chartBottom - chartTop) * mark;
          return (
            <path
              key={mark}
              d={`M ${chartLeft} ${y} H ${chartRight}`}
              className="stroke-border/60"
              fill="none"
              strokeDasharray="3 6"
              strokeWidth="1"
            />
          );
        })}
        <path
          d={`M ${chartLeft} ${chartBottom} H ${chartRight}`}
          className="stroke-border"
          fill="none"
        />
        {areaPath ? <path d={areaPath} fill="url(#token-trend-fill)" /> : null}
        <path
          d={path}
          className="stroke-foreground"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
        />
        {points.map(({ bucket, x, y }, index) => {
          const visiblePoint = bucket.totals.totalTokens > 0 || index === hoveredIndex;
          const visibleLabel =
            index === 0 || index === points.length - 1 || index % labelStep === 0;
          return (
            <g key={bucket.key}>
              {visiblePoint ? (
                <circle
                  cx={x}
                  cy={y}
                  r={index === hoveredIndex ? 4 : 2.25}
                  className={index === hoveredIndex ? "fill-foreground" : "fill-muted-foreground"}
                />
              ) : null}
              {visibleLabel ? (
                <text
                  x={x}
                  y={height - 14}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[9px]"
                >
                  {bucket.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {hoveredPoint ? (
          <path
            d={`M ${hoveredPoint.x} ${chartTop} V ${chartBottom}`}
            className="stroke-muted-foreground/70"
            strokeDasharray="3 4"
            fill="none"
          />
        ) : null}
      </svg>
      {hoveredPoint ? (
        <div
          className="pointer-events-none absolute top-5 z-10 min-w-40 rounded-md border border-border bg-popover px-2.5 py-2 text-xs shadow-lg"
          style={{
            left: `${(hoveredPoint.x / width) * 100}%`,
            transform:
              hoveredPoint.x > width * 0.72
                ? "translateX(-100%)"
                : hoveredPoint.x < width * 0.28
                  ? "translateX(0)"
                  : "translateX(-50%)",
          }}
        >
          <div className="font-medium text-foreground">{hoveredPoint.bucket.label}</div>
          <div className="mt-1 text-muted-foreground">
            {formatUsageTokens(hoveredPoint.bucket.totals.totalTokens)} tokens
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {formatUsageCost(hoveredPoint.bucket.totals.estimatedCostUsd)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelRows({ tokenUsage }: { tokenUsage: ProviderTokenUsageSnapshot }) {
  if (tokenUsage.models.length === 0) {
    return (
      <div className="px-3 py-3 text-muted-foreground text-xs">
        No model-attributed token usage has loaded yet.
      </div>
    );
  }

  const visibleModels = tokenUsage.models.slice(0, 4);

  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="divide-y divide-border/60">
        {visibleModels.map((model) => (
          <div
            key={model.model}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground text-sm">{model.model}</div>
              <div className="mt-0.5 truncate text-muted-foreground text-xs">
                {usageDescription(model.totals)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs tabular-nums text-foreground">
                {formatUsageTokens(model.totals.totalTokens)}
              </div>
              <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                {formatUsageCost(model.totals.estimatedCostUsd)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <HiddenRowsNotice hiddenCount={tokenUsage.models.length - visibleModels.length} />
    </div>
  );
}

function ProviderRows({
  providerUsages,
}: {
  providerUsages: ReturnType<typeof deriveProviderStatisticsSnapshot>["providerUsages"];
}) {
  if (providerUsages.length === 0) {
    return (
      <div className="px-3 py-3 text-muted-foreground text-xs">
        No enabled providers are available.
      </div>
    );
  }

  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="divide-y divide-border/60">
        {providerUsages.map((snapshot) => {
          const hasTotals = hasProviderTokenUsageTotals(snapshot.tokenUsage.totals);
          return (
            <div
              key={snapshot.entry.instanceId}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
            >
              <ProviderInstanceIcon
                driverKind={snapshot.entry.driverKind}
                displayName={snapshot.entry.displayName}
                accentColor={snapshot.entry.accentColor}
                showBadge={Boolean(snapshot.entry.accentColor)}
                className="size-5"
                iconClassName="size-4"
                badgeClassName="hidden"
              />
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground text-sm">
                  {snapshot.entry.displayName}
                </div>
                <div className="mt-0.5 truncate text-muted-foreground text-xs">
                  {hasTotals
                    ? usageDescription(snapshot.tokenUsage.totals)
                    : "No token usage in this period"}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs tabular-nums text-foreground">
                  {formatUsageTokens(snapshot.tokenUsage.totals.totalTokens)}
                </div>
                <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                  {formatUsageCost(snapshot.tokenUsage.totals.estimatedCostUsd)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProviderStatisticsSettingsPanel() {
  const [periodId, setPeriodId] = useState<ProviderStatisticsPeriodId>("7d");
  const [loadedAt] = useState(() => new Date());
  const providers = useServerProviders();
  const liveActivities = useStore(useShallow(selectProviderUsageActivities));
  const activities = useProviderStatisticsCachedActivities(liveActivities);
  useStatisticsThreadPrewarm(periodId, activities);
  const statistics = useMemo(
    () =>
      deriveProviderStatisticsSnapshot({
        providers,
        activities,
        periodId,
        now: loadedAt,
      }),
    [activities, loadedAt, periodId, providers],
  );
  const totals = statistics.tokenUsage.totals;

  return (
    <div className="flex-1 overflow-hidden px-0 py-1 pr-1">
      <div className="mx-auto grid h-full w-full max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)] gap-3 pb-1">
        <PeriodPicker periodId={periodId} onChange={setPeriodId} />

        <StatisticsSection title="Token usage" icon={<GaugeIcon className="size-3.5" />}>
          <div className="grid grid-cols-1 sm:grid-cols-4">
            <SummaryTile
              title="T3 Code tokens"
              value={formatUsageTokens(totals.totalTokens)}
              description={`${statistics.activityCount} events loaded`}
            />
            <SummaryTile
              title="Estimated cost"
              value={formatUsageCost(totals.estimatedCostUsd)}
              description="Model-attributed T3 turns"
            />
            <SummaryTile
              title="Input"
              value={formatUsageTokens(totals.inputTokens)}
              description={`${formatUsageTokens(totals.cachedInputTokens)} cached`}
            />
            <SummaryTile
              title="Output"
              value={formatUsageTokens(totals.outputTokens + totals.reasoningOutputTokens)}
              description={`${formatUsageTokens(totals.reasoningOutputTokens)} reasoning`}
            />
          </div>
        </StatisticsSection>

        <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.15fr)_minmax(17rem,0.85fr)]">
          <StatisticsSection
            title="Trend"
            icon={<BarChart3Icon className="size-3.5" />}
            className="min-h-0"
          >
            {statistics.trend.length > 0 ? (
              <TrendChart buckets={statistics.trend} />
            ) : (
              <div className="px-3 py-3 text-muted-foreground text-xs">
                No token usage has loaded for this period.
              </div>
            )}
          </StatisticsSection>

          <div className="grid min-h-0 grid-rows-2 gap-3">
            <StatisticsSection
              title="Models"
              icon={<DatabaseIcon className="size-3.5" />}
              className="min-h-0"
            >
              <ModelRows tokenUsage={statistics.tokenUsage} />
            </StatisticsSection>

            <StatisticsSection
              title="Providers"
              icon={<CoinsIcon className="size-3.5" />}
              className="min-h-0"
            >
              <ProviderRows providerUsages={statistics.providerUsages} />
            </StatisticsSection>
          </div>
        </div>
      </div>
    </div>
  );
}
