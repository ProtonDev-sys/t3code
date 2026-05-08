import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CodexPluginId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type CodexPluginId = typeof CodexPluginId.Type;

export const CodexPluginSummary = Schema.Struct({
  id: CodexPluginId,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  marketplace: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  developerName: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  cached: Schema.Boolean,
  installed: Schema.optionalKey(Schema.Boolean),
  installPolicy: Schema.optionalKey(Schema.String),
  sourceType: Schema.optionalKey(Schema.String),
  marketplacePath: Schema.optionalKey(Schema.String),
  remoteMarketplaceName: Schema.optionalKey(Schema.String),
  path: Schema.optional(Schema.String),
});
export type CodexPluginSummary = typeof CodexPluginSummary.Type;

export const CodexPluginListInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type CodexPluginListInput = typeof CodexPluginListInput.Type;

export const CodexPluginListResult = Schema.Struct({
  configPath: Schema.String,
  pluginsPath: Schema.String,
  plugins: Schema.Array(CodexPluginSummary),
});
export type CodexPluginListResult = typeof CodexPluginListResult.Type;

export const CodexPluginUpdateInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  id: CodexPluginId,
  enabled: Schema.Boolean,
});
export type CodexPluginUpdateInput = typeof CodexPluginUpdateInput.Type;

export const CodexPluginInstallInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  pluginName: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  marketplacePath: Schema.optional(Schema.String),
  remoteMarketplaceName: Schema.optional(Schema.String),
});
export type CodexPluginInstallInput = typeof CodexPluginInstallInput.Type;

export const CodexAutomationId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type CodexAutomationId = typeof CodexAutomationId.Type;

export const CodexAutomationSummary = Schema.Struct({
  id: CodexAutomationId,
  name: TrimmedNonEmptyString,
  prompt: Schema.optional(Schema.String),
  status: Schema.String,
  enabled: Schema.Boolean,
  rrule: Schema.optional(Schema.String),
  executionEnvironment: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  cwds: Schema.Array(Schema.String),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  path: Schema.String,
});
export type CodexAutomationSummary = typeof CodexAutomationSummary.Type;

export const CodexAutomationListInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type CodexAutomationListInput = typeof CodexAutomationListInput.Type;

export const CodexAutomationListResult = Schema.Struct({
  automationsPath: Schema.String,
  automations: Schema.Array(CodexAutomationSummary),
});
export type CodexAutomationListResult = typeof CodexAutomationListResult.Type;

export const CodexAutomationUpdateInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  id: CodexAutomationId,
  enabled: Schema.Boolean,
});
export type CodexAutomationUpdateInput = typeof CodexAutomationUpdateInput.Type;

export const CodexAutomationSaveInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  originalId: Schema.optional(CodexAutomationId),
  id: CodexAutomationId,
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  rrule: Schema.optional(Schema.String),
  executionEnvironment: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  cwds: Schema.Array(Schema.String),
});
export type CodexAutomationSaveInput = typeof CodexAutomationSaveInput.Type;

export const CodexAutomationDeleteInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  id: CodexAutomationId,
});
export type CodexAutomationDeleteInput = typeof CodexAutomationDeleteInput.Type;

export const CodexUsageHistorySourceKind = Schema.Literals([
  "cli",
  "vscode",
  "subagent",
  "automation",
  "other",
]);
export type CodexUsageHistorySourceKind = typeof CodexUsageHistorySourceKind.Type;

export const CodexUsageHistoryThread = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  sourceKind: CodexUsageHistorySourceKind,
  sourceLabel: Schema.String,
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  tokensUsed: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CodexUsageHistoryThread = typeof CodexUsageHistoryThread.Type;

export const CodexUsageHistoryListInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  updatedAfter: Schema.optional(Schema.String),
});
export type CodexUsageHistoryListInput = typeof CodexUsageHistoryListInput.Type;

export const CodexUsageHistoryListResult = Schema.Struct({
  statePath: Schema.String,
  threads: Schema.Array(CodexUsageHistoryThread),
});
export type CodexUsageHistoryListResult = typeof CodexUsageHistoryListResult.Type;

export class CodexExtensionsConfigError extends Schema.TaggedErrorClass<CodexExtensionsConfigError>()(
  "CodexExtensionsConfigError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const CodexPluginUpdateResult = CodexPluginListResult;
export type CodexPluginUpdateResult = typeof CodexPluginUpdateResult.Type;

export const CodexPluginInstallResult = CodexPluginListResult;
export type CodexPluginInstallResult = typeof CodexPluginInstallResult.Type;

export const CodexAutomationUpdateResult = CodexAutomationListResult;
export type CodexAutomationUpdateResult = typeof CodexAutomationUpdateResult.Type;

export const CodexAutomationSaveResult = CodexAutomationListResult;
export type CodexAutomationSaveResult = typeof CodexAutomationSaveResult.Type;

export const CodexAutomationDeleteResult = CodexAutomationListResult;
export type CodexAutomationDeleteResult = typeof CodexAutomationDeleteResult.Type;

export const DEFAULT_CODEX_USAGE_HISTORY_LIMIT = 5_000;
