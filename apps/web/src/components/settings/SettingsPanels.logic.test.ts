import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vitest";
import type { Project, ThreadShell } from "../../types";
import {
  buildProviderInstanceUpdatePatch,
  getEmptyProjectCleanupCandidates,
  getInactiveThreadCleanupCandidates,
} from "./SettingsPanels.logic";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function makeProject(input: Omit<Partial<Project>, "id"> & { id: string; name?: string }): Project {
  return {
    ...input,
    id: ProjectId.make(input.id),
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    name: input.name ?? input.id,
    cwd: input.cwd ?? `/repo/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? input.createdAt ?? "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

function makeThread(
  input: Omit<Partial<ThreadShell>, "id" | "projectId"> & { id: string; projectId: string },
): ThreadShell {
  return {
    ...input,
    id: ThreadId.make(input.id),
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: ProjectId.make(input.projectId),
    title: input.title ?? input.id,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    error: null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: input.updatedAt ?? input.createdAt ?? "2026-01-01T00:00:00.000Z",
    branch: null,
    worktreePath: null,
  };
}

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("cleanup candidate helpers", () => {
  it("selects threads not updated for 30 days", () => {
    const candidates = getInactiveThreadCleanupCandidates(
      [
        makeThread({
          id: "old",
          projectId: "project-a",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: "recent",
          projectId: "project-a",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        }),
      ],
      Date.parse("2026-05-06T00:00:00.000Z"),
    );

    expect(candidates.map((candidate) => candidate.thread.id)).toEqual([ThreadId.make("old")]);
    expect(candidates[0]?.lastUsedAtIso).toBe("2026-03-01T00:00:00.000Z");
  });

  it("falls back to thread creation time when updatedAt is missing", () => {
    const candidates = getInactiveThreadCleanupCandidates(
      [
        makeThread({
          id: "created-old",
          projectId: "project-a",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: undefined,
        }),
      ],
      Date.parse("2026-05-06T00:00:00.000Z"),
    );

    expect(candidates.map((candidate) => candidate.thread.id)).toEqual([
      ThreadId.make("created-old"),
    ]);
  });

  it("selects only projects with no threads in the same environment", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const candidates = getEmptyProjectCleanupCandidates(
      [
        makeProject({ id: "project-a", name: "Project A" }),
        makeProject({ id: "project-b", name: "Project B" }),
        makeProject({
          id: "project-a",
          environmentId: remoteEnvironmentId,
          name: "Remote Project A",
        }),
      ],
      [
        makeThread({ id: "thread-a", projectId: "project-a" }),
        makeThread({
          id: "thread-remote-a",
          projectId: "project-a",
          environmentId: remoteEnvironmentId,
        }),
      ],
    );

    expect(candidates.map((candidate) => candidate.project.id)).toEqual([
      ProjectId.make("project-b"),
    ]);
  });
});
