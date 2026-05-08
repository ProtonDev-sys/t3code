import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ContextMenuItem,
  DesktopAppBranding,
  DesktopBridge,
  DesktopEnvironmentBootstrap,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshPasswordPromptRequest,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { showContextMenuFallback } from "./contextMenuFallback";
import { readHashParams } from "./urlHashParams";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "object"
  );
}

function readInjectedBootstrap(): DesktopEnvironmentBootstrap | null {
  const params = readHashParams(window.location.hash);
  const httpBaseUrl = params.get("t3DesktopHttpBaseUrl")?.trim() || null;
  const wsBaseUrl = params.get("t3DesktopWsBaseUrl")?.trim() || null;
  const label = params.get("t3DesktopLabel")?.trim() || "Local environment";
  const bootstrapToken = params.get("token")?.trim() || "";
  if (!httpBaseUrl || !wsBaseUrl) {
    return null;
  }
  return {
    label,
    httpBaseUrl,
    wsBaseUrl,
    ...(bootstrapToken ? { bootstrapToken } : {}),
  };
}

function readInjectedBranding(): DesktopAppBranding {
  const stageLabel = import.meta.env.DEV ? "Dev" : "Alpha";
  return {
    baseName: "T3 Code",
    stageLabel,
    displayName: `T3 Code (${stageLabel})`,
  };
}

function safeHttpUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function tauriCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

async function fetchJson<T>(
  httpBaseUrl: string,
  pathname: string,
  options?: {
    readonly bearerToken?: string;
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
  },
): Promise<T> {
  const url = new URL(pathname, httpBaseUrl);
  const requestInit: RequestInit = {
    headers: {
      ...(options?.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    method: options?.method ?? "GET",
  };
  if (options?.body !== undefined) {
    requestInit.body = JSON.stringify(options.body);
  }
  const response = await fetch(url.toString(), requestInit);
  if (!response.ok) {
    throw new Error((await response.text()) || `Desktop request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function listenDesktopEvent<T>(eventName: string, listener: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void listen<T>(eventName, (event) => {
    listener(event.payload);
  }).then((nextUnlisten) => {
    if (disposed) {
      nextUnlisten();
      return;
    }
    unlisten = nextUnlisten;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

function unwrapEnsureSshEnvironmentResult(result: unknown): DesktopSshEnvironmentBootstrap {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === "ssh-password-prompt-cancelled"
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }

  return result as DesktopSshEnvironmentBootstrap;
}

function installTauriDesktopBridge(): void {
  if (!isTauriRuntime() || window.desktopBridge) {
    return;
  }

  const injectedBootstrap = readInjectedBootstrap();

  window.desktopBridge = {
    getAppBranding: () => readInjectedBranding(),
    getLocalEnvironmentBootstrap: () => injectedBootstrap,
    getClientSettings: () =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["getClientSettings"]>>>("get_client_settings"),
    setClientSettings: (settings) => tauriCommand<void>("set_client_settings", { settings }),
    getSavedEnvironmentRegistry: () =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["getSavedEnvironmentRegistry"]>>>(
        "get_saved_environment_registry",
      ),
    setSavedEnvironmentRegistry: (records) =>
      tauriCommand<void>("set_saved_environment_registry", { records }),
    getSavedEnvironmentSecret: (environmentId) =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["getSavedEnvironmentSecret"]>>>(
        "get_saved_environment_secret",
        { environmentId },
      ),
    setSavedEnvironmentSecret: (environmentId, secret) =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["setSavedEnvironmentSecret"]>>>(
        "set_saved_environment_secret",
        { environmentId, secret },
      ),
    removeSavedEnvironmentSecret: (environmentId) =>
      tauriCommand<void>("remove_saved_environment_secret", { environmentId }),
    discoverSshHosts: () =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["discoverSshHosts"]>>>("discover_ssh_hosts"),
    ensureSshEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { issuePairingToken?: boolean },
    ) =>
      tauriCommand<unknown>("ensure_ssh_environment", { target, options }).then(
        unwrapEnsureSshEnvironmentResult,
      ),
    disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) =>
      tauriCommand<void>("disconnect_ssh_environment", { target }),
    fetchSshEnvironmentDescriptor: (httpBaseUrl: string) =>
      fetchJson<ExecutionEnvironmentDescriptor>(httpBaseUrl, "/.well-known/t3/environment"),
    bootstrapSshBearerSession: (httpBaseUrl: string, credential: string) =>
      fetchJson<AuthBearerBootstrapResult>(httpBaseUrl, "/api/auth/bootstrap/bearer", {
        body: { credential },
        method: "POST",
      }),
    fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) =>
      fetchJson<AuthSessionState>(httpBaseUrl, "/api/auth/session", { bearerToken }),
    issueSshWebSocketToken: (httpBaseUrl: string, bearerToken: string) =>
      fetchJson<AuthWebSocketTokenResult>(httpBaseUrl, "/api/auth/ws-token", {
        bearerToken,
        method: "POST",
      }),
    onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) =>
      listenDesktopEvent("desktop:ssh-password-prompt", listener),
    resolveSshPasswordPrompt: (requestId, password) =>
      tauriCommand<void>("resolve_ssh_password_prompt", { requestId, password }),
    getServerExposureState: () =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>>(
        "get_server_exposure_state",
      ),
    setServerExposureMode: (mode) =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["setServerExposureMode"]>>>(
        "set_server_exposure_mode",
        { mode },
      ),
    setTailscaleServeEnabled: (input) =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["setTailscaleServeEnabled"]>>>(
        "set_tailscale_serve_enabled",
        { input },
      ),
    getAdvertisedEndpoints: () =>
      tauriCommand<Awaited<ReturnType<DesktopBridge["getAdvertisedEndpoints"]>>>(
        "get_advertised_endpoints",
      ),
    pickFolder: async (options) => {
      const dialogOptions = {
        directory: true,
        multiple: false,
        ...(options?.initialPath ? { defaultPath: options.initialPath } : {}),
      } as const;
      const selected = await openDialog(dialogOptions);
      return typeof selected === "string" ? selected : null;
    },
    confirm: (message) => confirmDialog(message, { title: "T3 Code" }),
    setTheme: (theme: DesktopTheme) => tauriCommand<void>("set_theme", { theme }),
    showContextMenu: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => showContextMenuFallback(items, position),
    openExternal: async (url) => {
      const externalUrl = safeHttpUrl(url);
      if (!externalUrl) {
        return false;
      }
      await openUrl(externalUrl);
      return true;
    },
    onMenuAction: () => () => undefined,
    getUpdateState: () => tauriCommand<DesktopUpdateState>("get_update_state"),
    setUpdateChannel: (channel: DesktopUpdateChannel) =>
      tauriCommand<DesktopUpdateState>("set_update_channel", { channel }),
    checkForUpdate: () => tauriCommand<DesktopUpdateCheckResult>("check_for_update"),
    downloadUpdate: () => tauriCommand<DesktopUpdateActionResult>("download_update"),
    installUpdate: () => tauriCommand<DesktopUpdateActionResult>("install_update"),
    onUpdateState: (listener: (state: DesktopUpdateState) => void) =>
      listenDesktopEvent("desktop:update-state", listener),
  } satisfies DesktopBridge;
}

installTauriDesktopBridge();
