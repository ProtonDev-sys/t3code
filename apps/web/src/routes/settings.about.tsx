import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function AboutSettingsRouteComponent() {
  return <GeneralSettingsPanel section="about" />;
}

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsRouteComponent,
});
