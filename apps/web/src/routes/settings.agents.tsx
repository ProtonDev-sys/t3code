import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function AgentsSettingsRouteComponent() {
  return <GeneralSettingsPanel section="agents" />;
}

export const Route = createFileRoute("/settings/agents")({
  component: AgentsSettingsRouteComponent,
});
