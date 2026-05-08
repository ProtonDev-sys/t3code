import { createFileRoute } from "@tanstack/react-router";

import { ProviderStatisticsSettingsPanel } from "../components/settings/ProviderStatisticsSettings";

export const Route = createFileRoute("/settings/statistics")({
  component: ProviderStatisticsSettingsPanel,
});
