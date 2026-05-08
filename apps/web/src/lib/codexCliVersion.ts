import type { ServerProvider } from "@t3tools/contracts";

const CODEX_CLI_LATEST_VERSION_URL = "https://registry.npmjs.org/@openai/codex/latest";
const CODEX_CLI_UPDATE_CHECK_TIMEOUT_MS = 2_500;

let codexCliLatestVersionPromise: Promise<string | null> | null = null;
let codexCliLatestVersionCache: string | null | undefined;

function parseSemverParts(version: string): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerSemver(candidate: string, current: string): boolean {
  const candidateParts = parseSemverParts(candidate);
  const currentParts = parseSemverParts(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart > currentPart) return true;
    if (candidatePart < currentPart) return false;
  }
  return false;
}

export function getLatestCodexCliVersion(): Promise<string | null> {
  codexCliLatestVersionPromise ??= (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      CODEX_CLI_UPDATE_CHECK_TIMEOUT_MS,
    );
    try {
      const response = await fetch(CODEX_CLI_LATEST_VERSION_URL, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeoutId);
    }
  })().then((version) => {
    codexCliLatestVersionCache = version;
    return version;
  });
  return codexCliLatestVersionPromise;
}

export function getCachedCodexCliLatestVersion(): string | null | undefined {
  return codexCliLatestVersionCache;
}

export function resolveOutdatedCodexCliStatuses(input: {
  readonly latestVersion: string | null;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
}): ServerProvider[] {
  const latestVersion = input.latestVersion;
  if (!latestVersion) return [];
  return input.providerStatuses.filter((provider) => {
    const currentVersion = provider.version;
    return (
      provider.driver === "codex" &&
      provider.enabled &&
      provider.installed &&
      typeof currentVersion === "string" &&
      isNewerSemver(latestVersion, currentVersion)
    );
  });
}
