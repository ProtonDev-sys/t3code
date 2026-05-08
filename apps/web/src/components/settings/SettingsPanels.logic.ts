import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import type { Project, ThreadShell } from "../../types";

export const INACTIVE_THREAD_CLEANUP_DAYS = 30;
const INACTIVE_THREAD_CLEANUP_MS = INACTIVE_THREAD_CLEANUP_DAYS * 24 * 60 * 60 * 1000;

export interface InactiveThreadCleanupCandidate {
  readonly thread: ThreadShell;
  readonly lastUsedAtIso: string;
}

export interface EmptyProjectCleanupCandidate {
  readonly project: Project;
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function projectThreadKey(input: {
  readonly environmentId: string;
  readonly id?: string;
  readonly projectId?: string;
}): string {
  return `${input.environmentId}:${input.projectId ?? input.id ?? ""}`;
}

export function getInactiveThreadCleanupCandidates(
  threads: ReadonlyArray<ThreadShell>,
  nowMs: number = Date.now(),
): InactiveThreadCleanupCandidate[] {
  const cutoffMs = nowMs - INACTIVE_THREAD_CLEANUP_MS;
  return threads
    .flatMap((thread) => {
      const lastUsedAtMs = parseTimestampMs(thread.updatedAt) ?? parseTimestampMs(thread.createdAt);
      if (lastUsedAtMs === null || lastUsedAtMs >= cutoffMs) {
        return [];
      }
      return [
        {
          thread,
          lastUsedAtIso: new Date(lastUsedAtMs).toISOString(),
        },
      ];
    })
    .toSorted((left, right) => left.lastUsedAtIso.localeCompare(right.lastUsedAtIso));
}

export function getEmptyProjectCleanupCandidates(
  projects: ReadonlyArray<Project>,
  threads: ReadonlyArray<ThreadShell>,
): EmptyProjectCleanupCandidate[] {
  const projectsWithThreads = new Set(threads.map((thread) => projectThreadKey(thread)));
  return projects
    .filter((project) => !projectsWithThreads.has(projectThreadKey(project)))
    .map((project) => ({ project }))
    .toSorted((left, right) => {
      const leftLabel = left.project.name || left.project.cwd || left.project.id;
      const rightLabel = right.project.name || right.project.cwd || right.project.id;
      return leftLabel.localeCompare(rightLabel);
    });
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}
