import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderCustomAgentId, ProviderInstanceId } from "./providerInstance.ts";

export const CodexAgentSummary = Schema.Struct({
  id: ProviderCustomAgentId,
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  instructions: TrimmedNonEmptyString,
  nicknameCandidates: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  reasoningEffort: Schema.optional(Schema.String),
  sandboxMode: Schema.optional(Schema.String),
  managed: Schema.Boolean,
  managedProviderInstanceId: Schema.optional(ProviderInstanceId),
  path: Schema.String,
});
export type CodexAgentSummary = typeof CodexAgentSummary.Type;

export const CodexAgentListInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type CodexAgentListInput = typeof CodexAgentListInput.Type;

export const CodexAgentListResult = Schema.Struct({
  agentsPath: Schema.String,
  agents: Schema.Array(CodexAgentSummary),
});
export type CodexAgentListResult = typeof CodexAgentListResult.Type;

export class CodexAgentConfigError extends Schema.TaggedErrorClass<CodexAgentConfigError>()(
  "CodexAgentConfigError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
