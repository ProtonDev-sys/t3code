import {
  ProviderDriverKind,
  type CopilotSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderState,
} from "@t3tools/contracts";
import { spawn as spawnNodeChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { buildCopilotProviderUsage } from "../copilotUsage.ts";
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
const COPILOT_QUOTA_TIMEOUT_MS = 20_000;
const COPILOT_QUOTA_CACHE_TTL_MS = 30 * 60_000;

let copilotQuotaCache:
  | {
      readonly updatedAtMs: number;
      readonly quotaSnapshots: unknown;
    }
  | undefined;

const ignoreCopilotQuotaStderr = () => undefined;

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
      ...(input.parsed.usage ? { usage: input.parsed.usage } : {}),
    },
  });
}

export interface CopilotProbeResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
  readonly usage?: ServerProviderDraft["usage"];
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

interface JsonRpcMessage {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

function encodeJsonRpcRequest(id: number, method: string, params?: unknown): string {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readContentLength(header: string): number | null {
  const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const JSON_RPC_HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

function takeJsonRpcMessages(buffer: Buffer<ArrayBufferLike>): {
  readonly messages: ReadonlyArray<JsonRpcMessage>;
  readonly remaining: Buffer<ArrayBufferLike>;
} {
  const messages: JsonRpcMessage[] = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf(JSON_RPC_HEADER_SEPARATOR);
    if (headerEnd < 0) {
      break;
    }
    const header = remaining.subarray(0, headerEnd).toString("ascii");
    const contentLength = readContentLength(header);
    if (contentLength === null) {
      break;
    }
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (remaining.length < bodyEnd) {
      break;
    }
    const body = remaining.subarray(bodyStart, bodyEnd);
    remaining = remaining.subarray(bodyEnd);
    try {
      const parsed = JSON.parse(body.toString("utf8")) as JsonRpcMessage;
      messages.push(parsed);
    } catch {
      continue;
    }
  }

  return { messages, remaining };
}

function readQuotaSnapshotsFromResult(result: unknown): unknown | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const quotaSnapshots = (result as { readonly quotaSnapshots?: unknown }).quotaSnapshots;
  return quotaSnapshots && typeof quotaSnapshots === "object" && !Array.isArray(quotaSnapshots)
    ? quotaSnapshots
    : null;
}

function hasQuotaSnapshots(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0,
  );
}

function readQuotaSnapshotsFromSessionEvent(message: JsonRpcMessage): unknown | null {
  if (message.method !== "session.event") {
    return null;
  }
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const event = (params as { readonly event?: unknown }).event;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const record = event as {
    readonly type?: unknown;
    readonly data?: unknown;
  };
  if (record.type !== "assistant.usage") {
    return null;
  }
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const quotaSnapshots = (data as { readonly quotaSnapshots?: unknown }).quotaSnapshots;
  return hasQuotaSnapshots(quotaSnapshots) ? quotaSnapshots : null;
}

function writeCopilotQuotaProbeCreateRequest(
  child: ReturnType<typeof spawnNodeChildProcess>,
): string | null {
  const stdin = child.stdin;
  if (!stdin) {
    return null;
  }
  const sessionId = randomUUID();
  stdin.write(
    encodeJsonRpcRequest(3, "session.create", {
      sessionId,
      workingDirectory: process.cwd(),
      model: "auto",
      streaming: false,
      availableTools: [],
      clientName: "t3-code-quota-probe",
    }),
  );
  return sessionId;
}

function writeCopilotQuotaProbeSendRequest(
  child: ReturnType<typeof spawnNodeChildProcess>,
  sessionId: string,
): void {
  const stdin = child.stdin;
  if (!stdin) {
    return;
  }
  stdin.write(
    encodeJsonRpcRequest(4, "session.send", {
      sessionId,
      prompt: "Reply with exactly: ok",
    }),
  );
}

async function fetchCopilotQuotaSnapshotsViaJsonRpc(
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown | null> {
  const now = Date.now();
  if (
    copilotQuotaCache &&
    now - copilotQuotaCache.updatedAtMs <= COPILOT_QUOTA_CACHE_TTL_MS &&
    hasQuotaSnapshots(copilotQuotaCache.quotaSnapshots)
  ) {
    return copilotQuotaCache.quotaSnapshots;
  }

  return await new Promise((resolve, reject) => {
    const child = spawnNodeChildProcess(
      copilotSettings.binaryPath || "copilot",
      ["--server", "--stdio", "--log-level", "none", "--disable-builtin-mcps"],
      {
        env: environment,
        shell: process.platform === "win32",
        windowsHide: true,
      },
    );
    let settled = false;
    let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let probeStarted = false;
    let probeSessionId: string | null = null;

    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", ignoreCopilotQuotaStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!child.killed) {
        child.kill();
      }
    };
    const settle = (value: unknown | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (hasQuotaSnapshots(value)) {
        copilotQuotaCache = {
          updatedAtMs: Date.now(),
          quotaSnapshots: value,
        };
      }
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    timeout = setTimeout(() => {
      settle(null);
    }, COPILOT_QUOTA_TIMEOUT_MS);

    const onStdout = (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      const parsed = takeJsonRpcMessages(stdoutBuffer);
      stdoutBuffer = parsed.remaining;
      for (const message of parsed.messages) {
        const eventQuotaSnapshots = readQuotaSnapshotsFromSessionEvent(message);
        if (eventQuotaSnapshots) {
          settle(eventQuotaSnapshots);
          return;
        }

        if (message.id !== 2) {
          if (message.id === 3 && probeSessionId) {
            writeCopilotQuotaProbeSendRequest(child, probeSessionId);
            continue;
          }
          if (message.id === 4 && message.error !== undefined) {
            settle(null);
            return;
          }
          continue;
        }
        if (message.error !== undefined) {
          if (!probeStarted) {
            probeStarted = true;
            probeSessionId = writeCopilotQuotaProbeCreateRequest(child);
            continue;
          }
          settle(null);
          return;
        }
        const quotaSnapshots = readQuotaSnapshotsFromResult(message.result);
        if (hasQuotaSnapshots(quotaSnapshots)) {
          settle(quotaSnapshots);
          return;
        }
        if (!probeStarted) {
          probeStarted = true;
          probeSessionId = writeCopilotQuotaProbeCreateRequest(child);
          continue;
        }
        settle(null);
        return;
      }
    };
    const onError = (error: Error) => fail(error);
    const onExit = () => settle(null);

    child.stdout.on("data", onStdout);
    child.stderr.on("data", ignoreCopilotQuotaStderr);
    child.on("error", onError);
    child.on("exit", onExit);
    const stdin = child.stdin;
    if (!stdin) {
      fail(new Error("Copilot JSON-RPC process did not expose stdin."));
      return;
    }
    stdin.write(encodeJsonRpcRequest(1, "connect", { protocolVersion: 3 }));
    stdin.write(encodeJsonRpcRequest(2, "account.getQuota", {}));
  });
}

const fetchCopilotQuotaUsage = (
  copilotSettings: CopilotSettings,
  checkedAt: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.promise(async () => {
    try {
      const quotaSnapshots = await fetchCopilotQuotaSnapshotsViaJsonRpc(
        copilotSettings,
        environment,
      );
      return quotaSnapshots ? buildCopilotProviderUsage({ checkedAt, quotaSnapshots }) : undefined;
    } catch {
      return undefined;
    }
  });

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
    const usage = yield* fetchCopilotQuotaUsage(copilotSettings, checkedAt, environment);
    if (usage) {
      parsed = { ...parsed, usage };
    }

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
