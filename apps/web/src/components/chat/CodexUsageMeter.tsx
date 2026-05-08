import { GaugeIcon } from "lucide-react";

import {
  formatCodexUsagePercent,
  formatCodexUsageRemainingLabel,
  formatCodexUsageReset,
  getCodexUsageRemainingPercent,
  getCodexUsageWindows,
  getMostConstrainedCodexUsageWindow,
  getPrimaryCodexUsageLimit,
  type CodexUsageAccountSnapshot,
  type CodexUsageWindowDescriptor,
} from "~/lib/codexUsage";
import { hasReportedProviderAccountUsage, type ProviderUsageSnapshot } from "~/lib/providerUsage";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function CodexUsagePopoverRow({ window }: { window: CodexUsageWindowDescriptor }) {
  const remainingPercent = getCodexUsageRemainingPercent(window.usage);
  const remaining = formatCodexUsagePercent(remainingPercent);
  const reset = formatCodexUsageReset(window.usage.resetsAt);
  const label = window.isWeekly ? "Weekly" : window.shortLabel;
  const progressValue = remainingPercent ?? 0;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 text-xs leading-tight">
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{remaining ?? "-"}</span>
        <span className="min-w-10 text-right tabular-nums text-muted-foreground/80">
          {reset ?? "-"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent ?? undefined}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-foreground/80"
          style={{ width: `${progressValue}%` }}
        />
      </div>
    </div>
  );
}

function providerUsageDisplayWindow(
  snapshot: ProviderUsageSnapshot,
): CodexUsageWindowDescriptor | null {
  const primaryLimit = snapshot.accountUsage
    ? getPrimaryCodexUsageLimit(snapshot.accountUsage)
    : null;
  return primaryLimit ? getMostConstrainedCodexUsageWindow(primaryLimit) : null;
}

function pickMostConstrainedProviderUsage(
  snapshots: ReadonlyArray<ProviderUsageSnapshot>,
): { snapshot: ProviderUsageSnapshot; window: CodexUsageWindowDescriptor } | null {
  let selected: { snapshot: ProviderUsageSnapshot; window: CodexUsageWindowDescriptor } | null =
    null;
  for (const snapshot of snapshots) {
    const window = providerUsageDisplayWindow(snapshot);
    if (!window) {
      continue;
    }
    const remaining = getCodexUsageRemainingPercent(window.usage) ?? Number.POSITIVE_INFINITY;
    const selectedRemaining = selected
      ? (getCodexUsageRemainingPercent(selected.window.usage) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    if (!selected || remaining < selectedRemaining) {
      selected = { snapshot, window };
    }
  }
  return selected;
}

function sortUsageSummaryWindows(
  windows: ReadonlyArray<CodexUsageWindowDescriptor>,
): ReadonlyArray<CodexUsageWindowDescriptor> {
  return windows
    .toSorted((left, right) => {
      if (left.isWeekly !== right.isWeekly) {
        return left.isWeekly ? -1 : 1;
      }
      const leftDuration = left.usage.windowDurationMins ?? Number.POSITIVE_INFINITY;
      const rightDuration = right.usage.windowDurationMins ?? Number.POSITIVE_INFINITY;
      return leftDuration - rightDuration;
    })
    .slice(0, 2);
}

function getUsageSummaryWindows(
  usage: CodexUsageAccountSnapshot | null,
): ReadonlyArray<CodexUsageWindowDescriptor> {
  const primaryLimit = usage ? getPrimaryCodexUsageLimit(usage) : null;
  return primaryLimit ? sortUsageSummaryWindows(getCodexUsageWindows(primaryLimit)) : [];
}

function formatUsageSummaryWindowLabel(window: CodexUsageWindowDescriptor): string {
  return window.isWeekly ? "Week" : window.shortLabel;
}

function ProviderUsagePopoverRow({ snapshot }: { snapshot: ProviderUsageSnapshot }) {
  const window = providerUsageDisplayWindow(snapshot);
  const remaining = window ? formatCodexUsageRemainingLabel(window.usage) : null;
  const usageWindows = getUsageSummaryWindows(snapshot.accountUsage).flatMap((usageWindow) => {
    const remainingPercent = formatCodexUsagePercent(
      getCodexUsageRemainingPercent(usageWindow.usage),
    );
    return remainingPercent
      ? [
          {
            key: usageWindow.key,
            label: formatUsageSummaryWindowLabel(usageWindow),
            remaining: remainingPercent,
          },
        ]
      : [];
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 text-xs leading-tight">
      <span className="truncate font-medium text-foreground">{snapshot.entry.displayName}</span>
      {usageWindows.length > 0 ? (
        <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums text-muted-foreground">
          {usageWindows.map((usageWindow) => (
            <span key={usageWindow.key} className="inline-flex items-baseline gap-0.5">
              <span className="text-muted-foreground/60">{usageWindow.label}</span>
              <span>{usageWindow.remaining}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {remaining ?? "No data"}
        </span>
      )}
    </div>
  );
}

export function CodexUsageMeter({
  className,
  popoverSide = "right",
  usage,
  providerUsages,
}: {
  className?: string;
  popoverSide?: "top" | "right" | "bottom" | "left";
  usage?: CodexUsageAccountSnapshot | null;
  providerUsages?: ReadonlyArray<ProviderUsageSnapshot>;
}) {
  const primaryLimit = usage ? getPrimaryCodexUsageLimit(usage) : null;
  const windows = primaryLimit ? getCodexUsageWindows(primaryLimit) : [];
  const reportedProviderUsages = providerUsages?.filter(hasReportedProviderAccountUsage) ?? [];
  const providerDisplayUsage = providerUsages
    ? pickMostConstrainedProviderUsage(reportedProviderUsages)
    : null;
  const displayWindow = providerDisplayUsage
    ? providerDisplayUsage.window
    : primaryLimit
      ? getMostConstrainedCodexUsageWindow(primaryLimit)
      : null;
  const remainingLabel = displayWindow ? formatCodexUsageRemainingLabel(displayWindow.usage) : null;
  const ariaBaseLabel = providerUsages ? "Usage" : "Codex usage";
  const ariaLabel = remainingLabel ? `${ariaBaseLabel} ${remainingLabel}` : ariaBaseLabel;
  const popoverAlign = popoverSide === "top" || popoverSide === "bottom" ? "start" : "end";
  const showProviderUsage = providerUsages !== undefined;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground/75 outline-hidden transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
            aria-label={ariaLabel}
          >
            <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Usage</span>
            {remainingLabel ? (
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/80">
                {remainingLabel.replace(" left", "")}
              </span>
            ) : null}
          </button>
        }
      />
      <PopoverPopup
        side={popoverSide}
        align={popoverAlign}
        sideOffset={8}
        className="w-(--anchor-width) px-3 py-2.5 [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        <div className="space-y-2">
          <div className="text-xs font-semibold text-foreground">
            {showProviderUsage ? "Provider usage" : "Rate limits remaining"}
          </div>
          {showProviderUsage ? (
            reportedProviderUsages.length > 0 ? (
              <div className="space-y-2">
                {reportedProviderUsages.map((snapshot) => (
                  <ProviderUsagePopoverRow key={snapshot.entry.instanceId} snapshot={snapshot} />
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                No provider usage data has been reported yet.
              </div>
            )
          ) : windows.length > 0 ? (
            <div className="space-y-2.5">
              {windows.map((window) => (
                <CodexUsagePopoverRow key={window.key} window={window} />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No account usage data has been reported yet.
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
