import { useEffect, useEffectEvent, useRef } from "react";
import type { CliUpdateState, ServerProvider } from "@t3tools/contracts";

import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import {
  getCachedCodexCliLatestVersion,
  getLatestCodexCliVersion,
  resolveOutdatedCodexCliStatuses,
} from "../lib/codexCliVersion";
import { setCliUpdateUiState } from "../lib/cliUpdateUiState";
import { useServerConfig } from "../rpc/serverState";
import { stackedThreadToast, toastManager } from "./ui/toast";

const startedCodexCliAutoUpdateKeys = new Set<string>();

function cliUpdateKey(state: Pick<CliUpdateState, "providerInstanceId" | "targetVersion">) {
  return `${state.providerInstanceId}:${state.targetVersion ?? "latest"}`;
}

function providerUpdateKey(provider: ServerProvider, latestVersion: string) {
  return `${provider.instanceId}:${provider.version ?? "unknown"}->${latestVersion}`;
}

function formatVersionRange(state: CliUpdateState): string {
  if (state.currentVersion && state.targetVersion) {
    return `${state.currentVersion} to ${state.targetVersion}`;
  }
  if (state.targetVersion) {
    return state.targetVersion;
  }
  return "latest";
}

export function CodexCliAutoUpdateCoordinator() {
  const serverConfig = useServerConfig();
  const providerStatuses = serverConfig?.providers;
  const toastIdsRef = useRef(new Map<string, ReturnType<typeof toastManager.add>>());

  const handleState = useEffectEvent((state: CliUpdateState) => {
    setCliUpdateUiState(state);
    const key = cliUpdateKey(state);
    const existingToastId = toastIdsRef.current.get(key);
    const providerLabel = state.displayName ?? "Codex CLI";

    const toastPayload =
      state.status === "running"
        ? stackedThreadToast({
            type: "loading",
            title: `Updating ${providerLabel}`,
            description: `Running in the background (${formatVersionRange(state)}).`,
            timeout: 0,
            data: {
              hideCopyButton: true,
            },
          })
        : state.status === "succeeded"
          ? stackedThreadToast({
              type: "success",
              title: `${providerLabel} updated`,
              description: `Finished updating ${formatVersionRange(state)}.`,
              data: {
                dismissAfterVisibleMs: 8_000,
                hideCopyButton: true,
              },
            })
          : stackedThreadToast({
              type: "error",
              title: `${providerLabel} update failed`,
              description: state.message ?? "The background update failed.",
              timeout: 0,
            });

    if (existingToastId) {
      toastManager.update(existingToastId, toastPayload);
      return;
    }
    toastIdsRef.current.set(key, toastManager.add(toastPayload));
  });

  useEffect(() => {
    return getPrimaryEnvironmentConnection().client.server.cliUpdates.subscribe((event) => {
      handleState(event.state);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startOutdatedCodexUpdates = async () => {
      if (!providerStatuses) return;
      const latestVersion =
        getCachedCodexCliLatestVersion() === undefined
          ? await getLatestCodexCliVersion()
          : getCachedCodexCliLatestVersion();
      if (cancelled || !latestVersion) return;

      const outdatedProviders = resolveOutdatedCodexCliStatuses({
        latestVersion,
        providerStatuses,
      });

      for (const provider of outdatedProviders) {
        const updateKey = providerUpdateKey(provider, latestVersion);
        if (startedCodexCliAutoUpdateKeys.has(updateKey)) {
          continue;
        }
        startedCodexCliAutoUpdateKeys.add(updateKey);
        getPrimaryEnvironmentConnection()
          .client.server.cliUpdates.startCodex({
            providerInstanceId: provider.instanceId,
            currentVersion: provider.version,
            targetVersion: latestVersion,
          })
          .then((result) => {
            handleState(result.state);
          })
          .catch((error) => {
            startedCodexCliAutoUpdateKeys.delete(updateKey);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not start Codex CLI update",
                description:
                  error instanceof Error ? error.message : "The background update could not start.",
              }),
            );
          });
      }
    };

    void startOutdatedCodexUpdates();
    return () => {
      cancelled = true;
    };
  }, [providerStatuses]);

  return null;
}
