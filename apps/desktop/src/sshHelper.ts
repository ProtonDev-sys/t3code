import * as Crypto from "node:crypto";
import * as Readline from "node:readline";

import type {
  DesktopSshEnvironmentTarget,
  DesktopSshPasswordPromptRequest,
} from "@t3tools/contracts";
import type { SshPasswordRequest } from "@t3tools/ssh/auth";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

import {
  DesktopSshEnvironmentManager,
  isSshPasswordPromptCancellation,
  resolveRemoteT3CliPackageSpec,
} from "./sshEnvironment.ts";

const SSH_PASSWORD_PROMPT_EVENT = "desktop:ssh-password-prompt";
const SSH_PASSWORD_PROMPT_CANCELLED_RESULT = "ssh-password-prompt-cancelled";
const DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS = 3 * 60 * 1000;

interface HelperRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface PendingSshPasswordPrompt {
  readonly resolve: (password: string | null) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const pendingPrompts = new Map<string, PendingSshPasswordPrompt>();
const inFlightRequests = new Set<Promise<void>>();
let shutdownStarted = false;

function writeProtocol(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResponse(id: number, result: unknown): void {
  writeProtocol({
    kind: "response",
    id,
    ok: true,
    result,
  });
}

function writeErrorResponse(id: number, error: unknown): void {
  writeProtocol({
    kind: "response",
    id,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function emitEvent(event: string, payload: unknown): void {
  writeProtocol({
    kind: "event",
    event,
    payload,
  });
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readTarget(value: unknown): DesktopSshEnvironmentTarget {
  const target = readObject(value);
  const alias = typeof target.alias === "string" ? target.alias.trim() : "";
  const hostname = typeof target.hostname === "string" ? target.hostname.trim() : "";
  const username = typeof target.username === "string" ? target.username.trim() || null : null;
  const port = Number.isInteger(target.port) ? (target.port as number) : null;

  if (!alias || !hostname) {
    throw new Error("Invalid desktop SSH target.");
  }

  return {
    alias,
    hostname,
    username,
    port,
  };
}

function readEnsureOptions(value: unknown): { issuePairingToken?: boolean } | undefined {
  const options = readObject(value);
  return options.issuePairingToken === true ? { issuePairingToken: true } : undefined;
}

function resolveCliRunner(): RemoteT3RunnerOptions {
  const devRemoteEntryPath = process.env.T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH?.trim() ?? "";
  const isDevelopment = process.env.T3CODE_DESKTOP_IS_DEV === "1";
  if (isDevelopment && devRemoteEntryPath.length > 0) {
    return { nodeScriptPath: devRemoteEntryPath };
  }

  return {
    packageSpec: resolveRemoteT3CliPackageSpec({
      appVersion: process.env.T3CODE_DESKTOP_APP_VERSION?.trim() || "0.0.0",
      updateChannel: process.env.T3CODE_DESKTOP_UPDATE_CHANNEL === "nightly" ? "nightly" : "latest",
      isDevelopment,
    }),
  };
}

async function requestPasswordFromRenderer(input: SshPasswordRequest): Promise<string | null> {
  const request: DesktopSshPasswordPromptRequest = {
    requestId: Crypto.randomUUID(),
    destination: input.destination,
    username: input.username,
    prompt: input.prompt,
    expiresAt: new Date(Date.now() + DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS).toISOString(),
  };

  return await new Promise<string | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPrompts.delete(request.requestId);
      reject(new Error(`SSH authentication timed out for ${input.destination}.`));
    }, DEFAULT_SSH_PASSWORD_PROMPT_TIMEOUT_MS);
    timeout.unref();

    pendingPrompts.set(request.requestId, { resolve, reject, timeout });
    emitEvent(SSH_PASSWORD_PROMPT_EVENT, request);
  });
}

const manager = new DesktopSshEnvironmentManager({
  passwordProvider: requestPasswordFromRenderer,
  resolveCliRunner,
});

async function handleRequest(request: HelperRequest): Promise<unknown> {
  const params = readObject(request.params);

  switch (request.method) {
    case "discoverSshHosts":
      return await manager.discoverHosts();

    case "ensureSshEnvironment":
      try {
        return await manager.ensureEnvironment(
          readTarget(params.target),
          readEnsureOptions(params.options),
        );
      } catch (error) {
        if (isSshPasswordPromptCancellation(error)) {
          return {
            type: SSH_PASSWORD_PROMPT_CANCELLED_RESULT,
            message: error.message,
          };
        }
        throw error;
      }

    case "disconnectSshEnvironment":
      await manager.disconnectEnvironment(readTarget(params.target));
      return null;

    case "resolveSshPasswordPrompt": {
      const requestId = typeof params.requestId === "string" ? params.requestId.trim() : "";
      const password =
        typeof params.password === "string"
          ? params.password
          : params.password === null
            ? null
            : undefined;
      if (!requestId || password === undefined) {
        throw new Error("Invalid SSH password prompt response.");
      }

      const pending = pendingPrompts.get(requestId);
      if (!pending) {
        throw new Error("SSH password prompt expired. Try connecting again.");
      }

      clearTimeout(pending.timeout);
      pendingPrompts.delete(requestId);
      pending.resolve(password);
      return null;
    }

    case "dispose":
      await manager.dispose();
      return null;

    default:
      throw new Error(`Unknown SSH helper method '${request.method}'.`);
  }
}

function cancelPendingPrompts(reason: string): void {
  for (const [requestId, pending] of pendingPrompts) {
    clearTimeout(pending.timeout);
    pendingPrompts.delete(requestId);
    pending.reject(new Error(reason));
  }
}

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  cancelPendingPrompts(reason);
  await Promise.race([
    Promise.allSettled(inFlightRequests),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await manager.dispose();
  process.exit(exitCode);
}

const readline = Readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

readline.on("line", (line) => {
  const requestPromise = (async () => {
    let request: HelperRequest;
    try {
      request = JSON.parse(line) as HelperRequest;
      if (!Number.isInteger(request.id) || typeof request.method !== "string") {
        throw new Error("Invalid SSH helper request.");
      }
    } catch (error) {
      process.stderr.write(
        `[desktop-ssh-helper] ignored invalid request: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return;
    }

    try {
      writeResponse(request.id, await handleRequest(request));
    } catch (error) {
      writeErrorResponse(request.id, error);
    }
  })();
  inFlightRequests.add(requestPromise);
  void requestPromise.finally(() => {
    inFlightRequests.delete(requestPromise);
  });
});

readline.on("close", () => {
  void shutdown("SSH helper input closed.", 0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(`SSH helper received ${signal}.`, 0);
  });
}
