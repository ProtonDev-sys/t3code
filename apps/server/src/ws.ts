import {
  Cause,
  Duration,
  Effect,
  Equal,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import {
  type AuthAccessStreamEvent,
  AuthSessionId,
  CliUpdateError,
  type CliUpdateState,
  type CliUpdateStreamEvent,
  CodexAgentConfigError,
  CodexExtensionsConfigError,
  CodexMcpConfigError,
  CommandId,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  ThreadId,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import {
  addCodexMcpServer,
  deleteCodexMcpServer,
  listCodexMcpServers,
  updateCodexMcpServer,
} from "./codexMcpConfig.ts";
import { listCodexAgents } from "./codexAgentsConfig.ts";
import { resolveCodexCliUpdateLaunch, runCodexCliUpdate } from "./codexCliUpdater.ts";
import {
  listCodexAutomations,
  listCodexPlugins,
  listCodexUsageHistory,
  deleteCodexAutomation,
  installCodexPlugin,
  saveCodexAutomation,
  updateCodexAutomation,
  updateCodexPlugin,
} from "./codexExtensionsConfig.ts";
import { ServerConfig } from "./config.ts";
import { Keybindings } from "./keybindings.ts";
import { Open, resolveAvailableEditors } from "./open.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadDetailReadOptions,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";

function toCodexMcpRpcError(value: unknown): CodexMcpConfigError {
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "CodexMcpConfigError"
  ) {
    return value as CodexMcpConfigError;
  }
  return new CodexMcpConfigError({ detail: String(value) });
}

function toCodexAgentRpcError(value: unknown): CodexAgentConfigError {
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "CodexAgentConfigError"
  ) {
    return value as CodexAgentConfigError;
  }
  return new CodexAgentConfigError({ detail: String(value) });
}

function toCodexExtensionsRpcError(value: unknown): CodexExtensionsConfigError {
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    value._tag === "CodexExtensionsConfigError"
  ) {
    return value as CodexExtensionsConfigError;
  }
  return new CodexExtensionsConfigError({ detail: String(value) });
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;
const SHELL_REPOSITORY_IDENTITY_BACKFILL_LIMIT = 64;
const INITIAL_THREAD_DETAIL_MESSAGE_LIMIT = 80;
const INITIAL_THREAD_DETAIL_PROPOSED_PLAN_LIMIT = 20;
const INITIAL_THREAD_DETAIL_ACTIVITY_LIMIT = 80;
const INITIAL_THREAD_DETAIL_CHECKPOINT_LIMIT = 80;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

function nowIso(): string {
  return new Date().toISOString();
}

function cliUpdateMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : "Unknown CLI update error.";
}

function summarizeCliUpdateFailure(input: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}): string {
  const output = (input.stderr || input.stdout).trim();
  if (output.length > 0) {
    return output;
  }
  if (input.signal) {
    return `Codex update stopped by signal ${input.signal}.`;
  }
  return `Codex update exited with code ${input.code ?? "unknown"}.`;
}

function codexCliUpdateKey(state: Pick<CliUpdateState, "providerInstanceId" | "targetVersion">) {
  return `${state.providerInstanceId}:${state.targetVersion ?? "latest"}`;
}

const cliUpdatesRef = Effect.runSync(Ref.make<ReadonlyMap<string, CliUpdateState>>(new Map()));
const cliUpdatesPubSub = Effect.runSync(PubSub.unbounded<CliUpdateStreamEvent>());

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (currentSessionId: AuthSessionId) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const open = yield* Open;
      const gitWorkflow = yield* GitWorkflowService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager;
      const providerRegistry = yield* ProviderRegistry;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
      const sourceControlRepositories = yield* SourceControlRepositoryService;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const serverCommandId = (tag: string) =>
        CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("setup-script-activity"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        Schema.is(OrchestrationDispatchCommandError)(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return Schema.is(OrchestrationDispatchCommandError)(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                (yield* orchestrationEngine.getReadModel()).projects.find(
                  (project) => project.id === event.payload.projectId,
                )?.workspaceRoot ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            });
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) => {
            const payload = {
              scriptId: input.scriptId,
              scriptName: input.scriptName,
              terminalId: input.terminalId,
              worktreePath: input.worktreePath,
            };
            return Effect.all([
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: input.requestedAt,
                payload,
                tone: "info",
              }),
              appendSetupScriptActivity({
                threadId: command.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: new Date().toISOString(),
                payload,
                tone: "info",
              }),
            ]).pipe(
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.logWarning(
                  "bootstrap turn start launched setup script but failed to record setup activity",
                  {
                    threadId: command.threadId,
                    worktreePath: input.worktreePath,
                    scriptId: input.scriptId,
                    terminalId: input.terminalId,
                    detail: error.message,
                  },
                ),
              ),
            );
          };

          const runSetupProgram = () =>
            bootstrap?.runSetupScript && targetWorktreePath
              ? (() => {
                  const worktreePath = targetWorktreePath;
                  const requestedAt = new Date().toISOString();
                  return projectSetupScriptRunner
                    .runForThread({
                      threadId: command.threadId,
                      ...(targetProjectId ? { projectId: targetProjectId } : {}),
                      ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                      worktreePath,
                    })
                    .pipe(
                      Effect.matchEffect({
                        onFailure: (error) =>
                          recordSetupScriptLaunchFailure({
                            error,
                            requestedAt,
                            worktreePath,
                          }),
                        onSuccess: (setupResult) => {
                          if (setupResult.status !== "started") {
                            return Effect.void;
                          }
                          return recordSetupScriptStarted({
                            requestedAt,
                            worktreePath,
                            scriptId: setupResult.scriptId,
                            scriptName: setupResult.scriptName,
                            terminalId: setupResult.terminalId,
                          });
                        },
                      }),
                    );
                })()
              : Effect.void;

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                newRefName: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const publishCliUpdateState = (state: CliUpdateState) =>
        Ref.update(cliUpdatesRef, (updates) => {
          const next = new Map(updates);
          next.set(codexCliUpdateKey(state), state);
          return next;
        }).pipe(
          Effect.andThen(PubSub.publish(cliUpdatesPubSub, { version: 1 as const, state })),
          Effect.asVoid,
        );

      const startCodexCliUpdate = (input: {
        readonly providerInstanceId: CliUpdateState["providerInstanceId"];
        readonly currentVersion: string | null;
        readonly targetVersion: string | null;
      }) =>
        Effect.gen(function* () {
          const running = yield* Ref.get(cliUpdatesRef).pipe(
            Effect.map((updates) =>
              Array.from(updates.values()).find(
                (state) =>
                  state.providerInstanceId === input.providerInstanceId &&
                  state.targetVersion === input.targetVersion &&
                  state.status === "running",
              ),
            ),
          );
          if (running) {
            return { started: false, state: running };
          }

          const settings = yield* serverSettings.getSettings;
          const launch = yield* Effect.try({
            try: () => resolveCodexCliUpdateLaunch(settings, input),
            catch: (error) =>
              Schema.is(CliUpdateError)(error)
                ? error
                : new CliUpdateError({ detail: cliUpdateMessage(error) }),
          });
          const state = {
            id: `codex-cli-update:${input.providerInstanceId}:${crypto.randomUUID()}`,
            providerInstanceId: input.providerInstanceId,
            driver: CODEX_DRIVER_KIND,
            ...(launch.displayName ? { displayName: launch.displayName } : {}),
            status: "running" as const,
            currentVersion: input.currentVersion,
            targetVersion: input.targetVersion,
            startedAt: nowIso(),
            finishedAt: null,
            message: "Codex CLI update is running in the background.",
          } satisfies CliUpdateState;

          yield* publishCliUpdateState(state);
          const finish = (nextState: CliUpdateState) =>
            publishCliUpdateState(nextState).pipe(
              Effect.andThen(providerRegistry.refreshInstance(input.providerInstanceId)),
              Effect.ignoreCause({ log: true }),
            );

          yield* Effect.tryPromise({
            try: () => runCodexCliUpdate(launch),
            catch: (error) =>
              Schema.is(CliUpdateError)(error)
                ? error
                : new CliUpdateError({ detail: cliUpdateMessage(error) }),
          }).pipe(
            Effect.flatMap((result) => {
              if (result.code === 0) {
                return finish({
                  ...state,
                  status: "succeeded",
                  finishedAt: nowIso(),
                  message: "Codex CLI update finished.",
                });
              }
              return finish({
                ...state,
                status: "failed",
                finishedAt: nowIso(),
                message: summarizeCliUpdateFailure(result),
              });
            }),
            Effect.catch((error: unknown) =>
              finish({
                ...state,
                status: "failed",
                finishedAt: nowIso(),
                message: cliUpdateMessage(error),
              }),
            ),
            Effect.ignoreCause({ log: true }),
            Effect.forkDetach,
          );

          return { started: true, state };
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(CliUpdateError)(error)
              ? error
              : new CliUpdateError({ detail: cliUpdateMessage(error) }),
          ),
        );

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.catch(() => Effect.succeed(false)),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: new Date().toISOString(),
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }

                yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after archive", {
                      threadId: normalizedCommand.threadId,
                      error: error.message,
                    }),
                  ),
                );
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                Schema.is(OrchestrationDispatchCommandError)(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );
              const identityBackfillProjects =
                snapshot.projects.length <= SHELL_REPOSITORY_IDENTITY_BACKFILL_LIMIT
                  ? snapshot.projects
                  : snapshot.projects
                      .toSorted(
                        (left, right) =>
                          right.updatedAt.localeCompare(left.updatedAt) ||
                          right.createdAt.localeCompare(left.createdAt) ||
                          right.id.localeCompare(left.id),
                      )
                      .slice(0, SHELL_REPOSITORY_IDENTITY_BACKFILL_LIMIT);
              const repositoryIdentityBackfillStream = Stream.fromIterable(
                identityBackfillProjects,
              ).pipe(
                Stream.mapEffect((project) =>
                  repositoryIdentityResolver.resolve(project.workspaceRoot).pipe(
                    Effect.map((repositoryIdentity) =>
                      repositoryIdentity === null
                        ? Option.none<OrchestrationShellStreamEvent>()
                        : Option.some({
                            kind: "project-upserted" as const,
                            sequence: snapshot.snapshotSequence,
                            project: {
                              ...project,
                              repositoryIdentity,
                            },
                          }),
                    ),
                  ),
                ),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                Stream.merge(repositoryIdentityBackfillStream, liveStream),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.sync(() => {
              const loadThreadSnapshot = (options?: ProjectionThreadDetailReadOptions) =>
                Effect.all([
                  projectionSnapshotQuery.getThreadDetailById(input.threadId, options).pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: `Failed to load thread ${input.threadId}`,
                          cause,
                        }),
                    ),
                  ),
                  projectionSnapshotQuery.getSnapshotSequence().pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: "Failed to load projection snapshot sequence",
                          cause,
                        }),
                    ),
                  ),
                ]).pipe(
                  Effect.flatMap(([threadDetail, snapshotSequence]) => {
                    if (Option.isNone(threadDetail)) {
                      return Effect.fail(
                        new OrchestrationGetSnapshotError({
                          message: `Thread ${input.threadId} was not found`,
                          cause: input.threadId,
                        }),
                      );
                    }
                    return Effect.succeed({
                      kind: "snapshot" as const,
                      snapshot: {
                        snapshotSequence,
                        thread: threadDetail.value,
                      },
                    });
                  }),
                );

              const toThreadDetailStream = <E, R>(
                events: Stream.Stream<OrchestrationEvent, E, R>,
              ) =>
                events.pipe(
                  Stream.filter(
                    (event) =>
                      event.aggregateKind === "thread" &&
                      event.aggregateId === input.threadId &&
                      isThreadDetailEvent(event),
                  ),
                  Stream.map((event) => ({
                    kind: "event" as const,
                    event,
                  })),
                );

              return Stream.fromEffect(
                loadThreadSnapshot({
                  messageLimit: INITIAL_THREAD_DETAIL_MESSAGE_LIMIT,
                  proposedPlanLimit: INITIAL_THREAD_DETAIL_PROPOSED_PLAN_LIMIT,
                  activityLimit: INITIAL_THREAD_DETAIL_ACTIVITY_LIMIT,
                  checkpointLimit: INITIAL_THREAD_DETAIL_CHECKPOINT_LIMIT,
                }),
              ).pipe(
                Stream.flatMap((snapshotItem) => {
                  const snapshotSequence = snapshotItem.snapshot.snapshotSequence;
                  const replayStream = toThreadDetailStream(
                    orchestrationEngine.readEvents(snapshotSequence).pipe(
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: "Failed to replay thread detail events",
                            cause,
                          }),
                      ),
                    ),
                  );
                  const liveStream = toThreadDetailStream(
                    orchestrationEngine.streamDomainEvents.pipe(
                      Stream.filter((event) => event.sequence > snapshotSequence),
                    ),
                  );
                  return Stream.concat(
                    Stream.make(snapshotItem),
                    Stream.concat(replayStream, liveStream),
                  );
                }),
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverCodexMcpList]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexMcpList,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => listCodexMcpServers(settings, input)),
              Effect.mapError(toCodexMcpRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexMcpAdd]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexMcpAdd,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => addCodexMcpServer(settings, input)),
              Effect.tap(() =>
                input.providerInstanceId
                  ? providerRegistry.refreshInstance(input.providerInstanceId)
                  : providerRegistry.refresh(),
              ),
              Effect.mapError(toCodexMcpRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexMcpUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexMcpUpdate,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => updateCodexMcpServer(settings, input)),
              Effect.tap(() =>
                input.providerInstanceId
                  ? providerRegistry.refreshInstance(input.providerInstanceId)
                  : providerRegistry.refresh(),
              ),
              Effect.mapError(toCodexMcpRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexMcpDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexMcpDelete,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => deleteCodexMcpServer(settings, input)),
              Effect.tap(() =>
                input.providerInstanceId
                  ? providerRegistry.refreshInstance(input.providerInstanceId)
                  : providerRegistry.refresh(),
              ),
              Effect.mapError(toCodexMcpRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexAgentsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexAgentsList,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => listCodexAgents(settings, input)),
              Effect.mapError(toCodexAgentRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexPluginsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexPluginsList,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => listCodexPlugins(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexPluginsUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexPluginsUpdate,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => updateCodexPlugin(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexPluginsInstall]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexPluginsInstall,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => installCodexPlugin(settings, input)),
              Effect.tap(() =>
                input.providerInstanceId
                  ? providerRegistry.refreshInstance(input.providerInstanceId)
                  : providerRegistry.refresh(),
              ),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexAutomationsList]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexAutomationsList,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => listCodexAutomations(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexAutomationsUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexAutomationsUpdate,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => updateCodexAutomation(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexAutomationsSave]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexAutomationsSave,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => saveCodexAutomation(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexAutomationsDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexAutomationsDelete,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => deleteCodexAutomation(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCodexUsageHistoryList]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCodexUsageHistoryList,
            serverSettings.getSettings.pipe(
              Effect.flatMap((settings) => listCodexUsageHistory(settings, input)),
              Effect.mapError(toCodexExtensionsRpcError),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCliUpdatesStartCodex]: (input) =>
          observeRpcEffect(WS_METHODS.serverCliUpdatesStartCodex, startCodexCliUpdate(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const initialConfig = yield* loadServerConfig;
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const refreshedProviderStatuses = Stream.fromEffect(
                providerRegistry.refresh().pipe(
                  Effect.map((providers) =>
                    Equal.equals(initialConfig.providers, providers)
                      ? null
                      : {
                          version: 1 as const,
                          type: "providerStatuses" as const,
                          payload: { providers },
                        },
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logError("provider registry initial refresh failed", {
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as(null)),
                  ),
                ),
              ).pipe(Stream.filter((event) => event !== null));
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  Stream.merge(refreshedProviderStatuses, providerStatuses),
                  settingsUpdates,
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: initialConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeCliUpdates]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeCliUpdates,
            Effect.gen(function* () {
              const snapshot = yield* Ref.get(cliUpdatesRef);
              const snapshotEvents = Array.from(snapshot.values(), (state) => ({
                version: 1 as const,
                state,
              }));
              return Stream.concat(
                Stream.fromIterable(snapshotEvents),
                Stream.fromPubSub(cliUpdatesPubSub),
              );
            }),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session.sessionId).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(
                SourceControlDiscoveryLayer.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
