import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function AdvancedSettingsRouteComponent() {
  return <GeneralSettingsPanel section="advanced" />;
}

export const Route = createFileRoute("/settings/advanced")({
  component: AdvancedSettingsRouteComponent,
});
