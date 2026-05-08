import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function GeneralSettingsRouteComponent() {
  return <GeneralSettingsPanel section="general" />;
}

export const Route = createFileRoute("/settings/general")({
  component: GeneralSettingsRouteComponent,
});
