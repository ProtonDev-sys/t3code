import { describe, expect, it } from "vitest";

import { filterSettingsSearchEntries } from "./SettingsSidebarNav";

describe("filterSettingsSearchEntries", () => {
  it("returns top-level settings sections when the query is empty", () => {
    expect(filterSettingsSearchEntries("").map((entry) => entry.label)).toEqual([
      "General",
      "Usage Limits",
      "Statistics",
      "Providers",
      "Agents",
      "MCP Servers",
      "Plugins",
      "Automations",
      "Source Control",
      "Connections",
      "Archive",
      "Advanced",
      "About",
    ]);
  });

  it("matches setting-level entries by label and keywords", () => {
    expect(filterSettingsSearchEntries("clean projects").map((entry) => entry.label)).toContain(
      "Clean inactive projects",
    );
    expect(filterSettingsSearchEntries("weekly limits").map((entry) => entry.label)).toContain(
      "Usage Limits",
    );
    expect(filterSettingsSearchEntries("tokens 30d").map((entry) => entry.label)).toContain(
      "Statistics",
    );
    expect(filterSettingsSearchEntries("mcp toggle").map((entry) => entry.label)).toContain(
      "MCP Servers",
    );
    expect(filterSettingsSearchEntries("custom agents").map((entry) => entry.label)).toContain(
      "Agents",
    );
    expect(filterSettingsSearchEntries("plugin marketplace").map((entry) => entry.label)).toContain(
      "Plugins",
    );
    expect(
      filterSettingsSearchEntries("automation schedule").map((entry) => entry.label),
    ).toContain("Automations");
  });
});
