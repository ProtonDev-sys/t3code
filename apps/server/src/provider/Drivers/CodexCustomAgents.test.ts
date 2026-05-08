import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { ProviderCustomAgentId, ProviderInstanceId } from "@t3tools/contracts";
import type { CodexHomeLayout } from "./CodexHomeLayout.ts";
import { materializeCodexCustomAgents } from "./CodexCustomAgents.ts";

const makeTempDir = Effect.fn("CodexCustomAgents.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

function makeLayout(homePath: string): CodexHomeLayout {
  return {
    mode: "direct",
    sharedHomePath: homePath,
    effectiveHomePath: homePath,
    continuationKey: `codex:home:${homePath}`,
  };
}

it.layer(NodeServices.layer)("CodexCustomAgents", (it) => {
  describe("materializeCodexCustomAgents", () => {
    it.effect("does not remove managed agents owned by another provider instance", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* makeTempDir("t3code-codex-custom-agents-");
        const layout = makeLayout(homePath);
        const personalInstanceId = ProviderInstanceId.make("codex_personal");
        const workInstanceId = ProviderInstanceId.make("codex_work");
        const reviewerPath = path.join(homePath, "agents", "reviewer.toml");
        const builderPath = path.join(homePath, "agents", "builder.toml");

        yield* materializeCodexCustomAgents(layout, personalInstanceId, [
          {
            id: ProviderCustomAgentId.make("reviewer"),
            name: "Reviewer",
            instructions: "Review code for regressions.",
            enabled: true,
          },
        ]);
        yield* materializeCodexCustomAgents(layout, workInstanceId, [
          {
            id: ProviderCustomAgentId.make("builder"),
            name: "Builder",
            instructions: "Implement requested changes.",
            enabled: true,
          },
        ]);

        expect(yield* fileSystem.exists(reviewerPath)).toBe(true);
        expect(yield* fileSystem.exists(builderPath)).toBe(true);

        yield* materializeCodexCustomAgents(layout, personalInstanceId, []);

        expect(yield* fileSystem.exists(reviewerPath)).toBe(false);
        expect(yield* fileSystem.exists(builderPath)).toBe(true);
      }),
    );
  });
});
