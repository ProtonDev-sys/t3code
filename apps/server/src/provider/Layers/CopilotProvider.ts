import {
  ProviderDriverKind,
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import { Cause, Effect, Exit, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeCopilotAcpRuntime } from "../acp/CopilotAcpSupport.ts";
import { buildCursorDiscoveredModelsFromConfigOptions } from "./CursorProvider.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_PRESENTATION = {
  displayName: "Copilot",
  badgeLabel: "Preview",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 8_000;

export function buildInitialCopilotProviderSnapshot(
  copilotSettings: CopilotSettings,
): ServerProviderDraft {
  const checkedAt = new Date().toISOString();
  const models = getCopilotFallbackModels(copilotSettings);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot CLI is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot CLI availability...",
    },
  });
}

function mergeCopilotMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildCopilotProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly copilotSettings: CopilotSettings;
  readonly parsed: CopilotProbeResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProviderDraft {
  const message = mergeCopilotMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: input.copilotSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.copilotSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

export interface CopilotProbeResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function parseCopilotVersionOutput(result: CommandResult): CopilotProbeResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const lower = combined.toLowerCase();
  const version = parseGenericCliVersion(combined);

  if (lower.includes("login") && lower.includes("copilot")) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Copilot CLI is not authenticated. Run `copilot login` and try again.",
    };
  }

  return {
    version,
    status: result.code === 0 ? "ready" : "warning",
    auth: { status: "unknown" },
    ...(result.code === 0
      ? {}
      : { message: "Could not verify Copilot CLI version. Check server logs for details." }),
  };
}

function formatCopilotAcpDiscoveryFailure(cause: Cause.Cause<unknown>): {
  readonly auth: ServerProviderAuth;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly message: string;
} {
  const pretty = Cause.pretty(cause);
  const lower = pretty.toLowerCase();
  if (
    lower.includes("auth") ||
    lower.includes("login") ||
    lower.includes("token") ||
    lower.includes("credential")
  ) {
    return {
      auth: { status: "unauthenticated" },
      status: "error",
      message: "Copilot CLI is not authenticated. Run `copilot login` and try again.",
    };
  }
  return {
    auth: { status: "unknown" },
    status: "warning",
    message: "Copilot ACP model discovery failed. Check server logs for details.",
  };
}

const runCopilotCommand = (
  copilotSettings: CopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(copilotSettings.binaryPath, [...args], {
        env: environment,
        shell: process.platform === "win32",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const discoverCopilotModelsViaAcp = (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeCopilotAcpRuntime({
      copilotSettings,
      childProcessSpawner,
      cwd: process.cwd(),
      environment,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    return buildCursorDiscoveredModelsFromConfigOptions(
      started.sessionSetupResult.configOptions ?? [],
    );
  }).pipe(Effect.scoped);

export function getCopilotFallbackModels(
  copilotSettings: Pick<CopilotSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [{ slug: "auto", name: "Auto", capabilities: EMPTY_CAPABILITIES, isCustom: false }],
    PROVIDER,
    copilotSettings.customModels,
    EMPTY_CAPABILITIES,
  );
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = new Date().toISOString();
  const fallbackModels = getCopilotFallbackModels(copilotSettings);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Copilot CLI is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runCopilotCommand(copilotSettings, ["version"], environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Copilot CLI (`copilot`) is not installed or not on PATH."
          : `Failed to execute Copilot CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Copilot CLI is installed but timed out while running `copilot version`.",
      },
    });
  }

  let parsed = parseCopilotVersionOutput(versionProbe.success.value);
  let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
  let discoveryWarning: string | undefined;
  if (parsed.auth.status !== "unauthenticated") {
    const discoveryExit = yield* Effect.exit(
      discoverCopilotModelsViaAcp(copilotSettings, environment).pipe(
        Effect.timeoutOption(COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
      ),
    );
    if (Exit.isFailure(discoveryExit)) {
      yield* Effect.logWarning("Copilot ACP model discovery failed", {
        cause: Cause.pretty(discoveryExit.cause),
      });
      const formatted = formatCopilotAcpDiscoveryFailure(discoveryExit.cause);
      parsed = {
        ...parsed,
        status: formatted.status,
        auth: formatted.auth,
      };
      discoveryWarning = formatted.message;
    } else if (Option.isNone(discoveryExit.value)) {
      discoveryWarning = `Copilot ACP model discovery timed out after ${COPILOT_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
    } else if (discoveryExit.value.value.length === 0) {
      discoveryWarning = "Copilot ACP model discovery returned no built-in models.";
    } else {
      discoveredModels = discoveryExit.value;
    }
  }

  return buildCopilotProviderSnapshot({
    checkedAt,
    copilotSettings,
    parsed,
    discoveredModels: Option.getOrElse(
      Option.filter(discoveredModels, (models) => models.length > 0),
      () => fallbackModels,
    ),
    ...(discoveryWarning ? { discoveryWarning } : {}),
  });
});
