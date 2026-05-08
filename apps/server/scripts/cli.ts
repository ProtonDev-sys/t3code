#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFs from "node:fs/promises";
import { Data, Effect, FileSystem, Logger, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };

interface PackageJson {
  name: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new CliError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

const copyNodePtyRuntime = Effect.fn("copyNodePtyRuntime")(function* (repoRoot: string) {
  const path = yield* Path.Path;
  const sourcePath = path.join(repoRoot, "apps/server/node_modules/node-pty");
  const targetPath = path.join(repoRoot, "apps/server/dist/node_modules/node-pty");
  const sourceExists = yield* Effect.tryPromise({
    try: () => NodeFs.stat(sourcePath),
    catch: (cause) =>
      new CliError({
        message: `Missing node-pty runtime dependency at ${sourcePath}. Run package install first.`,
        cause,
      }),
  }).pipe(Effect.map((stat) => stat.isDirectory()));

  if (!sourceExists) {
    return yield* new CliError({
      message: `node-pty runtime dependency is not a directory at ${sourcePath}.`,
    });
  }

  yield* Effect.tryPromise({
    try: () => NodeFs.rm(targetPath, { recursive: true, force: true }),
    catch: (cause) =>
      new CliError({
        message: `Failed to clear bundled node-pty runtime at ${targetPath}.`,
        cause,
      }),
  });
  yield* Effect.tryPromise({
    try: () => NodeFs.cp(sourcePath, targetPath, { recursive: true, dereference: true }),
    catch: (cause) =>
      new CliError({
        message: `Failed to copy node-pty runtime dependency to ${targetPath}.`,
        cause,
      }),
  });
  yield* Effect.log("[cli] Bundled node-pty runtime dependency into dist/node_modules");
});

const copyClaudeAgentRuntime = Effect.fn("copyClaudeAgentRuntime")(function* (repoRoot: string) {
  const path = yield* Path.Path;
  const sourceDir = path.join(repoRoot, "apps/server/node_modules/@anthropic-ai/claude-agent-sdk");
  const targetDir = path.join(repoRoot, "apps/server/dist");
  const sourceCli = path.join(sourceDir, "cli.js");
  const targetCli = path.join(targetDir, "cli.js");

  yield* Effect.tryPromise({
    try: () => NodeFs.copyFile(sourceCli, targetCli),
    catch: (cause) =>
      new CliError({
        message: `Failed to copy Claude Agent CLI from ${sourceCli}.`,
        cause,
      }),
  });

  for (const fileName of ["manifest.json", "manifest.zst.json"]) {
    yield* Effect.tryPromise({
      try: () => NodeFs.copyFile(path.join(sourceDir, fileName), path.join(targetDir, fileName)),
      catch: (cause) =>
        new CliError({
          message: `Failed to copy Claude Agent runtime asset ${fileName}.`,
          cause,
        }),
    });
  }

  yield* Effect.tryPromise({
    try: () => NodeFs.rm(path.join(targetDir, "vendor"), { recursive: true, force: true }),
    catch: (cause) =>
      new CliError({
        message: "Failed to clear bundled Claude Agent vendor runtime assets.",
        cause,
      }),
  });
  yield* Effect.tryPromise({
    try: () =>
      NodeFs.cp(path.join(sourceDir, "vendor"), path.join(targetDir, "vendor"), {
        recursive: true,
        dereference: true,
        force: true,
      }),
    catch: (cause) =>
      new CliError({
        message: "Failed to copy Claude Agent vendor runtime assets.",
        cause,
      }),
  });
  yield* Effect.log("[cli] Bundled Claude Agent runtime assets into dist");
});

interface PublishIconBackup {
  readonly targetPath: string;
  readonly backupPath: string;
}

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const backups: PublishIconBackup[] = [];

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);
    const backupPath = `${targetPath}.publish-bak`;

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing publish icon target: ${targetPath}. Run the build subcommand first.`,
      });
    }

    yield* fs.copyFile(targetPath, backupPath);
    yield* fs.copyFile(sourcePath, targetPath);
    backups.push({ targetPath, backupPath });
  }

  yield* Effect.log("[cli] Applied publish icon overrides to dist/client");
  return backups as ReadonlyArray<PublishIconBackup>;
});

const restorePublishIconOverrides = Effect.fn("restorePublishIconOverrides")(function* (
  backups: ReadonlyArray<PublishIconBackup>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const backup of backups) {
    if (!(yield* fs.exists(backup.backupPath))) {
      continue;
    }
    yield* fs.rename(backup.backupPath, backup.targetPath);
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing development icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing development icon target: ${targetPath}. Build web first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
        }),
      );
      yield* copyNodePtyRuntime(repoRoot);
      yield* copyClaudeAgentRuntime(repoRoot);

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const packageJsonPath = path.join(serverDir, "package.json");
      const backupPath = `${packageJsonPath}.bak`;

      // Assert build assets exist
      for (const relPath of ["dist/bin.mjs", "dist/client/index.html"]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new CliError({
            message: `Missing build asset: ${abs}. Run the build subcommand first.`,
          });
        }
      }

      yield* Effect.acquireUseRelease(
        // Acquire: backup package.json, resolve catalog dependencies, and strip devDependencies/scripts
        Effect.gen(function* () {
          const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
          const pkg: PackageJson = {
            name: serverPackageJson.name,
            repository: serverPackageJson.repository,
            bin: serverPackageJson.bin,
            type: serverPackageJson.type,
            version,
            engines: serverPackageJson.engines,
            files: serverPackageJson.files,
            dependencies: resolveCatalogDependencies(
              serverPackageJson.dependencies,
              rootPackageJson.workspaces.catalog,
              "apps/server",
            ),
            overrides: resolveCatalogDependencies(
              rootPackageJson.overrides,
              rootPackageJson.workspaces.catalog,
              "apps/server",
            ),
          };

          const original = yield* fs.readFileString(packageJsonPath);
          yield* fs.writeFileString(backupPath, original);
          yield* fs.writeFileString(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
          yield* Effect.log("[cli] Prepared package.json for publish");

          const iconBackups = yield* applyPublishIconOverrides(repoRoot, serverDir);
          return { iconBackups };
        }),
        // Use: npm publish
        () =>
          Effect.gen(function* () {
            const args = ["publish", "--access", config.access, "--tag", config.tag];
            if (config.provenance) args.push("--provenance");
            if (config.dryRun) args.push("--dry-run");

            yield* Effect.log(`[cli] Running: npm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make("npm", [...args], {
                cwd: serverDir,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                // Windows needs shell mode to resolve .cmd shims.
                shell: process.platform === "win32",
              }),
            );
          }),
        // Release: restore
        (resource: { readonly iconBackups: ReadonlyArray<PublishIconBackup> }) =>
          Effect.gen(function* () {
            yield* restorePublishIconOverrides(resource.iconBackups).pipe(
              Effect.catch((error) =>
                Effect.logError(`[cli] Failed to restore publish icon overrides: ${String(error)}`),
              ),
            );
            yield* fs.rename(backupPath, packageJsonPath);
            if (config.verbose) yield* Effect.log("[cli] Restored original package.json");
          }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
