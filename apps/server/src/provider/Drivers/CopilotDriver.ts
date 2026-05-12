/**
 * CopilotDriver — `ProviderDriver` for GitHub Copilot CLI over ACP.
 *
 * GitHub exposes Copilot CLI as an Agent Client Protocol server via
 * `copilot --acp --stdio`. The runtime path reuses the shared ACP adapter
 * machinery used by Cursor while binding provider identity, process launch,
 * status probing, and settings to Copilot-specific values.
 *
 * @module provider/Drivers/CopilotDriver
 */
import { CopilotSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeCopilotTextGeneration } from "../../textGeneration/CopilotTextGeneration.ts";
import { makeCopilotAcpRuntime } from "../acp/CopilotAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
} from "../Layers/CopilotProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { providerModelsWithCustomAgents, type ServerProviderDraft } from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type CopilotDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig;

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

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => Schema.decodeSync(CopilotSettings)({}),
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
      const processEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        ...(config.homePath ? { COPILOT_HOME: config.homePath } : {}),
      };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        customAgents,
      });
      const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;

      const adapter = yield* makeCursorAdapter(effectiveConfig, {
        providerKind: DRIVER_KIND,
        providerLabel: "Copilot",
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        makeRuntime: (input) =>
          makeCopilotAcpRuntime({
            copilotSettings: input.settings,
            ...(input.environment ? { environment: input.environment } : {}),
            childProcessSpawner: input.childProcessSpawner,
            cwd: input.cwd,
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
            clientInfo: input.clientInfo,
            ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
            ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
          }),
      });
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkCopilotProviderStatus(effectiveConfig, processEnv, {
        includeUsage: false,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<CopilotSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(buildInitialCopilotProviderSnapshot(settings)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Copilot snapshot: ${cause.message ?? String(cause)}`,
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
        customAgents,
      } satisfies ProviderInstance;
    }),
};
