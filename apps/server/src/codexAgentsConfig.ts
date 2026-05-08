import {
  CodexAgentConfigError,
  CodexSettings,
  ProviderCustomAgentId,
  ProviderDriverKind,
  type CodexAgentListInput,
  type CodexAgentListResult,
  type CodexAgentSummary,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";

import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const LEGACY_MANAGED_AGENT_MARKER = "# Managed by T3 Code. Do not edit by hand.";
const MANAGED_AGENT_OWNER_MARKER_PATTERN =
  /^# Managed by T3 Code for provider instance (.+)\. Do not edit by hand\.$/;
const AGENT_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function errorDetail(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  return String(value);
}

function toCodexAgentConfigError(value: unknown): CodexAgentConfigError {
  return Schema.is(CodexAgentConfigError)(value)
    ? value
    : new CodexAgentConfigError({ detail: errorDetail(value) });
}

function decodeCodexSettings(config: unknown): CodexSettings | CodexAgentConfigError {
  try {
    return Schema.decodeUnknownSync(CodexSettings)(config ?? {});
  } catch (error) {
    return new CodexAgentConfigError({
      detail: `Invalid Codex provider settings: ${errorDetail(error)}`,
    });
  }
}

function resolveCodexSettings(
  settings: ServerSettings,
  providerInstanceId?: ProviderInstanceId,
): CodexSettings | CodexAgentConfigError {
  if (providerInstanceId !== undefined) {
    const instance = settings.providerInstances[providerInstanceId];
    if (!instance && String(providerInstanceId) === "codex") {
      return settings.providers.codex;
    }
    if (!instance) {
      return new CodexAgentConfigError({
        detail: `Provider instance '${providerInstanceId}' was not found.`,
      });
    }
    if (instance.driver !== CODEX_DRIVER_KIND) {
      return new CodexAgentConfigError({
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

function parseTomlStringValue(value: string): string | null {
  const trimmed = stripInlineComment(value);
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
  return trimmed.length > 0 ? trimmed : null;
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

function parseManagedAgentOwner(raw: string): ProviderInstanceId | null {
  if (raw.startsWith(LEGACY_MANAGED_AGENT_MARKER)) {
    return null;
  }
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = firstLine.match(MANAGED_AGENT_OWNER_MARKER_PATTERN);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1] ?? "");
    return typeof parsed === "string" ? ProviderInstanceId.make(parsed) : null;
  } catch {
    return null;
  }
}

function normalizeAgentId(fileStem: string): string {
  const withoutAgentSuffix = fileStem.endsWith(".agent")
    ? fileStem.slice(0, -".agent".length)
    : fileStem;
  const normalized = withoutAgentSuffix
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) {
    return "agent";
  }
  const candidate = /^[a-zA-Z]/.test(normalized) ? normalized : `agent-${normalized}`;
  return AGENT_ID_PATTERN.test(candidate) ? candidate.slice(0, 64) : "agent";
}

function parseAgentToml(id: string, filePath: string, raw: string): CodexAgentSummary | null {
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
    if (key === "nickname_candidates") {
      arrays.set(key, parseTomlStringArray(value));
      continue;
    }
    const parsed = parseTomlStringValue(value);
    if (parsed !== null) {
      values.set(key, parsed);
    }
  }

  const name = values.get("name")?.trim();
  const instructions = values.get("developer_instructions")?.trim();
  if (!name || !instructions) {
    return null;
  }

  const managedProviderInstanceId = parseManagedAgentOwner(raw);
  const managed = raw.startsWith(LEGACY_MANAGED_AGENT_MARKER) || managedProviderInstanceId !== null;

  return {
    id: ProviderCustomAgentId.make(id),
    name,
    instructions,
    managed,
    ...(managedProviderInstanceId ? { managedProviderInstanceId } : {}),
    path: filePath,
    ...(values.get("description") ? { description: values.get("description") } : {}),
    ...(arrays.get("nickname_candidates")?.length
      ? { nicknameCandidates: arrays.get("nickname_candidates") }
      : {}),
    ...(values.get("model") ? { model: values.get("model") } : {}),
    ...((values.get("reasoning_effort") ?? values.get("model_reasoning_effort"))
      ? { reasoningEffort: values.get("reasoning_effort") ?? values.get("model_reasoning_effort") }
      : {}),
    ...(values.get("sandbox_mode") ? { sandboxMode: values.get("sandbox_mode") } : {}),
  };
}

export const listCodexAgents = Effect.fn("listCodexAgents")(function* (
  settings: ServerSettings,
  input: CodexAgentListInput,
): Effect.fn.Return<
  CodexAgentListResult,
  CodexAgentConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const codexSettings = resolveCodexSettings(settings, input.providerInstanceId);
  if (Schema.is(CodexAgentConfigError)(codexSettings)) {
    return yield* codexSettings;
  }
  const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
    Effect.mapError(toCodexAgentConfigError),
  );
  const agentsPath = path.join(layout.sharedHomePath, "agents");
  const agents = yield* listCodexAgentsFromPath(agentsPath);
  return {
    agentsPath,
    agents,
  };
});

export const listCodexAgentsFromPath = Effect.fn("listCodexAgentsFromPath")(function* (
  agentsPath: string,
): Effect.fn.Return<
  ReadonlyArray<CodexAgentSummary>,
  CodexAgentConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(agentsPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
    ),
    Effect.mapError(toCodexAgentConfigError),
  );
  const agents: CodexAgentSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".toml")) {
      continue;
    }
    const filePath = path.join(agentsPath, entry);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.catch(() => Effect.succeed("")),
      Effect.mapError(toCodexAgentConfigError),
    );
    const parsed = parseAgentToml(normalizeAgentId(entry.slice(0, -".toml".length)), filePath, raw);
    if (parsed) {
      agents.push(parsed);
    }
  }
  return agents.toSorted((left, right) => left.name.localeCompare(right.name));
});
