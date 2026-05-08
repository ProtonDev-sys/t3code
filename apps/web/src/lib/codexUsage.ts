import type { OrchestrationThreadActivity, ServerProvider } from "@t3tools/contracts";

export interface CodexUsageCreditsSnapshot {
  readonly balance: string | null;
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
}

export interface CodexUsageRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly windowDurationMins: number | null;
}

export interface CodexUsageSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly planType: string | null;
  readonly primary: CodexUsageRateLimitWindow | null;
  readonly secondary: CodexUsageRateLimitWindow | null;
  readonly credits: CodexUsageCreditsSnapshot | null;
  readonly rateLimitReachedType: string | null;
}

export interface CodexUsageLimitSnapshot extends CodexUsageSnapshot {
  readonly key: string;
}

export interface CodexUsageAccountSnapshot {
  readonly limits: ReadonlyArray<CodexUsageLimitSnapshot>;
  readonly updatedAt: string | null;
}

export type CodexUsageRateLimitWindowKey = "primary" | "secondary";

export interface CodexUsageWindowDescriptor {
  readonly key: CodexUsageRateLimitWindowKey;
  readonly label: string;
  readonly shortLabel: string;
  readonly isWeekly: boolean;
  readonly usage: CodexUsageRateLimitWindow;
}

const WEEKLY_WINDOW_DURATION_MINS = 7 * 24 * 60;
const DAILY_WINDOW_DURATION_MINS = 24 * 60;
const HOURLY_WINDOW_DURATION_MINS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readCredits(value: unknown): CodexUsageCreditsSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasCredits = typeof value.hasCredits === "boolean" ? value.hasCredits : null;
  const unlimited = typeof value.unlimited === "boolean" ? value.unlimited : null;
  if (hasCredits === null || unlimited === null) {
    return null;
  }
  return {
    balance: readString(value.balance),
    hasCredits,
    unlimited,
  };
}

function readWindow(value: unknown): CodexUsageRateLimitWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = readNumber(value.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    resetsAt: readNumber(value.resetsAt),
    windowDurationMins: readNumber(value.windowDurationMins),
  };
}

function readSnapshot(value: unknown): CodexUsageSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const primary = readWindow(value.primary);
  const secondary = readWindow(value.secondary);
  const credits = readCredits(value.credits);
  if (!primary && !secondary && !credits) {
    return null;
  }
  return {
    limitId: readString(value.limitId),
    limitName: readString(value.limitName),
    planType: readString(value.planType),
    primary,
    secondary,
    credits,
    rateLimitReachedType: readString(value.rateLimitReachedType),
  };
}

function snapshotMatchesCodex(snapshot: CodexUsageSnapshot, key: string): boolean {
  const haystack = [key, snapshot.limitId, snapshot.limitName].join(" ").toLowerCase();
  return haystack.includes("codex");
}

function readRateLimitSnapshotEntries(value: unknown): CodexUsageLimitSnapshot[] {
  if (!isRecord(value)) {
    return [];
  }

  const nestedEntries = isRecord(value.rateLimits)
    ? readRateLimitSnapshotEntries(value.rateLimits)
    : [];

  const byLimitId = isRecord(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : null;
  if (byLimitId) {
    const entries = Object.entries(byLimitId).flatMap(([key, candidate]) => {
      const snapshot = readSnapshot(candidate);
      return snapshot ? [{ ...snapshot, key }] : [];
    });
    return [...entries, ...nestedEntries];
  }

  if (nestedEntries.length > 0) {
    return nestedEntries;
  }

  const snapshot = readSnapshot(value);
  return snapshot
    ? [
        {
          ...snapshot,
          key: snapshot.limitId ?? snapshot.limitName ?? "codex",
        },
      ]
    : [];
}

function isWeeklyWindowDuration(value: number | null): boolean {
  return value === WEEKLY_WINDOW_DURATION_MINS;
}

function formatWindowDurationLabel(value: number | null): string | null {
  if (value === null || value <= 0) {
    return null;
  }
  if (value === WEEKLY_WINDOW_DURATION_MINS) {
    return "Weekly";
  }
  if (value % WEEKLY_WINDOW_DURATION_MINS === 0) {
    return `${value / WEEKLY_WINDOW_DURATION_MINS}-week`;
  }
  if (value === DAILY_WINDOW_DURATION_MINS) {
    return "Daily";
  }
  if (value % DAILY_WINDOW_DURATION_MINS === 0) {
    return `${value / DAILY_WINDOW_DURATION_MINS}-day`;
  }
  if (value % HOURLY_WINDOW_DURATION_MINS === 0) {
    return `${value / HOURLY_WINDOW_DURATION_MINS}h`;
  }
  return `${value}m`;
}

function formatWindowDurationShortLabel(value: number | null): string | null {
  if (value === null || value <= 0) {
    return null;
  }
  if (value % DAILY_WINDOW_DURATION_MINS === 0) {
    return `${value / DAILY_WINDOW_DURATION_MINS}d`;
  }
  if (value % HOURLY_WINDOW_DURATION_MINS === 0) {
    return `${value / HOURLY_WINDOW_DURATION_MINS}h`;
  }
  return `${value}m`;
}

function describeWindow(
  key: CodexUsageRateLimitWindowKey,
  usage: CodexUsageRateLimitWindow | null,
): CodexUsageWindowDescriptor | null {
  if (!usage) {
    return null;
  }
  const durationLabel = formatWindowDurationLabel(usage.windowDurationMins);
  const shortLabel = formatWindowDurationShortLabel(usage.windowDurationMins);
  const fallbackLabel = key === "primary" ? "Primary window" : "Secondary window";
  return {
    key,
    label: durationLabel ? `${durationLabel} window` : fallbackLabel,
    shortLabel: shortLabel ?? (key === "primary" ? "Usage" : "Alt"),
    isWeekly: isWeeklyWindowDuration(usage.windowDurationMins),
    usage,
  };
}

function readRateLimitSnapshot(value: unknown): CodexUsageSnapshot | null {
  const candidates = readRateLimitSnapshotEntries(value);
  const preferred = candidates.find((snapshot) => snapshotMatchesCodex(snapshot, snapshot.key));
  return preferred ?? candidates[0] ?? null;
}

function usageLimitDedupeKey(snapshot: CodexUsageLimitSnapshot): string {
  return (snapshot.limitId ?? snapshot.key).toLowerCase();
}

function dedupeUsageLimits(
  snapshots: ReadonlyArray<CodexUsageLimitSnapshot>,
): CodexUsageLimitSnapshot[] {
  const seen = new Set<string>();
  const deduped: CodexUsageLimitSnapshot[] = [];
  for (const snapshot of snapshots) {
    const key = usageLimitDedupeKey(snapshot);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(snapshot);
  }
  return deduped;
}

export function parseCodexUsageAccountSnapshot(
  payload: unknown,
  updatedAt: string | null = null,
): CodexUsageAccountSnapshot | null {
  const limits = dedupeUsageLimits(readRateLimitSnapshotEntries(payload)).toSorted(
    (left, right) => {
      const leftGeneral = isGeneralCodexLimit(left);
      const rightGeneral = isGeneralCodexLimit(right);
      if (leftGeneral !== rightGeneral) {
        return leftGeneral ? -1 : 1;
      }
      return left.key.localeCompare(right.key);
    },
  );
  return limits.length > 0 ? { limits, updatedAt } : null;
}

function compareUsageSnapshots(
  left: CodexUsageAccountSnapshot | null,
  right: CodexUsageAccountSnapshot | null,
): CodexUsageAccountSnapshot | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NaN;
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && rightTime !== leftTime) {
    return rightTime > leftTime ? right : left;
  }
  return right.updatedAt && !left.updatedAt ? right : left;
}

export function deriveLatestCodexUsageAccountSnapshotFromProviders(
  providers: ReadonlyArray<ServerProvider>,
): CodexUsageAccountSnapshot | null {
  let latestSnapshot: CodexUsageAccountSnapshot | null = null;
  for (const provider of providers) {
    if (provider.driver !== "codex" || !provider.usage) {
      continue;
    }
    latestSnapshot = compareUsageSnapshots(
      latestSnapshot,
      parseCodexUsageAccountSnapshot(provider.usage.rateLimits, provider.usage.checkedAt),
    );
  }
  return latestSnapshot;
}

export function pickLatestCodexUsageAccountSnapshot(
  snapshots: ReadonlyArray<CodexUsageAccountSnapshot | null>,
): CodexUsageAccountSnapshot | null {
  return snapshots.reduce<CodexUsageAccountSnapshot | null>(compareUsageSnapshots, null);
}

export function deriveLatestCodexUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CodexUsageSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "account.rate-limits.updated") {
      continue;
    }
    const snapshot = readRateLimitSnapshot(activity.payload);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

export function deriveLatestCodexUsageAccountSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CodexUsageAccountSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== "account.rate-limits.updated") {
      continue;
    }
    const snapshot = parseCodexUsageAccountSnapshot(activity.payload, activity.createdAt);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

export function getCodexUsageWindows(
  snapshot: CodexUsageSnapshot,
): ReadonlyArray<CodexUsageWindowDescriptor> {
  return [
    describeWindow("primary", snapshot.primary),
    describeWindow("secondary", snapshot.secondary),
  ].filter((window): window is CodexUsageWindowDescriptor => window !== null);
}

export function getCodexUsageDisplayWindow(
  snapshot: CodexUsageSnapshot,
): CodexUsageWindowDescriptor | null {
  const windows = getCodexUsageWindows(snapshot);
  return windows.find((window) => window.isWeekly) ?? windows[0] ?? null;
}

export function getPrimaryCodexUsageLimit(
  snapshot: CodexUsageAccountSnapshot,
): CodexUsageLimitSnapshot | null {
  return (
    snapshot.limits.find((limit) => snapshotMatchesCodex(limit, limit.key)) ??
    snapshot.limits[0] ??
    null
  );
}

export function getCodexUsageRemainingPercent(window: CodexUsageRateLimitWindow): number | null {
  if (!Number.isFinite(window.usedPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

export function getMostConstrainedCodexUsageWindow(
  snapshot: CodexUsageSnapshot,
): CodexUsageWindowDescriptor | null {
  const windows = getCodexUsageWindows(snapshot);
  return (
    windows.toSorted((left, right) => {
      const leftRemaining = getCodexUsageRemainingPercent(left.usage) ?? Number.POSITIVE_INFINITY;
      const rightRemaining = getCodexUsageRemainingPercent(right.usage) ?? Number.POSITIVE_INFINITY;
      return leftRemaining - rightRemaining;
    })[0] ?? null
  );
}

export function formatCodexUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function formatCodexUsageReset(value: number | null, now = new Date()): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const resetDate = new Date(value * 1000);
  if (!Number.isFinite(resetDate.getTime())) {
    return null;
  }

  if (isSameLocalDay(resetDate, now)) {
    return resetDate.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return resetDate.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(resetDate.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function formatCodexUsageRemainingLabel(window: CodexUsageRateLimitWindow): string | null {
  const remainingPercent = formatCodexUsagePercent(getCodexUsageRemainingPercent(window));
  return remainingPercent ? `${remainingPercent} left` : null;
}

function formatEnumLabel(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isGeneralCodexLimit(snapshot: CodexUsageLimitSnapshot): boolean {
  const key = snapshot.key.toLowerCase();
  const limitId = snapshot.limitId?.toLowerCase() ?? "";
  const limitName = snapshot.limitName?.toLowerCase() ?? "";
  return key === "codex" || limitId === "codex" || limitName === "codex";
}

export function formatCodexUsageLimitTitle(snapshot: CodexUsageLimitSnapshot): string {
  if (isGeneralCodexLimit(snapshot)) {
    return "General usage limits";
  }

  const label = snapshot.limitName ?? formatEnumLabel(snapshot.limitId ?? snapshot.key);
  return `${label} usage limits`;
}

export function formatCodexUsageWindowLimitLabel(window: CodexUsageWindowDescriptor): string {
  if (window.isWeekly) {
    return "Weekly usage limit";
  }

  const duration = window.usage.windowDurationMins;
  if (duration !== null && duration > 0 && duration % HOURLY_WINDOW_DURATION_MINS === 0) {
    const hours = duration / HOURLY_WINDOW_DURATION_MINS;
    return `${hours} hour usage limit`;
  }

  return `${window.label} usage limit`;
}
