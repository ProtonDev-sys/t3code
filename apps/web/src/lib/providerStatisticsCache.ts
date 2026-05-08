import type { CodexUsageHistoryThread, OrchestrationThreadActivity } from "@t3tools/contracts";

const CACHE_KEY = "t3.providerStatistics.usageActivities.v1";
const CODEX_HISTORY_CACHE_KEY = "t3.providerStatistics.codexHistory.v1";
const MAX_CACHED_USAGE_ACTIVITIES = 20_000;
const MAX_CACHED_CODEX_HISTORY_THREADS = 25_000;

export const PROVIDER_STATISTICS_USAGE_ACTIVITY_KINDS = new Set([
  "account.rate-limits.updated",
  "context-window.updated",
  "usage.turn.started",
  "usage.turn.completed",
]);

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isUsageActivity(value: unknown): value is OrchestrationThreadActivity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OrchestrationThreadActivity>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.createdAt === "string" &&
    PROVIDER_STATISTICS_USAGE_ACTIVITY_KINDS.has(candidate.kind)
  );
}

function isCodexUsageHistoryThread(value: unknown): value is CodexUsageHistoryThread {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CodexUsageHistoryThread>;
  return (
    typeof candidate.threadId === "string" &&
    typeof candidate.sourceKind === "string" &&
    typeof candidate.sourceLabel === "string" &&
    typeof candidate.tokensUsed === "number" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function activitySortTime(activity: OrchestrationThreadActivity): number {
  const time = Date.parse(activity.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function codexHistorySortTime(thread: CodexUsageHistoryThread): number {
  const updatedAt = Date.parse(thread.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(thread.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function readCachedProviderStatisticsActivities(): ReadonlyArray<OrchestrationThreadActivity> {
  if (!canUseLocalStorage()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUsageActivity) : [];
  } catch {
    return [];
  }
}

export function readCachedCodexUsageHistoryThreads(): ReadonlyArray<CodexUsageHistoryThread> {
  if (!canUseLocalStorage()) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(CODEX_HISTORY_CACHE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCodexUsageHistoryThread) : [];
  } catch {
    return [];
  }
}

export function mergeProviderStatisticsActivities(
  left: ReadonlyArray<OrchestrationThreadActivity>,
  right: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const byId = new Map<string, OrchestrationThreadActivity>();
  for (const activity of [...left, ...right]) {
    if (!isUsageActivity(activity)) {
      continue;
    }
    byId.set(activity.id, activity);
  }
  return Array.from(byId.values())
    .toSorted(
      (leftActivity, rightActivity) =>
        activitySortTime(leftActivity) - activitySortTime(rightActivity) ||
        leftActivity.id.localeCompare(rightActivity.id),
    )
    .slice(-MAX_CACHED_USAGE_ACTIVITIES);
}

export function mergeCodexUsageHistoryThreads(
  left: ReadonlyArray<CodexUsageHistoryThread>,
  right: ReadonlyArray<CodexUsageHistoryThread>,
): ReadonlyArray<CodexUsageHistoryThread> {
  const byId = new Map<string, CodexUsageHistoryThread>();
  for (const thread of [...left, ...right]) {
    if (!isCodexUsageHistoryThread(thread)) {
      continue;
    }
    const current = byId.get(thread.threadId);
    if (!current || codexHistorySortTime(thread) >= codexHistorySortTime(current)) {
      byId.set(thread.threadId, thread);
    }
  }
  return Array.from(byId.values())
    .toSorted(
      (leftThread, rightThread) =>
        codexHistorySortTime(leftThread) - codexHistorySortTime(rightThread) ||
        leftThread.threadId.localeCompare(rightThread.threadId),
    )
    .slice(-MAX_CACHED_CODEX_HISTORY_THREADS);
}

export function writeCachedProviderStatisticsActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): void {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(activities));
  } catch {
    // Cache writes are best-effort. Statistics still work from live activities.
  }
}

export function writeCachedCodexUsageHistoryThreads(
  threads: ReadonlyArray<CodexUsageHistoryThread>,
): void {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(CODEX_HISTORY_CACHE_KEY, JSON.stringify(threads));
  } catch {
    // Cache writes are best-effort. Statistics still work from live Codex state.
  }
}

export function getProviderStatisticsCacheHighWaterMark(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  let highWaterMark: number | null = null;
  for (const activity of activities) {
    const time = activitySortTime(activity);
    if (time <= 0) {
      continue;
    }
    highWaterMark = highWaterMark === null ? time : Math.max(highWaterMark, time);
  }
  return highWaterMark;
}
