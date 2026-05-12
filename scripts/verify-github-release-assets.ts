#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

type ReleaseChannel = "stable" | "nightly";

export interface GitHubReleaseAssetSummary {
  readonly name: string;
  readonly size?: number | undefined;
  readonly downloadUrl?: string | undefined;
  readonly text?: string | undefined;
}

export interface GitHubReleaseSummary {
  readonly tagName: string;
  readonly name: string | null;
  readonly htmlUrl: string | null;
  readonly isDraft: boolean;
  readonly isPrerelease: boolean;
  readonly assets: ReadonlyArray<GitHubReleaseAssetSummary>;
}

export interface ReleaseAssetRequirement {
  readonly id: string;
  readonly description: string;
  readonly matches: (assetName: string) => boolean;
}

export interface ReleaseAssetVerificationResult {
  readonly channel: ReleaseChannel;
  readonly release: GitHubReleaseSummary;
  readonly missingRequirements: ReadonlyArray<ReleaseAssetRequirement>;
  readonly emptyAssets: ReadonlyArray<GitHubReleaseAssetSummary>;
  readonly manifestProblems: ReadonlyArray<string>;
}

interface CliOptions {
  readonly repo: string;
  readonly channel: ReleaseChannel | "all";
  readonly stableTag: string;
  readonly nightlyTag: string;
  readonly assetsDir: string | null;
  readonly expectedPrerelease: boolean | null;
}

const DEFAULT_REPOSITORY = "ProtonDev-sys/t3code";
const EXPECTED_UPDATER_PLATFORM_KEYS = [
  "darwin-aarch64-app",
  "darwin-x86_64-app",
  "linux-x86_64-appimage",
  "windows-x86_64-nsis",
] as const;

const assetNameMatches = (pattern: RegExp) => (assetName: string) => pattern.test(assetName);

const sharedDesktopAssetRequirements: ReadonlyArray<ReleaseAssetRequirement> = [
  {
    id: "windows.x64-installer",
    description: "Windows x64 NSIS installer (*.exe)",
    matches: assetNameMatches(/_x64-setup\.exe$/i),
  },
  {
    id: "windows.x64-installer-signature",
    description: "Windows x64 updater signature (*.exe.sig)",
    matches: assetNameMatches(/_x64-setup\.exe\.sig$/i),
  },
  {
    id: "linux.x64-appimage",
    description: "Linux x64 AppImage (*.AppImage)",
    matches: assetNameMatches(/\.AppImage$/i),
  },
  {
    id: "linux.x64-appimage-signature",
    description: "Linux x64 AppImage updater signature (*.AppImage.sig)",
    matches: assetNameMatches(/\.AppImage\.sig$/i),
  },
  {
    id: "macos.arm64-dmg",
    description: "macOS arm64 DMG (*_aarch64.dmg)",
    matches: assetNameMatches(/_aarch64\.dmg$/i),
  },
  {
    id: "macos.x64-dmg",
    description: "macOS x64 DMG (*_x64.dmg)",
    matches: assetNameMatches(/_x64\.dmg$/i),
  },
  {
    id: "macos.arm64-updater-archive",
    description: "macOS arm64 updater archive (*_aarch64.app.tar.gz)",
    matches: assetNameMatches(/_aarch64\.app\.tar\.gz$/i),
  },
  {
    id: "macos.arm64-updater-signature",
    description: "macOS arm64 updater signature (*_aarch64.app.tar.gz.sig)",
    matches: assetNameMatches(/_aarch64\.app\.tar\.gz\.sig$/i),
  },
  {
    id: "macos.x64-updater-archive",
    description: "macOS x64 updater archive (*_x64.app.tar.gz)",
    matches: assetNameMatches(/_x64\.app\.tar\.gz$/i),
  },
  {
    id: "macos.x64-updater-signature",
    description: "macOS x64 updater signature (*_x64.app.tar.gz.sig)",
    matches: assetNameMatches(/_x64\.app\.tar\.gz\.sig$/i),
  },
];

export const releaseAssetRequirements: Record<
  ReleaseChannel,
  ReadonlyArray<ReleaseAssetRequirement>
> = {
  stable: [
    {
      id: "metadata.not-draft",
      description: "GitHub release is not a draft",
      matches: () => false,
    },
    {
      id: "metadata.prerelease-state",
      description: "GitHub release prerelease state matches the expected channel state",
      matches: () => false,
    },
    {
      id: "updater.latest-manifest",
      description: "Stable updater manifest (latest.json)",
      matches: assetNameMatches(/^latest\.json$/i),
    },
    ...sharedDesktopAssetRequirements,
  ],
  nightly: [
    {
      id: "metadata.not-draft",
      description: "GitHub release is not a draft",
      matches: () => false,
    },
    {
      id: "metadata.prerelease-state",
      description: "GitHub release prerelease state matches the expected channel state",
      matches: () => false,
    },
    {
      id: "updater.nightly-manifest",
      description: "Nightly updater manifest (nightly.json)",
      matches: assetNameMatches(/^nightly\.json$/i),
    },
    ...sharedDesktopAssetRequirements,
  ],
};

function metadataRequirementSatisfied(
  channel: ReleaseChannel,
  requirement: ReleaseAssetRequirement,
  release: GitHubReleaseSummary,
  expectedPrerelease: boolean,
): boolean | null {
  switch (requirement.id) {
    case "metadata.not-draft":
      return !release.isDraft;
    case "metadata.prerelease-state":
      return release.isPrerelease === expectedPrerelease;
    default:
      return null;
  }
}

function manifestNameForChannel(channel: ReleaseChannel): string {
  return channel === "stable" ? "latest.json" : "nightly.json";
}

function validateUpdaterManifest(channel: ReleaseChannel, text: string): ReadonlyArray<string> {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return [`${manifestNameForChannel(channel)} is not valid JSON: ${message}`];
  }

  const record = asRecord(parsed);
  if (!record) {
    return [`${manifestNameForChannel(channel)} is not a JSON object.`];
  }

  if (typeof record.version !== "string" || record.version.trim().length === 0) {
    problems.push(`${manifestNameForChannel(channel)} is missing a string version.`);
  }

  const platforms = asRecord(record.platforms);
  if (!platforms) {
    problems.push(`${manifestNameForChannel(channel)} is missing a platforms object.`);
    return problems;
  }

  for (const platformKey of EXPECTED_UPDATER_PLATFORM_KEYS) {
    const platform = asRecord(platforms[platformKey]);
    if (!platform) {
      problems.push(`${manifestNameForChannel(channel)} is missing platform ${platformKey}.`);
      continue;
    }

    if (typeof platform.url !== "string" || platform.url.trim().length === 0) {
      problems.push(`${manifestNameForChannel(channel)} platform ${platformKey} is missing a URL.`);
    }
    if (typeof platform.signature !== "string" || platform.signature.trim().length === 0) {
      problems.push(
        `${manifestNameForChannel(channel)} platform ${platformKey} is missing a signature.`,
      );
    }
  }

  return problems;
}

export function verifyReleaseAssets(input: {
  readonly channel: ReleaseChannel;
  readonly release: GitHubReleaseSummary;
  readonly expectedPrerelease?: boolean | undefined;
}): ReleaseAssetVerificationResult {
  const expectedPrerelease = input.expectedPrerelease ?? input.channel === "nightly";
  const assetNames = new Set(input.release.assets.map((asset) => asset.name));
  const missingRequirements = releaseAssetRequirements[input.channel].filter((requirement) => {
    const metadataSatisfied = metadataRequirementSatisfied(
      input.channel,
      requirement,
      input.release,
      expectedPrerelease,
    );
    if (metadataSatisfied !== null) {
      return !metadataSatisfied;
    }
    for (const assetName of assetNames) {
      if (requirement.matches(assetName)) {
        return false;
      }
    }
    return true;
  });

  const emptyAssets = input.release.assets.filter((asset) => asset.size === 0);
  const manifestName = manifestNameForChannel(input.channel);
  const manifestProblems = input.release.assets.flatMap((asset) =>
    asset.name.toLowerCase() === manifestName.toLowerCase() && asset.text !== undefined
      ? validateUpdaterManifest(input.channel, asset.text)
      : [],
  );

  return {
    channel: input.channel,
    release: input.release,
    missingRequirements,
    emptyAssets,
    manifestProblems,
  };
}

export async function readLocalReleaseAssets(input: {
  readonly channel: ReleaseChannel;
  readonly assetsDir: string;
  readonly tagName: string;
  readonly expectedPrerelease?: boolean | undefined;
}): Promise<GitHubReleaseSummary> {
  const manifestName = manifestNameForChannel(input.channel);
  const entries = await readdir(input.assetsDir, { withFileTypes: true });
  const assets = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<GitHubReleaseAssetSummary> => {
        const path = resolve(input.assetsDir, entry.name);
        const assetStat = await stat(path);
        const asset: GitHubReleaseAssetSummary = {
          name: entry.name,
          size: assetStat.size,
        };
        if (entry.name.toLowerCase() === manifestName.toLowerCase()) {
          return Object.assign(asset, { text: await readFile(path, "utf8") });
        }
        return asset;
      }),
  );

  return {
    tagName: input.tagName,
    name: null,
    htmlUrl: null,
    isDraft: false,
    isPrerelease: input.expectedPrerelease ?? input.channel === "nightly",
    assets,
  };
}

export function formatReleaseVerificationResult(result: ReleaseAssetVerificationResult): string {
  const lines = [
    `${result.channel}: ${result.release.tagName} (${result.release.assets.length} assets)`,
  ];

  if (result.release.htmlUrl) {
    lines.push(`  ${result.release.htmlUrl}`);
  }

  if (
    result.missingRequirements.length === 0 &&
    result.emptyAssets.length === 0 &&
    result.manifestProblems.length === 0
  ) {
    lines.push("  OK: all required release assets are present.");
    return lines.join("\n");
  }

  if (result.missingRequirements.length > 0) {
    lines.push("  Missing:");
    for (const requirement of result.missingRequirements) {
      lines.push(`  - ${requirement.description} [${requirement.id}]`);
    }
  }

  if (result.emptyAssets.length > 0) {
    lines.push("  Empty assets:");
    for (const asset of result.emptyAssets) {
      lines.push(`  - ${asset.name}`);
    }
  }

  if (result.manifestProblems.length > 0) {
    lines.push("  Invalid manifests:");
    for (const problem of result.manifestProblems) {
      lines.push(`  - ${problem}`);
    }
  }

  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeReleasePayload(value: unknown): GitHubReleaseSummary {
  const record = asRecord(value);
  if (!record) {
    throw new Error("GitHub release response was not an object.");
  }

  const tagName = record.tag_name;
  if (typeof tagName !== "string" || tagName.trim().length === 0) {
    throw new Error("GitHub release response is missing tag_name.");
  }

  const assetsValue = record.assets;
  if (!Array.isArray(assetsValue)) {
    throw new Error("GitHub release response is missing assets.");
  }

  const assets: GitHubReleaseAssetSummary[] = [];
  for (const assetValue of assetsValue) {
    const asset = asRecord(assetValue);
    if (!asset) {
      throw new Error("GitHub release asset response was not an object.");
    }
    const name = asset.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("GitHub release asset response is missing name.");
    }
    const size = asset.size;
    const downloadUrl = asset.browser_download_url;
    assets.push({
      name,
      ...(typeof size === "number" ? { size } : {}),
      ...(typeof downloadUrl === "string" ? { downloadUrl } : {}),
    });
  }

  return {
    tagName,
    name: typeof record.name === "string" ? record.name : null,
    htmlUrl: typeof record.html_url === "string" ? record.html_url : null,
    isDraft: record.draft === true,
    isPrerelease: record.prerelease === true,
    assets,
  };
}

function normalizeRepository(input: string | undefined): string {
  const repo = input?.trim() || DEFAULT_REPOSITORY;
  const match = /github\.com[/:]([^/\s]+\/[^/\s.]+)(?:\.git)?$/i.exec(repo);
  return match?.[1] ?? repo;
}

function parseArgs(args: ReadonlyArray<string>): CliOptions {
  let repo = normalizeRepository(process.env.GITHUB_REPOSITORY);
  let channel: CliOptions["channel"] = "all";
  let stableTag = "latest";
  let nightlyTag = "nightly";
  let assetsDir: string | null = null;
  let expectedPrerelease: boolean | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case "--repo":
        if (!next) throw new Error("--repo requires a value.");
        repo = normalizeRepository(next);
        index += 1;
        break;
      case "--channel":
        if (next !== "stable" && next !== "nightly" && next !== "all") {
          throw new Error("--channel must be stable, nightly, or all.");
        }
        channel = next;
        index += 1;
        break;
      case "--stable-tag":
        if (!next) throw new Error("--stable-tag requires a value.");
        stableTag = next;
        index += 1;
        break;
      case "--nightly-tag":
        if (!next) throw new Error("--nightly-tag requires a value.");
        nightlyTag = next;
        index += 1;
        break;
      case "--assets-dir":
        if (!next) throw new Error("--assets-dir requires a value.");
        assetsDir = next;
        index += 1;
        break;
      case "--expected-prerelease":
        if (next !== "true" && next !== "false") {
          throw new Error("--expected-prerelease must be true or false.");
        }
        expectedPrerelease = next === "true";
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bun run release:verify-github -- [options]

Options:
  --repo <owner/name>       GitHub repository. Defaults to GITHUB_REPOSITORY or ${DEFAULT_REPOSITORY}.
  --channel <channel>      stable, nightly, or all. Defaults to all.
  --stable-tag <tag>       Stable release tag, or latest. Defaults to latest.
  --nightly-tag <tag>      Nightly release tag. Defaults to nightly.
  --assets-dir <path>      Verify local assembled release assets instead of GitHub assets.
  --expected-prerelease <bool>
                           Expected GitHub prerelease state. Defaults to nightly=true, stable=false.

Authentication:
  Uses GITHUB_TOKEN or GH_TOKEN when set.`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { repo, channel, stableTag, nightlyTag, assetsDir, expectedPrerelease };
}

async function fetchGitHubRelease(repo: string, tag: string): Promise<GitHubReleaseSummary> {
  const path =
    tag === "latest"
      ? `/repos/${repo}/releases/latest`
      : `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const apiBase = process.env.GITHUB_API_URL?.replace(/\/+$/u, "") ?? "https://api.github.com";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "t3code-release-verifier",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub release lookup failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return decodeReleasePayload(await response.json());
}

async function fetchAssetText(asset: GitHubReleaseAssetSummary): Promise<string> {
  if (!asset.downloadUrl) {
    throw new Error(`GitHub release asset ${asset.name} is missing browser_download_url.`);
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(asset.downloadUrl, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "t3code-release-verifier",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub release asset download failed for ${asset.name} (${response.status}): ${body.slice(
        0,
        500,
      )}`,
    );
  }

  return response.text();
}

async function fetchUpdaterManifestAsset(
  channel: ReleaseChannel,
  release: GitHubReleaseSummary,
): Promise<GitHubReleaseSummary> {
  const manifestName = manifestNameForChannel(channel);
  const assets = await Promise.all(
    release.assets.map(async (asset) => {
      if (asset.name.toLowerCase() !== manifestName.toLowerCase()) {
        return asset;
      }

      return { ...asset, text: await fetchAssetText(asset) };
    }),
  );

  return { ...release, assets };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const channels: ReleaseChannel[] =
    options.channel === "all" ? ["stable", "nightly"] : [options.channel];
  const results: ReleaseAssetVerificationResult[] = [];

  for (const channel of channels) {
    const tag = channel === "stable" ? options.stableTag : options.nightlyTag;
    const expectedPrerelease = options.expectedPrerelease ?? channel === "nightly";
    const release = options.assetsDir
      ? await readLocalReleaseAssets({
          channel,
          assetsDir: options.assetsDir,
          tagName: tag,
          expectedPrerelease,
        })
      : await fetchUpdaterManifestAsset(channel, await fetchGitHubRelease(options.repo, tag));
    results.push(verifyReleaseAssets({ channel, release, expectedPrerelease }));
  }

  for (const result of results) {
    console.log(formatReleaseVerificationResult(result));
  }

  if (
    results.some(
      (result) => result.missingRequirements.length > 0 || result.emptyAssets.length > 0,
    ) ||
    results.some((result) => result.manifestProblems.length > 0)
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
