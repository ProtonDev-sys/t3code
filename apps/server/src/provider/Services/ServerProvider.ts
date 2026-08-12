import type { ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Acquire a change subscription in the calling fiber before a consumer is
   * forked. This closes the startup window where a lazy stream subscription
   * can miss a provider update on a busy event loop.
   */
  readonly subscribeChanges?: Effect.Effect<Stream.Stream<ServerProvider>, never, Scope.Scope>;
}
