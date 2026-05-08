import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ProviderUsageSnapshot } from "../../lib/providerUsage";
import { CodexUsageMeter } from "./CodexUsageMeter";

function makeProviderUsageSnapshot(input: {
  displayName: string;
  driverKind: string;
  instanceId: string;
  accountUsage: ProviderUsageSnapshot["accountUsage"];
  contextWindow?: ProviderUsageSnapshot["contextWindow"];
}): ProviderUsageSnapshot {
  const driverKind = ProviderDriverKind.make(input.driverKind);
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const snapshot = {
    instanceId,
    driver: driverKind,
    displayName: input.displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-05T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
  const entry = {
    instanceId,
    driverKind,
    displayName: input.displayName,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: true,
    snapshot,
    models: [],
  } satisfies ProviderInstanceEntry;

  return {
    entry,
    accountUsage: input.accountUsage,
    tokenUsage: {
      totals: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
      models: [],
    },
    contextWindow: input.contextWindow ?? null,
    updatedAt: input.accountUsage?.updatedAt ?? input.contextWindow?.updatedAt ?? null,
  };
}

describe("CodexUsageMeter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps window labels in the popover while showing compact sidebar usage", async () => {
    const mounted = await render(
      <CodexUsageMeter
        usage={{
          updatedAt: "2026-05-05T00:00:00.000Z",
          limits: [
            {
              key: "codex",
              limitId: "codex",
              limitName: "Codex",
              planType: "plus",
              primary: {
                usedPercent: 18,
                resetsAt: null,
                windowDurationMins: 300,
              },
              secondary: {
                usedPercent: 64,
                resetsAt: 1_777_777_777,
                windowDurationMins: 10_080,
              },
              credits: {
                balance: "$4.20",
                hasCredits: true,
                unlimited: false,
              },
              rateLimitReachedType: null,
            },
          ],
        }}
      />,
    );

    try {
      const trigger = page.getByRole("button", {
        name: "Codex usage 36% left",
      });
      await expect.element(trigger).toBeInTheDocument();
      await expect.element(page.getByText("Usage", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("36%", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Week", { exact: true })).not.toBeInTheDocument();
      await expect.element(page.getByText("5h", { exact: true })).not.toBeInTheDocument();

      await trigger.click();
      await expect
        .element(page.getByText("Rate limits remaining", { exact: true }))
        .toBeInTheDocument();
      await expect.element(page.getByText("Weekly", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByRole("progressbar", { name: "Weekly usage remaining" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("progressbar", { name: "5h usage remaining" }))
        .toBeInTheDocument();
      await expect.element(page.getByText("Learn more", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the usage affordance visible while waiting for account data", async () => {
    const mounted = await render(<CodexUsageMeter usage={null} />);

    try {
      const trigger = page.getByRole("button", { name: "Codex usage" });
      await expect.element(trigger).toBeInTheDocument();

      await trigger.click();
      await expect
        .element(page.getByText("No account usage data has been reported yet.", { exact: true }))
        .toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("filters provider mode to providers with reported account usage", async () => {
    const mounted = await render(
      <CodexUsageMeter
        providerUsages={[
          makeProviderUsageSnapshot({
            displayName: "Codex",
            driverKind: "codex",
            instanceId: "codex",
            accountUsage: null,
            contextWindow: {
              usedTokens: 31_251,
              totalProcessedTokens: null,
              maxTokens: 200_000,
              remainingTokens: 168_749,
              usedPercentage: 15.6255,
              remainingPercentage: 84.3745,
              inputTokens: null,
              cachedInputTokens: null,
              outputTokens: null,
              reasoningOutputTokens: null,
              lastUsedTokens: null,
              lastInputTokens: null,
              lastCachedInputTokens: null,
              lastOutputTokens: null,
              lastReasoningOutputTokens: null,
              toolUses: null,
              durationMs: null,
              compactsAutomatically: false,
              updatedAt: "2026-05-05T00:00:00.000Z",
            },
          }),
          makeProviderUsageSnapshot({
            displayName: "Claude",
            driverKind: "claudeAgent",
            instanceId: "claudeAgent",
            accountUsage: {
              updatedAt: "2026-05-05T00:00:00.000Z",
              limits: [
                {
                  key: "claude",
                  limitId: "claude",
                  limitName: "Claude",
                  planType: null,
                  primary: {
                    usedPercent: 70,
                    resetsAt: null,
                    windowDurationMins: 300,
                  },
                  secondary: {
                    usedPercent: 18,
                    resetsAt: null,
                    windowDurationMins: 10_080,
                  },
                  credits: null,
                  rateLimitReachedType: null,
                },
              ],
            },
          }),
        ]}
      />,
    );

    try {
      const trigger = page.getByRole("button", { name: "Usage 30% left" });
      await trigger.click();

      await expect.element(page.getByText("Claude", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Week", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("5h", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Codex", { exact: true })).not.toBeInTheDocument();
      await expect.element(page.getByText("31k context", { exact: true })).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});
