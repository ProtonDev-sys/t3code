import { describe, expect, it } from "vitest";

import { convertCopilotQuotaSnapshotsToRateLimits } from "./copilotUsage.ts";

describe("copilotUsage", () => {
  it("normalizes Copilot quota snapshots into account rate limits", () => {
    const rateLimits = convertCopilotQuotaSnapshotsToRateLimits({
      chat: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 500,
        usedRequests: 70,
        remainingPercentage: 86,
        resetDate: "2026-06-08T00:00:00.000Z",
      },
      completions: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 4000,
        usedRequests: 0,
        remainingPercentage: 100,
        resetDate: "2026-06-08T00:00:00.000Z",
      },
      premium_interactions: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 0,
        usedRequests: 0,
        remainingPercentage: 0,
        resetDate: "2026-06-08T00:00:00.000Z",
      },
      session: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 0,
        usedRequests: 0,
        remainingPercentage: 99,
        resetDate: "2026-05-10T01:21:08.000Z",
      },
      weekly: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 0,
        usedRequests: 0,
        remainingPercentage: 97.6,
        resetDate: "2026-05-11T00:00:00.000Z",
      },
    });

    expect(Object.keys(rateLimits?.rateLimitsByLimitId ?? {})).toEqual([
      "copilot_chat",
      "copilot_completions",
      "copilot_session",
      "copilot_weekly",
    ]);
    expect(rateLimits?.rateLimitsByLimitId.copilot_chat?.primary.usedPercent).toBe(14);
    expect(rateLimits?.rateLimitsByLimitId.copilot_chat?.primary.windowDurationMins).toBe(43_200);
    expect(rateLimits?.rateLimitsByLimitId.copilot_session?.primary.usedPercent).toBe(1);
    expect(rateLimits?.rateLimitsByLimitId.copilot_session?.primary.windowDurationMins).toBe(300);
    expect(rateLimits?.rateLimitsByLimitId.copilot_weekly?.primary.usedPercent).toBeCloseTo(2.4);
    expect(rateLimits?.rateLimitsByLimitId.copilot_weekly?.primary.windowDurationMins).toBe(10_080);
    expect(rateLimits?.rateLimitsByLimitId.copilot_premium_interactions).toBeUndefined();
  });
});
