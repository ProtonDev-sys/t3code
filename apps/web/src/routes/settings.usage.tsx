import { createFileRoute } from "@tanstack/react-router";

import { CodexUsageSettingsPanel } from "../components/settings/CodexUsageSettings";

export const Route = createFileRoute("/settings/usage")({
  component: CodexUsageSettingsPanel,
});
