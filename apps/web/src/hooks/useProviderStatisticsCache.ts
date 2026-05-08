import { useEffect, useMemo, useState } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  mergeProviderStatisticsActivities,
  readCachedProviderStatisticsActivities,
  writeCachedProviderStatisticsActivities,
} from "../lib/providerStatisticsCache";

function activitySignature(activities: ReadonlyArray<OrchestrationThreadActivity>): string {
  return activities.map((activity) => activity.id).join("\0");
}

export function useProviderStatisticsCachedActivities(
  liveActivities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const [cachedActivities, setCachedActivities] = useState(() =>
    readCachedProviderStatisticsActivities(),
  );

  useEffect(() => {
    const merged = mergeProviderStatisticsActivities(cachedActivities, liveActivities);
    if (activitySignature(merged) === activitySignature(cachedActivities)) {
      return;
    }
    setCachedActivities(merged);
    writeCachedProviderStatisticsActivities(merged);
  }, [cachedActivities, liveActivities]);

  return useMemo(
    () => mergeProviderStatisticsActivities(cachedActivities, liveActivities),
    [cachedActivities, liveActivities],
  );
}
