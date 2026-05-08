import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { listCodexMcpServers } from "./codexMcpConfig.ts";

it.layer(NodeServices.layer)("codexMcpConfig", (it) => {
  describe("listCodexMcpServers", () => {
    it.effect("returns a typed error for an unknown provider instance", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          listCodexMcpServers(DEFAULT_SERVER_SETTINGS, {
            providerInstanceId: ProviderInstanceId.make("missing_codex"),
          }),
        );

        expect(error._tag).toBe("CodexMcpConfigError");
        expect(error.message).toContain("Provider instance 'missing_codex' was not found.");
      }),
    );

    it.effect("returns a typed error for a non-Codex provider instance", () =>
      Effect.gen(function* () {
        const providerInstanceId = ProviderInstanceId.make("claude_work");
        const settings: ServerSettings = {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [providerInstanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              displayName: "Claude Work",
              config: {},
              environment: [],
            },
          },
        };

        const error = yield* Effect.flip(
          listCodexMcpServers(settings, {
            providerInstanceId,
          }),
        );

        expect(error._tag).toBe("CodexMcpConfigError");
        expect(error.message).toContain("Provider instance 'claude_work' is not a Codex instance.");
      }),
    );
  });
});
