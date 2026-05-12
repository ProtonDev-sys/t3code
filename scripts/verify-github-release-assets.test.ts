import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";

import {
  formatReleaseVerificationResult,
  readLocalReleaseAssets,
  verifyReleaseAssets,
  type GitHubReleaseAssetSummary,
  type GitHubReleaseSummary,
} from "./verify-github-release-assets.ts";

function release(input: {
  readonly tagName?: string;
  readonly isDraft?: boolean;
  readonly isPrerelease?: boolean;
  readonly assets: ReadonlyArray<string | GitHubReleaseAssetSummary>;
}): GitHubReleaseSummary {
  return {
    tagName: input.tagName ?? "v0.0.27",
    name: "T3 Code",
    htmlUrl: "https://github.com/ProtonDev-sys/t3code/releases/tag/test",
    isDraft: input.isDraft ?? false,
    isPrerelease: input.isPrerelease ?? false,
    assets: input.assets.map((asset) =>
      typeof asset === "string"
        ? {
            name: asset,
            size: 1,
          }
        : asset,
    ),
  };
}

const completeNightlyAssets = [
  "nightly.json",
  "T3.Code.Nightly._0.0.27-nightly.20260510.47_aarch64.dmg",
  "T3.Code.Nightly._0.0.27-nightly.20260510.47_amd64.AppImage",
  "T3.Code.Nightly._0.0.27-nightly.20260510.47_amd64.AppImage.sig",
  "T3.Code.Nightly._0.0.27-nightly.20260510.47_x64-setup.exe",
  "T3.Code.Nightly._0.0.27-nightly.20260510.47_x64-setup.exe.sig",
  "T3.Code.Nightly._0.0.27-nightly.20260510.47_x64.dmg",
  "T3.Code.Nightly._aarch64.app.tar.gz",
  "T3.Code.Nightly._aarch64.app.tar.gz.sig",
  "T3.Code.Nightly._x64.app.tar.gz",
  "T3.Code.Nightly._x64.app.tar.gz.sig",
];

const completeStableAssets = [
  "latest.json",
  "T3.Code.Alpha._0.0.27_aarch64.dmg",
  "T3.Code.Alpha._0.0.27_amd64.AppImage",
  "T3.Code.Alpha._0.0.27_amd64.AppImage.sig",
  "T3.Code.Alpha._0.0.27_x64-setup.exe",
  "T3.Code.Alpha._0.0.27_x64-setup.exe.sig",
  "T3.Code.Alpha._0.0.27_x64.dmg",
  "T3.Code.Alpha._aarch64.app.tar.gz",
  "T3.Code.Alpha._aarch64.app.tar.gz.sig",
  "T3.Code.Alpha._x64.app.tar.gz",
  "T3.Code.Alpha._x64.app.tar.gz.sig",
];

const completeManifestText = JSON.stringify({
  version: "0.0.27",
  platforms: {
    "darwin-aarch64-app": {
      signature: "darwin-aarch64-signature",
      url: "https://github.com/ProtonDev-sys/t3code/releases/download/v0.0.27/T3.Code.Alpha._aarch64.app.tar.gz",
    },
    "darwin-x86_64-app": {
      signature: "darwin-x64-signature",
      url: "https://github.com/ProtonDev-sys/t3code/releases/download/v0.0.27/T3.Code.Alpha._x64.app.tar.gz",
    },
    "linux-x86_64-appimage": {
      signature: "linux-x64-signature",
      url: "https://github.com/ProtonDev-sys/t3code/releases/download/v0.0.27/T3.Code.Alpha._0.0.27_amd64.AppImage",
    },
    "windows-x86_64-nsis": {
      signature: "windows-x64-signature",
      url: "https://github.com/ProtonDev-sys/t3code/releases/download/v0.0.27/T3.Code.Alpha._0.0.27_x64-setup.exe",
    },
  },
});

it("accepts a complete stable release asset set", () => {
  const result = verifyReleaseAssets({
    channel: "stable",
    release: release({
      tagName: "v0.0.27",
      assets: completeStableAssets,
    }),
  });

  assert.deepStrictEqual(result.missingRequirements, []);
  assert.deepStrictEqual(result.emptyAssets, []);
});

it("accepts a stable prerelease when that state is expected", () => {
  const result = verifyReleaseAssets({
    channel: "stable",
    expectedPrerelease: true,
    release: release({
      tagName: "v0.0.27-test.1",
      isPrerelease: true,
      assets: completeStableAssets,
    }),
  });

  assert.deepStrictEqual(result.missingRequirements, []);
  assert.deepStrictEqual(result.emptyAssets, []);
});

it("reports an unexpected stable prerelease by default", () => {
  const result = verifyReleaseAssets({
    channel: "stable",
    release: release({
      tagName: "v0.0.27-test.1",
      isPrerelease: true,
      assets: completeStableAssets,
    }),
  });

  assert.ok(
    result.missingRequirements.some(
      (requirement) => requirement.id === "metadata.prerelease-state",
    ),
  );
});

it("accepts a complete nightly release asset set", () => {
  const result = verifyReleaseAssets({
    channel: "nightly",
    release: release({
      tagName: "nightly",
      isPrerelease: true,
      assets: completeNightlyAssets,
    }),
  });

  assert.deepStrictEqual(result.missingRequirements, []);
  assert.deepStrictEqual(result.emptyAssets, []);
});

it("accepts a complete updater manifest", () => {
  const result = verifyReleaseAssets({
    channel: "stable",
    release: release({
      tagName: "v0.0.27",
      assets: completeStableAssets.map((assetName) =>
        assetName === "latest.json"
          ? {
              name: assetName,
              size: 1,
              text: completeManifestText,
            }
          : assetName,
      ),
    }),
  });

  assert.deepStrictEqual(result.manifestProblems, []);
});

it("accepts complete assets from a local assembled release directory", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "t3-release-assets-"));
  try {
    for (const assetName of completeStableAssets) {
      writeFileSync(
        join(tempDir, assetName),
        assetName === "latest.json" ? completeManifestText : "asset",
      );
    }

    const localRelease = await readLocalReleaseAssets({
      channel: "stable",
      assetsDir: tempDir,
      tagName: "v0.0.27",
    });

    const result = verifyReleaseAssets({
      channel: "stable",
      release: localRelease,
    });

    assert.deepStrictEqual(result.missingRequirements, []);
    assert.deepStrictEqual(result.emptyAssets, []);
    assert.deepStrictEqual(result.manifestProblems, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("reports updater manifests missing platform targets", () => {
  const result = verifyReleaseAssets({
    channel: "nightly",
    release: release({
      tagName: "nightly",
      isPrerelease: true,
      assets: completeNightlyAssets.map((assetName) =>
        assetName === "nightly.json"
          ? {
              name: assetName,
              size: 1,
              text: JSON.stringify({
                version: "0.0.27-nightly.20260510.47",
                platforms: {
                  "windows-x86_64-nsis": {
                    signature: "windows-x64-signature",
                    url: "https://example.com/setup.exe",
                  },
                },
              }),
            }
          : assetName,
      ),
    }),
  });

  assert.ok(
    result.manifestProblems.some((problem) =>
      problem.includes("nightly.json is missing platform darwin-aarch64-app"),
    ),
  );
  assert.ok(
    result.manifestProblems.some((problem) =>
      problem.includes("nightly.json is missing platform linux-x86_64-appimage"),
    ),
  );
});

it("reports missing stable platform assets and updater metadata", () => {
  const result = verifyReleaseAssets({
    channel: "stable",
    release: release({
      tagName: "v0.0.25",
      assets: ["T3.Code.Alpha._0.0.25_x64-setup.exe"],
    }),
  });

  assert.ok(
    result.missingRequirements.some((requirement) => requirement.id === "updater.latest-manifest"),
  );
  assert.ok(
    result.missingRequirements.some((requirement) => requirement.id === "linux.x64-appimage"),
  );
  assert.ok(result.missingRequirements.some((requirement) => requirement.id === "macos.x64-dmg"));
  assert.ok(result.missingRequirements.some((requirement) => requirement.id === "macos.arm64-dmg"));
});

it("reports empty assets even when required names are present", () => {
  const result = verifyReleaseAssets({
    channel: "nightly",
    release: release({
      tagName: "nightly",
      isPrerelease: true,
      assets: completeNightlyAssets.map((assetName) => ({
        name: assetName,
        size: assetName === "nightly.json" ? 0 : 1,
      })),
    }),
  });

  assert.deepStrictEqual(
    result.emptyAssets.map((asset) => asset.name),
    ["nightly.json"],
  );
});

it("formats missing release requirements for CLI output", () => {
  const result = verifyReleaseAssets({
    channel: "stable",
    release: release({
      tagName: "v0.0.25",
      assets: ["T3.Code.Alpha._0.0.25_x64-setup.exe"],
    }),
  });

  const output = formatReleaseVerificationResult(result);

  assert.match(output, /stable: v0\.0\.25/);
  assert.match(output, /Missing:/);
  assert.match(output, /Stable updater manifest/);
});
