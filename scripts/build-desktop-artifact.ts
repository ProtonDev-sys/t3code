#!/usr/bin/env node

import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as NodePath from "node:path";

import { BRAND_ASSET_PATHS, type WebAssetBrand } from "./lib/brand-assets.ts";
import { getDefaultBuildArch } from "./lib/build-target-arch.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, FileSystem, Layer, Logger, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);
const MockUpdateServerPortSchema = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

interface PlatformConfig {
  readonly defaultTarget: string;
  readonly bundleChoices: ReadonlyArray<string>;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    defaultTarget: "dmg",
    bundleChoices: ["dmg", "app"],
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    defaultTarget: "appimage",
    bundleChoices: ["appimage", "deb", "rpm"],
    archChoices: ["x64", "arm64"],
  },
  win: {
    defaultTarget: "nsis",
    bundleChoices: ["nsis", "msi"],
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
  readonly mockUpdates: Option.Option<boolean>;
  readonly mockUpdateServerPort: Option.Option<number>;
}

export interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
  readonly updaterPubkey: string | undefined;
  readonly updaterEndpoints: readonly string[];
  readonly createUpdaterArtifacts: boolean;
}

export interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
  mockUpdates: Config.boolean("T3CODE_DESKTOP_MOCK_UPDATES").pipe(Config.withDefault(false)),
  mockUpdateServerPort: Config.string("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(Config.option),
  updaterPubkey: Config.string("T3CODE_TAURI_UPDATER_PUBKEY").pipe(Config.option),
  updaterFallbackPubkey: Config.string("TAURI_SIGNING_PUBLIC_KEY").pipe(Config.option),
  updaterEndpoints: Config.string("T3CODE_TAURI_UPDATER_ENDPOINTS").pipe(Config.option),
  createUpdaterArtifacts: Config.boolean("T3CODE_TAURI_CREATE_UPDATER_ARTIFACTS").pipe(
    Config.withDefault(false),
  ),
});

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  return getDefaultBuildArch(platform, process.arch, process.env, PLATFORM_CONFIG[platform]);
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);

const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

function resolveBunExecutable(): string {
  if (process.platform !== "win32") {
    return "bun";
  }

  const candidates = [
    process.env.BUN_INSTALL ? NodePath.join(process.env.BUN_INSTALL, "bin", "bun.exe") : null,
    process.env.APPDATA
      ? NodePath.join(process.env.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe")
      : null,
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return "bun";
}

export const resolveMockUpdateServerPort = Effect.fn("resolveMockUpdateServerPort")(function* (
  mockUpdateServerPort: string | undefined,
) {
  const port = mockUpdateServerPort?.trim();
  if (!port) {
    return undefined;
  }

  return yield* Schema.decodeUnknownEffect(MockUpdateServerPortSchema)(port);
});

export function resolveMockUpdateServerUrl(mockUpdateServerPort: number | undefined): string {
  return `http://localhost:${mockUpdateServerPort ?? 3000}`;
}

function splitCsv(rawValue: string | undefined): readonly string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function resolveUpdaterEndpointConfig(input: {
  readonly configuredEndpoints: string | undefined;
  readonly mockUpdates: boolean;
  readonly mockUpdateServerPort: number | undefined;
}): readonly string[] {
  const endpoints = [...splitCsv(input.configuredEndpoints)];
  if (input.mockUpdates) {
    endpoints.unshift(`${resolveMockUpdateServerUrl(input.mockUpdateServerPort)}/latest.json`);
  }
  return endpoints;
}

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function resolveDesktopProductName(version: string): string {
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3 Code (Nightly)"
    : (desktopPackageJson.productName ?? "T3 Code");
}

export function resolveDesktopBuildIconAssets(version: string): DesktopBuildIconAssets {
  if (resolveDesktopUpdateChannel(version) === "nightly") {
    return {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    };
  }

  return {
    macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
    linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
    windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  };
}

export function resolveDesktopWebAssetBrand(version: string): WebAssetBrand {
  return resolveDesktopUpdateChannel(version) === "nightly" ? "nightly" : "production";
}

function resolveUpdaterOs(platform: typeof BuildPlatform.Type): string {
  switch (platform) {
    case "mac":
      return "darwin";
    case "linux":
      return "linux";
    case "win":
      return "windows";
  }
}

function resolveUpdaterArch(arch: typeof BuildArch.Type): string {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    case "universal":
      return "universal";
  }
}

function resolveUpdaterInstaller(target: string): string {
  switch (target.toLowerCase()) {
    case "app":
    case "dmg":
      return "app";
    case "appimage":
      return "appimage";
    case "deb":
      return "deb";
    case "msi":
      return "msi";
    case "nsis":
      return "nsis";
    case "rpm":
      return "rpm";
    default:
      return target.toLowerCase();
  }
}

function resolveUpdaterTargetKey(
  options: Pick<ResolvedBuildOptions, "arch" | "platform"> & {
    readonly target: string;
  },
) {
  return `${resolveUpdaterOs(options.platform)}-${resolveUpdaterArch(options.arch)}-${resolveUpdaterInstaller(options.target)}`;
}

function endpointDirectoryUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  const pathname = url.pathname;
  url.pathname = pathname.endsWith("/") ? pathname : pathname.replace(/\/[^/]*$/, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function resolveUpdaterAssetBaseUrl(options: ResolvedBuildOptions): URL | undefined {
  const configuredBaseUrl = process.env.T3CODE_TAURI_UPDATER_ASSET_BASE_URL?.trim();
  if (configuredBaseUrl) {
    const url = new URL(configuredBaseUrl);
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    return url;
  }

  const firstEndpoint = options.updaterEndpoints[0];
  return firstEndpoint ? endpointDirectoryUrl(firstEndpoint) : undefined;
}

function makeUpdaterAssetUrl(baseUrl: URL, fileName: string): string {
  return new URL(fileName, baseUrl).toString();
}

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();
  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const mockUpdates = resolveBooleanFlag(input.mockUpdates, env.mockUpdates);
  const outputDir = path.resolve(
    repoRoot,
    mergeOptions(input.outputDir, env.outputDir, mockUpdates ? "release-mock" : "release"),
  );
  const mockUpdateServerPort =
    Option.getOrUndefined(input.mockUpdateServerPort) ??
    (yield* resolveMockUpdateServerPort(Option.getOrUndefined(env.mockUpdateServerPort)).pipe(
      Effect.mapError(
        (cause) =>
          new BuildScriptError({
            message: "Invalid mock update server port.",
            cause,
          }),
      ),
    ));
  const updaterPubkey =
    Option.getOrUndefined(env.updaterPubkey) ?? Option.getOrUndefined(env.updaterFallbackPubkey);
  const updaterEndpoints = resolveUpdaterEndpointConfig({
    configuredEndpoints: Option.getOrUndefined(env.updaterEndpoints),
    mockUpdates,
    mockUpdateServerPort,
  });

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild: resolveBooleanFlag(input.skipBuild, env.skipBuild),
    keepStage: resolveBooleanFlag(input.keepStage, env.keepStage),
    signed: resolveBooleanFlag(input.signed, env.signed),
    verbose: resolveBooleanFlag(input.verbose, env.verbose),
    mockUpdates,
    mockUpdateServerPort,
    updaterPubkey,
    updaterEndpoints,
    createUpdaterArtifacts:
      env.createUpdaterArtifacts ||
      Boolean(
        process.env.TAURI_SIGNING_PRIVATE_KEY && updaterPubkey && updaterEndpoints.length > 0,
      ),
  } satisfies ResolvedBuildOptions;
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function resolveRustTarget(platform: typeof BuildPlatform.Type, arch: typeof BuildArch.Type) {
  if (platform === "win") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (platform === "mac") {
    if (arch === "universal") return "universal-apple-darwin";
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

function resolveTauriBundleDir(input: {
  readonly desktopDir: string;
  readonly target: string;
  readonly rustTarget: string | undefined;
}) {
  const targetRoot = input.rustTarget
    ? `${input.desktopDir}/src-tauri/target/${input.rustTarget}/release`
    : `${input.desktopDir}/src-tauri/target/release`;
  return `${targetRoot}/bundle/${input.target}`;
}

function resolveBundledNodeRuntimePath(input: {
  readonly desktopDir: string;
  readonly platform: typeof BuildPlatform.Type;
}) {
  return NodePath.join(
    input.desktopDir,
    "dist",
    "node",
    input.platform === "win" ? "node.exe" : "node",
  );
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = NodePath.resolve(parentPath);
  const child = NodePath.resolve(childPath);
  const relative = NodePath.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

function removeDirectoryInside(parentPath: string, directoryPath: string): void {
  if (!isPathInside(parentPath, directoryPath)) {
    throw new Error(`Refusing to remove directory outside ${parentPath}: ${directoryPath}`);
  }
  rmSync(directoryPath, { force: true, recursive: true });
}

function removeArtifactOutputDirectory(repoRoot: string, outputDir: string): void {
  const relative = NodePath.relative(NodePath.resolve(repoRoot), NodePath.resolve(outputDir));
  const firstSegment = relative.split(/[\\/]/)[0] ?? "";
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    NodePath.isAbsolute(relative) ||
    !firstSegment.startsWith("release")
  ) {
    return;
  }
  rmSync(outputDir, { force: true, recursive: true });
}

export function createTauriConfigOverride(
  version: string,
  productName: string,
  options: Pick<
    ResolvedBuildOptions,
    "createUpdaterArtifacts" | "mockUpdates" | "updaterEndpoints" | "updaterPubkey"
  >,
) {
  const config: {
    productName: string;
    version: string;
    bundle?: { createUpdaterArtifacts: boolean };
    plugins: {
      updater: {
        dangerousInsecureTransportProtocol?: boolean;
        endpoints: readonly string[];
        pubkey: string;
      };
    };
  } = {
    productName,
    version,
    plugins: {
      updater: {
        endpoints: [],
        pubkey: "",
      },
    },
  };

  if (options.createUpdaterArtifacts) {
    config.bundle = { createUpdaterArtifacts: true };
  }

  if (options.updaterPubkey && options.updaterEndpoints.length > 0) {
    config.plugins.updater = {
      pubkey: options.updaterPubkey,
      endpoints: options.updaterEndpoints,
      ...(options.mockUpdates ? { dangerousInsecureTransportProtocol: true } : {}),
    };
  }

  return config;
}

const writeTauriUpdateManifest = Effect.fn("writeTauriUpdateManifest")(function* (input: {
  readonly appVersion: string;
  readonly copiedArtifacts: ReadonlyArray<string>;
  readonly options: ResolvedBuildOptions;
  readonly productName: string;
}) {
  if (!input.options.createUpdaterArtifacts) {
    return;
  }

  if (input.options.arch === "universal") {
    return yield* new BuildScriptError({
      message: "Tauri updater manifests require a concrete architecture, not universal.",
    });
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const signaturePath = input.copiedArtifacts.find((artifact) => artifact.endsWith(".sig"));
  if (!signaturePath) {
    return yield* new BuildScriptError({
      message: "Tauri updater artifacts were requested, but no .sig file was produced.",
    });
  }

  const artifactPath = signaturePath.slice(0, -".sig".length);
  if (!input.copiedArtifacts.includes(artifactPath) && !(yield* fs.exists(artifactPath))) {
    return yield* new BuildScriptError({
      message: `Tauri updater signature has no matching artifact: ${signaturePath}`,
    });
  }

  const assetBaseUrl = resolveUpdaterAssetBaseUrl(input.options);
  if (!assetBaseUrl) {
    return yield* new BuildScriptError({
      message:
        "Tauri updater artifacts were produced, but no updater endpoint or T3CODE_TAURI_UPDATER_ASSET_BASE_URL was configured.",
    });
  }

  const manifestStem = resolveDesktopUpdateChannel(input.appVersion);
  const targetKey = resolveUpdaterTargetKey(input.options);
  const artifactFileName = path.basename(artifactPath);
  const signature = readFileSync(signaturePath, "utf8").trim();
  const manifestPath = path.join(input.options.outputDir, `${manifestStem}-${targetKey}.json`);
  const manifest = {
    version: input.appVersion,
    notes: `${input.productName} ${input.appVersion}`,
    pub_date: new Date().toISOString(),
    platforms: {
      [targetKey]: {
        signature,
        url: makeUpdaterAssetUrl(assetBaseUrl, artifactFileName),
      },
    },
  };

  yield* fs.writeFileString(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  yield* Effect.log(`[desktop-artifact] Wrote Tauri updater manifest: ${manifestPath}`);
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const appVersion = options.version ?? serverPackageJson.version;
  const desktopDir = path.join(repoRoot, "apps/desktop");
  const tauriDir = path.join(desktopDir, "src-tauri");
  const target = options.target.toLowerCase();
  const rustTarget = resolveRustTarget(options.platform, options.arch);
  const bundleDir = resolveTauriBundleDir({ desktopDir, target, rustTarget });
  const bunExecutable = resolveBunExecutable();

  if (options.updaterEndpoints.length > 0 && !options.updaterPubkey) {
    return yield* new BuildScriptError({
      message: "Tauri updater endpoints were configured, but no updater public key was provided.",
    });
  }

  if (options.createUpdaterArtifacts && options.updaterEndpoints.length === 0) {
    return yield* new BuildScriptError({
      message: "Tauri updater artifacts were requested, but no updater endpoint was configured.",
    });
  }

  if (!PLATFORM_CONFIG[options.platform].bundleChoices.includes(target)) {
    return yield* new BuildScriptError({
      message: `Unsupported Tauri bundle target '${options.target}' for ${options.platform}.`,
    });
  }

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building web, server, and Tauri shell artifacts...");
    yield* runCommand(
      ChildProcess.make(bunExecutable, ["run", "build:desktop"], {
        cwd: repoRoot,
        stderr: "inherit",
        stdout: options.verbose ? "inherit" : "ignore",
      }),
    );
  }

  const serverEntry = path.join(repoRoot, "apps/server/dist/bin.mjs");
  const clientEntry = path.join(repoRoot, "apps/server/dist/client/index.html");
  const claudeCliEntry = path.join(repoRoot, "apps/server/dist/cli.js");
  const nodePtyEntry = path.join(repoRoot, "apps/server/dist/node_modules/node-pty/package.json");
  const sshHelperEntry = path.join(repoRoot, "apps/desktop/dist/ssh-helper.mjs");
  const nodeRuntimeEntry = resolveBundledNodeRuntimePath({
    desktopDir,
    platform: options.platform,
  });
  for (const required of [
    serverEntry,
    clientEntry,
    claudeCliEntry,
    nodePtyEntry,
    sshHelperEntry,
    nodeRuntimeEntry,
  ]) {
    if (!(yield* fs.exists(required))) {
      return yield* new BuildScriptError({
        message: `Missing desktop runtime asset at ${required}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  const configOverride = JSON.stringify(
    createTauriConfigOverride(appVersion, resolveDesktopProductName(appVersion), options),
  );
  const configOverrideDir = path.join(tauriDir, "target");
  const configOverridePath = path.join(
    configOverrideDir,
    `t3code-tauri-config-${process.pid}.json`,
  );
  yield* fs.makeDirectory(configOverrideDir, { recursive: true });
  yield* fs.writeFileString(configOverridePath, configOverride);

  const args = [
    "x",
    "tauri",
    "build",
    "--bundles",
    target,
    "--target",
    rustTarget,
    "--config",
    configOverridePath,
    "--ci",
    ...(options.signed || options.createUpdaterArtifacts ? [] : ["--no-sign"]),
  ];

  yield* Effect.try({
    try: () => {
      removeDirectoryInside(path.join(tauriDir, "target"), bundleDir);
      removeArtifactOutputDirectory(repoRoot, options.outputDir);
    },
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not clean stale desktop build artifacts before packaging.",
        cause,
      }),
  });

  yield* Effect.log(
    `[desktop-artifact] Building Tauri ${options.platform}/${target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make(bunExecutable, args, {
      cwd: desktopDir,
      stderr: "inherit",
      stdout: options.verbose ? "inherit" : "ignore",
    }),
  );

  if (!(yield* fs.exists(bundleDir))) {
    return yield* new BuildScriptError({
      message: `Tauri build completed but bundle directory was not found at ${bundleDir}`,
    });
  }

  yield* fs.makeDirectory(options.outputDir, { recursive: true });
  const entries = yield* fs.readDirectory(bundleDir);
  const copiedArtifacts: string[] = [];
  for (const entry of entries) {
    const from = path.join(bundleDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || (stat.type !== "File" && stat.type !== "Directory")) continue;
    const to = path.join(options.outputDir, entry);
    if (stat.type === "Directory") {
      yield* fs.copy(from, to);
    } else {
      yield* fs.copyFile(from, to);
    }
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Tauri build completed but no artifacts were produced in ${bundleDir}`,
    });
  }
  yield* writeTauriUpdateManifest({
    appVersion,
    copiedArtifacts,
    options,
    productName: resolveDesktopProductName(appVersion),
  });

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription("Bundle target, for example nsis/msi/dmg/appimage."),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription("Skip `bun run build:desktop` and use existing dist artifacts."),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Compatibility flag retained for older release workflows."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription("Allow platform signing instead of passing Tauri --no-sign."),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Use release-mock as the default output directory."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.integer("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a Tauri desktop artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
