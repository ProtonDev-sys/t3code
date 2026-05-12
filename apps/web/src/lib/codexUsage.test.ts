import { describe, expect, it } from "vitest";
import {
  EventId,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  TurnId,
} from "@t3tools/contracts";

import {
  deriveLatestCodexUsageAccountSnapshot,
  deriveLatestCodexUsageAccountSnapshotFromProviders,
  deriveLatestCodexUsageSnapshot,
  estimateCodexUsageRunoutSeconds,
  formatCodexUsageLimitTitle,
  formatCodexUsageRemainingLabel,
  formatCodexUsageRunoutEstimate,
  getCodexUsageDisplayWindow,
  getCodexUsageWindows,
} from "./codexUsage";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-05-05T00:00:00.000Z",
  };
}

function makeProvider(input: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: {
      status: "authenticated",
    },
    checkedAt: "2026-05-05T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...input,
  } satisfies ServerProvider;
}

describe("codexUsage", () => {
  it("derives the latest Codex rate-limit snapshot", () => {
    const snapshot = deriveLatestCodexUsageSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        primary: {
          usedPercent: 12,
          resetsAt: 1_777_777_777,
        },
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "account.rate-limits.updated", {
        primary: {
          usedPercent: 23,
          windowDurationMins: 300,
        },
        planType: "plus",
        limitId: "codex",
        limitName: "Codex",
      }),
    ]);

    expect(snapshot?.limitId).toBe("codex");
    expect(snapshot?.limitName).toBe("Codex");
    expect(snapshot?.planType).toBe("plus");
    expect(snapshot?.primary?.usedPercent).toBe(23);
    expect(snapshot?.primary?.windowDurationMins).toBe(300);
  });

  it("prefers the Codex bucket from multi-limit payloads", () => {
    const snapshot = deriveLatestCodexUsageSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitsByLimitId: {
          chatgpt: {
            limitId: "chatgpt",
            limitName: "ChatGPT",
            primary: { usedPercent: 90 },
          },
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 35 },
          },
        },
      }),
    ]);

    expect(snapshot?.limitId).toBe("codex");
    expect(snapshot?.primary?.usedPercent).toBe(35);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestCodexUsageSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        primary: {},
      }),
    ]);

    expect(snapshot).toBeNull();
  });

  it("labels windows by duration and prefers the weekly window for display", () => {
    const snapshot = deriveLatestCodexUsageSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 18,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 64,
          windowDurationMins: 10_080,
        },
      }),
    ]);

    expect(snapshot).not.toBeNull();
    if (!snapshot) {
      return;
    }

    expect(getCodexUsageWindows(snapshot).map((window) => window.label)).toEqual([
      "5h window",
      "Weekly window",
    ]);

    const displayWindow = getCodexUsageDisplayWindow(snapshot);
    expect(displayWindow?.key).toBe("secondary");
    expect(displayWindow?.shortLabel).toBe("7d");
    expect(displayWindow?.usage.usedPercent).toBe(64);
  });

  it("derives all Codex usage limit buckets for the settings detail view", () => {
    const snapshot = deriveLatestCodexUsageAccountSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 13, windowDurationMins: 300 },
          },
          "gpt-5.3-codex-spark": {
            limitId: "gpt-5.3-codex-spark",
            limitName: "GPT-5.3-Codex-Spark",
            primary: { usedPercent: 0, windowDurationMins: 300 },
          },
        },
      }),
    ]);

    expect(snapshot?.limits).toHaveLength(2);
    expect(snapshot?.limits.map(formatCodexUsageLimitTitle)).toEqual([
      "General usage limits",
      "GPT-5.3-Codex-Spark usage limits",
    ]);
    const generalWindow = snapshot?.limits[0] ? getCodexUsageWindows(snapshot.limits[0])[0] : null;
    expect(generalWindow ? formatCodexUsageRemainingLabel(generalWindow.usage) : null).toBe(
      "87% left",
    );
  });

  it("derives provider-snapshot usage and deduplicates the compatibility bucket", () => {
    const snapshot = deriveLatestCodexUsageAccountSnapshotFromProviders([
      makeProvider({
        usage: {
          checkedAt: "2026-05-05T01:00:00.000Z",
          rateLimits: {
            rateLimits: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 13, windowDurationMins: 300 },
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: "Codex",
                primary: { usedPercent: 13, windowDurationMins: 300 },
              },
              "gpt-5.3-codex-spark": {
                limitId: "gpt-5.3-codex-spark",
                limitName: "GPT-5.3-Codex-Spark",
                primary: { usedPercent: 0, windowDurationMins: 300 },
              },
            },
          },
        },
      }),
    ]);

    expect(snapshot?.updatedAt).toBe("2026-05-05T01:00:00.000Z");
    expect(snapshot?.limits.map((limit) => limit.limitId)).toEqual([
      "codex",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("estimates runout seconds from rate-limit windows", () => {
    const window = {
      usedPercent: 80,
      resetsAt: Date.parse("2026-05-09T20:00:00.000Z") / 1000,
      windowDurationMins: 300,
    };
    const estimate = estimateCodexUsageRunoutSeconds(
      window,
      "2026-05-09T17:30:00.000Z",
      new Date("2026-05-09T17:45:00.000Z"),
    );
    expect(estimate).toBe(1350);
  });

  it("formats usage-runout estimates for low-signal windows", () => {
    const window = {
      usedPercent: 80,
      resetsAt: Date.parse("2026-05-09T20:00:00.000Z") / 1000,
      windowDurationMins: 300,
    };
    expect(
      formatCodexUsageRunoutEstimate(
        window,
        "2026-05-09T17:30:00.000Z",
        new Date("2026-05-09T17:45:00.000Z"),
      ),
    ).toBe("in 23m");
  });

  it("omits runout estimates when usage won't exhaust before reset", () => {
    const window = {
      usedPercent: 20,
      resetsAt: Date.parse("2026-05-09T20:00:00.000Z") / 1000,
      windowDurationMins: 300,
    };
    expect(
      estimateCodexUsageRunoutSeconds(
        window,
        "2026-05-09T17:00:00.000Z",
        new Date("2026-05-09T17:45:00.000Z"),
      ),
    ).toBeNull();
  });
});
