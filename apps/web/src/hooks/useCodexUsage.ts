import { useMemo } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { pickLatestCodexUsageAccountSnapshot } from "../lib/codexUsage";
import { deriveProviderUsageSnapshots } from "../lib/providerUsage";
import { useServerProviders } from "../rpc/serverState";
import { type AppState, useStore } from "../store";

export function selectProviderUsageActivities(
  state: AppState,
): ReadonlyArray<OrchestrationThreadActivity> {
  const usageActivities: OrchestrationThreadActivity[] = [];

  for (const environmentState of Object.values(state.environmentStateById)) {
    for (const threadId of environmentState.threadIds) {
      const activityIds = environmentState.activityIdsByThreadId[threadId] ?? [];
      const activitiesById = environmentState.activityByThreadId[threadId];
      if (!activitiesById || activityIds.length === 0) {
        continue;
      }

      for (let index = activityIds.length - 1; index >= 0; index -= 1) {
        const activityId = activityIds[index];
        const activity = activityId ? activitiesById[activityId] : undefined;
        if (
          activity?.kind !== "account.rate-limits.updated" &&
          activity?.kind !== "context-window.updated" &&
          activity?.kind !== "usage.turn.started" &&
          activity?.kind !== "usage.turn.completed"
        ) {
          continue;
        }
        usageActivities.push(activity);
      }
    }
  }

  return usageActivities;
}

const EMPTY_USAGE_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];

export function useProviderAccountUsageSnapshots() {
  const providers = useServerProviders();
  return useMemo(
    () => deriveProviderUsageSnapshots(providers, EMPTY_USAGE_ACTIVITIES),
    [providers],
  );
}

export function useProviderUsageSnapshots() {
  const providers = useServerProviders();
  const usageActivities = useStore(useShallow(selectProviderUsageActivities));
  return useMemo(
    () => deriveProviderUsageSnapshots(providers, usageActivities),
    [providers, usageActivities],
  );
}

export function useLatestCodexUsageAccountSnapshot() {
  const providerUsageSnapshots = useProviderAccountUsageSnapshots();
  return useMemo(
    () =>
      pickLatestCodexUsageAccountSnapshot(
        providerUsageSnapshots
          .filter((snapshot) => snapshot.entry.driverKind === "codex")
          .map((snapshot) => snapshot.accountUsage),
      ),
    [providerUsageSnapshots],
  );
}
