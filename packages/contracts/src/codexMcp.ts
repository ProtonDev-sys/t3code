import { Effect, Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CodexMcpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export type CodexMcpServerName = typeof CodexMcpServerName.Type;

export const CodexMcpServerTransport = Schema.Literals(["stdio", "sse", "http", "unknown"]);
export type CodexMcpServerTransport = typeof CodexMcpServerTransport.Type;
export const CodexMcpAddServerTransport = Schema.Literals(["stdio", "sse", "http"]);
export type CodexMcpAddServerTransport = typeof CodexMcpAddServerTransport.Type;

export const CodexMcpServerSummary = Schema.Struct({
  name: CodexMcpServerName,
  transport: CodexMcpServerTransport,
  enabled: Schema.Boolean,
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  toolCount: Schema.Number,
});
export type CodexMcpServerSummary = typeof CodexMcpServerSummary.Type;

export const CodexMcpListInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type CodexMcpListInput = typeof CodexMcpListInput.Type;

export const CodexMcpListResult = Schema.Struct({
  configPath: Schema.String,
  servers: Schema.Array(CodexMcpServerSummary),
});
export type CodexMcpListResult = typeof CodexMcpListResult.Type;

export const CodexMcpAddServerInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  name: CodexMcpServerName,
  transport: CodexMcpAddServerTransport,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
});
export type CodexMcpAddServerInput = typeof CodexMcpAddServerInput.Type;

export const CodexMcpUpdateServerInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  name: CodexMcpServerName,
  enabled: Schema.Boolean,
});
export type CodexMcpUpdateServerInput = typeof CodexMcpUpdateServerInput.Type;

export const CodexMcpDeleteServerInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  name: CodexMcpServerName,
});
export type CodexMcpDeleteServerInput = typeof CodexMcpDeleteServerInput.Type;

export class CodexMcpConfigError extends Schema.TaggedErrorClass<CodexMcpConfigError>()(
  "CodexMcpConfigError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
