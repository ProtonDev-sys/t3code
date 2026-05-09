export interface CopilotQuotaRateLimitWindow {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly windowDurationMins: number | null;
}

export interface CopilotQuotaRateLimitSnapshot {
  readonly credits: null;
  readonly limitId: string;
  readonly limitName: string;
  readonly planType: "copilot";
  readonly primary: CopilotQuotaRateLimitWindow;
  readonly rateLimitReachedType: null;
  readonly secondary: null;
}

export interface CopilotQuotaRateLimitsPayload {
  readonly rateLimitsByLimitId: Record<string, CopilotQuotaRateLimitSnapshot>;
}

const COPILOT_WEEKLY_WINDOW_MINS = 7 * 24 * 60;
const COPILOT_MONTHLY_WINDOW_MINS = 30 * 24 * 60;
const COPILOT_SESSION_WINDOW_MINS = 5 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDateEpochSeconds(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function quotaLimitName(quotaId: string): string {
  switch (quotaId) {
    case "chat":
      return "Copilot chat";
    case "completions":
      return "Copilot completions";
    case "premium_interactions":
      return "Copilot premium requests";
    case "session":
      return "Copilot session";
    case "weekly":
      return "Copilot weekly";
    default:
      return `Copilot ${quotaId.replaceAll("_", " ")}`;
  }
}

function quotaWindowDurationMins(quotaId: string): number | null {
  switch (quotaId) {
    case "weekly":
      return COPILOT_WEEKLY_WINDOW_MINS;
    case "session":
      return COPILOT_SESSION_WINDOW_MINS;
    case "chat":
    case "completions":
    case "premium_interactions":
      return COPILOT_MONTHLY_WINDOW_MINS;
    default:
      return null;
  }
}

function shouldIncludeQuotaSnapshot(quotaId: string, quota: Record<string, unknown>): boolean {
  const remainingPercentage = readFiniteNumber(quota.remainingPercentage);
  if (remainingPercentage === null) {
    return false;
  }
  if (quotaId === "weekly" || quotaId === "session") {
    return true;
  }

  const entitlementRequests = readFiniteNumber(quota.entitlementRequests);
  const isUnlimitedEntitlement = readBoolean(quota.isUnlimitedEntitlement);
  const hasQuota = readBoolean(quota.hasQuota);
  return (
    isUnlimitedEntitlement === true ||
    hasQuota === true ||
    (entitlementRequests !== null && entitlementRequests > 0) ||
    remainingPercentage > 0
  );
}

function convertQuotaSnapshot(
  quotaId: string,
  quotaValue: unknown,
): CopilotQuotaRateLimitSnapshot | null {
  if (!isRecord(quotaValue) || !shouldIncludeQuotaSnapshot(quotaId, quotaValue)) {
    return null;
  }

  const remainingPercentage = readFiniteNumber(quotaValue.remainingPercentage);
  if (remainingPercentage === null) {
    return null;
  }

  const limitId = `copilot_${quotaId}`;
  return {
    credits: null,
    limitId,
    limitName: quotaLimitName(quotaId),
    planType: "copilot",
    primary: {
      usedPercent: clampPercent(100 - remainingPercentage),
      resetsAt: readDateEpochSeconds(quotaValue.resetDate),
      windowDurationMins: quotaWindowDurationMins(quotaId),
    },
    rateLimitReachedType: null,
    secondary: null,
  };
}

export function convertCopilotQuotaSnapshotsToRateLimits(
  quotaSnapshots: unknown,
): CopilotQuotaRateLimitsPayload | null {
  if (!isRecord(quotaSnapshots)) {
    return null;
  }

  const rateLimitsByLimitId: Record<string, CopilotQuotaRateLimitSnapshot> = {};
  for (const [quotaId, quotaValue] of Object.entries(quotaSnapshots)) {
    const normalizedQuotaId = quotaId.trim().toLowerCase();
    if (!normalizedQuotaId) {
      continue;
    }
    const snapshot = convertQuotaSnapshot(normalizedQuotaId, quotaValue);
    if (!snapshot) {
      continue;
    }
    rateLimitsByLimitId[snapshot.limitId] = snapshot;
  }

  return Object.keys(rateLimitsByLimitId).length > 0 ? { rateLimitsByLimitId } : null;
}

export function buildCopilotProviderUsage(input: {
  readonly checkedAt: string;
  readonly quotaSnapshots: unknown;
}) {
  const rateLimits = convertCopilotQuotaSnapshotsToRateLimits(input.quotaSnapshots);
  return rateLimits
    ? {
        checkedAt: input.checkedAt,
        rateLimits,
      }
    : undefined;
}

export function extractCopilotQuotaSnapshots(value: unknown): unknown | null {
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.quotaSnapshots)) {
    return value.quotaSnapshots;
  }
  if (isRecord(value.data) && isRecord(value.data.quotaSnapshots)) {
    return value.data.quotaSnapshots;
  }
  if (isRecord(value._meta) && isRecord(value._meta.quotaSnapshots)) {
    return value._meta.quotaSnapshots;
  }
  if (isRecord(value.update)) {
    const nested = extractCopilotQuotaSnapshots(value.update);
    if (nested) {
      return nested;
    }
  }
  return null;
}
