import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function ProvidersSettingsRouteComponent() {
  return <GeneralSettingsPanel section="providers" />;
}

export const Route = createFileRoute("/settings/providers")({
  component: ProvidersSettingsRouteComponent,
});
