import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function PluginsSettingsRouteComponent() {
  return <GeneralSettingsPanel section="plugins" />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsSettingsRouteComponent,
});
