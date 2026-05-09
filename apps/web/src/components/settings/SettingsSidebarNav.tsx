import { useCallback, useMemo, useState, type ComponentType } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BotIcon,
  BoxIcon,
  CalendarClockIcon,
  GaugeIcon,
  GitBranchIcon,
  InfoIcon,
  Link2Icon,
  PlugIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/usage"
  | "/settings/statistics"
  | "/settings/providers"
  | "/settings/agents"
  | "/settings/mcp"
  | "/settings/plugins"
  | "/settings/automations"
  | "/settings/advanced"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived"
  | "/settings/about";

type SettingsNavItem = {
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<SettingsNavItem>;
}> = [
  {
    label: "General",
    items: [{ label: "General", to: "/settings/general", icon: Settings2Icon }],
  },
  {
    label: "Usage",
    items: [
      { label: "Usage Limits", to: "/settings/usage", icon: GaugeIcon },
      { label: "Statistics", to: "/settings/statistics", icon: BarChart3Icon },
    ],
  },
  {
    label: "Agents & Providers",
    items: [
      { label: "Providers", to: "/settings/providers", icon: BoxIcon },
      { label: "Agents", to: "/settings/agents", icon: BotIcon },
      { label: "MCP Servers", to: "/settings/mcp", icon: ServerIcon },
      { label: "Plugins", to: "/settings/plugins", icon: PlugIcon },
      { label: "Automations", to: "/settings/automations", icon: CalendarClockIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
      { label: "Connections", to: "/settings/connections", icon: Link2Icon },
    ],
  },
  {
    label: "Data & System",
    items: [
      { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
      { label: "Advanced", to: "/settings/advanced", icon: SlidersHorizontalIcon },
      { label: "About", to: "/settings/about", icon: InfoIcon },
    ],
  },
];

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = SETTINGS_NAV_GROUPS.flatMap(
  (group) => group.items,
);

export interface SettingsSearchEntry {
  readonly label: string;
  readonly description: string;
  readonly to: SettingsSectionPath;
  readonly icon: ComponentType<{ className?: string }>;
  readonly keywords: ReadonlyArray<string>;
}

const SETTINGS_SEARCH_ENTRIES: ReadonlyArray<SettingsSearchEntry> = [
  {
    label: "General",
    description: "Theme, timestamps, diff, composer, projects, and thread defaults.",
    to: "/settings/general",
    icon: Settings2Icon,
    keywords: ["general", "theme", "model", "diff", "project", "thread"],
  },
  {
    label: "Usage Limits",
    description: "Provider account usage and remaining rate-limit windows.",
    to: "/settings/usage",
    icon: GaugeIcon,
    keywords: ["usage", "rate", "limit", "limits", "weekly", "account", "codex", "provider"],
  },
  {
    label: "Statistics",
    description: "Token totals, model usage, estimated cost, and recent usage trends.",
    to: "/settings/statistics",
    icon: BarChart3Icon,
    keywords: ["statistics", "stats", "tokens", "cost", "models", "graphs", "7d", "30d"],
  },
  {
    label: "Providers",
    description: "Codex, Claude, Copilot, OpenCode, provider binaries, models, and favorites.",
    to: "/settings/providers",
    icon: BoxIcon,
    keywords: ["provider", "codex", "claude", "opencode", "binary", "favorite"],
  },
  {
    label: "Agents",
    description: "Reusable provider agent profiles for chat model controls.",
    to: "/settings/agents",
    icon: BotIcon,
    keywords: ["agent", "agents", "custom", "profile", "profiles", "provider"],
  },
  {
    label: "MCP Servers",
    description: "Add, enable, disable, and delete Codex MCP server entries.",
    to: "/settings/mcp",
    icon: ServerIcon,
    keywords: ["mcp", "tools", "server", "servers", "provider", "toggle"],
  },
  {
    label: "Plugins",
    description: "Enable or disable installed Codex plugins.",
    to: "/settings/plugins",
    icon: PlugIcon,
    keywords: ["plugin", "plugins", "marketplace", "codex", "extension", "extensions"],
  },
  {
    label: "Automations",
    description: "Pause and resume local Codex automation schedules.",
    to: "/settings/automations",
    icon: CalendarClockIcon,
    keywords: ["automation", "automations", "schedule", "rrule", "cron", "codex"],
  },
  {
    label: "Source Control",
    description: "Git and source-control integrations.",
    to: "/settings/source-control",
    icon: GitBranchIcon,
    keywords: ["source", "git", "github", "gitlab", "bitbucket", "azure", "pr"],
  },
  {
    label: "Connections",
    description: "Pairing links, connected clients, network access, and remote environments.",
    to: "/settings/connections",
    icon: Link2Icon,
    keywords: ["connection", "pair", "client", "network", "remote", "ssh", "url"],
  },
  {
    label: "Archive",
    description: "Archived threads and thread restore actions.",
    to: "/settings/archived",
    icon: ArchiveIcon,
    keywords: ["archive", "archived", "restore", "thread"],
  },
  {
    label: "Advanced",
    description: "Cleanup actions, keybindings, and low-level app maintenance.",
    to: "/settings/advanced",
    icon: SlidersHorizontalIcon,
    keywords: ["advanced", "cleanup", "clean", "inactive", "keybindings", "shortcut"],
  },
  {
    label: "About",
    description: "Version and diagnostics paths.",
    to: "/settings/about",
    icon: InfoIcon,
    keywords: ["about", "version", "diagnostics", "logs", "trace", "observability"],
  },
  {
    label: "Theme",
    description: "Switch between system, light, dark, and Blurple Twilight appearance.",
    to: "/settings/general",
    icon: Settings2Icon,
    keywords: ["appearance", "dark", "light", "system", "blurple", "twilight"],
  },
  {
    label: "Diff line wrapping",
    description: "Default wrapping and whitespace behavior in the diff panel.",
    to: "/settings/general",
    icon: Settings2Icon,
    keywords: ["diff", "wrap", "whitespace"],
  },
  {
    label: "Assistant output",
    description: "Show token-by-token output while a response is in progress.",
    to: "/settings/general",
    icon: Settings2Icon,
    keywords: ["streaming", "assistant", "output", "response"],
  },
  {
    label: "New threads",
    description: "Default workspace mode for newly created draft threads.",
    to: "/settings/general",
    icon: Settings2Icon,
    keywords: ["thread", "draft", "workspace", "worktree", "local"],
  },
  {
    label: "Text generation model",
    description: "Model used for generated commit messages, PR titles, and Git text.",
    to: "/settings/general",
    icon: Settings2Icon,
    keywords: ["model", "commit", "pr", "title", "text"],
  },
  {
    label: "Provider instances",
    description: "Codex, Claude, Copilot, OpenCode, provider binaries, models, and favorites.",
    to: "/settings/providers",
    icon: BoxIcon,
    keywords: ["provider", "codex", "claude", "opencode", "binary", "favorite"],
  },
  {
    label: "MCP Servers",
    description: "Add, enable, disable, and delete Codex MCP server entries.",
    to: "/settings/mcp",
    icon: ServerIcon,
    keywords: ["mcp", "tools", "server", "servers", "provider", "toggle"],
  },
  {
    label: "Codex plugins",
    description: "Enable or disable installed Codex plugins.",
    to: "/settings/plugins",
    icon: PlugIcon,
    keywords: ["plugin", "plugins", "marketplace", "codex", "extension", "extensions"],
  },
  {
    label: "Codex automations",
    description: "Pause and resume local Codex automation schedules.",
    to: "/settings/automations",
    icon: CalendarClockIcon,
    keywords: ["automation", "automations", "schedule", "rrule", "cron", "codex"],
  },
  {
    label: "Custom agents",
    description: "Create reusable provider agent profiles for chat model controls.",
    to: "/settings/agents",
    icon: BotIcon,
    keywords: ["agent", "agents", "custom", "profile", "profiles", "provider"],
  },
  {
    label: "Clean inactive threads",
    description: "Delete threads that have not been used for 30+ days from T3 Code.",
    to: "/settings/advanced",
    icon: SlidersHorizontalIcon,
    keywords: ["cleanup", "clean", "inactive", "old", "thread", "delete"],
  },
  {
    label: "Clean inactive projects",
    description: "Remove projects with no threads from T3 Code without deleting folders.",
    to: "/settings/advanced",
    icon: SlidersHorizontalIcon,
    keywords: ["cleanup", "clean", "inactive", "empty", "project", "folder", "disk"],
  },
  {
    label: "Keybindings",
    description: "Open the persisted keybindings.json file.",
    to: "/settings/advanced",
    icon: SlidersHorizontalIcon,
    keywords: ["shortcut", "keyboard", "binding", "keybindings"],
  },
  {
    label: "Diagnostics",
    description: "Open logs and inspect tracing/export configuration.",
    to: "/settings/about",
    icon: InfoIcon,
    keywords: ["diagnostics", "logs", "trace", "observability"],
  },
];

function normalizedSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function filterSettingsSearchEntries(query: string): ReadonlyArray<SettingsSearchEntry> {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) {
    return SETTINGS_SEARCH_ENTRIES.slice(0, SETTINGS_NAV_ITEMS.length);
  }
  const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => {
    const haystack = [
      entry.label,
      entry.description,
      ...entry.keywords,
      SETTINGS_NAV_ITEMS.find((item) => item.to === entry.to)?.label ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return queryParts.every((part) => haystack.includes(part));
  });
}

function SettingsNavButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
      onClick={onClick}
    >
      <Icon
        className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground/65")}
      />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

export function SettingsCenterNav({
  className,
  pathname,
}: {
  className?: string;
  pathname: string;
}) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [query, setQuery] = useState("");
  const results = useMemo(() => filterSettingsSearchEntries(query), [query]);
  const hasQuery = normalizedSearchText(query).length > 0;
  const goToPath = useCallback(
    (to: SettingsSectionPath) => {
      void navigate({ to, replace: true });
    },
    [navigate],
  );
  const goBack = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col rounded-xl border border-border/70 bg-card/55 p-2 shadow-sm/4",
        className,
      )}
      aria-label="Settings navigation"
    >
      <div className="p-1">
        <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Settings
        </div>
        <label className="relative block">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            size="sm"
            nativeInput
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            className="rounded-md bg-background/80 pl-6 text-xs"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || results.length === 0) return;
              event.preventDefault();
              goToPath(results[0]!.to);
            }}
          />
        </label>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {hasQuery ? (
          <div className="space-y-1">
            {results.length > 0 ? (
              results.map((entry) => {
                const Icon = entry.icon;
                return (
                  <button
                    key={`${entry.to}:${entry.label}`}
                    type="button"
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-md px-2 py-2 text-left outline-hidden transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => goToPath(entry.to)}
                  >
                    <Icon className="mt-0.5 size-3.5 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {entry.label}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                        {entry.description}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No settings match "{query.trim()}".
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.label} className="space-y-1">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <SettingsNavButton
                    key={item.to}
                    active={pathname === item.to}
                    icon={item.icon}
                    label={item.label}
                    onClick={() => goToPath(item.to)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 border-border/70 border-t pt-2">
        <SettingsNavButton active={false} icon={ArrowLeftIcon} label="Back" onClick={goBack} />
      </div>
    </aside>
  );
}

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="px-2 py-2">
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
              {group.label}
            </div>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.to;
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      size="sm"
                      isActive={isActive}
                      className={
                        isActive
                          ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                          : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                      }
                      onClick={() => handleSectionClick(item.to)}
                    >
                      <Icon
                        className={
                          isActive
                            ? "size-4 shrink-0 text-foreground"
                            : "size-4 shrink-0 text-muted-foreground/60"
                        }
                      />
                      <span className="truncate">{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
