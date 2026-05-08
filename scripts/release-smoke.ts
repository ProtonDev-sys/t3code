import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveBunExecutable(): string {
  if (process.platform !== "win32") {
    return "bun";
  }

  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun.exe") : null,
    process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe")
      : null,
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return "bun";
}

const workspaceFiles = [
  "package.json",
  "bun.lock",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/marketing/package.json",
  "packages/client-runtime/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "packages/ssh/package.json",
  "packages/tailscale/package.json",
  "packages/effect-acp/package.json",
  "packages/effect-codex-app-server/package.json",
  "scripts/package.json",
] as const;

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of workspaceFiles) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }

  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    readonly patchedDependencies?: Record<string, string>;
  };

  for (const relativePath of Object.values(packageJson.patchedDependencies ?? {})) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
}

function writeTauriManifestFixture(
  targetRoot: string,
  channel: "latest" | "nightly",
  target: string,
  url: string,
): string {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });
  const manifestPath = resolve(assetDirectory, `${channel}-${target}.json`);

  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: "9.9.9-smoke.0",
        notes: "T3 Code smoke",
        pub_date: "2026-03-08T10:32:14.587Z",
        platforms: {
          [target]: {
            url,
            signature: `${target}-signature`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  return manifestPath;
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertMissing(path: string, message: string): void {
  if (existsSync(path)) {
    throw new Error(message);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "t3-release-smoke-"));

try {
  const bunExecutable = resolveBunExecutable();
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync(bunExecutable, ["install", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const nightlyReleaseMetadata = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
      "--date",
      "20260413",
      "--run-number",
      "321",
      "--sha",
      "abcdef1234567890",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assertContains(
    nightlyReleaseMetadata,
    "version=9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly version.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "tag=v9.9.10-nightly.20260413.321",
    "Expected nightly metadata to contain the derived nightly tag.",
  );
  assertContains(
    nightlyReleaseMetadata,
    "name=T3 Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
    "Expected nightly metadata to include the short commit SHA in the release name.",
  );

  const latestWinManifestPath = writeTauriManifestFixture(
    tempRoot,
    "latest",
    "windows-x86_64-nsis",
    "https://example.invalid/releases/T3%20Code%20(Alpha)_9.9.9-smoke.0_x64-setup.exe",
  );
  const latestMacArmManifestPath = writeTauriManifestFixture(
    tempRoot,
    "latest",
    "darwin-aarch64-app",
    "https://example.invalid/releases/T3%20Code_9.9.9-smoke.0_aarch64.dmg",
  );
  const latestMacX64ManifestPath = writeTauriManifestFixture(
    tempRoot,
    "latest",
    "darwin-x86_64-app",
    "https://example.invalid/releases/T3%20Code_9.9.9-smoke.0_x64.dmg",
  );
  const nightlyLinuxManifestPath = writeTauriManifestFixture(
    tempRoot,
    "nightly",
    "linux-x86_64-appimage",
    "https://example.invalid/releases/T3%20Code_9.9.10-nightly.20260413.321_x64.AppImage",
  );
  const releaseAssetsDir = resolve(tempRoot, "release-assets");

  for (const channel of ["latest", "nightly"] as const) {
    const manifestPaths = readdirSync(releaseAssetsDir)
      .filter((entry) => entry.startsWith(`${channel}-`) && entry.endsWith(".json"))
      .map((entry) => resolve(releaseAssetsDir, entry));
    if (manifestPaths.length === 0) {
      continue;
    }
    execFileSync(
      process.execPath,
      [
        resolve(repoRoot, "scripts/merge-tauri-update-manifests.ts"),
        "--output",
        resolve(releaseAssetsDir, `${channel}.json`),
        ...manifestPaths,
      ],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );
    for (const manifestPath of manifestPaths) {
      rmSync(manifestPath, { force: true });
    }
  }

  const latestManifestPath = resolve(releaseAssetsDir, "latest.json");
  const latestManifest = readFileSync(latestManifestPath, "utf8");
  assertContains(
    latestManifest,
    "windows-x86_64-nsis",
    "Merged Tauri manifest is missing the Windows target.",
  );
  assertContains(
    latestManifest,
    "darwin-aarch64-app",
    "Merged Tauri manifest is missing the macOS arm64 target.",
  );
  assertContains(
    latestManifest,
    "darwin-x86_64-app",
    "Merged Tauri manifest is missing the macOS x64 target.",
  );

  const nightlyManifest = readFileSync(resolve(releaseAssetsDir, "nightly.json"), "utf8");
  assertContains(
    nightlyManifest,
    "linux-x86_64-appimage",
    "Merged Tauri nightly manifest is missing the Linux target.",
  );

  assertMissing(
    latestWinManifestPath,
    "Release smoke unexpectedly kept the per-platform Windows manifest.",
  );
  assertMissing(
    latestMacArmManifestPath,
    "Release smoke unexpectedly kept the macOS arm64 manifest.",
  );
  assertMissing(
    latestMacX64ManifestPath,
    "Release smoke unexpectedly kept the macOS x64 manifest.",
  );
  assertMissing(nightlyLinuxManifestPath, "Release smoke unexpectedly kept the Linux manifest.");

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
