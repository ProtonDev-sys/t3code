import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";

function McpSettingsRouteComponent() {
  return <GeneralSettingsPanel section="mcp" />;
}

export const Route = createFileRoute("/settings/mcp")({
  component: McpSettingsRouteComponent,
});
