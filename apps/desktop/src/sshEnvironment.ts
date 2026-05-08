import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@t3tools/shared/Net";
import type { DesktopDiscoveredSshHost, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import {
  SshPasswordPrompt,
  type SshPasswordPromptShape,
  type SshPasswordRequest,
} from "@t3tools/ssh/auth";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import { SshEnvironmentManager, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";

export { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";

interface DesktopSshEnvironmentManagerOptions {
  readonly passwordProvider?: (request: SshPasswordRequest) => Promise<string | null>;
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: () => RemoteT3RunnerOptions;
}

const sshRuntime = ManagedRuntime.make(
  Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
);

function createDesktopSshRuntime(
  passwordPrompt: SshPasswordPromptShape,
  scope: Scope.Scope,
  options: DesktopSshEnvironmentManagerOptions,
) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      NodeServices.layer,
      NodeHttpClient.layerUndici,
      NetService.layer,
      Layer.succeed(Scope.Scope, scope),
      Layer.succeed(SshPasswordPrompt, SshPasswordPrompt.of(passwordPrompt)),
      SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );
}

export async function discoverDesktopSshHosts(input?: {
  readonly homeDir?: string;
}): Promise<readonly DesktopDiscoveredSshHost[]> {
  return await sshRuntime.runPromise(discoverSshHosts(input ?? {}));
}

export class DesktopSshEnvironmentManager {
  private readonly runtime: ReturnType<typeof createDesktopSshRuntime>;
  private readonly scope: Scope.Scope;

  constructor(options: DesktopSshEnvironmentManagerOptions = {}) {
    const passwordPrompt: SshPasswordPromptShape = {
      isAvailable: options.passwordProvider !== undefined,
      request: (request) => {
        const passwordProvider = options.passwordProvider;
        if (!passwordProvider) {
          return Effect.succeed(null);
        }

        return Effect.tryPromise({
          try: () => passwordProvider(request),
          catch: (cause) =>
            new SshPasswordPromptError({
              message: cause instanceof Error ? cause.message : "SSH password prompt failed.",
              cause,
            }),
        });
      },
    };
    this.scope = Effect.runSync(Scope.make());
    this.runtime = createDesktopSshRuntime(passwordPrompt, this.scope, options);
  }

  async discoverHosts(): Promise<readonly DesktopDiscoveredSshHost[]> {
    return await discoverDesktopSshHosts();
  }

  async ensureEnvironment(
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) {
    return await this.runtime.runPromise(
      Effect.service(SshEnvironmentManager).pipe(
        Effect.flatMap((manager) => manager.ensureEnvironment(target, options)),
      ),
    );
  }

  async disconnectEnvironment(target: DesktopSshEnvironmentTarget): Promise<void> {
    await this.runtime.runPromise(
      Effect.service(SshEnvironmentManager).pipe(
        Effect.flatMap((manager) => manager.disconnectEnvironment(target)),
      ),
    );
  }

  async dispose(): Promise<void> {
    await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
    await this.runtime.dispose();
  }
}

export function isSshPasswordPromptCancellation(error: unknown): error is SshPasswordPromptError {
  const message = error instanceof SshPasswordPromptError ? error.message.toLowerCase() : "";
  return (
    error instanceof SshPasswordPromptError &&
    (message.includes("cancelled") || message.includes("timed out"))
  );
}
