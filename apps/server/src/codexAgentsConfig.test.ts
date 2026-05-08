import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { listCodexAgents } from "./codexAgentsConfig.ts";

const makeTempDir = Effect.fn("codexAgentsConfig.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("codexAgentsConfig.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

function makeSettings(homePath: string): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        homePath,
      },
    },
  };
}

it.layer(NodeServices.layer)("codexAgentsConfig", (it) => {
  describe("listCodexAgents", () => {
    it.effect("loads multiline .agent.toml files from CODEX_HOME agents", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = yield* makeTempDir("t3code-codex-agents-");
        const agentPath = path.join(homePath, "agents", "reverse_engineer.agent.toml");

        yield* writeTextFile(
          agentPath,
          [
            'name = "Reverse Engineer"',
            'description = "Reads binaries"',
            'developer_instructions = """',
            "Inspect local files only.",
            '"""',
            'nickname_candidates = ["Reverse Engineer", "RE"]',
            'model = "gpt-5.5"',
            'model_reasoning_effort = "high"',
            'sandbox_mode = "workspace-write"',
            "",
          ].join("\n"),
        );

        const result = yield* listCodexAgents(makeSettings(homePath), {});

        expect(result.agentsPath).toBe(path.join(homePath, "agents"));
        expect(result.agents).toMatchObject([
          {
            id: "reverse_engineer",
            name: "Reverse Engineer",
            description: "Reads binaries",
            instructions: "Inspect local files only.",
            nicknameCandidates: ["Reverse Engineer", "RE"],
            model: "gpt-5.5",
            reasoningEffort: "high",
            sandboxMode: "workspace-write",
            managed: false,
            path: agentPath,
          },
        ]);
      }),
    );

    it.effect("marks T3-managed agent files with their owning provider instance", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = yield* makeTempDir("t3code-codex-managed-agents-");
        const agentPath = path.join(homePath, "agents", "reviewer.toml");

        yield* writeTextFile(
          agentPath,
          [
            '# Managed by T3 Code for provider instance "codex_work". Do not edit by hand.',
            'name = "Reviewer"',
            'developer_instructions = "Review the current diff."',
            "",
          ].join("\n"),
        );

        const result = yield* listCodexAgents(makeSettings(homePath), {});

        expect(result.agents).toMatchObject([
          {
            id: "reviewer",
            name: "Reviewer",
            managed: true,
            managedProviderInstanceId: "codex_work",
            path: agentPath,
          },
        ]);
      }),
    );
  });
});
