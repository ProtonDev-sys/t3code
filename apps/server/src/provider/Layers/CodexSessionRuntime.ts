import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Deferred, Effect, Exit, Layer, Queue, Ref, Scope, Random, Schema, Stream } from "effect";
import * as SchemaIssue from "effect/SchemaIssue";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: EffectCodexSchema.V2ThreadStartParams__ServiceTier | undefined;
  readonly modelContextWindow?: number;
  readonly mcpEnabled?: boolean;
  readonly resumeCursor?: CodexResumeCursor;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: EffectCodexSchema.V2TurnStartParams__ServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexSessionRuntimeSteerTurnInput {
  readonly turnId: TurnId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}

export interface CodexSessionRuntimeReviewInput {
  readonly instructions?: string;
}

export type CodexSessionRuntimeGoalStatus = "active" | "paused";

export interface CodexSessionRuntimeGoalState {
  readonly objective: string;
  readonly status: CodexSessionRuntimeGoalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CodexSessionRuntimeGoalCommandInput {
  readonly args: string;
}

export interface CodexSessionRuntimeRenameInput {
  readonly name: string;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

const CODEX_GOAL_PROTOCOL = [
  "Keep this goal active across turns until it is actually complete.",
  "Do not present the goal as complete unless all requested work is done.",
  "When you stop, state whether the goal is complete. If it is incomplete, list the remaining work clearly.",
].join("\n");

function normalizeCodexServiceTier(
  value: unknown,
): EffectCodexSchema.V2ThreadStartParams__ServiceTier | undefined {
  switch (value) {
    case "fast":
    case "priority":
      return "fast";
    case "flex":
      return "flex";
    default:
      return undefined;
  }
}

export function applyCodexGoalToPrompt(
  prompt: string | undefined,
  goal: CodexSessionRuntimeGoalState | null,
): string | undefined {
  const objective = goal?.objective.trim();
  if (!objective || goal?.status !== "active") {
    return prompt;
  }
  const goalContext = `Current long-running goal:\n${objective}\n\nGoal protocol:\n${CODEX_GOAL_PROTOCOL}`;
  const trimmedPrompt = prompt?.trim();
  if (!trimmedPrompt) {
    return goalContext;
  }
  return `${goalContext}\n\nUser request:\n${prompt}`;
}

export function buildCodexGoalStartPrompt(goal: CodexSessionRuntimeGoalState): string {
  const objective = goal.objective.trim();
  const goalContext =
    applyCodexGoalToPrompt(undefined, { ...goal, objective, status: "active" }) ??
    `Current long-running goal:\n${objective}`;
  return `${goalContext}\n\nUser request:\nStart working toward this goal now. Continue through the available work before ending the turn.`;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly steerTurn: (
    input: CodexSessionRuntimeSteerTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly compactThread: () => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly startReview: (
    input: CodexSessionRuntimeReviewInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly runGoalCommand: (
    input: CodexSessionRuntimeGoalCommandInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly renameThread: (
    input: CodexSessionRuntimeRenameInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return Schema.is(CodexResumeCursorSchema)(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: EffectCodexSchema.V2ThreadStartParams__ServiceTier | undefined;
  readonly modelContextWindow: number | undefined;
  readonly mcpEnabled: boolean;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const serviceTier = normalizeCodexServiceTier(input.serviceTier);
  const threadConfig = {
    ...(input.mcpEnabled ? {} : { mcp_servers: {} }),
    ...(input.modelContextWindow ? { model_context_window: input.modelContextWindow } : {}),
  };
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    ...(Object.keys(threadConfig).length > 0 ? { config: threadConfig } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: EffectCodexSchema.V2TurnStartParams__ServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const serviceTier = normalizeCodexServiceTier(input.serviceTier);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return Schema.decodeUnknownEffect(CodexTurnStartParamsWithCollaborationMode)({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/start request payload", error)),
  );
}

export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: TurnId;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnSteerParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  return Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams)({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    input: turnInput,
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/steer request payload", error)),
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: EffectCodexSchema.V2ThreadStartParams__ServiceTier | undefined;
  readonly modelContextWindow: number | undefined;
  readonly mcpEnabled: boolean;
  readonly resumeThreadId: string | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
    modelContextWindow: input.modelContextWindow,
    mcpEnabled: input.mcpEnabled,
  });

  if (resumeThreadId === undefined) {
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error.message,
        }).pipe(Effect.andThen(input.client.request("thread/start", startParams))),
      ),
    );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

function sessionUpdateFromThreadStatus(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): Partial<ProviderSession> | null {
  switch (status.type) {
    case "idle":
      return {
        status: "ready",
        activeTurnId: undefined,
      };
    case "systemError":
      return {
        status: "error",
        activeTurnId: undefined,
      };
    default:
      return null;
  }
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (Schema.is(CodexUserInputAnswerObject)(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function toProtocolParseError(
  detail: string,
  cause: Schema.SchemaError,
): CodexErrors.CodexAppServerProtocolParseError {
  return new CodexErrors.CodexAppServerProtocolParseError({
    detail: `${detail}: ${formatSchemaIssue(cause.issue)}`,
    cause,
  });
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession>,
): Effect.Effect<void> {
  return Ref.update(sessionRef, (session) => ({
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  }));
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const closedRef = yield* Ref.make(false);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.binaryPath, ["app-server"], {
          cwd: options.cwd,
          env,
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();

    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const goalRef = yield* Ref.make<CodexSessionRuntimeGoalState | null>(null);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.flatMap(Random.nextUUIDv4, (id) =>
        offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: new Date().toISOString(),
          ...event,
        }),
      );
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });
    const emitSessionEventForTurn = (method: string, message: string, turnId: TurnId) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        turnId,
        method,
        message,
      });

    const emitAccountRateLimitsSnapshot = Effect.gen(function* () {
      const response = yield* client.request("account/rateLimits/read", undefined);
      yield* emitEvent({
        kind: "notification",
        threadId: options.threadId,
        method: "account/rateLimits/updated",
        payload: {
          rateLimits: response.rateLimits,
          ...(response.rateLimitsByLimitId !== undefined
            ? { rateLimitsByLimitId: response.rateLimitsByLimitId }
            : {}),
        },
      });
    });
    // Do not await a client request from inside the protocol input handler: the
    // same reader must process the response, so awaiting here deadlocks future turns.
    const refreshAccountRateLimitsSnapshot = emitAccountRateLimitsSnapshot.pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(runtimeScope),
      Effect.asVoid,
    );

    const emitSyntheticCommandTurn = (providerThreadId: string, turnId: TurnId) =>
      Effect.gen(function* () {
        const startedAt = Math.floor(Date.now() / 1000);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "turn/started",
          turnId,
          payload: {
            threadId: providerThreadId,
            turn: {
              id: turnId,
              items: [],
              startedAt,
              status: "inProgress",
            },
          },
        });
        yield* Effect.sleep("50 millis");
        const completedAt = Math.floor(Date.now() / 1000);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "turn/completed",
          turnId,
          payload: {
            threadId: providerThreadId,
            turn: {
              id: turnId,
              items: [],
              startedAt,
              completedAt,
              durationMs: Math.max(0, (completedAt - startedAt) * 1000),
              status: "completed",
            },
          },
        });
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(runtimeScope), Effect.asVoid);

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const payload = notification.params;
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        if (childParentTurnId && shouldSuppressChildConversationNotification(notification.method)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        const currentSession = yield* Ref.get(sessionRef);
        const payloadWithRuntimeContext =
          payload !== undefined &&
          typeof payload === "object" &&
          payload !== null &&
          notification.method === "turn/started" &&
          currentSession.model
            ? { ...(payload as Record<string, unknown>), model: currentSession.model }
            : payload;
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payloadWithRuntimeContext !== undefined
            ? { payload: payloadWithRuntimeContext }
            : {}),
        });
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);
    const forwardServerNotification = <M extends CodexRpc.ServerNotificationMethod>(
      method: M,
      params: CodexRpc.ServerNotificationParamsByMethod[M],
    ) =>
      Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
        Effect.asVoid,
      );

    yield* client.handleServerNotification("thread/started", (payload) =>
      forwardServerNotification("thread/started", payload).pipe(
        Effect.andThen(
          currentSessionProviderThreadId.pipe(
            Effect.flatMap((providerThreadId) => {
              if (providerThreadId && payload.thread.id !== providerThreadId) {
                return Effect.void;
              }
              return updateSession(sessionRef, {
                resumeCursor: { threadId: payload.thread.id },
              });
            }),
          ),
        ),
      ),
    );

    yield* client.handleServerNotification("thread/status/changed", (payload) =>
      forwardServerNotification("thread/status/changed", payload).pipe(
        Effect.andThen(
          currentSessionProviderThreadId.pipe(
            Effect.flatMap((providerThreadId) => {
              if (providerThreadId && payload.threadId !== providerThreadId) {
                return Effect.void;
              }
              const update = sessionUpdateFromThreadStatus(payload.status);
              return update ? updateSession(sessionRef, update) : Effect.void;
            }),
          ),
        ),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      forwardServerNotification("turn/started", payload).pipe(
        Effect.andThen(
          currentSessionProviderThreadId.pipe(
            Effect.flatMap((providerThreadId) => {
              if (providerThreadId && payload.threadId !== providerThreadId) {
                return Effect.void;
              }
              return updateSession(sessionRef, {
                status: "running",
                activeTurnId: TurnId.make(payload.turn.id),
              });
            }),
          ),
        ),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      forwardServerNotification("turn/completed", payload).pipe(
        Effect.andThen(
          currentSessionProviderThreadId.pipe(
            Effect.flatMap((providerThreadId) => {
              if (providerThreadId && payload.threadId !== providerThreadId) {
                return Effect.void;
              }
              const lastError =
                payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
                  ? payload.turn.error.message
                  : undefined;
              return updateSession(sessionRef, {
                status: payload.turn.status === "failed" ? "error" : "ready",
                activeTurnId: undefined,
                ...(lastError ? { lastError } : {}),
              }).pipe(Effect.andThen(refreshAccountRateLimitsSnapshot));
            }),
          ),
        ),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      forwardServerNotification("error", payload).pipe(
        Effect.andThen(
          currentSessionProviderThreadId.pipe(
            Effect.flatMap((providerThreadId) => {
              const payloadThreadId = payload.threadId;
              if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
                return Effect.void;
              }
              const errorMessage = payload.error.message;
              const willRetry = payload.willRetry;
              return updateSession(sessionRef, {
                status: willRetry ? "running" : "error",
                ...(errorMessage ? { lastError: errorMessage } : {}),
              });
            }),
          ),
        ),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );
    const handledServerNotificationMethods = new Set<CodexRpc.ServerNotificationMethod>([
      "thread/started",
      "thread/status/changed",
      "turn/started",
      "turn/completed",
      "error",
    ]);

    yield* Effect.forEach(
      (
        Object.values(
          CodexRpc.SERVER_NOTIFICATION_METHODS,
        ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>
      ).filter((method) => !handledServerNotificationMethods.has(method)),
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        modelContextWindow: options.modelContextWindow,
        mcpEnabled: options.mcpEnabled ?? true,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      const providerThreadId = opened.thread.id;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: new Date().toISOString(),
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      yield* emitAccountRateLimitsSnapshot.pipe(Effect.ignoreCause({ log: true }));
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });
    const buildTurnStartResult = (turnId: TurnId) =>
      Effect.gen(function* () {
        const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
        return {
          threadId: options.threadId,
          turnId,
          ...(resumedProviderThreadId
            ? { resumeCursor: { threadId: resumedProviderThreadId } }
            : {}),
        } satisfies ProviderTurnStartResult;
      });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped");
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const goal = yield* Ref.get(goalRef);
          const prompt = applyCodexGoalToPrompt(input.input, goal);
          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );
          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            runtimeMode: options.runtimeMode,
            ...(prompt ? { prompt } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
          });
          const rawResponse = yield* client.raw.request("turn/start", params);
          const response = yield* Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse)(
            rawResponse,
          ).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/start response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turn.id);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          });
          return yield* buildTurnStartResult(turnId);
        }),
      steerTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const goal = yield* Ref.get(goalRef);
          const prompt = applyCodexGoalToPrompt(input.input, goal);
          const params = yield* buildTurnSteerParams({
            threadId: providerThreadId,
            expectedTurnId: input.turnId,
            ...(prompt ? { prompt } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
          const rawResponse = yield* client.raw.request("turn/steer", params);
          const response = yield* Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerResponse)(
            rawResponse,
          ).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/steer response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turnId);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
          });
          return yield* buildTurnStartResult(turnId);
        }),
      compactThread: () =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          yield* client.request("thread/compact/start", {
            threadId: providerThreadId,
          });
          const syntheticTurnId = TurnId.make(`compact-${yield* Random.nextUUIDv4}`);
          const session = yield* Ref.get(sessionRef);
          yield* updateSession(sessionRef, {
            status: "running",
            ...(session.activeTurnId ? {} : { activeTurnId: syntheticTurnId }),
          });
          return yield* buildTurnStartResult(session.activeTurnId ?? syntheticTurnId);
        }),
      startReview: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const instructions = input.instructions?.trim();
          const target: EffectCodexSchema.V2ReviewStartParams__ReviewTarget = instructions
            ? {
                type: "custom",
                instructions,
              }
            : {
                type: "uncommittedChanges",
              };
          const response = yield* client.request("review/start", {
            threadId: providerThreadId,
            delivery: "inline",
            target,
          });
          const turnId = TurnId.make(response.turn.id);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
          });
          return yield* buildTurnStartResult(turnId);
        }),
      runGoalCommand: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const args = input.args.trim();
          const normalized = args.toLowerCase();
          const now = Math.floor(Date.now() / 1000);
          const turnId = TurnId.make(`goal-${yield* Random.nextUUIDv4}`);
          if (!args) {
            const goal = yield* Ref.get(goalRef);
            yield* emitSessionEventForTurn(
              "thread/goal/get",
              goal
                ? `Goal is ${goal.status}: ${goal.objective}`
                : "No active goal is set for this thread.",
              turnId,
            );
          } else if (normalized === "clear") {
            yield* Ref.set(goalRef, null);
            yield* emitSessionEventForTurn("thread/goal/clear", "Thread goal cleared.", turnId);
          } else if (normalized === "pause" || normalized === "resume") {
            const status: CodexSessionRuntimeGoalStatus =
              normalized === "pause" ? "paused" : "active";
            const currentGoal = yield* Ref.get(goalRef);
            if (currentGoal) {
              yield* Ref.set(goalRef, { ...currentGoal, status, updatedAt: now });
              yield* emitSessionEventForTurn(
                "thread/goal/set",
                normalized === "pause" ? "Thread goal paused." : "Thread goal resumed.",
                turnId,
              );
            } else {
              yield* emitSessionEventForTurn(
                "thread/goal/get",
                "No active goal is set for this thread.",
                turnId,
              );
            }
          } else {
            const currentGoal = yield* Ref.get(goalRef);
            const nextGoal = {
              objective: args,
              status: "active",
              createdAt: currentGoal?.createdAt ?? now,
              updatedAt: now,
            } satisfies CodexSessionRuntimeGoalState;
            yield* Ref.set(goalRef, nextGoal);
            const goalPrompt = buildCodexGoalStartPrompt(nextGoal);
            const normalizedModel = normalizeCodexModelSlug((yield* Ref.get(sessionRef)).model);
            const params = yield* buildTurnStartParams({
              threadId: providerThreadId,
              runtimeMode: options.runtimeMode,
              prompt: goalPrompt,
              ...(normalizedModel ? { model: normalizedModel } : {}),
            });
            const rawResponse = yield* client.raw.request("turn/start", params);
            const response = yield* Schema.decodeUnknownEffect(
              EffectCodexSchema.V2TurnStartResponse,
            )(rawResponse).pipe(
              Effect.mapError((error) =>
                toProtocolParseError("Invalid turn/start response payload", error),
              ),
            );
            const startedTurnId = TurnId.make(response.turn.id);
            yield* emitSessionEventForTurn(
              "thread/goal/set",
              `Thread goal set: ${args}`,
              startedTurnId,
            );
            yield* updateSession(sessionRef, {
              status: "running",
              activeTurnId: startedTurnId,
              ...(normalizedModel ? { model: normalizedModel } : {}),
            });
            return yield* buildTurnStartResult(startedTurnId);
          }
          yield* emitSyntheticCommandTurn(providerThreadId, turnId);
          return yield* buildTurnStartResult(turnId);
        }),
      renameThread: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const name = input.name.trim();
          yield* client.request("thread/name/set", {
            threadId: providerThreadId,
            name,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "thread/name/updated",
            payload: {
              threadId: providerThreadId,
              threadName: name,
            },
          });
          const turnId = TurnId.make(`rename-${yield* Random.nextUUIDv4}`);
          yield* emitSyntheticCommandTurn(providerThreadId, turnId);
          return yield* buildTurnStartResult(turnId);
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const effectiveTurnId = turnId ?? session.activeTurnId;
          if (!effectiveTurnId) {
            return;
          }
          yield* client.request("turn/interrupt", {
            threadId: providerThreadId,
            turnId: effectiveTurnId,
          });
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
          return parseThreadSnapshot(response);
        }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
