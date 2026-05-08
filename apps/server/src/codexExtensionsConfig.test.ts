import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import {
  listCodexAutomations,
  listCodexPlugins,
  listCodexUsageHistory,
  updateCodexAutomation,
  updateCodexPlugin,
} from "./codexExtensionsConfig.ts";

const makeTempDir = Effect.fn("codexExtensionsConfig.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("codexExtensionsConfig.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

function makeSettings(
  homePath: string,
  codexOverrides?: Partial<(typeof DEFAULT_SERVER_SETTINGS.providers)["codex"]>,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        homePath,
        ...codexOverrides,
      },
    },
  };
}

function seedCodexState(statePath: string) {
  const db = new DatabaseSync(statePath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        source TEXT,
        model_provider TEXT,
        model TEXT,
        tokens_used INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      )
    `);
    db.prepare(`
      INSERT INTO threads (
        id,
        source,
        model_provider,
        model,
        tokens_used,
        created_at,
        updated_at,
        created_at_ms,
        updated_at_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "thread-cli",
      "cli",
      "openai",
      "gpt-5.5",
      12345,
      1_788_500_000,
      1_788_501_000,
      1_788_500_000_000,
      1_788_501_000_000,
    );
  } finally {
    db.close();
  }
}

it.layer(NodeServices.layer)("codexExtensionsConfig", (it) => {
  describe("plugins", () => {
    it.effect("loads cached Codex plugins and rewrites enabled state", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* makeTempDir("t3code-codex-extensions-");
        const manifestPath = path.join(
          homePath,
          "plugins",
          "cache",
          "openai-bundled",
          "browser-use",
          "0.1.0",
          ".codex-plugin",
          "plugin.json",
        );
        const configPath = path.join(homePath, "config.toml");
        const settings = makeSettings(homePath, {
          binaryPath: path.join(homePath, "missing-codex"),
        });

        yield* writeTextFile(
          configPath,
          [
            '[plugins."browser-use@openai-bundled"]',
            "enabled = true",
            "",
            '[plugins."missing@local"]',
            "enabled = false",
            "",
          ].join("\n"),
        );
        yield* writeTextFile(
          manifestPath,
          JSON.stringify({
            name: "browser-use",
            version: "0.1.0",
            interface: {
              displayName: "Browser Use",
              shortDescription: "Browser automation",
              developerName: "OpenAI",
              category: "tools",
            },
          }),
        );

        const loaded = yield* listCodexPlugins(settings, {});

        expect(loaded.configPath).toBe(configPath);
        expect(loaded.plugins).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "browser-use@openai-bundled",
              displayName: "Browser Use",
              enabled: true,
              cached: true,
            }),
            expect.objectContaining({
              id: "missing@local",
              enabled: false,
              cached: false,
            }),
          ]),
        );

        const updated = yield* updateCodexPlugin(settings, {
          id: "browser-use@openai-bundled",
          enabled: false,
        });
        const raw = yield* fileSystem.readFileString(configPath);

        expect(
          updated.plugins.find((plugin) => plugin.id === "browser-use@openai-bundled"),
        ).toMatchObject({ enabled: false });
        expect(raw).toContain('[plugins."browser-use@openai-bundled"]\nenabled = false');
      }),
    );
  });

  describe("automations", () => {
    it.effect("loads local Codex automations and toggles their status", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* makeTempDir("t3code-codex-automations-");
        const automationPath = path.join(
          homePath,
          "automations",
          "protonn-chess-optimiser",
          "automation.toml",
        );

        yield* writeTextFile(
          automationPath,
          [
            'id = "protonn-chess-optimiser"',
            'name = "Chess Optimiser"',
            'status = "PAUSED"',
            'rrule = "FREQ=DAILY"',
            'model = "gpt-5.5"',
            'reasoning_effort = "high"',
            'cwds = ["C:\\\\repo"]',
            "",
          ].join("\n"),
        );

        const loaded = yield* listCodexAutomations(makeSettings(homePath), {});

        expect(loaded.automationsPath).toBe(path.join(homePath, "automations"));
        expect(loaded.automations).toEqual([
          expect.objectContaining({
            id: "protonn-chess-optimiser",
            name: "Chess Optimiser",
            enabled: false,
            model: "gpt-5.5",
            reasoningEffort: "high",
            cwds: ["C:\\repo"],
          }),
        ]);

        const updated = yield* updateCodexAutomation(makeSettings(homePath), {
          id: "protonn-chess-optimiser",
          enabled: true,
        });
        const raw = yield* fileSystem.readFileString(automationPath);

        expect(updated.automations[0]).toMatchObject({ enabled: true, status: "ACTIVE" });
        expect(raw).toContain('status = "ACTIVE"');
      }),
    );
  });

  describe("usage history", () => {
    it.effect("reads token-only Codex CLI history from local state", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = yield* makeTempDir("t3code-codex-history-");
        const statePath = path.join(homePath, "state_5.sqlite");

        seedCodexState(statePath);

        const loaded = yield* listCodexUsageHistory(makeSettings(homePath), { limit: 10 });
        const incremental = yield* listCodexUsageHistory(makeSettings(homePath), {
          limit: 10,
          updatedAfter: "2099-01-01T00:00:00.000Z",
        });

        expect(loaded.statePath).toBe(statePath);
        expect(loaded.threads).toEqual([
          expect.objectContaining({
            threadId: "thread-cli",
            sourceKind: "cli",
            sourceLabel: "Codex CLI",
            tokensUsed: 12345,
            model: "gpt-5.5",
            modelProvider: "openai",
          }),
        ]);
        expect(incremental.threads).toEqual([]);
      }),
    );
  });
});
