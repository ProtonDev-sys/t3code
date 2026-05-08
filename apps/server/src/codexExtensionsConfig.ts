import { existsSync } from "node:fs";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
  CodexExtensionsConfigError,
  CodexSettings,
  DEFAULT_CODEX_USAGE_HISTORY_LIMIT,
  ProviderDriverKind,
  type CodexAutomationDeleteInput,
  type CodexAutomationDeleteResult,
  type CodexAutomationListInput,
  type CodexAutomationListResult,
  type CodexAutomationSaveInput,
  type CodexAutomationSaveResult,
  type CodexAutomationSummary,
  type CodexAutomationUpdateInput,
  type CodexPluginInstallInput,
  type CodexPluginInstallResult,
  type CodexPluginListInput,
  type CodexPluginListResult,
  type CodexPluginSummary,
  type CodexPluginUpdateInput,
  type CodexUsageHistoryListInput,
  type CodexUsageHistoryListResult,
  type CodexUsageHistorySourceKind,
  type CodexUsageHistoryThread,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import { scopedSafeTeardown } from "./provider/Layers/scopedSafeTeardown.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

function errorDetail(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  return String(value);
}

function toCodexExtensionsConfigError(value: unknown): CodexExtensionsConfigError {
  return Schema.is(CodexExtensionsConfigError)(value)
    ? value
    : new CodexExtensionsConfigError({ detail: errorDetail(value) });
}

function decodeCodexSettings(config: unknown): CodexSettings | CodexExtensionsConfigError {
  try {
    return Schema.decodeUnknownSync(CodexSettings)(config ?? {});
  } catch (error) {
    return new CodexExtensionsConfigError({
      detail: `Invalid Codex provider settings: ${errorDetail(error)}`,
    });
  }
}

function resolveCodexSettings(
  settings: ServerSettings,
  providerInstanceId?: ProviderInstanceId,
): CodexSettings | CodexExtensionsConfigError {
  if (providerInstanceId !== undefined) {
    const instance = settings.providerInstances[providerInstanceId];
    if (!instance && String(providerInstanceId) === "codex") {
      return settings.providers.codex;
    }
    if (!instance) {
      return new CodexExtensionsConfigError({
        detail: `Provider instance '${providerInstanceId}' was not found.`,
      });
    }
    if (instance.driver !== CODEX_DRIVER_KIND) {
      return new CodexExtensionsConfigError({
        detail: `Provider instance '${providerInstanceId}' is not a Codex instance.`,
      });
    }
    return decodeCodexSettings(instance.config);
  }

  const explicitCodexInstance = Object.values(settings.providerInstances).find(
    (instance) => instance.driver === CODEX_DRIVER_KIND,
  );
  return explicitCodexInstance
    ? decodeCodexSettings(explicitCodexInstance.config)
    : settings.providers.codex;
}

const resolveCodexPaths = Effect.fn("resolveCodexExtensionPaths")(function* (
  settings: ServerSettings,
  input: { readonly providerInstanceId?: ProviderInstanceId | undefined },
) {
  const path = yield* Path.Path;
  const codexSettings = resolveCodexSettings(settings, input.providerInstanceId);
  if (Schema.is(CodexExtensionsConfigError)(codexSettings)) {
    return yield* codexSettings;
  }
  const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  return {
    sharedHomePath: layout.sharedHomePath,
    configPath: path.join(layout.sharedHomePath, "config.toml"),
    pluginsPath: path.join(layout.sharedHomePath, "plugins"),
    automationsPath: path.join(layout.sharedHomePath, "automations"),
    statePath: path.join(layout.sharedHomePath, "state_5.sqlite"),
  };
});

const resolveCodexRuntime = Effect.fn("resolveCodexExtensionsRuntime")(function* (
  settings: ServerSettings,
  input: { readonly providerInstanceId?: ProviderInstanceId | undefined },
) {
  const path = yield* Path.Path;
  const codexSettings = resolveCodexSettings(settings, input.providerInstanceId);
  if (Schema.is(CodexExtensionsConfigError)(codexSettings)) {
    return yield* codexSettings;
  }
  const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  return {
    codexSettings,
    sharedHomePath: layout.sharedHomePath,
    configPath: path.join(layout.sharedHomePath, "config.toml"),
    pluginsPath: path.join(layout.sharedHomePath, "plugins"),
    automationsPath: path.join(layout.sharedHomePath, "automations"),
    statePath: path.join(layout.sharedHomePath, "state_5.sqlite"),
  };
});

const withCodexAppServerClient = Effect.fn("withCodexAppServerClient")(function* <A>(
  settings: ServerSettings,
  input: { readonly providerInstanceId?: ProviderInstanceId | undefined },
  useClient: (
    client: CodexClient.CodexAppServerClientShape,
  ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
): Effect.fn.Return<
  A,
  CodexExtensionsConfigError,
  Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const runtime = yield* resolveCodexRuntime(settings, input);
  return yield* scopedSafeTeardown("codex-extensions-app-server")(
    Effect.gen(function* () {
      const clientContext = yield* Layer.build(
        CodexClient.layerCommand({
          command: runtime.codexSettings.binaryPath || "codex",
          args: ["app-server"],
          cwd: process.cwd(),
          env: {
            ...process.env,
            CODEX_HOME: runtime.sharedHomePath,
          },
        }),
      ).pipe(Effect.mapError(toCodexExtensionsConfigError));
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );

      yield* client
        .request("initialize", {
          clientInfo: {
            name: "t3code_desktop",
            title: "T3 Code Desktop",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        })
        .pipe(Effect.mapError(toCodexExtensionsConfigError));
      yield* client
        .notify("initialized", undefined)
        .pipe(Effect.mapError(toCodexExtensionsConfigError));
      return yield* useClient(client).pipe(Effect.mapError(toCodexExtensionsConfigError));
    }),
  );
});

function stripInlineComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === "#" && !inString) {
      return line.slice(0, index).trim();
    }
  }
  return line.trim();
}

function parseTomlString(value: string): string | null {
  const trimmed = stripInlineComment(value);
  if (!trimmed) return null;
  if (trimmed.startsWith('"""')) {
    const endIndex = trimmed.lastIndexOf('"""');
    return endIndex > 2 ? trimmed.slice(3, endIndex) : null;
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined);
    }
  }
  return trimmed;
}

function parseTomlBoolean(value: string): boolean | null {
  const normalized = stripInlineComment(value).toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parseTomlStringArray(value: string): string[] {
  const matches = stripInlineComment(value).match(/"(?:\\.|[^"\\])*"/g) ?? [];
  return matches
    .map((entry) => {
      try {
        const parsed = JSON.parse(entry);
        return typeof parsed === "string" ? parsed : "";
      } catch {
        return "";
      }
    })
    .filter((entry) => entry.length > 0);
}

function parsePluginEnabled(raw: string): Map<string, boolean> {
  const enabledById = new Map<string, boolean>();
  let currentId: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const tableMatch = line.match(/^\s*\[plugins\."([^"]+)"]\s*$/);
    if (tableMatch) {
      currentId = tableMatch[1]!;
      if (!enabledById.has(currentId)) {
        enabledById.set(currentId, true);
      }
      continue;
    }
    if (/^\s*\[[^\]]+]\s*$/.test(line)) {
      currentId = null;
      continue;
    }
    if (!currentId) {
      continue;
    }
    const enabledMatch = line.match(/^\s*enabled\s*=\s*(.*)$/);
    if (!enabledMatch) {
      continue;
    }
    const enabled = parseTomlBoolean(enabledMatch[1]!);
    if (enabled !== null) {
      enabledById.set(currentId, enabled);
    }
  }
  return enabledById;
}

function upsertPluginEnabled(raw: string, input: CodexPluginUpdateInput): string {
  const lines = raw.split(/\r?\n/);
  const nextLines: string[] = [];
  const escapedId = input.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tablePattern = new RegExp(`^\\s*\\[plugins\\."${escapedId}"]\\s*$`);
  let insideTarget = false;
  let found = false;
  let wroteEnabled = false;

  for (const line of lines) {
    if (tablePattern.test(line)) {
      insideTarget = true;
      found = true;
      wroteEnabled = false;
      nextLines.push(line);
      continue;
    }
    if (insideTarget && /^\s*\[[^\]]+]\s*$/.test(line)) {
      if (!wroteEnabled) {
        nextLines.push(`enabled = ${input.enabled ? "true" : "false"}`);
      }
      insideTarget = false;
    }
    if (insideTarget && /^\s*enabled\s*=/.test(line)) {
      nextLines.push(`enabled = ${input.enabled ? "true" : "false"}`);
      wroteEnabled = true;
      continue;
    }
    nextLines.push(line);
  }

  if (insideTarget && !wroteEnabled) {
    nextLines.push(`enabled = ${input.enabled ? "true" : "false"}`);
  }

  const base = nextLines.join("\n").trimEnd();
  if (found) {
    return `${base}\n`;
  }
  const separator = base.length > 0 ? "\n\n" : "";
  return `${base}${separator}[plugins.${JSON.stringify(input.id)}]\nenabled = ${
    input.enabled ? "true" : "false"
  }\n`;
}

function readJsonRecord(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parsePluginManifest(input: {
  readonly marketplace: string;
  readonly manifestPath: string;
  readonly raw: string;
  readonly enabledById: ReadonlyMap<string, boolean>;
}): CodexPluginSummary | null {
  const manifest = readJsonRecord(input.raw);
  if (!manifest) {
    return null;
  }
  const name = readString(manifest.name);
  if (!name) {
    return null;
  }
  const id = `${name}@${input.marketplace}`;
  const ui = readJsonRecord(manifest.interface);
  return {
    id,
    name,
    enabled: input.enabledById.get(id) ?? false,
    cached: true,
    path: input.manifestPath,
    ...(readString(manifest.version) ? { version: readString(manifest.version)! } : {}),
    ...(readString(manifest.description) ? { description: readString(manifest.description)! } : {}),
    ...(input.marketplace ? { marketplace: input.marketplace } : {}),
    ...(readString(ui?.displayName) ? { displayName: readString(ui?.displayName)! } : {}),
    ...(readString(ui?.shortDescription) ? { description: readString(ui?.shortDescription)! } : {}),
    ...(readString(ui?.developerName) ? { developerName: readString(ui?.developerName)! } : {}),
    ...(readString(ui?.category) ? { category: readString(ui?.category)! } : {}),
  };
}

function readCodexPluginSourcePath(source: CodexSchema.V2PluginListResponse__PluginSource) {
  if (source.type === "local") return source.path;
  if (source.type === "git") return source.path ?? undefined;
  return undefined;
}

function mapCodexAppServerPlugin(input: {
  readonly marketplace: CodexSchema.V2PluginListResponse__PluginMarketplaceEntry;
  readonly plugin: CodexSchema.V2PluginListResponse__PluginSummary;
}): CodexPluginSummary {
  const ui = input.plugin.interface ?? null;
  const sourcePath = readCodexPluginSourcePath(input.plugin.source);
  const description = ui?.shortDescription ?? ui?.longDescription ?? null;
  const isRemoteMarketplace = !input.marketplace.path;
  return {
    id: input.plugin.id,
    name: input.plugin.name,
    enabled: input.plugin.enabled,
    cached: input.plugin.installed || input.plugin.source.type !== "remote",
    installed: input.plugin.installed,
    installPolicy: input.plugin.installPolicy,
    sourceType: input.plugin.source.type,
    marketplace: input.marketplace.name,
    ...(input.marketplace.path ? { marketplacePath: input.marketplace.path } : {}),
    ...(isRemoteMarketplace ? { remoteMarketplaceName: input.marketplace.name } : {}),
    ...(sourcePath ? { path: sourcePath } : {}),
    ...(ui?.displayName ? { displayName: ui.displayName } : {}),
    ...(description ? { description } : {}),
    ...(ui?.developerName ? { developerName: ui.developerName } : {}),
    ...(ui?.category ? { category: ui.category } : {}),
  };
}

const listCodexPluginsFromAppServer = Effect.fn("listCodexPluginsFromAppServer")(function* (
  settings: ServerSettings,
  input: CodexPluginListInput,
): Effect.fn.Return<
  CodexPluginListResult,
  CodexExtensionsConfigError,
  Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const response = yield* withCodexAppServerClient(settings, input, (client) =>
    client.request("plugin/list", {}),
  );
  const plugins = response.marketplaces
    .flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => mapCodexAppServerPlugin({ marketplace, plugin })),
    )
    .toSorted((left, right) =>
      (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name),
    );
  return {
    configPath: paths.configPath,
    pluginsPath: paths.pluginsPath,
    plugins,
  };
});

const listCodexCachedPlugins = Effect.fn("listCodexCachedPlugins")(function* (
  settings: ServerSettings,
  input: CodexPluginListInput,
): Effect.fn.Return<
  CodexPluginListResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const configRaw = yield* fileSystem.readFileString(paths.configPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    ),
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const enabledById = parsePluginEnabled(configRaw);
  const pluginsById = new Map<string, CodexPluginSummary>();
  const cachePath = path.join(paths.pluginsPath, "cache");
  const marketplaces = yield* fileSystem.readDirectory(cachePath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
    ),
    Effect.mapError(toCodexExtensionsConfigError),
  );

  for (const marketplace of marketplaces) {
    const marketplacePath = path.join(cachePath, marketplace);
    const pluginNames = yield* fileSystem.readDirectory(marketplacePath).pipe(
      Effect.catch(() => Effect.succeed([])),
      Effect.mapError(toCodexExtensionsConfigError),
    );
    for (const pluginName of pluginNames) {
      const pluginPath = path.join(marketplacePath, pluginName);
      const versions = yield* fileSystem.readDirectory(pluginPath).pipe(
        Effect.catch(() => Effect.succeed([])),
        Effect.mapError(toCodexExtensionsConfigError),
      );
      for (const version of versions) {
        const manifestPath = path.join(pluginPath, version, ".codex-plugin", "plugin.json");
        const raw = yield* fileSystem.readFileString(manifestPath).pipe(
          Effect.catch(() => Effect.succeed("")),
          Effect.mapError(toCodexExtensionsConfigError),
        );
        const plugin = parsePluginManifest({ marketplace, manifestPath, raw, enabledById });
        if (plugin) {
          pluginsById.set(plugin.id, plugin);
        }
      }
    }
  }

  for (const [id, enabled] of enabledById.entries()) {
    if (!pluginsById.has(id)) {
      const marketplace = id.includes("@") ? id.split("@").slice(1).join("@") : null;
      pluginsById.set(id, {
        id,
        name: id.split("@")[0] || id,
        enabled,
        cached: false,
        ...(marketplace ? { marketplace } : {}),
      });
    }
  }

  return {
    configPath: paths.configPath,
    pluginsPath: paths.pluginsPath,
    plugins: Array.from(pluginsById.values()).toSorted((left, right) =>
      (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name),
    ),
  };
});

export const listCodexPlugins = Effect.fn("listCodexPlugins")(function* (
  settings: ServerSettings,
  input: CodexPluginListInput,
): Effect.fn.Return<
  CodexPluginListResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return yield* listCodexPluginsFromAppServer(settings, input).pipe(
    Effect.catch(() => listCodexCachedPlugins(settings, input)),
  );
});

export const updateCodexPlugin = Effect.fn("updateCodexPlugin")(function* (
  settings: ServerSettings,
  input: CodexPluginUpdateInput,
): Effect.fn.Return<
  CodexPluginListResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const raw = yield* fileSystem.readFileString(paths.configPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    ),
    Effect.mapError(toCodexExtensionsConfigError),
  );
  yield* fileSystem
    .makeDirectory(path.dirname(paths.configPath), { recursive: true })
    .pipe(Effect.mapError(toCodexExtensionsConfigError));
  yield* fileSystem
    .writeFileString(paths.configPath, upsertPluginEnabled(raw, input))
    .pipe(Effect.mapError(toCodexExtensionsConfigError));
  return yield* listCodexPlugins(settings, input);
});

export const installCodexPlugin = Effect.fn("installCodexPlugin")(function* (
  settings: ServerSettings,
  input: CodexPluginInstallInput,
): Effect.fn.Return<
  CodexPluginInstallResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  yield* withCodexAppServerClient(settings, input, (client) =>
    client.request("plugin/install", {
      pluginName: input.pluginName,
      ...(input.marketplacePath ? { marketplacePath: input.marketplacePath } : {}),
      ...(input.remoteMarketplaceName
        ? { remoteMarketplaceName: input.remoteMarketplaceName }
        : {}),
    }),
  );
  return yield* listCodexPlugins(settings, input);
});

const AUTOMATION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function validateAutomationId(id: string): CodexExtensionsConfigError | null {
  if (AUTOMATION_ID_PATTERN.test(id)) {
    return null;
  }
  return new CodexExtensionsConfigError({
    detail:
      "Automation id must start with a letter and contain only letters, numbers, dashes, or underscores.",
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function normalizedOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeAutomationDirectory(
  automationsPath: string,
  automationId: string,
): string | CodexExtensionsConfigError {
  const validationError = validateAutomationId(automationId);
  if (validationError) {
    return validationError;
  }
  const automationsRoot = nodePath.resolve(automationsPath);
  const targetDirectory = nodePath.resolve(nodePath.join(automationsRoot, automationId));
  if (!targetDirectory.startsWith(`${automationsRoot}${nodePath.sep}`)) {
    return new CodexExtensionsConfigError({
      detail: `Refusing to access automation outside '${automationsRoot}'.`,
    });
  }
  return targetDirectory;
}

function renderAutomationToml(input: CodexAutomationSaveInput, existingRaw: string | null): string {
  const existing = existingRaw ? parseAutomationToml(input.id, "", existingRaw) : null;
  const now = new Date().toISOString();
  const createdAt = existing?.createdAt ?? now;
  const lines = [
    "version = 1",
    `id = ${tomlString(input.id)}`,
    `name = ${tomlString(input.name.trim())}`,
    `prompt = ${tomlString(input.prompt.trim())}`,
    `status = ${tomlString(input.enabled ? "ACTIVE" : "PAUSED")}`,
  ];
  const rrule = normalizedOptional(input.rrule);
  const executionEnvironment = normalizedOptional(input.executionEnvironment);
  const model = normalizedOptional(input.model);
  const reasoningEffort = normalizedOptional(input.reasoningEffort);
  if (rrule) {
    lines.push(`rrule = ${tomlString(rrule)}`);
  }
  if (executionEnvironment) {
    lines.push(`execution_environment = ${tomlString(executionEnvironment)}`);
  }
  if (model) {
    lines.push(`model = ${tomlString(model)}`);
  }
  if (reasoningEffort) {
    lines.push(`reasoning_effort = ${tomlString(reasoningEffort)}`);
  }
  lines.push(`cwds = ${tomlStringArray(input.cwds.map((cwd) => cwd.trim()).filter(Boolean))}`);
  lines.push(`created_at = ${tomlString(createdAt)}`);
  lines.push(`updated_at = ${tomlString(now)}`);
  return `${lines.join("\n")}\n`;
}

function parseAutomationToml(
  id: string,
  filePath: string,
  raw: string,
): CodexAutomationSummary | null {
  const values = new Map<string, string>();
  const arrays = new Map<string, string[]>();
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let value = match[2]!;
    const trimmedValue = value.trim();
    if (trimmedValue.startsWith('"""') && trimmedValue.lastIndexOf('"""') === 0) {
      while (index + 1 < lines.length) {
        index += 1;
        value += `\n${lines[index] ?? ""}`;
        if ((lines[index] ?? "").includes('"""')) {
          break;
        }
      }
    }
    if (key === "cwds") {
      arrays.set(key, parseTomlStringArray(value));
      continue;
    }
    const parsed = parseTomlString(value);
    if (parsed !== null) {
      values.set(key, parsed);
    }
  }
  const name = values.get("name")?.trim() || id;
  const status = values.get("status")?.trim() || "UNKNOWN";
  return {
    id,
    name,
    status,
    enabled: status.toUpperCase() !== "PAUSED",
    path: filePath,
    cwds: arrays.get("cwds") ?? [],
    ...(values.get("prompt") ? { prompt: values.get("prompt") } : {}),
    ...(values.get("rrule") ? { rrule: values.get("rrule") } : {}),
    ...(values.get("execution_environment")
      ? { executionEnvironment: values.get("execution_environment") }
      : {}),
    ...(values.get("model") ? { model: values.get("model") } : {}),
    ...(values.get("reasoning_effort") ? { reasoningEffort: values.get("reasoning_effort") } : {}),
    ...(values.get("created_at") ? { createdAt: values.get("created_at") } : {}),
    ...(values.get("updated_at") ? { updatedAt: values.get("updated_at") } : {}),
  };
}

function setAutomationEnabled(raw: string, enabled: boolean): string {
  const nextStatus = enabled ? "ACTIVE" : "PAUSED";
  const lines = raw.split(/\r?\n/);
  let wrote = false;
  const nextLines = lines.map((line) => {
    if (/^\s*status\s*=/.test(line)) {
      wrote = true;
      return `status = ${JSON.stringify(nextStatus)}`;
    }
    return line;
  });
  if (!wrote) {
    nextLines.push(`status = ${JSON.stringify(nextStatus)}`);
  }
  return `${nextLines.join("\n").trimEnd()}\n`;
}

export const saveCodexAutomation = Effect.fn("saveCodexAutomation")(function* (
  settings: ServerSettings,
  input: CodexAutomationSaveInput,
): Effect.fn.Return<
  CodexAutomationSaveResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const targetDirectory = safeAutomationDirectory(paths.automationsPath, input.id);
  if (Schema.is(CodexExtensionsConfigError)(targetDirectory)) {
    return yield* targetDirectory;
  }
  const targetFile = nodePath.join(targetDirectory, "automation.toml");
  const originalId = input.originalId?.trim();
  const originalDirectory =
    originalId && originalId !== input.id
      ? safeAutomationDirectory(paths.automationsPath, originalId)
      : targetDirectory;
  if (Schema.is(CodexExtensionsConfigError)(originalDirectory)) {
    return yield* originalDirectory;
  }
  const originalFile = nodePath.join(originalDirectory, "automation.toml");
  const existingRaw = yield* fileSystem.readFileString(originalFile).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    ),
    Effect.mapError(toCodexExtensionsConfigError),
  );

  yield* fileSystem
    .makeDirectory(targetDirectory, { recursive: true })
    .pipe(Effect.mapError(toCodexExtensionsConfigError));
  yield* fileSystem
    .writeFileString(targetFile, renderAutomationToml(input, existingRaw))
    .pipe(Effect.mapError(toCodexExtensionsConfigError));

  if (originalDirectory !== targetDirectory) {
    yield* fileSystem
      .remove(originalDirectory, { recursive: true, force: true })
      .pipe(Effect.mapError(toCodexExtensionsConfigError));
  }
  return yield* listCodexAutomations(settings, input);
});

export const deleteCodexAutomation = Effect.fn("deleteCodexAutomation")(function* (
  settings: ServerSettings,
  input: CodexAutomationDeleteInput,
): Effect.fn.Return<
  CodexAutomationDeleteResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const targetDirectory = safeAutomationDirectory(paths.automationsPath, input.id);
  if (Schema.is(CodexExtensionsConfigError)(targetDirectory)) {
    return yield* targetDirectory;
  }
  yield* fileSystem
    .remove(targetDirectory, { recursive: true, force: true })
    .pipe(Effect.mapError(toCodexExtensionsConfigError));
  return yield* listCodexAutomations(settings, input);
});

export const listCodexAutomations = Effect.fn("listCodexAutomations")(function* (
  settings: ServerSettings,
  input: CodexAutomationListInput,
): Effect.fn.Return<
  CodexAutomationListResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const entries = yield* fileSystem.readDirectory(paths.automationsPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
    ),
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const automations: CodexAutomationSummary[] = [];
  for (const entry of entries) {
    const filePath = path.join(paths.automationsPath, entry, "automation.toml");
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.catch(() => Effect.succeed("")),
      Effect.mapError(toCodexExtensionsConfigError),
    );
    if (!raw.trim()) {
      continue;
    }
    const parsed = parseAutomationToml(entry, filePath, raw);
    if (parsed) {
      automations.push(parsed);
    }
  }
  return {
    automationsPath: paths.automationsPath,
    automations: automations.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
});

export const updateCodexAutomation = Effect.fn("updateCodexAutomation")(function* (
  settings: ServerSettings,
  input: CodexAutomationUpdateInput,
): Effect.fn.Return<
  CodexAutomationListResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const filePath = path.join(paths.automationsPath, input.id, "automation.toml");
  const raw = yield* fileSystem.readFileString(filePath).pipe(
    Effect.mapError(
      (cause) =>
        new CodexExtensionsConfigError({
          detail: `Failed to read Codex automation '${input.id}': ${errorDetail(cause)}`,
        }),
    ),
  );
  yield* fileSystem
    .writeFileString(filePath, setAutomationEnabled(raw, input.enabled))
    .pipe(Effect.mapError(toCodexExtensionsConfigError));
  return yield* listCodexAutomations(settings, input);
});

function timestampToIso(seconds: unknown, milliseconds: unknown): string {
  const ms =
    typeof milliseconds === "number" && Number.isFinite(milliseconds)
      ? milliseconds
      : typeof seconds === "number" && Number.isFinite(seconds)
        ? seconds * 1000
        : Date.now();
  return new Date(ms).toISOString();
}

function sourceKindAndLabel(source: unknown): {
  readonly sourceKind: CodexUsageHistorySourceKind;
  readonly sourceLabel: string;
} {
  if (source === "cli") {
    return { sourceKind: "cli", sourceLabel: "Codex CLI" };
  }
  if (source === "vscode") {
    return { sourceKind: "vscode", sourceLabel: "Codex VS Code" };
  }
  if (typeof source === "string" && source.trim().startsWith("{")) {
    const parsed = readJsonRecord(source);
    const subagent = readJsonRecord(readJsonRecord(parsed?.subagent)?.thread_spawn);
    const role = readString(subagent?.agent_role);
    return {
      sourceKind: "subagent",
      sourceLabel: role ? `Codex subagent: ${role}` : "Codex subagent",
    };
  }
  if (source === "automation") {
    return { sourceKind: "automation", sourceLabel: "Codex automation" };
  }
  return { sourceKind: "other", sourceLabel: typeof source === "string" ? source : "Codex" };
}

interface CodexUsageThreadRow {
  readonly id: string;
  readonly source: string | null;
  readonly model_provider: string | null;
  readonly model: string | null;
  readonly tokens_used: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly created_at_ms: number | null;
  readonly updated_at_ms: number | null;
}

interface MutableCodexUsageHistoryThread {
  threadId: string;
  sourceKind: CodexUsageHistorySourceKind;
  sourceLabel: string;
  model?: string;
  modelProvider?: string;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

function parseUpdatedAfterMs(updatedAfter: string | undefined): number | null {
  if (!updatedAfter) {
    return null;
  }
  const parsed = Date.parse(updatedAfter);
  return Number.isFinite(parsed) ? parsed : null;
}

function readUsageHistoryRows(input: {
  readonly statePath: string;
  readonly limit: number;
  readonly updatedAfter?: string | undefined;
}): CodexUsageHistoryThread[] {
  const { limit, statePath } = input;
  if (!existsSync(statePath)) {
    return [];
  }
  const updatedAfterMs = parseUpdatedAfterMs(input.updatedAfter);
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const statement = db.prepare(
      updatedAfterMs === null
        ? `
      SELECT id, source, model_provider, model, tokens_used, created_at, updated_at, created_at_ms, updated_at_ms
      FROM threads
      WHERE tokens_used > 0
      ORDER BY updated_at DESC
      LIMIT ?
    `
        : `
      SELECT id, source, model_provider, model, tokens_used, created_at, updated_at, created_at_ms, updated_at_ms
      FROM threads
      WHERE tokens_used > 0
        AND COALESCE(updated_at_ms, updated_at * 1000) > ?
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    );
    const rows =
      updatedAfterMs === null ? statement.all(limit) : statement.all(updatedAfterMs, limit);
    return (rows as unknown as CodexUsageThreadRow[]).map((row) => {
      const source = sourceKindAndLabel(row.source);
      const thread: MutableCodexUsageHistoryThread = {
        threadId: row.id,
        sourceKind: source.sourceKind,
        sourceLabel: source.sourceLabel,
        tokensUsed: row.tokens_used,
        createdAt: timestampToIso(row.created_at, row.created_at_ms),
        updatedAt: timestampToIso(row.updated_at, row.updated_at_ms),
      };
      if (row.model) {
        thread.model = row.model;
      }
      if (row.model_provider) {
        thread.modelProvider = row.model_provider;
      }
      return thread;
    });
  } finally {
    db.close();
  }
}

export const listCodexUsageHistory = Effect.fn("listCodexUsageHistory")(function* (
  settings: ServerSettings,
  input: CodexUsageHistoryListInput,
): Effect.fn.Return<
  CodexUsageHistoryListResult,
  CodexExtensionsConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const paths = yield* resolveCodexPaths(settings, input).pipe(
    Effect.mapError(toCodexExtensionsConfigError),
  );
  const limit = Math.min(25_000, Math.max(1, input.limit ?? DEFAULT_CODEX_USAGE_HISTORY_LIMIT));
  const threads = yield* Effect.try({
    try: () =>
      readUsageHistoryRows({
        statePath: paths.statePath,
        limit,
        updatedAfter: input.updatedAfter,
      }),
    catch: (cause) =>
      new CodexExtensionsConfigError({
        detail: `Failed to read Codex usage history '${paths.statePath}': ${errorDetail(cause)}`,
      }),
  });
  return {
    statePath: paths.statePath,
    threads,
  };
});
