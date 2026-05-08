import {
  CodexMcpConfigError,
  ProviderDriverKind,
  ProviderInstanceId,
  CodexSettings,
  type CodexMcpAddServerInput,
  type CodexMcpDeleteServerInput,
  type CodexMcpListInput,
  type CodexMcpListResult,
  type CodexMcpServerSummary,
  type CodexMcpUpdateServerInput,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";

import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

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

function isCodexMcpConfigError(value: unknown): value is CodexMcpConfigError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "CodexMcpConfigError"
  );
}

function errorDetail(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  return String(value);
}

function toCodexMcpConfigError(value: unknown): CodexMcpConfigError {
  return isCodexMcpConfigError(value)
    ? value
    : new CodexMcpConfigError({ detail: errorDetail(value) });
}

function parseCodexMcpServers(raw: string): CodexMcpServerSummary[] {
  const lines = raw.split(/\r?\n/);
  const servers = new Map<string, CodexMcpServerSummary>();
  const toolCounts = new Map<string, number>();
  let currentName: string | null = null;
  let argsCollectingFor: string | null = null;
  let argsBuffer = "";

  const ensureServer = (name: string) => {
    const existing = servers.get(name);
    if (existing) return existing;
    const created: CodexMcpServerSummary = {
      name: name as CodexMcpServerSummary["name"],
      transport: "unknown",
      enabled: true,
      toolCount: 0,
    };
    servers.set(name, created);
    return created;
  };

  const updateServer = (name: string, patch: Partial<CodexMcpServerSummary>) => {
    servers.set(name, { ...ensureServer(name), ...patch });
  };

  for (const line of lines) {
    const tableMatch = line.match(/^\s*\[mcp_servers\.([a-zA-Z0-9_-]+)(?:\.([^\]]+))?]\s*$/);
    if (tableMatch) {
      argsCollectingFor = null;
      argsBuffer = "";
      const name = tableMatch[1]!;
      const nested = tableMatch[2];
      if (nested) {
        currentName = null;
        if (nested.startsWith("tools.")) {
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        }
      } else {
        currentName = name;
        ensureServer(name);
      }
      continue;
    }

    if (argsCollectingFor) {
      argsBuffer += `\n${line}`;
      if (line.includes("]")) {
        updateServer(argsCollectingFor, { args: parseTomlStringArray(argsBuffer) });
        argsCollectingFor = null;
        argsBuffer = "";
      }
      continue;
    }

    if (!currentName) {
      continue;
    }

    const propertyMatch = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.*)$/);
    if (!propertyMatch) {
      continue;
    }
    const key = propertyMatch[1]!;
    const value = propertyMatch[2]!;
    if (key === "args") {
      if (value.includes("[") && !value.includes("]")) {
        argsCollectingFor = currentName;
        argsBuffer = value;
      } else {
        updateServer(currentName, { args: parseTomlStringArray(value) });
      }
      continue;
    }
    if (key === "command") {
      const command = parseTomlString(value);
      if (command) {
        updateServer(currentName, { command, transport: "stdio" });
      }
      continue;
    }
    if (key === "url") {
      const url = parseTomlString(value);
      if (url) {
        updateServer(currentName, { url });
      }
      continue;
    }
    if (key === "type") {
      const type = parseTomlString(value);
      if (type === "sse" || type === "http") {
        updateServer(currentName, { transport: type });
      }
      continue;
    }
    if (key === "enabled") {
      const enabled = parseTomlBoolean(value);
      if (enabled !== null) {
        updateServer(currentName, { enabled });
      }
    }
  }

  const parsed: CodexMcpServerSummary[] = [];
  for (const server of servers.values()) {
    const transport: CodexMcpServerSummary["transport"] =
      server.transport !== "unknown" ? server.transport : server.command ? "stdio" : "unknown";
    parsed.push({
      ...server,
      transport,
      toolCount: toolCounts.get(server.name) ?? 0,
    });
  }
  return parsed.toSorted((left, right) => left.name.localeCompare(right.name));
}

function decodeCodexSettings(config: unknown): CodexSettings | CodexMcpConfigError {
  try {
    return Schema.decodeUnknownSync(CodexSettings)(config ?? {});
  } catch (error) {
    return new CodexMcpConfigError({
      detail: `Invalid Codex provider settings: ${errorDetail(error)}`,
    });
  }
}

function resolveCodexSettings(
  settings: ServerSettings,
  providerInstanceId?: ProviderInstanceId,
): CodexSettings | CodexMcpConfigError {
  if (providerInstanceId !== undefined) {
    const instance = settings.providerInstances[providerInstanceId];
    if (!instance && String(providerInstanceId) === "codex") {
      return settings.providers.codex;
    }
    if (!instance) {
      return new CodexMcpConfigError({
        detail: `Provider instance '${providerInstanceId}' was not found.`,
      });
    }
    if (instance.driver !== CODEX_DRIVER_KIND) {
      return new CodexMcpConfigError({
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

const resolveCodexConfigPath = Effect.fn("resolveCodexConfigPath")(function* (
  settings: ServerSettings,
  input: CodexMcpListInput,
) {
  const path = yield* Path.Path;
  const codexSettings = resolveCodexSettings(settings, input.providerInstanceId);
  if (isCodexMcpConfigError(codexSettings)) {
    return yield* codexSettings;
  }
  const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
    Effect.mapError(toCodexMcpConfigError),
  );
  return path.join(layout.sharedHomePath, "config.toml");
});

function renderMcpServerBlock(input: CodexMcpAddServerInput): string {
  const lines = [`[mcp_servers.${input.name}]`, `enabled = ${input.enabled ? "true" : "false"}`];
  if (input.transport === "stdio") {
    lines.push(`command = ${tomlString(input.command?.trim() ?? "")}`);
    const args = (input.args ?? []).map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    if (args.length > 0) {
      lines.push(`args = ${tomlStringArray(args)}`);
    }
  } else {
    lines.push(`type = ${tomlString(input.transport)}`);
    lines.push(`url = ${tomlString(input.url?.trim() ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}

function tableBelongsToMcpServer(line: string, name: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[mcp_servers\\.${escapedName}(?:\\.[^\\]]+)?]\\s*$`).test(line);
}

function isAnyTomlTable(line: string): boolean {
  return /^\s*\[[^\]]+]\s*$/.test(line);
}

function removeMcpServerBlocks(
  raw: string,
  name: string,
): { readonly raw: string; readonly found: boolean } {
  const lines = raw.split(/\r?\n/);
  const nextLines: string[] = [];
  let skipping = false;
  let found = false;

  for (const line of lines) {
    if (tableBelongsToMcpServer(line, name)) {
      skipping = true;
      found = true;
      continue;
    }
    if (skipping && isAnyTomlTable(line)) {
      skipping = false;
    }
    if (!skipping) {
      nextLines.push(line);
    }
  }

  return {
    raw: nextLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd(),
    found,
  };
}

function setMcpServerEnabled(raw: string, input: CodexMcpUpdateServerInput) {
  const lines = raw.split(/\r?\n/);
  const nextLines: string[] = [];
  let insideTarget = false;
  let found = false;
  let wroteEnabled = false;

  for (const line of lines) {
    if (tableBelongsToMcpServer(line, input.name)) {
      const isMainTable = new RegExp(`^\\s*\\[mcp_servers\\.${input.name}]\\s*$`).test(line);
      if (isMainTable) {
        insideTarget = true;
        found = true;
        wroteEnabled = false;
      } else if (insideTarget && !wroteEnabled) {
        nextLines.push(`enabled = ${input.enabled ? "true" : "false"}`);
        wroteEnabled = true;
        insideTarget = false;
      }
    } else if (insideTarget && isAnyTomlTable(line)) {
      if (!wroteEnabled) {
        nextLines.push(`enabled = ${input.enabled ? "true" : "false"}`);
        wroteEnabled = true;
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

  return { raw: nextLines.join("\n").trimEnd(), found };
}

function validateAddInput(input: CodexMcpAddServerInput): CodexMcpConfigError | null {
  if (input.transport === "stdio" && !input.command?.trim()) {
    return new CodexMcpConfigError({ detail: "Command is required for a stdio MCP server." });
  }
  if ((input.transport === "sse" || input.transport === "http") && !input.url?.trim()) {
    return new CodexMcpConfigError({ detail: "URL is required for a remote MCP server." });
  }
  return null;
}

export const listCodexMcpServers = Effect.fn("listCodexMcpServers")(function* (
  settings: ServerSettings,
  input: CodexMcpListInput,
): Effect.fn.Return<CodexMcpListResult, CodexMcpConfigError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const configPath = yield* resolveCodexConfigPath(settings, input).pipe(
    Effect.mapError(toCodexMcpConfigError),
  );
  const raw = yield* fileSystem.readFileString(configPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    ),
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to read Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  return {
    configPath,
    servers: parseCodexMcpServers(raw),
  };
});

export const addCodexMcpServer = Effect.fn("addCodexMcpServer")(function* (
  settings: ServerSettings,
  input: CodexMcpAddServerInput,
): Effect.fn.Return<CodexMcpListResult, CodexMcpConfigError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const validationError = validateAddInput(input);
  if (validationError) {
    return yield* validationError;
  }
  const configPath = yield* resolveCodexConfigPath(settings, input).pipe(
    Effect.mapError(toCodexMcpConfigError),
  );
  const raw = yield* fileSystem.readFileString(configPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
    ),
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to read Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  const existingServers = parseCodexMcpServers(raw);
  if (existingServers.some((server) => server.name === input.name)) {
    return yield* new CodexMcpConfigError({
      detail: `MCP server '${input.name}' already exists in Codex config.`,
    });
  }
  const separator = raw.trim().length > 0 ? "\n\n" : "";
  const nextRaw = `${raw.replace(/\s*$/, "")}${separator}${renderMcpServerBlock(input)}`;
  yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to prepare Codex config directory: ${String(cause)}`,
        }),
    ),
  );
  yield* fileSystem.writeFileString(configPath, nextRaw).pipe(
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to write Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  return {
    configPath,
    servers: parseCodexMcpServers(nextRaw),
  };
});

export const updateCodexMcpServer = Effect.fn("updateCodexMcpServer")(function* (
  settings: ServerSettings,
  input: CodexMcpUpdateServerInput,
): Effect.fn.Return<CodexMcpListResult, CodexMcpConfigError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const configPath = yield* resolveCodexConfigPath(settings, input).pipe(
    Effect.mapError(toCodexMcpConfigError),
  );
  const raw = yield* fileSystem.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to read Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  const updated = setMcpServerEnabled(raw, input);
  if (!updated.found) {
    return yield* new CodexMcpConfigError({
      detail: `MCP server '${input.name}' was not found in Codex config.`,
    });
  }
  yield* fileSystem.writeFileString(configPath, `${updated.raw}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to write Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  return {
    configPath,
    servers: parseCodexMcpServers(updated.raw),
  };
});

export const deleteCodexMcpServer = Effect.fn("deleteCodexMcpServer")(function* (
  settings: ServerSettings,
  input: CodexMcpDeleteServerInput,
): Effect.fn.Return<CodexMcpListResult, CodexMcpConfigError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const configPath = yield* resolveCodexConfigPath(settings, input).pipe(
    Effect.mapError(toCodexMcpConfigError),
  );
  const raw = yield* fileSystem.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to read Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  const updated = removeMcpServerBlocks(raw, input.name);
  if (!updated.found) {
    return yield* new CodexMcpConfigError({
      detail: `MCP server '${input.name}' was not found in Codex config.`,
    });
  }
  const nextRaw = updated.raw.trim().length > 0 ? `${updated.raw}\n` : "";
  yield* fileSystem.writeFileString(configPath, nextRaw).pipe(
    Effect.mapError(
      (cause) =>
        new CodexMcpConfigError({
          detail: `Failed to write Codex MCP config '${configPath}': ${String(cause)}`,
        }),
    ),
  );
  return {
    configPath,
    servers: parseCodexMcpServers(nextRaw),
  };
});
