import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function AutomationsSettingsRouteComponent() {
  return <GeneralSettingsPanel section="automations" />;
}

export const Route = createFileRoute("/settings/automations")({
  component: AutomationsSettingsRouteComponent,
});
