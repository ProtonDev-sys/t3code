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
  deriveProviderUsageSnapshots,
  estimateProviderTotalTokenCostUsd,
  hasReportedProviderAccountUsage,
  hasReportedProviderTokenUsage,
} from "./providerUsage";

function makeProvider(input: Partial<ServerProvider>): ServerProvider {
  const driver = input.driver ?? ProviderDriverKind.make("codex");
  return {
    instanceId: input.instanceId ?? ProviderInstanceId.make(String(driver)),
    driver,
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: {
      status: "authenticated",
    },
    checkedAt: input.checkedAt ?? "2026-05-05T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...input,
  } satisfies ServerProvider;
}

function makeActivity(
  id: string,
  kind:
    | "account.rate-limits.updated"
    | "context-window.updated"
    | "usage.turn.started"
    | "usage.turn.completed",
  payload: unknown,
  createdAt = "2026-05-05T01:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    sequence: 1,
    createdAt,
  };
}

describe("providerUsage", () => {
  it("derives usage for each enabled available provider", () => {
    const codex = ProviderDriverKind.make("codex");
    const claude = ProviderDriverKind.make("claudeAgent");
    const opencode = ProviderDriverKind.make("opencode");

    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: codex,
          displayName: "Codex",
          usage: {
            checkedAt: "2026-05-05T00:00:00.000Z",
            rateLimits: {
              rateLimitsByLimitId: {
                codex: {
                  limitId: "codex",
                  limitName: "Codex",
                  primary: { usedPercent: 10, windowDurationMins: 300 },
                },
              },
            },
          },
        }),
        makeProvider({
          driver: claude,
          displayName: "Claude",
        }),
        makeProvider({
          driver: opencode,
          displayName: "OpenCode",
          enabled: false,
          status: "disabled",
        }),
      ],
      [
        makeActivity("activity-codex", "account.rate-limits.updated", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          rateLimits: {
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: "Codex",
                primary: { usedPercent: 42, windowDurationMins: 300 },
              },
            },
          },
        }),
        makeActivity("activity-claude-account", "account.rate-limits.updated", {
          provider: claude,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          rateLimits: {
            limitId: "claude",
            limitName: "Claude",
            primary: { usedPercent: 70, windowDurationMins: 300 },
          },
        }),
        makeActivity("activity-claude-context", "context-window.updated", {
          provider: claude,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          usedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
        }),
      ],
    );

    expect(snapshots.map((snapshot) => snapshot.entry.displayName)).toEqual(["Codex", "Claude"]);
    expect(snapshots[0]?.accountUsage?.limits[0]?.primary?.usedPercent).toBe(42);
    expect(snapshots[1]?.accountUsage?.limits[0]?.primary?.usedPercent).toBe(70);
    expect(snapshots[1]?.contextWindow?.usedTokens).toBe(31_251);
  });

  it("keeps legacy unscoped rate-limit events on the Codex provider", () => {
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex",
        }),
      ],
      [
        makeActivity("activity-legacy", "account.rate-limits.updated", {
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 18, windowDurationMins: 300 },
            },
          },
        }),
      ],
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.accountUsage?.limits[0]?.primary?.usedPercent).toBe(18);
  });

  it("distinguishes reported account usage from context-window telemetry", () => {
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex",
        }),
        makeProvider({
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Claude",
        }),
      ],
      [
        makeActivity("activity-codex-context", "context-window.updated", {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          usedTokens: 31_251,
          maxTokens: 200_000,
        }),
        makeActivity("activity-claude-account", "account.rate-limits.updated", {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          rateLimits: {
            limitId: "claude",
            limitName: "Claude",
            primary: { usedPercent: 70, windowDurationMins: 300 },
          },
        }),
      ],
    );

    expect(snapshots.map((snapshot) => snapshot.entry.displayName)).toEqual(["Codex", "Claude"]);
    expect(
      snapshots
        .filter(hasReportedProviderAccountUsage)
        .map((snapshot) => snapshot.entry.displayName),
    ).toEqual(["Claude"]);
  });

  it("keeps Copilot ACP usage updates visible as context-window telemetry", () => {
    const copilot = ProviderDriverKind.make("copilot");
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: copilot,
          instanceId: ProviderInstanceId.make("copilot"),
          displayName: "Copilot",
        }),
      ],
      [
        makeActivity("activity-copilot-context", "context-window.updated", {
          provider: copilot,
          providerInstanceId: ProviderInstanceId.make("copilot"),
          usedTokens: 12_345,
          maxTokens: 200_000,
        }),
      ],
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.entry.displayName).toBe("Copilot");
    expect(snapshots[0]?.contextWindow).toMatchObject({
      usedTokens: 12_345,
      maxTokens: 200_000,
      remainingTokens: 187_655,
    });
    expect(hasReportedProviderTokenUsage(snapshots[0]!)).toBe(false);
  });

  it("aggregates token usage by provider and model without double-counting context snapshots", () => {
    const codex = ProviderDriverKind.make("codex");
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: codex,
          displayName: "Codex",
        }),
      ],
      [
        makeActivity("activity-turn-completed-1", "usage.turn.completed", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          usage: {
            inputTokens: 60,
            cachedInputTokens: 40,
            outputTokens: 25,
            reasoningOutputTokens: 5,
            totalTokens: 130,
          },
          totalCostUsd: 0.02,
        }),
        makeActivity("activity-turn-started-1", "usage.turn.started", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
        makeActivity("activity-context-same-turn", "context-window.updated", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          usedTokens: 130,
          lastInputTokens: 60,
          lastCachedInputTokens: 40,
          lastOutputTokens: 25,
          lastReasoningOutputTokens: 5,
          lastUsedTokens: 130,
        }),
        {
          ...makeActivity("activity-turn-started-2", "usage.turn.started", {
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
          }),
          turnId: TurnId.make("turn-2"),
        },
        {
          ...makeActivity("activity-turn-completed-2", "usage.turn.completed", {
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex"),
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 5,
              output_tokens: 8,
              reasoning_output_tokens: 2,
            },
            totalCostUsd: 0.01,
          }),
          turnId: TurnId.make("turn-2"),
        },
      ],
    );

    expect(snapshots).toHaveLength(1);
    expect(hasReportedProviderTokenUsage(snapshots[0]!)).toBe(true);
    expect(snapshots[0]?.tokenUsage.totals).toEqual({
      inputTokens: 75,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 45,
      outputTokens: 33,
      reasoningOutputTokens: 7,
      totalTokens: 155,
      estimatedCostUsd: 0.0008625,
    });
    expect(snapshots[0]?.tokenUsage.models).toEqual([
      {
        model: "gpt-5.4",
        totals: {
          inputTokens: 60,
          cacheCreationInputTokens: 0,
          cachedInputTokens: 40,
          outputTokens: 25,
          reasoningOutputTokens: 5,
          totalTokens: 130,
          estimatedCostUsd: 0.00051,
        },
      },
      {
        model: "gpt-5.5",
        totals: {
          inputTokens: 15,
          cacheCreationInputTokens: 0,
          cachedInputTokens: 5,
          outputTokens: 8,
          reasoningOutputTokens: 2,
          totalTokens: 25,
          estimatedCostUsd: 0.0003525,
        },
      },
    ]);
  });

  it("uses provider context-window deltas without inventing an unknown model row", () => {
    const codex = ProviderDriverKind.make("codex");
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: codex,
          displayName: "Codex",
        }),
      ],
      [
        makeActivity("activity-codex-context", "context-window.updated", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          usedTokens: 15_462_942,
          lastInputTokens: 15_421_182,
          lastCachedInputTokens: 15_040_640,
          lastOutputTokens: 40_778,
          lastReasoningOutputTokens: 982,
          lastUsedTokens: 15_462_942,
        }),
      ],
    );

    expect(snapshots[0]?.tokenUsage.totals).toEqual({
      inputTokens: 15_421_182,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 15_040_640,
      outputTokens: 40_778,
      reasoningOutputTokens: 982,
      totalTokens: 15_462_942,
      estimatedCostUsd: 0,
    });
    expect(snapshots[0]?.tokenUsage.models).toEqual([]);
  });

  it("prices context-window deltas when model attribution is available", () => {
    const codex = ProviderDriverKind.make("codex");
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: codex,
          displayName: "Codex",
        }),
      ],
      [
        makeActivity("activity-codex-context", "context-window.updated", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
          usedTokens: 1_100_000,
          lastInputTokens: 1_000_000,
          lastCachedInputTokens: 100_000,
          lastOutputTokens: 100_000,
          lastUsedTokens: 1_100_000,
        }),
      ],
    );

    expect(snapshots[0]?.tokenUsage.totals.estimatedCostUsd).toBe(13.6);
    expect(snapshots[0]?.tokenUsage.models).toEqual([
      {
        model: "gpt-5.5",
        totals: {
          inputTokens: 1_000_000,
          cacheCreationInputTokens: 0,
          cachedInputTokens: 100_000,
          outputTokens: 100_000,
          reasoningOutputTokens: 0,
          totalTokens: 1_100_000,
          estimatedCostUsd: 13.6,
        },
      },
    ]);
  });

  it("uses the large-context Sonnet 4.5 pricing tier when input exceeds 200K tokens", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: claude,
          instanceId: ProviderInstanceId.make("claudeAgent"),
          displayName: "Claude",
        }),
      ],
      [
        makeActivity("activity-turn-started", "usage.turn.started", {
          provider: claude,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-5",
        }),
        makeActivity("activity-turn-completed", "usage.turn.completed", {
          provider: claude,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          usage: {
            input_tokens: 250_000,
            cache_read_input_tokens: 100_000,
            output_tokens: 10_000,
          },
        }),
      ],
    );

    expect(snapshots[0]?.tokenUsage.totals.estimatedCostUsd).toBe(1.785);
  });

  it("prices GPT-5.5 shorthand with the GPT-5.5 tier", () => {
    const codex = ProviderDriverKind.make("codex");
    const snapshots = deriveProviderUsageSnapshots(
      [
        makeProvider({
          driver: codex,
          displayName: "Codex",
        }),
      ],
      [
        makeActivity("activity-turn-started", "usage.turn.started", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "5.5",
        }),
        makeActivity("activity-turn-completed", "usage.turn.completed", {
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          usage: {
            input_tokens: 1_000_000,
            cache_read_input_tokens: 100_000,
            output_tokens: 100_000,
          },
        }),
      ],
    );

    expect(snapshots[0]?.tokenUsage.totals.estimatedCostUsd).toBe(14.6);
  });

  it("prices provider-prefixed GPT-5.5 model IDs with the GPT-5.5 tier", () => {
    expect(estimateProviderTotalTokenCostUsd("openai/gpt-5.5", 1_000_000)).toBe(5);
  });
});
