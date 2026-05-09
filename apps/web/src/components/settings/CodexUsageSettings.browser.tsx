import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import { CodexUsageSettingsPanel } from "./CodexUsageSettings";

function makeCodexProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.74.0",
    status: "ready",
    auth: {
      status: "authenticated",
      label: "OpenAI",
    },
    checkedAt: "2026-05-09T20:17:35.530Z",
    usage: {
      checkedAt: "2026-05-09T20:17:35.530Z",
      rateLimits: {
        rateLimitsByLimitId: {
          codex: {
            credits: null,
            limitId: "codex",
            limitName: "Codex",
            planType: "plus",
            primary: {
              resetsAt: 1778376068,
              usedPercent: 2,
              windowDurationMins: 300,
            },
            rateLimitReachedType: null,
            secondary: {
              resetsAt: 1778457600,
              usedPercent: 64,
              windowDurationMins: 10080,
            },
          },
        },
      },
    },
    models: [],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
}

function makeCopilotProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("copilot"),
    driver: ProviderDriverKind.make("copilot"),
    displayName: "Copilot",
    enabled: true,
    installed: true,
    version: "1.0.44",
    status: "ready",
    auth: {
      status: "authenticated",
      label: "GitHub Copilot",
    },
    checkedAt: "2026-05-09T20:17:35.530Z",
    usage: {
      checkedAt: "2026-05-09T20:17:35.530Z",
      rateLimits: {
        rateLimitsByLimitId: {
          copilot_chat: {
            credits: null,
            limitId: "copilot_chat",
            limitName: "Copilot chat",
            planType: "copilot",
            primary: {
              resetsAt: 1780873200,
              usedPercent: 14,
              windowDurationMins: 43200,
            },
            rateLimitReachedType: null,
            secondary: null,
          },
          copilot_completions: {
            credits: null,
            limitId: "copilot_completions",
            limitName: "Copilot completions",
            planType: "copilot",
            primary: {
              resetsAt: 1780873200,
              usedPercent: 0,
              windowDurationMins: 43200,
            },
            rateLimitReachedType: null,
            secondary: null,
          },
          copilot_session: {
            credits: null,
            limitId: "copilot_session",
            limitName: "Copilot session",
            planType: "copilot",
            primary: {
              resetsAt: 1778376068,
              usedPercent: 1,
              windowDurationMins: 300,
            },
            rateLimitReachedType: null,
            secondary: null,
          },
          copilot_weekly: {
            credits: null,
            limitId: "copilot_weekly",
            limitName: "Copilot weekly",
            planType: "copilot",
            primary: {
              resetsAt: 1778457600,
              usedPercent: 2.4,
              windowDurationMins: 10080,
            },
            rateLimitReachedType: null,
            secondary: null,
          },
        },
      },
    },
    models: [],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
}

function makeServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: {
        os: "windows",
        arch: "x64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "C:\\workspace",
    keybindingsConfigPath: "C:\\workspace\\.config\\keybindings.json",
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    issues: [],
    providers: [makeCodexProvider(), makeCopilotProvider()],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "C:\\workspace\\.config\\logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  } satisfies ServerConfig;
}

describe("CodexUsageSettingsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    resetServerStateForTests();
    resetAppAtomRegistryForTests();
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
  });

  it("groups account usage-limit windows by provider", async () => {
    setServerConfigSnapshot(makeServerConfig());

    const mounted = await render(
      <AppAtomRegistryProvider>
        <CodexUsageSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    try {
      await expect
        .element(page.getByRole("heading", { name: "Usage", exact: true }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("heading", { name: "Codex", exact: true }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("heading", { name: "Copilot", exact: true }))
        .toBeInTheDocument();
      await expect.element(page.getByText("General - 5 hour usage limit")).toBeInTheDocument();
      await expect.element(page.getByText("General - Weekly usage limit")).toBeInTheDocument();
      await expect.element(page.getByText("Chat", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Completions", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Session", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Weekly", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByText("Monthly usage limit", { exact: false }).first())
        .toBeInTheDocument();
      await expect
        .element(page.getByText("5 hour usage limit", { exact: false }).first())
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Weekly usage limit", { exact: false }).first())
        .toBeInTheDocument();
      await expect.element(page.getByText("86% left")).toBeInTheDocument();
      await expect.element(page.getByText("100% left")).toBeInTheDocument();
      await expect.element(page.getByText("99% left")).toBeInTheDocument();
      await expect.element(page.getByText("98% left").first()).toBeInTheDocument();
      await expect.element(page.getByText("36% left")).toBeInTheDocument();
      await expect.element(page.getByText("Copilot chat usage limits")).not.toBeInTheDocument();
      await expect.element(page.getByText("No account-limit data")).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});
