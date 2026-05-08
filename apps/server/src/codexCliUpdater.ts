import { spawn } from "node:child_process";

import {
  CliUpdateError,
  CodexSettings,
  ProviderDriverKind,
  type CliUpdateStartInput,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { expandHomePath } from "./pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "./provider/ProviderInstanceEnvironment.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const OUTPUT_LIMIT = 8_000;

export interface CodexCliUpdateLaunch {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly displayName: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface CodexCliUpdateRunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function detail(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : "Unknown Codex CLI update error.";
}

function decodeCodexSettings(config: unknown): CodexSettings {
  return Schema.decodeUnknownSync(CodexSettings)(config ?? {});
}

function getCodexInstanceSettings(
  settings: ServerSettings,
  providerInstanceId: ProviderInstanceId,
): {
  readonly config: CodexSettings;
  readonly displayName: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
} {
  const instance = settings.providerInstances[providerInstanceId];
  if (!instance && String(providerInstanceId) === "codex") {
    return {
      config: settings.providers.codex,
      displayName: undefined,
      environment: process.env,
    };
  }
  if (!instance) {
    throw new CliUpdateError({
      detail: `Provider instance '${providerInstanceId}' was not found.`,
    });
  }
  if (instance.driver !== CODEX_DRIVER_KIND) {
    throw new CliUpdateError({
      detail: `Provider instance '${providerInstanceId}' is not a Codex instance.`,
    });
  }
  return {
    config: decodeCodexSettings(instance.config),
    displayName: instance.displayName,
    environment: mergeProviderInstanceEnvironment(instance.environment),
  };
}

function withCodexHomeEnv(env: NodeJS.ProcessEnv, config: CodexSettings): NodeJS.ProcessEnv {
  const homePath = config.shadowHomePath.trim() || config.homePath.trim();
  if (!homePath) {
    return env;
  }
  return {
    ...env,
    CODEX_HOME: expandHomePath(homePath),
  };
}

export function resolveCodexCliUpdateLaunch(
  settings: ServerSettings,
  input: CliUpdateStartInput,
): CodexCliUpdateLaunch {
  try {
    const resolved = getCodexInstanceSettings(settings, input.providerInstanceId);
    return {
      binaryPath: resolved.config.binaryPath,
      cwd: process.cwd(),
      displayName: resolved.displayName,
      env: withCodexHomeEnv(resolved.environment, resolved.config),
    };
  } catch (error) {
    if (Schema.is(CliUpdateError)(error)) {
      throw error;
    }
    throw new CliUpdateError({
      detail: `Unable to resolve Codex CLI update settings: ${detail(error)}`,
    });
  }
}

function appendLimited(buffer: string, chunk: Buffer | string): string {
  const next = `${buffer}${chunk.toString()}`;
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

export function runCodexCliUpdate(launch: CodexCliUpdateLaunch): Promise<CodexCliUpdateRunResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(launch.binaryPath, ["update"], {
      cwd: launch.cwd,
      env: launch.env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", (error) => {
      reject(
        new CliUpdateError({
          detail: `Failed to start Codex CLI update: ${detail(error)}`,
        }),
      );
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
