import { type ProviderCustomAgent, type ProviderInstanceId } from "@t3tools/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";

import type { CodexHomeLayout } from "./CodexHomeLayout.ts";

const LEGACY_MANAGED_AGENT_MARKER = "# Managed by T3 Code. Do not edit by hand.";

function managedAgentMarker(instanceId: ProviderInstanceId): string {
  return `# Managed by T3 Code for provider instance ${JSON.stringify(instanceId)}. Do not edit by hand.`;
}

export class CodexCustomAgentMaterializationError extends Schema.TaggedErrorClass<CodexCustomAgentMaterializationError>()(
  "CodexCustomAgentMaterializationError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function toMaterializationError(cause: unknown): CodexCustomAgentMaterializationError {
  return Schema.is(CodexCustomAgentMaterializationError)(cause)
    ? cause
    : new CodexCustomAgentMaterializationError({
        detail: "Failed to materialize Codex custom agents.",
        cause,
      });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: ReadonlyArray<string>): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function optionalTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function renderAgentToml(agent: ProviderCustomAgent, instanceId: ProviderInstanceId): string {
  const lines = [
    managedAgentMarker(instanceId),
    `name = ${tomlString(agent.name.trim())}`,
    ...(agent.description ? [`description = ${tomlString(agent.description.trim())}`] : []),
    `developer_instructions = ${tomlString(agent.instructions.trim())}`,
  ];

  const nicknameCandidates = (agent.nicknameCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
  if (nicknameCandidates.length > 0) {
    lines.push(`nickname_candidates = ${tomlStringArray(nicknameCandidates)}`);
  }

  const model = optionalTrimmed(agent.model);
  if (model) {
    lines.push(`model = ${tomlString(model)}`);
  }

  const reasoningEffort = optionalTrimmed(agent.reasoningEffort);
  if (reasoningEffort) {
    lines.push(`reasoning_effort = ${tomlString(reasoningEffort)}`);
  }

  const sandboxMode = optionalTrimmed(agent.sandboxMode);
  if (sandboxMode) {
    lines.push(`sandbox_mode = ${tomlString(sandboxMode)}`);
  }

  return `${lines.join("\n")}\n`;
}

function isActiveAgent(agent: ProviderCustomAgent): boolean {
  return (
    agent.enabled !== false &&
    agent.id.trim().length > 0 &&
    agent.name.trim().length > 0 &&
    agent.instructions.trim().length > 0
  );
}

export const materializeCodexCustomAgents = Effect.fn("materializeCodexCustomAgents")(function* (
  layout: CodexHomeLayout,
  instanceId: ProviderInstanceId,
  customAgents: ReadonlyArray<ProviderCustomAgent>,
): Effect.fn.Return<void, CodexCustomAgentMaterializationError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentsDirectory = path.join(layout.sharedHomePath, "agents");
  const activeAgents = customAgents.filter(isActiveAgent);
  const activeIds = new Set(activeAgents.map((agent) => agent.id.trim()));
  const ownerMarker = managedAgentMarker(instanceId);

  yield* fileSystem
    .makeDirectory(agentsDirectory, { recursive: true })
    .pipe(Effect.mapError((cause) => toMaterializationError(cause)));

  const existingEntries = yield* fileSystem.readDirectory(agentsDirectory).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
    ),
    Effect.mapError((cause) => toMaterializationError(cause)),
  );

  for (const entry of existingEntries) {
    if (!entry.endsWith(".toml")) {
      continue;
    }
    const id = entry.slice(0, -".toml".length);
    if (activeIds.has(id)) {
      continue;
    }
    const filePath = path.join(agentsDirectory, entry);
    const contents = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    if (contents.startsWith(ownerMarker)) {
      yield* fileSystem.remove(filePath).pipe(Effect.mapError(toMaterializationError));
    }
  }

  for (const agent of activeAgents) {
    const filePath = path.join(agentsDirectory, `${agent.id.trim()}.toml`);
    const existing = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    if (
      existing &&
      !existing.startsWith(LEGACY_MANAGED_AGENT_MARKER) &&
      !existing.startsWith(ownerMarker)
    ) {
      return yield* new CodexCustomAgentMaterializationError({
        detail: `Cannot write Codex custom agent '${agent.id}' because '${filePath}' already exists and is not managed by T3 Code.`,
      });
    }
    yield* fileSystem
      .writeFileString(filePath, renderAgentToml(agent, instanceId))
      .pipe(Effect.mapError((cause) => toMaterializationError(cause)));
  }
});
