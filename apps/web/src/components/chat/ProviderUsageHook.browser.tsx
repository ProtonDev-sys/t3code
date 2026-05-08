import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { type EnvironmentState, useStore } from "../../store";
import { useProviderUsageSnapshots } from "../../hooks/useCodexUsage";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-usage");

function makeProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-05T00:00:00.000Z",
    usage: {
      checkedAt: "2026-05-05T00:00:00.000Z",
      rateLimits: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 18, windowDurationMins: 300 },
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
      environmentId,
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
    providers: [makeProvider()],
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

function makeUsageActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-usage"),
    tone: "info",
    kind: "account.rate-limits.updated",
    summary: "Codex usage updated",
    payload: {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      rateLimits: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 18, windowDurationMins: 300 },
          },
        },
      },
    },
    turnId: TurnId.make("turn-1"),
    sequence: 1,
    createdAt: "2026-05-05T01:00:00.000Z",
  };
}

function makeEnvironmentState(activity: OrchestrationThreadActivity): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [threadId],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {
      [threadId]: [activity.id],
    },
    activityByThreadId: {
      [threadId]: {
        [activity.id]: activity,
      },
    },
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  } satisfies EnvironmentState;
}

function ProviderUsageProbe() {
  const snapshots = useProviderUsageSnapshots();
  return <div>Provider usage probe: {snapshots.length}</div>;
}

describe("useProviderUsageSnapshots", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    resetServerStateForTests();
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
  });

  it("renders provider usage without a nested update loop", async () => {
    resetServerStateForTests();
    setServerConfigSnapshot(makeServerConfig());
    useStore.setState({
      activeEnvironmentId: environmentId,
      environmentStateById: {
        [environmentId]: makeEnvironmentState(makeUsageActivity()),
      },
    });

    const mounted = await render(<ProviderUsageProbe />);

    try {
      await expect.element(page.getByText("Provider usage probe: 0")).toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});
