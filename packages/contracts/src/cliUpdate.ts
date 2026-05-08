import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const CliUpdateStatus = Schema.Literals(["running", "succeeded", "failed"]);
export type CliUpdateStatus = typeof CliUpdateStatus.Type;

export const CliUpdateStartInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  targetVersion: Schema.NullOr(TrimmedNonEmptyString),
});
export type CliUpdateStartInput = typeof CliUpdateStartInput.Type;

export const CliUpdateState = Schema.Struct({
  id: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  status: CliUpdateStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  targetVersion: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.optional(Schema.String),
});
export type CliUpdateState = typeof CliUpdateState.Type;

export const CliUpdateStartResult = Schema.Struct({
  started: Schema.Boolean,
  state: CliUpdateState,
});
export type CliUpdateStartResult = typeof CliUpdateStartResult.Type;

export const CliUpdateStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  state: CliUpdateState,
});
export type CliUpdateStreamEvent = typeof CliUpdateStreamEvent.Type;

export class CliUpdateError extends Schema.TaggedErrorClass<CliUpdateError>()("CliUpdateError", {
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
