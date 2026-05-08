#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

interface TauriPlatformManifest {
  readonly signature: string;
  readonly url: string;
}

interface TauriUpdateManifest {
  readonly version: string;
  readonly notes?: string;
  readonly pub_date?: string;
  readonly platforms: Record<string, TauriPlatformManifest>;
}

function usage(): never {
  console.error(
    "Usage: node scripts/merge-tauri-update-manifests.ts --output <manifest.json> <manifest...>",
  );
  process.exit(1);
}

function parseArgs(args: ReadonlyArray<string>): {
  readonly outputPath: string;
  readonly manifestPaths: ReadonlyArray<string>;
} {
  let outputPath: string | undefined;
  const manifestPaths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output") {
      outputPath = args[index + 1];
      index += 1;
      continue;
    }
    if (!arg || arg.startsWith("-")) {
      usage();
    }
    manifestPaths.push(arg);
  }

  if (!outputPath || manifestPaths.length === 0) {
    usage();
  }

  return { outputPath, manifestPaths };
}

function readManifest(path: string): TauriUpdateManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TauriUpdateManifest>;
  if (!parsed.version || typeof parsed.version !== "string") {
    throw new Error(`${basename(path)} is missing a string version.`);
  }
  if (!parsed.platforms || typeof parsed.platforms !== "object") {
    throw new Error(`${basename(path)} is missing a platforms object.`);
  }
  for (const [target, platform] of Object.entries(parsed.platforms)) {
    if (
      !platform ||
      typeof platform !== "object" ||
      typeof platform.url !== "string" ||
      typeof platform.signature !== "string"
    ) {
      throw new Error(`${basename(path)} has an invalid platform entry for ${target}.`);
    }
  }
  return parsed as TauriUpdateManifest;
}

const { outputPath, manifestPaths } = parseArgs(process.argv.slice(2));
const manifests = manifestPaths.map(readManifest);
const firstManifest = manifests[0];
if (!firstManifest) {
  usage();
}
const platforms: Record<string, TauriPlatformManifest> = {};

for (const manifest of manifests) {
  if (manifest.version !== firstManifest.version) {
    throw new Error(
      `Cannot merge updater manifests with different versions: ${firstManifest.version} and ${manifest.version}.`,
    );
  }
  for (const [target, platform] of Object.entries(manifest.platforms)) {
    if (platforms[target]) {
      throw new Error(`Duplicate updater platform target: ${target}.`);
    }
    platforms[target] = platform;
  }
}

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      version: firstManifest.version,
      ...(firstManifest.notes ? { notes: firstManifest.notes } : {}),
      ...(firstManifest.pub_date ? { pub_date: firstManifest.pub_date } : {}),
      platforms,
    },
    null,
    2,
  )}\n`,
);
console.log(`Merged ${manifests.length} Tauri updater manifest(s) into ${outputPath}`);
