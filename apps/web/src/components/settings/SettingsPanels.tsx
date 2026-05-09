import {
  ArchiveIcon,
  ArchiveX,
  BotIcon,
  CalendarClockIcon,
  CircleHelpIcon,
  DownloadIcon,
  LoaderIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CodexMcpServerSummary,
  type CodexMcpServerName,
  type CodexMcpServerTransport,
  type CodexAutomationSummary,
  type CodexPluginListResult,
  type CodexPluginSummary,
  defaultInstanceIdForDriver,
  type DesktopUpdateChannel,
  type KeybindingCommand,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createModelSelection } from "@t3tools/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ComposerModelDropdown } from "../chat/ComposerModelDropdown";
import { TraitsPicker } from "../chat/TraitsPicker";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isDesktopShell } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useComposerDraftStore } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  clearDesktopUpdateInstallExpected,
  markDesktopUpdateInstallExpected,
} from "../../lib/desktopUpdateInstallState";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { newCommandId } from "../../lib/utils";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  buildProviderInstanceUpdatePatch,
  getEmptyProjectCleanupCandidates,
  getInactiveThreadCleanupCandidates,
  INACTIVE_THREAD_CLEANUP_DAYS,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerKeybindings,
  useServerKeybindingsConfigPath,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";
import { keybindingValueFromShortcutEvent, shortcutLabelForCommand } from "../../keybindings";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
  {
    value: "blurple-twilight",
    label: "Blurple Twilight",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const SETTINGS_INPUT_CLASS =
  "h-9 rounded-md border border-input bg-background px-3 text-sm outline-hidden transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/30";
const SETTINGS_TEXTAREA_CLASS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/30";

const EDITABLE_KEYBINDING_COMMANDS: ReadonlyArray<{
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly context: Record<string, boolean>;
}> = [
  { command: "commandPalette.toggle", label: "Command palette", context: { terminalFocus: false } },
  { command: "chat.new", label: "New thread", context: { terminalFocus: false } },
  { command: "chat.newLocal", label: "New local thread", context: { terminalFocus: false } },
  { command: "modelPicker.toggle", label: "Model picker", context: { terminalFocus: false } },
  { command: "terminal.toggle", label: "Toggle terminal", context: {} },
  { command: "terminal.split", label: "Split terminal", context: { terminalFocus: true } },
  { command: "terminal.new", label: "New terminal", context: { terminalFocus: true } },
  { command: "terminal.close", label: "Close terminal", context: { terminalFocus: true } },
  { command: "diff.toggle", label: "Toggle diff", context: { terminalFocus: false } },
  { command: "editor.openFavorite", label: "Open favorite editor", context: {} },
  { command: "thread.previous", label: "Previous thread", context: {} },
  { command: "thread.next", label: "Next thread", context: {} },
];

const DEFAULT_KEYBINDING_WHEN_BY_COMMAND = new Map<KeybindingCommand, string | undefined>(
  DEFAULT_KEYBINDINGS.map((rule) => [rule.command, rule.when]),
);

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt ? formatRelativeTime(lastCheckedAt) : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-[11px] text-muted-foreground/60">
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const updateState = updateStateQuery.data ?? null;
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateStateQueryData(queryClient, state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [queryClient, selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: error instanceof Error ? error.message : "Download failed.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      markDesktopUpdateInstallExpected();
      toastManager.add(
        stackedThreadToast({
          type: "loading",
          title: "Installing update",
          description: "T3 Code is restarting to finish the update.",
          timeout: 0,
          data: {
            hideCopyButton: true,
          },
        }),
      );
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          if (result.state.errorContext === "install") {
            clearDesktopUpdateInstallExpected();
          }
        })
        .catch((error: unknown) => {
          clearDesktopUpdateInstallExpected();
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    installing: "Installing…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      <SettingsRow
        title="Update track"
        description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
        control={
          <Select
            value={selectedUpdateChannel}
            onValueChange={(value) => {
              handleUpdateChannelChange(value as DesktopUpdateChannel);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={!hasDesktopBridge || isChangingUpdateChannel}
            >
              <SelectValue>
                {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="latest">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="nightly">
                Nightly
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

const MCP_TRANSPORT_OPTIONS = [
  { value: "stdio", label: "stdio" },
  { value: "sse", label: "SSE" },
  { value: "http", label: "HTTP" },
] as const satisfies ReadonlyArray<{
  readonly value: Exclude<CodexMcpServerTransport, "unknown">;
  readonly label: string;
}>;

function splitMcpArgs(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function McpServerSummaryRow({
  disabled,
  onDelete,
  onToggle,
  server,
}: {
  readonly disabled: boolean;
  readonly onDelete: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly server: CodexMcpServerSummary;
}) {
  const detail =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
      : (server.url ?? "");

  return (
    <div className="grid gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-foreground">{server.name}</h3>
          <Badge variant={server.enabled ? "success" : "warning"} size="sm">
            {server.enabled ? "enabled" : "disabled"}
          </Badge>
          <Badge variant="outline" size="sm">
            {server.transport}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {server.toolCount} tool{server.toolCount === 1 ? "" : "s"}
          </span>
        </div>
        {detail ? (
          <p
            className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80"
            title={detail}
          >
            {detail}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={server.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => onToggle(Boolean(checked))}
          aria-label={`${server.enabled ? "Disable" : "Enable"} MCP server ${server.name}`}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-8 text-muted-foreground hover:text-destructive"
          disabled={disabled}
          onClick={onDelete}
          aria-label={`Delete MCP server ${server.name}`}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function CodexMcpConfigSection() {
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [servers, setServers] = useState<ReadonlyArray<CodexMcpServerSummary>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    transport: "stdio" as Exclude<CodexMcpServerTransport, "unknown">,
    command: "",
    args: "",
    url: "",
  });

  const loadServers = useCallback(() => {
    setIsLoading(true);
    setError(null);
    void ensureLocalApi()
      .server.codexMcp.list()
      .then((result) => {
        setConfigPath(result.configPath);
        setServers(result.servers);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "Failed to load MCP servers.");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const addServer = useCallback(() => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    void ensureLocalApi()
      .server.codexMcp.add({
        name: draft.name.trim() as CodexMcpServerName,
        transport: draft.transport,
        enabled: true,
        ...(draft.transport === "stdio"
          ? {
              command: draft.command.trim(),
              args: splitMcpArgs(draft.args),
            }
          : {
              url: draft.url.trim(),
            }),
      })
      .then((result) => {
        setConfigPath(result.configPath);
        setServers(result.servers);
        setDraft({ name: "", transport: "stdio", command: "", args: "", url: "" });
        setIsAddDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "MCP server added",
          description: "Codex config was updated.",
        });
      })
      .catch((saveError: unknown) => {
        setError(saveError instanceof Error ? saveError.message : "Failed to add MCP server.");
      })
      .finally(() => setIsSaving(false));
  }, [draft, isSaving]);

  const updateServerEnabled = useCallback(
    (server: CodexMcpServerSummary, enabled: boolean) => {
      if (isSaving) return;
      setIsSaving(true);
      setError(null);
      void ensureLocalApi()
        .server.codexMcp.update({
          name: server.name,
          enabled,
        })
        .then((result) => {
          setConfigPath(result.configPath);
          setServers(result.servers);
        })
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : "Failed to update MCP server.");
        })
        .finally(() => setIsSaving(false));
    },
    [isSaving],
  );

  const deleteServer = useCallback(
    (server: CodexMcpServerSummary) => {
      if (isSaving) return;
      void (async () => {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          [`Delete MCP server ${server.name}?`, "This removes it from Codex config.toml."].join(
            "\n",
          ),
        );
        if (!confirmed) return;
        setIsSaving(true);
        setError(null);
        try {
          const result = await ensureLocalApi().server.codexMcp.delete({ name: server.name });
          setConfigPath(result.configPath);
          setServers(result.servers);
          toastManager.add({
            type: "success",
            title: "MCP server deleted",
            description: `${server.name} was removed from Codex config.`,
          });
        } catch (saveError) {
          setError(saveError instanceof Error ? saveError.message : "Failed to delete MCP server.");
        } finally {
          setIsSaving(false);
        }
      })();
    },
    [isSaving],
  );

  return (
    <SettingsSection
      title="Codex MCP Servers"
      icon={<ServerIcon className="size-3.5" />}
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => setIsAddDialogOpen(true)}
          >
            <PlusIcon className="size-3" />
            Add server
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-7 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isLoading}
                  onClick={loadServers}
                  aria-label="Refresh MCP servers"
                >
                  {isLoading ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh MCP servers</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      <SettingsRow
        title="Config path"
        description="Codex reads MCP servers from this config file."
        status={
          <span className="block break-all font-mono text-[11px] text-foreground">
            {configPath ?? "Resolving Codex config..."}
          </span>
        }
      />
      {error ? (
        <div className="border-t border-border px-4 py-3 text-sm text-destructive sm:px-5">
          {error}
        </div>
      ) : null}
      {servers.length === 0 && !isLoading ? (
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground sm:px-5">
          No MCP servers are configured in Codex yet.
        </div>
      ) : (
        servers.map((server) => (
          <McpServerSummaryRow
            key={server.name}
            server={server}
            disabled={isSaving}
            onToggle={(enabled) => updateServerEnabled(server, enabled)}
            onDelete={() => deleteServer(server)}
          />
        ))
      )}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
            <DialogDescription>
              Add a server to Codex config.toml. New Codex sessions will see it after the provider
              refresh.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <DraftInput
                value={draft.name}
                onCommit={(name) => setDraft((current) => ({ ...current, name }))}
                placeholder="MCP server name"
                spellCheck={false}
                aria-label="MCP server name"
              />
              <Select
                value={draft.transport}
                onValueChange={(transport) =>
                  setDraft((current) => ({
                    ...current,
                    transport: transport as Exclude<CodexMcpServerTransport, "unknown">,
                  }))
                }
              >
                <SelectTrigger aria-label="MCP transport">
                  <SelectValue>
                    {
                      MCP_TRANSPORT_OPTIONS.find((option) => option.value === draft.transport)
                        ?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {MCP_TRANSPORT_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {draft.transport === "stdio" ? (
              <>
                <DraftInput
                  value={draft.command}
                  onCommit={(command) => setDraft((current) => ({ ...current, command }))}
                  placeholder="MCP server command"
                  spellCheck={false}
                  aria-label="MCP server command"
                />
                <Textarea
                  value={draft.args}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, args: event.currentTarget.value }))
                  }
                  placeholder="Arguments, one per line"
                  spellCheck={false}
                  aria-label="MCP server arguments"
                  className="min-h-24"
                />
              </>
            ) : (
              <DraftInput
                value={draft.url}
                onCommit={(url) => setDraft((current) => ({ ...current, url }))}
                placeholder="MCP server URL"
                spellCheck={false}
                aria-label="MCP server URL"
              />
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isSaving || draft.name.trim().length === 0}
              onClick={addServer}
            >
              {isSaving ? "Adding..." : "Add server"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

function CodexPluginRow({
  disabled,
  installing,
  onInstall,
  onToggle,
  plugin,
}: {
  disabled: boolean;
  installing: boolean;
  onInstall: () => void;
  onToggle: (enabled: boolean) => void;
  plugin: CodexPluginSummary;
}) {
  const title = plugin.displayName ?? plugin.name;
  const isInstalled = plugin.installed ?? plugin.cached;
  const meta = [
    plugin.sourceType,
    plugin.version ? `v${plugin.version}` : null,
    plugin.marketplace,
    plugin.category,
    isInstalled ? null : "available",
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          <Badge
            variant={isInstalled ? (plugin.enabled ? "success" : "outline") : "info"}
            size="sm"
          >
            {isInstalled ? (plugin.enabled ? "enabled" : "disabled") : "install"}
          </Badge>
        </span>
      }
      description={plugin.description ?? plugin.id}
      status={
        <span className="block truncate font-mono text-[11px]">
          {plugin.id}
          {meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
        </span>
      }
      control={
        isInstalled ? (
          <Switch
            checked={plugin.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(Boolean(checked))}
            aria-label={`Toggle Codex plugin ${title}`}
          />
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={disabled || installing}
            onClick={onInstall}
          >
            {installing ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <DownloadIcon className="size-3" />
            )}
            Install
          </Button>
        )
      }
    />
  );
}

let cachedCodexPluginsSnapshot: CodexPluginListResult | null = null;
let pendingCodexPluginsSnapshot: Promise<CodexPluginListResult> | null = null;

export function __resetCodexPluginsCacheForTests() {
  cachedCodexPluginsSnapshot = null;
  pendingCodexPluginsSnapshot = null;
}

function rememberCodexPluginsSnapshot(snapshot: CodexPluginListResult): CodexPluginListResult {
  cachedCodexPluginsSnapshot = snapshot;
  return snapshot;
}

function readCodexPluginsSnapshot(options?: {
  readonly force?: boolean;
}): Promise<CodexPluginListResult> {
  const force = options?.force === true;
  if (!force && cachedCodexPluginsSnapshot) {
    return Promise.resolve(cachedCodexPluginsSnapshot);
  }
  if (!force && pendingCodexPluginsSnapshot) {
    return pendingCodexPluginsSnapshot;
  }
  const request = ensureLocalApi()
    .server.codexPlugins.list()
    .then(rememberCodexPluginsSnapshot)
    .finally(() => {
      if (pendingCodexPluginsSnapshot === request) {
        pendingCodexPluginsSnapshot = null;
      }
    });
  pendingCodexPluginsSnapshot = request;
  return request;
}

function CodexPluginsSection() {
  const [plugins, setPlugins] = useState<ReadonlyArray<CodexPluginSummary>>(
    () => cachedCodexPluginsSnapshot?.plugins ?? [],
  );
  const [configPath, setConfigPath] = useState<string | null>(
    () => cachedCodexPluginsSnapshot?.configPath ?? null,
  );
  const [pluginsPath, setPluginsPath] = useState<string | null>(
    () => cachedCodexPluginsSnapshot?.pluginsPath ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pluginQuery, setPluginQuery] = useState("");
  const [installingPluginId, setInstallingPluginId] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

  const applySnapshot = useCallback((snapshot: CodexPluginListResult) => {
    setConfigPath(snapshot.configPath);
    setPluginsPath(snapshot.pluginsPath);
    setPlugins(snapshot.plugins);
  }, []);

  const filteredPlugins = useMemo(() => {
    const query = pluginQuery.trim().toLowerCase();
    if (!query) {
      return plugins;
    }
    return plugins.filter((plugin) =>
      [
        plugin.id,
        plugin.name,
        plugin.displayName,
        plugin.description,
        plugin.marketplace,
        plugin.category,
        plugin.developerName,
        plugin.sourceType,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query)),
    );
  }, [pluginQuery, plugins]);
  const installedPlugins = useMemo(
    () => filteredPlugins.filter((plugin) => plugin.installed ?? plugin.cached),
    [filteredPlugins],
  );
  const availablePlugins = useMemo(
    () => filteredPlugins.filter((plugin) => !(plugin.installed ?? plugin.cached)),
    [filteredPlugins],
  );

  const loadPlugins = useCallback(
    (options?: { readonly force?: boolean }) => {
      if (!options?.force && cachedCodexPluginsSnapshot) {
        applySnapshot(cachedCodexPluginsSnapshot);
        return;
      }
      const requestId = (loadRequestIdRef.current += 1);
      setIsLoading(true);
      setError(null);
      void readCodexPluginsSnapshot(options)
        .then((result) => {
          if (requestId !== loadRequestIdRef.current) return;
          applySnapshot(result);
        })
        .catch((loadError: unknown) => {
          if (requestId !== loadRequestIdRef.current) return;
          setError(
            loadError instanceof Error ? loadError.message : "Failed to load Codex plugins.",
          );
        })
        .finally(() => {
          if (requestId === loadRequestIdRef.current) {
            setIsLoading(false);
          }
        });
    },
    [applySnapshot],
  );

  useEffect(() => {
    loadPlugins();
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [loadPlugins]);

  const updatePluginEnabled = useCallback(
    (plugin: CodexPluginSummary, enabled: boolean) => {
      if (isSaving) return;
      setIsSaving(true);
      setError(null);
      void ensureLocalApi()
        .server.codexPlugins.update({ id: plugin.id, enabled })
        .then((result) => {
          applySnapshot(rememberCodexPluginsSnapshot(result));
        })
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : "Failed to update plugin.");
        })
        .finally(() => setIsSaving(false));
    },
    [applySnapshot, isSaving],
  );

  const installPlugin = useCallback(
    (plugin: CodexPluginSummary) => {
      if (isSaving || installingPluginId) return;
      setInstallingPluginId(plugin.id);
      setError(null);
      void ensureLocalApi()
        .server.codexPlugins.install({
          pluginName: plugin.name,
          ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : {}),
          ...(plugin.remoteMarketplaceName
            ? { remoteMarketplaceName: plugin.remoteMarketplaceName }
            : {}),
        })
        .then((result) => {
          applySnapshot(rememberCodexPluginsSnapshot(result));
          toastManager.add({
            type: "success",
            title: "Plugin installed",
            description: plugin.displayName ?? plugin.name,
          });
        })
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : "Failed to install plugin.");
        })
        .finally(() => setInstallingPluginId(null));
    },
    [applySnapshot, installingPluginId, isSaving],
  );

  return (
    <SettingsSection
      title="Codex Plugins"
      icon={<PlugIcon className="size-3.5" />}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-7 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                disabled={isLoading}
                onClick={() => loadPlugins({ force: true })}
                aria-label="Refresh Codex plugins"
              >
                {isLoading ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
              </Button>
            }
          />
          <TooltipPopup side="top">Refresh Codex plugins</TooltipPopup>
        </Tooltip>
      }
    >
      <SettingsRow
        title="Plugin config"
        description="Installed plugins can be enabled here. Marketplace plugins are listed separately for installation."
        status={
          <span className="block break-all font-mono text-[11px] text-foreground">
            {configPath ?? pluginsPath ?? "Resolving Codex plugin paths..."}
          </span>
        }
      />
      <div className="border-t border-border px-4 py-3 sm:px-5">
        <label className="relative block">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute left-3 top-1/2 size-3.5 text-muted-foreground" />
          <input
            type="search"
            value={pluginQuery}
            onChange={(event) => setPluginQuery(event.currentTarget.value)}
            placeholder="Search by plugin name, category, or marketplace"
            aria-label="Search Codex plugins"
            className={`${SETTINGS_INPUT_CLASS} w-full pl-9`}
          />
        </label>
      </div>
      {error ? (
        <div className="border-t border-border px-4 py-3 text-sm text-destructive sm:px-5">
          {error}
        </div>
      ) : null}
      {plugins.length === 0 && !isLoading ? (
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground sm:px-5">
          No Codex plugins were found.
        </div>
      ) : filteredPlugins.length === 0 && !isLoading ? (
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground sm:px-5">
          No plugins matched the current search.
        </div>
      ) : (
        <>
          {installedPlugins.length > 0 ? (
            <div className="border-t border-border bg-muted/20 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-5">
              Installed plugins
            </div>
          ) : null}
          {installedPlugins.map((plugin) => (
            <CodexPluginRow
              key={plugin.id}
              plugin={plugin}
              disabled={isSaving || installingPluginId !== null}
              installing={installingPluginId === plugin.id}
              onInstall={() => installPlugin(plugin)}
              onToggle={(enabled) => updatePluginEnabled(plugin, enabled)}
            />
          ))}
          {availablePlugins.length > 0 ? (
            <div className="border-t border-border bg-muted/20 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-5">
              Available to install
            </div>
          ) : null}
          {availablePlugins.map((plugin) => (
            <CodexPluginRow
              key={plugin.id}
              plugin={plugin}
              disabled={isSaving || installingPluginId !== null}
              installing={installingPluginId === plugin.id}
              onInstall={() => installPlugin(plugin)}
              onToggle={(enabled) => updatePluginEnabled(plugin, enabled)}
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

function SettingsKeybindingInput({
  command,
  currentLabel,
  disabled,
  onSaved,
}: {
  command: KeybindingCommand;
  currentLabel: string | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveShortcut = useCallback(
    async (key: string) => {
      setError(null);
      const when = DEFAULT_KEYBINDING_WHEN_BY_COMMAND.get(command);
      try {
        await ensureLocalApi().server.upsertKeybinding({
          key,
          command,
          ...(when ? { when } : {}),
        });
        onSaved();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Unable to save shortcut.");
      } finally {
        setIsCapturing(false);
      }
    },
    [command, onSaved],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setIsCapturing(false);
        setError(null);
        return;
      }
      const shortcut = keybindingValueFromShortcutEvent(event);
      if (!shortcut) {
        setError("Press a key with Ctrl, Cmd, Alt, or Shift.");
        return;
      }
      void saveShortcut(shortcut);
    },
    [saveShortcut],
  );

  return (
    <div className="grid min-w-40 gap-1">
      <input
        readOnly
        disabled={disabled}
        value={isCapturing ? "Press shortcut..." : (currentLabel ?? "")}
        placeholder="Set shortcut"
        aria-label={`Set shortcut for ${command}`}
        className={`${SETTINGS_INPUT_CLASS} w-full cursor-pointer text-right`}
        onFocus={() => {
          setIsCapturing(true);
          setError(null);
        }}
        onBlur={() => setIsCapturing(false)}
        onKeyDown={handleKeyDown}
      />
      {error ? <span className="text-right text-[11px] text-destructive">{error}</span> : null}
    </div>
  );
}

function KeybindingsSettingsRows({
  disabled,
  keybindings,
}: {
  disabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
}) {
  return (
    <>
      {EDITABLE_KEYBINDING_COMMANDS.map((entry) => {
        const label = shortcutLabelForCommand(keybindings, entry.command, {
          context: entry.context,
        });
        return (
          <SettingsRow
            key={entry.command}
            title={entry.label}
            description={entry.command}
            control={
              <SettingsKeybindingInput
                command={entry.command}
                currentLabel={label}
                disabled={disabled}
                onSaved={() => undefined}
              />
            }
          />
        );
      })}
    </>
  );
}

function formatAutomationSchedule(automation: CodexAutomationSummary): string {
  const rrule = automation.rrule?.trim() ?? "";
  if (!rrule) {
    return "Manual";
  }
  const presetLabel = labelForAutomationSchedule(rrule);
  return presetLabel === "Custom" ? rrule : presetLabel;
}

type AutomationDraft = {
  readonly originalId?: string;
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly rrule: string;
  readonly executionEnvironment: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly cwds: string;
  readonly enabled: boolean;
};

function slugifyAutomationName(value: string): string {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) {
    return "automation";
  }
  return /^[a-zA-Z]/.test(slug) ? slug : `automation-${slug}`;
}

function makeAutomationDraft(automation: CodexAutomationSummary): AutomationDraft {
  return {
    originalId: automation.id,
    id: automation.id,
    name: automation.name,
    prompt: automation.prompt ?? "",
    rrule: automation.rrule ?? "",
    executionEnvironment: automation.executionEnvironment ?? "",
    model: automation.model ?? "",
    reasoningEffort: automation.reasoningEffort ?? "",
    cwds: automation.cwds.join("\n"),
    enabled: automation.enabled,
  };
}

function makeNewAutomationDraft(): AutomationDraft {
  return {
    id: "",
    name: "",
    prompt: "",
    rrule: "",
    executionEnvironment: "",
    model: "",
    reasoningEffort: "",
    cwds: "",
    enabled: true,
  };
}

function splitAutomationCwds(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const AUTOMATION_SCHEDULE_PRESETS = [
  { value: "manual", label: "Manual", rrule: "" },
  { value: "daily", label: "Daily", rrule: "FREQ=DAILY" },
  { value: "weekdays", label: "Weekdays", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { value: "weekly", label: "Weekly", rrule: "FREQ=WEEKLY" },
  { value: "monthly", label: "Monthly", rrule: "FREQ=MONTHLY" },
] as const;

const AUTOMATION_REASONING_EFFORT_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
] as const;

const AUTOMATION_ENVIRONMENT_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "local", label: "Local" },
] as const;

function automationSchedulePresetForRrule(rrule: string): string {
  const normalized = rrule.trim();
  if (!normalized) {
    return "manual";
  }
  return (
    AUTOMATION_SCHEDULE_PRESETS.find((preset) => preset.rrule === normalized)?.value ?? "custom"
  );
}

function labelForAutomationSchedule(rrule: string): string {
  const preset = AUTOMATION_SCHEDULE_PRESETS.find(
    (candidate) => candidate.value === automationSchedulePresetForRrule(rrule),
  );
  return preset?.label ?? "Custom";
}

function automationEnvironmentSelectValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "default";
  }
  return AUTOMATION_ENVIRONMENT_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : "custom";
}

function automationReasoningEffortSelectValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "default";
  }
  return AUTOMATION_REASONING_EFFORT_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : "custom";
}

function CodexAutomationRow({
  automation,
  disabled,
  onDelete,
  onEdit,
  onToggle,
}: {
  automation: CodexAutomationSummary;
  disabled: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const meta = [
    automation.model,
    automation.reasoningEffort,
    automation.executionEnvironment,
    automation.cwds.length > 0 ? `${automation.cwds.length} cwd` : null,
  ].filter(Boolean);
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{automation.name}</span>
        </span>
      }
      description={automation.prompt?.trim() || formatAutomationSchedule(automation)}
      status={
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant={automation.enabled ? "success" : "warning"} size="sm">
            {automation.enabled ? "Enabled" : "Paused"}
          </Badge>
          <Badge variant="outline" size="sm">
            {formatAutomationSchedule(automation)}
          </Badge>
          {meta.map((entry) => (
            <Badge key={String(entry)} variant="secondary" size="sm">
              {entry}
            </Badge>
          ))}
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
            {automation.id}
          </span>
        </span>
      }
      control={
        <div className="flex items-center gap-1.5">
          <Switch
            checked={automation.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(Boolean(checked))}
            aria-label={`Toggle Codex automation ${automation.name}`}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-8 text-muted-foreground"
            disabled={disabled}
            onClick={onEdit}
            aria-label={`Edit Codex automation ${automation.name}`}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="size-8 text-muted-foreground hover:text-destructive"
            disabled={disabled}
            onClick={onDelete}
            aria-label={`Delete Codex automation ${automation.name}`}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}

function CodexAutomationsSection() {
  const [automations, setAutomations] = useState<ReadonlyArray<CodexAutomationSummary>>([]);
  const [automationsPath, setAutomationsPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [automationDraft, setAutomationDraft] = useState<AutomationDraft | null>(null);
  const [isAutomationEditorOpen, setIsAutomationEditorOpen] = useState(false);

  const loadAutomations = useCallback(() => {
    setIsLoading(true);
    setError(null);
    void ensureLocalApi()
      .server.codexAutomations.list()
      .then((result) => {
        setAutomationsPath(result.automationsPath);
        setAutomations(result.automations);
      })
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load Codex automations.",
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    loadAutomations();
  }, [loadAutomations]);

  const updateAutomationEnabled = useCallback(
    (automation: CodexAutomationSummary, enabled: boolean) => {
      if (isSaving) return;
      setIsSaving(true);
      setError(null);
      void ensureLocalApi()
        .server.codexAutomations.update({ id: automation.id, enabled })
        .then((result) => {
          setAutomationsPath(result.automationsPath);
          setAutomations(result.automations);
          toastManager.add({
            type: "success",
            title: enabled ? "Automation resumed" : "Automation paused",
            description: automation.name,
          });
        })
        .catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : "Failed to update automation.");
        })
        .finally(() => setIsSaving(false));
    },
    [isSaving],
  );

  const openNewAutomation = useCallback(() => {
    setAutomationDraft(makeNewAutomationDraft());
    setIsAutomationEditorOpen(true);
  }, []);

  const openEditAutomation = useCallback((automation: CodexAutomationSummary) => {
    setAutomationDraft(makeAutomationDraft(automation));
    setIsAutomationEditorOpen(true);
  }, []);

  const saveAutomationDraft = useCallback(() => {
    if (!automationDraft || isSaving) return;
    const id = automationDraft.id.trim();
    const name = automationDraft.name.trim();
    const prompt = automationDraft.prompt.trim();
    if (!id || !name || !prompt) return;
    setIsSaving(true);
    setError(null);
    void ensureLocalApi()
      .server.codexAutomations.save({
        ...(automationDraft.originalId ? { originalId: automationDraft.originalId } : {}),
        id,
        name,
        prompt,
        enabled: automationDraft.enabled,
        ...(automationDraft.rrule.trim() ? { rrule: automationDraft.rrule.trim() } : {}),
        ...(automationDraft.executionEnvironment.trim()
          ? { executionEnvironment: automationDraft.executionEnvironment.trim() }
          : {}),
        ...(automationDraft.model.trim() ? { model: automationDraft.model.trim() } : {}),
        ...(automationDraft.reasoningEffort.trim()
          ? { reasoningEffort: automationDraft.reasoningEffort.trim() }
          : {}),
        cwds: splitAutomationCwds(automationDraft.cwds),
      })
      .then((result) => {
        setAutomationsPath(result.automationsPath);
        setAutomations(result.automations);
        setIsAutomationEditorOpen(false);
        toastManager.add({
          type: "success",
          title: automationDraft.originalId ? "Automation updated" : "Automation created",
          description: name,
        });
      })
      .catch((saveError: unknown) => {
        setError(saveError instanceof Error ? saveError.message : "Failed to save automation.");
      })
      .finally(() => setIsSaving(false));
  }, [automationDraft, isSaving]);

  const deleteAutomation = useCallback(
    (automation: CodexAutomationSummary) => {
      if (isSaving) return;
      void (async () => {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          `Delete automation ${automation.name}\nThis removes ${automation.id} from the Codex automations directory.`,
        );
        if (!confirmed) return;
        setIsSaving(true);
        setError(null);
        try {
          const result = await ensureLocalApi().server.codexAutomations.delete({
            id: automation.id,
          });
          setAutomationsPath(result.automationsPath);
          setAutomations(result.automations);
          toastManager.add({
            type: "success",
            title: "Automation deleted",
            description: automation.name,
          });
        } catch (deleteError: unknown) {
          setError(
            deleteError instanceof Error ? deleteError.message : "Failed to delete automation.",
          );
        } finally {
          setIsSaving(false);
        }
      })();
    },
    [isSaving],
  );

  return (
    <SettingsSection
      title="Codex Automations"
      icon={<CalendarClockIcon className="size-3.5" />}
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={openNewAutomation}
            disabled={isSaving}
          >
            <PlusIcon className="size-3" />
            New
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-7 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={isLoading}
                  onClick={loadAutomations}
                  aria-label="Refresh Codex automations"
                >
                  {isLoading ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh Codex automations</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      <SettingsRow
        title="Automation directory"
        description="Local Codex automation schedules and run definitions."
        status={
          <span className="block break-all font-mono text-[11px] text-foreground">
            {automationsPath ?? "Resolving Codex automations directory..."}
          </span>
        }
      />
      {error ? (
        <div className="border-t border-border px-4 py-3 text-sm text-destructive sm:px-5">
          {error}
        </div>
      ) : null}
      {automations.length === 0 && !isLoading ? (
        <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground sm:px-5">
          No Codex automations were found.
        </div>
      ) : (
        automations.map((automation) => (
          <CodexAutomationRow
            key={automation.id}
            automation={automation}
            disabled={isSaving}
            onDelete={() => deleteAutomation(automation)}
            onEdit={() => openEditAutomation(automation)}
            onToggle={(enabled) => updateAutomationEnabled(automation, enabled)}
          />
        ))
      )}
      <Dialog
        open={isAutomationEditorOpen}
        onOpenChange={setIsAutomationEditorOpen}
        onOpenChangeComplete={(open) => {
          if (!open) {
            setAutomationDraft(null);
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {automationDraft?.originalId ? "Edit Automation" : "Create Automation"}
            </DialogTitle>
            <DialogDescription>
              Schedule recurring Codex work with prompt, model, environment, and workspace presets.
            </DialogDescription>
          </DialogHeader>
          {automationDraft ? (
            <DialogPanel className="grid gap-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={automationDraft.name}
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    setAutomationDraft((current) =>
                      current
                        ? {
                            ...current,
                            name,
                            id: current.id.trim() ? current.id : slugifyAutomationName(name),
                          }
                        : current,
                    );
                  }}
                  placeholder="Automation title"
                  spellCheck={false}
                  aria-label="Automation name"
                  className={SETTINGS_INPUT_CLASS}
                />
                <input
                  value={automationDraft.id}
                  onChange={(event) =>
                    setAutomationDraft((current) =>
                      current ? { ...current, id: event.currentTarget.value.trim() } : current,
                    )
                  }
                  placeholder="Automation id"
                  spellCheck={false}
                  aria-label="Automation id"
                  className={SETTINGS_INPUT_CLASS}
                />
              </div>
              <Textarea
                value={automationDraft.prompt}
                onChange={(event) =>
                  setAutomationDraft((current) =>
                    current ? { ...current, prompt: event.currentTarget.value } : current,
                  )
                }
                placeholder="Add prompt e.g. look for crashes in $sentry"
                spellCheck={false}
                aria-label="Automation prompt"
                className={`min-h-32 ${SETTINGS_TEXTAREA_CLASS}`}
              />
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="grid gap-2 sm:grid-cols-3">
                  <Select
                    value={automationSchedulePresetForRrule(automationDraft.rrule)}
                    onValueChange={(rawValue) =>
                      setAutomationDraft((current) => {
                        if (!current) return current;
                        const value = rawValue ?? "manual";
                        if (value === "custom") {
                          return {
                            ...current,
                            rrule: current.rrule.trim() || "FREQ=DAILY",
                          };
                        }
                        const preset = AUTOMATION_SCHEDULE_PRESETS.find(
                          (candidate) => candidate.value === value,
                        );
                        return preset ? { ...current, rrule: preset.rrule } : current;
                      })
                    }
                  >
                    <SelectTrigger aria-label="Automation schedule">
                      <SelectValue>{labelForAutomationSchedule(automationDraft.rrule)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {AUTOMATION_SCHEDULE_PRESETS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                      <SelectItem hideIndicator value="custom">
                        Custom RRULE
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                  <Select
                    value={automationEnvironmentSelectValue(automationDraft.executionEnvironment)}
                    onValueChange={(rawValue) =>
                      setAutomationDraft((current) => {
                        if (!current) return current;
                        const value = rawValue ?? "default";
                        if (value === "custom") {
                          return {
                            ...current,
                            executionEnvironment: current.executionEnvironment.trim() || "local",
                          };
                        }
                        return {
                          ...current,
                          executionEnvironment: value === "default" ? "" : value,
                        };
                      })
                    }
                  >
                    <SelectTrigger aria-label="Automation execution environment">
                      <SelectValue>
                        {automationEnvironmentSelectValue(automationDraft.executionEnvironment) ===
                        "custom"
                          ? "Custom"
                          : (AUTOMATION_ENVIRONMENT_OPTIONS.find(
                              (option) =>
                                option.value ===
                                automationEnvironmentSelectValue(
                                  automationDraft.executionEnvironment,
                                ),
                            )?.label ?? "Default")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {AUTOMATION_ENVIRONMENT_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                      <SelectItem hideIndicator value="custom">
                        Custom
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                  <Select
                    value={automationReasoningEffortSelectValue(automationDraft.reasoningEffort)}
                    onValueChange={(rawValue) =>
                      setAutomationDraft((current) => {
                        if (!current) return current;
                        const value = rawValue ?? "default";
                        if (value === "custom") {
                          return {
                            ...current,
                            reasoningEffort: current.reasoningEffort.trim() || "medium",
                          };
                        }
                        return {
                          ...current,
                          reasoningEffort: value === "default" ? "" : value,
                        };
                      })
                    }
                  >
                    <SelectTrigger aria-label="Automation reasoning effort">
                      <SelectValue>
                        {automationReasoningEffortSelectValue(automationDraft.reasoningEffort) ===
                        "custom"
                          ? "Custom"
                          : (AUTOMATION_REASONING_EFFORT_OPTIONS.find(
                              (option) =>
                                option.value ===
                                automationReasoningEffortSelectValue(
                                  automationDraft.reasoningEffort,
                                ),
                            )?.label ?? "Default")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {AUTOMATION_REASONING_EFFORT_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                      <SelectItem hideIndicator value="custom">
                        Custom
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                <label className="inline-flex h-9 items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={automationDraft.enabled}
                    onCheckedChange={(checked) =>
                      setAutomationDraft((current) =>
                        current ? { ...current, enabled: Boolean(checked) } : current,
                      )
                    }
                    aria-label="Toggle automation"
                  />
                  Enabled
                </label>
              </div>
              {automationSchedulePresetForRrule(automationDraft.rrule) === "custom" ||
              automationEnvironmentSelectValue(automationDraft.executionEnvironment) === "custom" ||
              automationReasoningEffortSelectValue(automationDraft.reasoningEffort) === "custom" ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  {automationSchedulePresetForRrule(automationDraft.rrule) === "custom" ? (
                    <input
                      value={automationDraft.rrule}
                      onChange={(event) =>
                        setAutomationDraft((current) =>
                          current ? { ...current, rrule: event.currentTarget.value } : current,
                        )
                      }
                      placeholder="Custom RRULE"
                      spellCheck={false}
                      aria-label="Automation recurrence rule"
                      className={SETTINGS_INPUT_CLASS}
                    />
                  ) : null}
                  {automationEnvironmentSelectValue(automationDraft.executionEnvironment) ===
                  "custom" ? (
                    <input
                      value={automationDraft.executionEnvironment}
                      onChange={(event) =>
                        setAutomationDraft((current) =>
                          current
                            ? { ...current, executionEnvironment: event.currentTarget.value }
                            : current,
                        )
                      }
                      placeholder="Execution environment"
                      spellCheck={false}
                      aria-label="Automation execution environment"
                      className={SETTINGS_INPUT_CLASS}
                    />
                  ) : null}
                  {automationReasoningEffortSelectValue(automationDraft.reasoningEffort) ===
                  "custom" ? (
                    <input
                      value={automationDraft.reasoningEffort}
                      onChange={(event) =>
                        setAutomationDraft((current) =>
                          current
                            ? { ...current, reasoningEffort: event.currentTarget.value }
                            : current,
                        )
                      }
                      placeholder="Reasoning effort"
                      spellCheck={false}
                      aria-label="Automation reasoning effort"
                      className={SETTINGS_INPUT_CLASS}
                    />
                  ) : null}
                </div>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={automationDraft.model}
                  onChange={(event) =>
                    setAutomationDraft((current) =>
                      current ? { ...current, model: event.currentTarget.value } : current,
                    )
                  }
                  placeholder="Model name"
                  spellCheck={false}
                  aria-label="Automation model"
                  className={SETTINGS_INPUT_CLASS}
                />
                <Textarea
                  value={automationDraft.cwds}
                  onChange={(event) =>
                    setAutomationDraft((current) =>
                      current ? { ...current, cwds: event.currentTarget.value } : current,
                    )
                  }
                  placeholder="Working directories, one per line"
                  spellCheck={false}
                  aria-label="Automation working directories"
                  className={`min-h-20 ${SETTINGS_TEXTAREA_CLASS}`}
                />
              </div>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsAutomationEditorOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={saveAutomationDraft}
              disabled={
                isSaving ||
                !automationDraft?.id.trim() ||
                !automationDraft.name.trim() ||
                !automationDraft.prompt.trim()
              }
            >
              {isSaving ? "Saving..." : "Save automation"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  // A provider surface is "dirty" if either the legacy per-kind
  // `settings.providers[kind]` struct differs from defaults (for users
  // on pre-migration data) or the new `settings.providerInstances` map
  // has any entries (every edit to a default slot promotes it into an
  // explicit entry, so any key in that map represents user intent to
  // diverge from factory defaults). Checking both keeps the Restore
  // Defaults chip accurate throughout the legacy→instance migration.
  const areProviderSettingsDirty =
    PROVIDER_SETTINGS.some((providerSettings) => {
      type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
      const currentProviders = settings.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const defaultProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
        string,
        LegacyProviderSettings | undefined
      >;
      const currentSettings = currentProviders[providerSettings.provider];
      const defaultSettings = defaultProviders[providerSettings.provider];
      return !Equal.equals(currentSettings, defaultSettings);
    }) ||
    Object.keys(settings.providerInstances ?? {}).length > 0 ||
    Object.keys(settings.providerModelPreferences ?? {}).length > 0 ||
    (settings.favorites ?? []).length > 0;

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Diff whitespace changes"]
        : []),
      ...(settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar
        ? ["Auto-open task panel"]
        : []),
      ...(settings.autoCleanupInactiveThreads !==
      DEFAULT_UNIFIED_SETTINGS.autoCleanupInactiveThreads
        ? ["Auto-clean inactive threads"]
        : []),
      ...(settings.autoCleanupEmptyProjects !== DEFAULT_UNIFIED_SETTINGS.autoCleanupEmptyProjects
        ? ["Auto-clean inactive projects"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      isGitWritingModelDirty,
      settings.autoOpenPlanSidebar,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.addProjectBaseDirectory,
      settings.autoCleanupEmptyProjects,
      settings.autoCleanupInactiveThreads,
      settings.defaultThreadEnvMode,
      settings.diffIgnoreWhitespace,
      settings.diffWordWrap,
      settings.enableAssistantStreaming,
      settings.timestampFormat,
      theme,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

export type GeneralSettingsPanelSection =
  | "all"
  | "general"
  | "providers"
  | "agents"
  | "mcp"
  | "plugins"
  | "automations"
  | "advanced"
  | "about";

export function GeneralSettingsPanel({
  section = "all",
}: {
  section?: GeneralSettingsPanelSection;
} = {}) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    keybindings: false,
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"keybindings" | "logsDirectory", string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [isCleaningInactiveThreads, setIsCleaningInactiveThreads] = useState(false);
  const [isCleaningEmptyProjects, setIsCleaningEmptyProjects] = useState(false);
  // Collapsible state per provider-instance card, keyed by the instance id.
  // `Record<string, boolean>` so we don't need to preseed an entry for every
  // configured instance — an absent key reads as collapsed. Default-slot
  // rows share this state: their id is the driver slug
  // (`defaultInstanceIdForDriver(driver)`), which is also `ProviderDriverKind` at
  // runtime, so a pre-existing open key for e.g. "codex" persists across
  // the legacy/unified render swap.
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const inactiveThreadCandidates = useMemo(
    () => getInactiveThreadCleanupCandidates(threads),
    [threads],
  );
  const oldestInactiveThreadCandidate = inactiveThreadCandidates[0] ?? null;
  const emptyProjectCandidates = useMemo(
    () => getEmptyProjectCleanupCandidates(projects, threads),
    [projects, threads],
  );
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureLocalApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const cleanInactiveThreads = useCallback(
    async (options?: { readonly confirm?: boolean }) => {
      if (inactiveThreadCandidates.length === 0 || isCleaningInactiveThreads) return;
      const threadCount = inactiveThreadCandidates.length;
      if (options?.confirm !== false) {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          [
            `Delete ${threadCount} thread${threadCount === 1 ? "" : "s"} not used for ${INACTIVE_THREAD_CLEANUP_DAYS}+ days?`,
            "This removes inactive threads from T3 Code. Project folders and worktrees on disk are not deleted.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      setIsCleaningInactiveThreads(true);
      try {
        const draftStore = useComposerDraftStore.getState();
        for (const { thread } of inactiveThreadCandidates) {
          const api = readEnvironmentApi(thread.environmentId);
          if (!api) continue;
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);

          await api.orchestration.dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: thread.id,
          });

          draftStore.clearDraftThread(threadRef);
          draftStore.clearProjectDraftThreadById(
            scopeProjectRef(thread.environmentId, thread.projectId),
            threadRef,
          );
        }

        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Inactive threads cleaned",
            description: `Deleted ${threadCount} thread${threadCount === 1 ? "" : "s"}.`,
          }),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not clean inactive threads",
            description:
              error instanceof Error ? error.message : "An unknown error occurred while deleting.",
          }),
        );
      } finally {
        setIsCleaningInactiveThreads(false);
      }
    },
    [inactiveThreadCandidates, isCleaningInactiveThreads],
  );

  const cleanEmptyProjects = useCallback(
    async (options?: { readonly confirm?: boolean }) => {
      if (emptyProjectCandidates.length === 0 || isCleaningEmptyProjects) return;
      const projectCount = emptyProjectCandidates.length;
      if (options?.confirm !== false) {
        const confirmed = await ensureLocalApi().dialogs.confirm(
          [
            `Remove ${projectCount} project${projectCount === 1 ? "" : "s"} with no threads?`,
            "This only cleans T3 Code's project list. It does not delete folders from disk.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      setIsCleaningEmptyProjects(true);
      try {
        const draftStore = useComposerDraftStore.getState();
        for (const { project } of emptyProjectCandidates) {
          const api = readEnvironmentApi(project.environmentId);
          if (!api) continue;
          const projectRef = scopeProjectRef(project.environmentId, project.id);
          const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
          if (projectDraftThread) {
            draftStore.clearDraftThread(projectDraftThread.draftId);
          }
          draftStore.clearProjectDraftThreadId(projectRef);

          await api.orchestration.dispatchCommand({
            type: "project.delete",
            commandId: newCommandId(),
            projectId: project.id,
          });
        }

        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Inactive projects cleaned",
            description: `Removed ${projectCount} project${projectCount === 1 ? "" : "s"}.`,
          }),
        );
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not clean inactive projects",
            description:
              error instanceof Error ? error.message : "An unknown error occurred while deleting.",
          }),
        );
      } finally {
        setIsCleaningEmptyProjects(false);
      }
    },
    [emptyProjectCandidates, isCleaningEmptyProjects],
  );

  const autoCleanInactiveThreadsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settings.autoCleanupInactiveThreads || inactiveThreadCandidates.length === 0) {
      return;
    }
    const key = inactiveThreadCandidates.map((candidate) => candidate.thread.id).join("\n");
    if (autoCleanInactiveThreadsKeyRef.current === key) {
      return;
    }
    autoCleanInactiveThreadsKeyRef.current = key;
    void cleanInactiveThreads({ confirm: false });
  }, [cleanInactiveThreads, inactiveThreadCandidates, settings.autoCleanupInactiveThreads]);

  const autoCleanEmptyProjectsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!settings.autoCleanupEmptyProjects || emptyProjectCandidates.length === 0) {
      return;
    }
    const key = emptyProjectCandidates.map((candidate) => candidate.project.id).join("\n");
    if (autoCleanEmptyProjectsKeyRef.current === key) {
      return;
    }
    autoCleanEmptyProjectsKeyRef.current = key;
    void cleanEmptyProjects({ confirm: false });
  }, [cleanEmptyProjects, emptyProjectCandidates, settings.autoCleanupEmptyProjects]);

  const keybindingsConfigPath = useServerKeybindingsConfigPath();
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const serverProviders = useServerProviders();
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const openInPreferredEditor = useCallback(
    (target: "keybindings" | "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        return;
      }

      void ensureLocalApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({ ...existing, [target]: false }));
        });
    },
    [availableEditors],
  );

  const openKeybindingsFile = useCallback(() => {
    openInPreferredEditor("keybindings", keybindingsConfigPath, "Unable to open keybindings file.");
  }, [keybindingsConfigPath, openInPreferredEditor]);

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  const openKeybindingsError = openPathErrorByTarget.keybindings ?? null;
  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningKeybindings = openingPathByTarget.keybindings;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  /**
   * Build the list of rows to render, one per configured instance. Each
   * row carries enough context to drive `ProviderInstanceCard` without
   * threading storage concerns: whether it's a built-in default slot (in
   * which case `isDefault` is true, deletion is gated off, and the
   * effective envelope may have been synthesized from legacy just for
   * this render), the driver kind narrow for the in-card model-slug
   * normalization, and whether a reset-to-factory action is warranted.
   *
   * Ordering mirrors the prior split: visible built-in default slots
   * first (one per visible kind), then user-authored custom instances
   * grouped by driver after their default sibling, then orphan instances
   * whose driver isn't in the visible-defaults set.
   */
  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    /** True for the slot whose id is `defaultInstanceIdForDriver(driver)`. */
    readonly isDefault: boolean;
    /**
     * True when this default slot differs from the factory defaults —
     * either through an explicit `providerInstances[defaultId]` entry,
     * or through a non-default legacy `settings.providers[kind]` struct
     * that we're still bridging. Used to show the reset-to-factory
     * affordance. Undefined for custom rows (they have a delete button
     * instead; "factory defaults" isn't meaningful).
     */
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    // Prefer an explicit `providerInstances[defaultId]` entry when one
    // exists (every edit via this UI promotes the default slot into
    // that map); fall back to synthesizing one from the legacy
    // `settings.providers[kind]` struct so first-time viewers still see
    // their persisted config.
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    // Non-default customs for this driver kind follow their default.
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  // Orphan instances: drivers the visible-defaults list doesn't cover
  // (e.g. Cursor when the server hasn't reported it but the user has
  // authored a Cursor instance anyway, or fork drivers not shipped by
  // this build). Preserve insertion order within each driver.
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      const isDefaultSlot = defaultSlotIdsBySource.has(String(id));
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: isDefaultSlot,
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  /**
   * Reset a built-in default slot back to factory defaults. Clears both
   * the legacy `settings.providers[kind]` struct and any explicit
   * `providerInstances[defaultId]` entry that has promoted legacy into
   * the new map, so hydration re-synthesizes a clean envelope on next
   * load. Safe to call on drivers that have never been edited.
   */
  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };
  const showGeneralSettings = section === "all" || section === "general";
  const showProviderSettings = section === "all" || section === "providers" || section === "agents";
  const showCodexMcpConfig = section === "mcp";
  const showCodexPlugins = section === "plugins";
  const showCodexAutomations = section === "automations";
  const showAdvancedSettings = section === "all" || section === "advanced";
  const showAboutSettings = section === "all" || section === "about";
  const providerSectionTitle = section === "agents" ? "Codex Agents" : "Providers";
  const providerDetailMode = section === "agents" ? "agents" : "all";
  const providerRows =
    section === "agents" ? rows.filter((row) => row.driver === DEFAULT_DRIVER_KIND) : rows;

  return (
    <SettingsPageContainer>
      {showGeneralSettings ? (
        <SettingsSection title="General" icon={<Settings2Icon className="size-3.5" />}>
          <SettingsRow
            title="Theme"
            description="Choose how T3 Code looks across the app."
            resetAction={
              theme !== "system" ? (
                <SettingResetButton label="theme" onClick={() => setTheme("system")} />
              ) : null
            }
            control={
              <Select
                value={theme}
                onValueChange={(value) => {
                  if (
                    value === "system" ||
                    value === "light" ||
                    value === "dark" ||
                    value === "blurple-twilight"
                  ) {
                    setTheme(value);
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                  <SelectValue>
                    {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {THEME_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Time format"
            description="System default follows your browser or OS clock preference."
            resetAction={
              settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
                <SettingResetButton
                  label="time format"
                  onClick={() =>
                    updateSettings({
                      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.timestampFormat}
                onValueChange={(value) => {
                  if (value === "locale" || value === "12-hour" || value === "24-hour") {
                    updateSettings({ timestampFormat: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                  <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="locale">
                    {TIMESTAMP_FORMAT_LABELS.locale}
                  </SelectItem>
                  <SelectItem hideIndicator value="12-hour">
                    {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="24-hour">
                    {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Diff line wrapping"
            description="Set the default wrap state when the diff panel opens."
            resetAction={
              settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
                <SettingResetButton
                  label="diff line wrapping"
                  onClick={() =>
                    updateSettings({
                      diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.diffWordWrap}
                onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
                aria-label="Wrap diff lines by default"
              />
            }
          />

          <SettingsRow
            title="Hide whitespace changes"
            description="Set whether the diff panel ignores whitespace-only edits by default."
            resetAction={
              settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
                <SettingResetButton
                  label="diff whitespace changes"
                  onClick={() =>
                    updateSettings({
                      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.diffIgnoreWhitespace}
                onCheckedChange={(checked) =>
                  updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
                }
                aria-label="Hide whitespace changes by default"
              />
            }
          />

          <SettingsRow
            title="Assistant output"
            description="Show token-by-token output while a response is in progress."
            resetAction={
              settings.enableAssistantStreaming !==
              DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
                <SettingResetButton
                  label="assistant output"
                  onClick={() =>
                    updateSettings({
                      enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableAssistantStreaming}
                onCheckedChange={(checked) =>
                  updateSettings({ enableAssistantStreaming: Boolean(checked) })
                }
                aria-label="Stream assistant messages"
              />
            }
          />

          <SettingsRow
            title="Auto-open task panel"
            description="Open the right-side plan and task panel automatically when steps appear."
            resetAction={
              settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
                <SettingResetButton
                  label="auto-open task panel"
                  onClick={() =>
                    updateSettings({
                      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.autoOpenPlanSidebar}
                onCheckedChange={(checked) =>
                  updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
                }
                aria-label="Open the task panel automatically"
              />
            }
          />

          <SettingsRow
            title="New threads"
            description="Pick the default workspace mode for newly created draft threads."
            resetAction={
              settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
                <SettingResetButton
                  label="new threads"
                  onClick={() =>
                    updateSettings({
                      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.defaultThreadEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree") {
                    updateSettings({ defaultThreadEnvMode: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                  <SelectValue>
                    {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="local">
                    Local
                  </SelectItem>
                  <SelectItem hideIndicator value="worktree">
                    New worktree
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Add project starts in"
            description='Leave empty to use "~/" when the Add Project browser opens.'
            resetAction={
              settings.addProjectBaseDirectory !==
              DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
                <SettingResetButton
                  label="add project base directory"
                  onClick={() =>
                    updateSettings({
                      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                className="w-full sm:w-72"
                value={settings.addProjectBaseDirectory}
                onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
                placeholder="~/"
                spellCheck={false}
                aria-label="Add project base directory"
              />
            }
          />

          <SettingsRow
            title="Archive confirmation"
            description="Require a second click on the inline archive action before a thread is archived."
            resetAction={
              settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
                <SettingResetButton
                  label="archive confirmation"
                  onClick={() =>
                    updateSettings({
                      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadArchive}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadArchive: Boolean(checked) })
                }
                aria-label="Confirm thread archiving"
              />
            }
          />

          <SettingsRow
            title="Delete confirmation"
            description="Ask before deleting a thread and its chat history."
            resetAction={
              settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
                <SettingResetButton
                  label="delete confirmation"
                  onClick={() =>
                    updateSettings({
                      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.confirmThreadDelete}
                onCheckedChange={(checked) =>
                  updateSettings({ confirmThreadDelete: Boolean(checked) })
                }
                aria-label="Confirm thread deletion"
              />
            }
          />

          <SettingsRow
            title="Text generation model"
            description="Configure the model used for generated commit messages, PR titles, and similar Git text."
            resetAction={
              isGitWritingModelDirty ? (
                <SettingResetButton
                  label="text generation model"
                  onClick={() =>
                    updateSettings({
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ComposerModelDropdown
                  activeInstanceId={textGenInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  instanceEntries={gitModelInstanceEntries}
                  modelOptionsByInstance={gitModelOptionsByInstance}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onInstanceModelChange={(instanceId, model) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(instanceId, model),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
                <TraitsPicker
                  instanceId={textGenInstanceId}
                  provider={textGenProvider}
                  models={
                    // Use the exact instance's models (rather than the
                    // first-kind-match) so a custom text-gen instance like
                    // `codex_personal` gets its own model list, not the
                    // default Codex one.
                    textGenInstanceEntry?.models ?? []
                  }
                  model={textGenModel}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={textGenModelOptions}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(
                            textGenInstanceId,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {showCodexMcpConfig ? <CodexMcpConfigSection /> : null}
      {showCodexPlugins ? <CodexPluginsSection /> : null}
      {showCodexAutomations ? <CodexAutomationsSection /> : null}

      {showProviderSettings ? (
        <>
          <SettingsSection
            title={providerSectionTitle}
            icon={<BotIcon className="size-3.5" />}
            headerAction={
              <div className="flex items-center gap-1.5">
                <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
                {section === "all" || section === "providers" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => setIsAddInstanceDialogOpen(true)}
                          aria-label="Add provider instance"
                        >
                          <PlusIcon className="size-3" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Add provider instance</TooltipPopup>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={isRefreshingProviders}
                        onClick={() => void refreshProviders()}
                        aria-label="Refresh provider status"
                      >
                        {isRefreshingProviders ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Refresh provider status</TooltipPopup>
                </Tooltip>
              </div>
            }
          >
            {providerRows.map((row) => {
              const driverOption = getDriverOption(row.driver);
              const liveProvider = serverProviders.find(
                (candidate) => candidate.instanceId === row.instanceId,
              );
              const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
                hiddenModels: [],
                modelOrder: [],
              };
              const favoriteModels = (settings.favorites ?? [])
                .filter((favorite) => favorite.provider === row.instanceId)
                .map((favorite) => favorite.model);
              const resetLabel = driverOption?.label ?? String(row.driver);
              const headerAction =
                row.isDefault && row.isDirty ? (
                  <SettingResetButton
                    label={`${resetLabel} provider settings`}
                    onClick={() => resetDefaultInstance(row.driver)}
                  />
                ) : null;
              return (
                <ProviderInstanceCard
                  key={row.instanceId}
                  instanceId={row.instanceId}
                  instance={row.instance}
                  driverOption={driverOption}
                  liveProvider={liveProvider}
                  isExpanded={openInstanceDetails[row.instanceId] ?? false}
                  onExpandedChange={(open) =>
                    setOpenInstanceDetails((existing) => {
                      return {
                        ...existing,
                        [row.instanceId]: open,
                      };
                    })
                  }
                  onUpdate={(next) => {
                    // When the user disables the exact instance the text-gen
                    // selection points at, fall back to the global default so we
                    // don't leave the selection dangling on a disabled instance.
                    // Prior kind-level behavior cleared on any kind-matching
                    // disable; instance-level addressing makes this narrower and
                    // more accurate (other instances of the same kind stay
                    // untouched).
                    const wasEnabled = row.instance.enabled ?? true;
                    const isDisabling = next.enabled === false && wasEnabled;
                    const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                    if (shouldClearTextGen) {
                      updateProviderInstance(row, next, {
                        textGenerationModelSelection:
                          DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                      });
                    } else {
                      updateProviderInstance(row, next);
                    }
                  }}
                  onDelete={
                    row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)
                  }
                  headerAction={headerAction}
                  hiddenModels={modelPreferences.hiddenModels}
                  favoriteModels={favoriteModels}
                  modelOrder={modelPreferences.modelOrder}
                  onHiddenModelsChange={(hiddenModels) =>
                    updateProviderModelPreferences(row.instanceId, {
                      ...modelPreferences,
                      hiddenModels,
                    })
                  }
                  onFavoriteModelsChange={(favoriteModels) =>
                    updateProviderFavoriteModels(row.instanceId, favoriteModels)
                  }
                  onModelOrderChange={(modelOrder) =>
                    updateProviderModelPreferences(row.instanceId, {
                      ...modelPreferences,
                      modelOrder,
                    })
                  }
                  detailMode={providerDetailMode}
                />
              );
            })}
          </SettingsSection>

          <AddProviderInstanceDialog
            open={isAddInstanceDialogOpen}
            onOpenChange={setIsAddInstanceDialogOpen}
          />
        </>
      ) : null}

      {showAdvancedSettings ? (
        <SettingsSection title="Advanced" icon={<SlidersHorizontalIcon className="size-3.5" />}>
          <SettingsRow
            title="Clean inactive threads"
            description={`Delete threads not used for ${INACTIVE_THREAD_CLEANUP_DAYS}+ days from T3 Code.`}
            status={
              inactiveThreadCandidates.length > 0 ? (
                <>
                  <span>
                    {inactiveThreadCandidates.length} eligible thread
                    {inactiveThreadCandidates.length === 1 ? "" : "s"}
                  </span>
                  {oldestInactiveThreadCandidate ? (
                    <span className="mt-1 block">
                      Oldest used{" "}
                      {formatRelativeTimeLabel(oldestInactiveThreadCandidate.lastUsedAtIso)}
                    </span>
                  ) : null}
                </>
              ) : (
                "No inactive threads older than 30 days."
              )
            }
            control={
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    checked={settings.autoCleanupInactiveThreads}
                    onCheckedChange={(checked) =>
                      updateSettings({ autoCleanupInactiveThreads: Boolean(checked) })
                    }
                    aria-label="Clean inactive threads automatically"
                  />
                  Auto
                </label>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={inactiveThreadCandidates.length === 0 || isCleaningInactiveThreads}
                  onClick={() => void cleanInactiveThreads()}
                >
                  {isCleaningInactiveThreads ? "Cleaning..." : "Clean threads"}
                </Button>
              </div>
            }
          />

          <SettingsRow
            title="Clean inactive projects"
            description="Remove projects with no threads from T3 Code. Folders on disk are not touched."
            status={
              emptyProjectCandidates.length > 0 ? (
                <span>
                  {emptyProjectCandidates.length} empty project
                  {emptyProjectCandidates.length === 1 ? "" : "s"}
                </span>
              ) : (
                "No projects without threads."
              )
            }
            control={
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    checked={settings.autoCleanupEmptyProjects}
                    onCheckedChange={(checked) =>
                      updateSettings({ autoCleanupEmptyProjects: Boolean(checked) })
                    }
                    aria-label="Clean inactive projects automatically"
                  />
                  Auto
                </label>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={emptyProjectCandidates.length === 0 || isCleaningEmptyProjects}
                  onClick={() => void cleanEmptyProjects()}
                >
                  {isCleaningEmptyProjects ? "Cleaning..." : "Clean projects"}
                </Button>
              </div>
            }
          />

          <SettingsRow
            title="Keybindings"
            description="Change common shortcuts in app. Edits are persisted to keybindings.json."
            status={
              <>
                <span className="block break-all font-mono text-[11px] text-foreground">
                  {keybindingsConfigPath ?? "Resolving keybindings path..."}
                </span>
                {openKeybindingsError ? (
                  <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
                ) : (
                  <span className="mt-1 block">Use the file for advanced conditional rules.</span>
                )}
              </>
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!keybindingsConfigPath || isOpeningKeybindings}
                onClick={openKeybindingsFile}
              >
                {isOpeningKeybindings ? "Opening..." : "Open file"}
              </Button>
            }
          />
          <KeybindingsSettingsRows disabled={!keybindingsConfigPath} keybindings={keybindings} />
        </SettingsSection>
      ) : null}

      {showAboutSettings ? (
        <SettingsSection title="About" icon={<CircleHelpIcon className="size-3.5" />}>
          {isDesktopShell ? (
            <AboutVersionSection />
          ) : (
            <SettingsRow
              title={<AboutVersionTitle />}
              description="Current version of the application."
            />
          )}
          <SettingsRow
            title="Diagnostics"
            description={diagnosticsDescription}
            status={
              <>
                <span className="block break-all font-mono text-[11px] text-foreground">
                  {logsDirectoryPath ?? "Resolving logs directory..."}
                </span>
                {openDiagnosticsError ? (
                  <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
                ) : null}
              </>
            }
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!logsDirectoryPath || isOpeningLogsDirectory}
                onClick={openLogsDirectory}
              >
                {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(() => {
    return projects
      .map((project) => ({
        project,
        threads: threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
      }))
      .filter((group) => group.threads.length > 0);
  }, [projects, threads]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads" icon={<ArchiveIcon className="size-3.5" />}>
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={project.id}
            title={project.name}
            icon={<ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />}
          >
            {projectThreads.map((thread) => (
              <div
                key={thread.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
              >
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                  onClick={() =>
                    void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id)).catch(
                      (error) => {
                        toastManager.add(
                          stackedThreadToast({
                            type: "error",
                            title: "Failed to unarchive thread",
                            description:
                              error instanceof Error ? error.message : "An error occurred.",
                          }),
                        );
                      },
                    )
                  }
                >
                  <ArchiveX className="size-3.5" />
                  <span>Unarchive</span>
                </Button>
              </div>
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
