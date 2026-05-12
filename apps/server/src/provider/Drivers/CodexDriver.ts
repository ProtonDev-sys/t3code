/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ServerProviderShape` for this instance;
 *   - `adapter`    — the Codex session/turn/approval runtime;
 *   - `textGeneration` — commit/PR/branch/title generation via `codex exec`.
 *
 * Each call to `create()` captures the `codexConfig` argument in closures
 * owned by the returned instance. Two instances created with different
 * `homePath`s (e.g. `codex_personal` + `codex_work`) therefore run with
 * fully independent Codex app-server processes and `CODEX_HOME`
 * environments — no shared mutable state.
 *
 * Resource lifecycle: `create()` runs in a scope handed in by the registry.
 * Closing that scope releases the adapter's child processes, the managed
 * snapshot's refresh fibre, and the text-generation binaries' transient
 * scratch files. The registry uses this to tear down an instance when its
 * `providerInstances` entry disappears or its config changes.
 *
 * @module provider/Drivers/CodexDriver
 */
import {
  CodexSettings,
  ProviderCustomAgentId,
  ProviderDriverKind,
  type CodexAgentSummary,
  type ProviderCustomAgent,
  type ServerProvider,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { listCodexAgentsFromPath } from "../../codexAgentsConfig.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { providerModelsWithCustomAgents, type ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { materializeCodexCustomAgents } from "./CodexCustomAgents.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

function providerCustomAgentFromCodexAgent(agent: CodexAgentSummary): ProviderCustomAgent {
  return {
    id: ProviderCustomAgentId.make(agent.id),
    name: agent.name,
    instructions: agent.instructions,
    enabled: true,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.nicknameCandidates?.length ? { nicknameCandidates: agent.nicknameCandidates } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    ...(agent.sandboxMode ? { sandboxMode: agent.sandboxMode } : {}),
  };
}

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly customAgents: ProviderInstance["customAgents"];
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    models: providerModelsWithCustomAgents({
      models: snapshot.models,
      customAgents: input.customAgents,
    }),
  });

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => Schema.decodeSync(CodexSettings)({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    mcpEnabled,
    customAgents,
    config,
  }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const homeLayout = yield* resolveCodexHomeLayout(config);
      const path = yield* Path.Path;
      yield* materializeCodexCustomAgents(homeLayout, instanceId, customAgents).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const configuredCustomAgentIds = new Set(customAgents.map((agent) => String(agent.id)));
      const effectiveCustomAgents = yield* listCodexAgentsFromPath(
        path.join(homeLayout.sharedHomePath, "agents"),
      ).pipe(
        Effect.map((agents) =>
          agents
            .filter((agent) => {
              if (!agent.managed) {
                return true;
              }
              if (agent.managedProviderInstanceId) {
                return String(agent.managedProviderInstanceId) === String(instanceId);
              }
              return configuredCustomAgentIds.has(String(agent.id));
            })
            .map(providerCustomAgentFromCodexAgent),
        ),
        Effect.catch(() => Effect.succeed(customAgents)),
      );
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        customAgents: effectiveCustomAgents,
      });
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const effectiveConfig = {
        ...config,
        enabled,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;

      // `makeCodexAdapter` and `makeCodexTextGeneration` have `never` error
      // channels at construction time — their failure modes are all on the
      // per-operation closures they return. No `mapError` wrapper is needed
      // here; the registry only has to worry about snapshot-build and
      // spawner-availability failures surfaced from `checkCodexProviderStatus`
      // below.
      const adapter = yield* makeCodexAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        mcpEnabled,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, processEnv);

      // Build a managed snapshot whose settings never change — mutations come
      // in as instance rebuilds from the registry rather than in-place
      // updates. Pre-provide `ChildProcessSpawner` so the check fits
      // `makeManagedServerProvider.checkProvider`'s `R = never`.
      const checkProvider = checkCodexProviderStatus(effectiveConfig, undefined, processEnv, {
        includeUsage: false,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<CodexSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingCodexProvider(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        mcpEnabled,
        customAgents: effectiveCustomAgents,
      } satisfies ProviderInstance;
    }),
};
