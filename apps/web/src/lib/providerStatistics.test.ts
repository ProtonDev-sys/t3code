import {
  EventId,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveProviderStatisticsSnapshot,
  getProviderStatisticsPeriod,
} from "./providerStatistics";

function makeProvider(input: Partial<ServerProvider> = {}): ServerProvider {
  const driver = input.driver ?? ProviderDriverKind.make("codex");
  return {
    instanceId: input.instanceId ?? ProviderInstanceId.make(String(driver)),
    driver,
    displayName: input.displayName ?? "Codex",
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: {
      status: "authenticated",
    },
    checkedAt: input.checkedAt ?? "2026-05-07T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...input,
  } satisfies ServerProvider;
}

function makeActivity(input: {
  id: string;
  kind: "usage.turn.started" | "usage.turn.completed";
  createdAt: string;
  turnId: string;
  payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    turnId: TurnId.make(input.turnId),
    sequence: 1,
    createdAt: input.createdAt,
  };
}

describe("providerStatistics", () => {
  it("filters by period and aggregates tokens, models, cost, and trend", () => {
    const provider = makeProvider();
    const snapshot = deriveProviderStatisticsSnapshot({
      providers: [provider],
      periodId: "7d",
      now: new Date("2026-05-07T12:00:00.000Z"),
      activities: [
        makeActivity({
          id: "started-recent",
          kind: "usage.turn.started",
          createdAt: "2026-05-06T10:00:00.000Z",
          turnId: "turn-recent",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        }),
        makeActivity({
          id: "completed-recent",
          kind: "usage.turn.completed",
          createdAt: "2026-05-06T10:01:00.000Z",
          turnId: "turn-recent",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            usage: {
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 10,
              totalTokens: 140,
            },
          },
        }),
        makeActivity({
          id: "started-old",
          kind: "usage.turn.started",
          createdAt: "2026-04-01T10:00:00.000Z",
          turnId: "turn-old",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
        }),
        makeActivity({
          id: "completed-old",
          kind: "usage.turn.completed",
          createdAt: "2026-04-01T10:01:00.000Z",
          turnId: "turn-old",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            usage: {
              inputTokens: 1_000,
              outputTokens: 1_000,
              totalTokens: 2_000,
            },
          },
        }),
      ],
    });

    expect(snapshot.period).toEqual(getProviderStatisticsPeriod("7d"));
    expect(snapshot.tokenUsage.totals.totalTokens).toBe(140);
    expect(snapshot.tokenUsage.totals.estimatedCostUsd).toBe(0.000805);
    expect(snapshot.tokenUsage.models.map((model) => model.model)).toEqual(["gpt-5.4"]);
    expect(snapshot.trend).toHaveLength(7);
    expect(snapshot.trend.at(-2)?.totals.totalTokens).toBe(140);
  });

  it("shows every hour in the last 24h trend", () => {
    const provider = makeProvider();
    const snapshot = deriveProviderStatisticsSnapshot({
      providers: [provider],
      periodId: "24h",
      now: new Date("2026-05-07T12:34:00.000Z"),
      activities: [
        makeActivity({
          id: "started-recent",
          kind: "usage.turn.started",
          createdAt: "2026-05-07T10:15:00.000Z",
          turnId: "turn-recent",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          },
        }),
        makeActivity({
          id: "completed-recent",
          kind: "usage.turn.completed",
          createdAt: "2026-05-07T10:16:00.000Z",
          turnId: "turn-recent",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            usage: {
              inputTokens: 100,
              outputTokens: 30,
              totalTokens: 130,
            },
          },
        }),
      ],
    });

    expect(snapshot.trend).toHaveLength(24);
    expect(snapshot.trend[0]?.key).toBe("2026-05-06T13");
    expect(snapshot.trend.at(-1)?.key).toBe("2026-05-07T12");
    expect(
      snapshot.trend.find((bucket) => bucket.key === "2026-05-07T10")?.totals.totalTokens,
    ).toBe(130);
  });
});
