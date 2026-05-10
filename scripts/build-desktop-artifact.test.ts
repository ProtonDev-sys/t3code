import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";

import {
  createTauriConfigOverride,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveGitHubUpdaterEndpoint,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("resolves fork-owned GitHub updater endpoints for both channels", () => {
    assert.equal(
      resolveGitHubUpdaterEndpoint({
        channel: "latest",
        repository: "ProtonDev-sys/t3code",
      }),
      "https://github.com/ProtonDev-sys/t3code/releases/latest/download/latest.json",
    );

    assert.equal(
      resolveGitHubUpdaterEndpoint({
        channel: "nightly",
        repository: "https://github.com/ProtonDev-sys/t3code.git",
      }),
      "https://github.com/ProtonDev-sys/t3code/releases/download/nightly/nightly.json",
    );
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "T3 Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches staged desktop web icons to the matching production or nightly brand", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it("keeps the Tauri updater plugin config non-null when updates are not configured", () => {
    assert.deepStrictEqual(
      createTauriConfigOverride("0.0.17", "T3 Code (Alpha)", {
        createUpdaterArtifacts: false,
        mockUpdates: false,
        updaterEndpoints: [],
        updaterPubkey: undefined,
      }).plugins.updater,
      {
        endpoints: [],
        pubkey: "",
      },
    );
  });

  it("overrides the disabled Tauri updater config when update signing is configured", () => {
    assert.deepStrictEqual(
      createTauriConfigOverride("0.0.17", "T3 Code (Alpha)", {
        createUpdaterArtifacts: true,
        mockUpdates: true,
        updaterEndpoints: ["https://updates.example/latest.json"],
        updaterPubkey: "trusted-public-key",
      }).plugins.updater,
      {
        dangerousInsecureTransportProtocol: true,
        endpoints: ["https://updates.example/latest.json"],
        pubkey: "trusted-public-key",
      },
    );
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("defaults signed updater builds to GitHub release feeds", () =>
    Effect.gen(function* () {
      const stable = yield* resolveBuildOptions({
        platform: Option.some("win"),
        target: Option.some("nsis"),
        arch: Option.some("x64"),
        buildVersion: Option.some("0.0.26"),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "ProtonDev-sys/t3code",
                TAURI_SIGNING_PUBLIC_KEY: "public-key",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(stable.updaterEndpoints, [
        "https://github.com/ProtonDev-sys/t3code/releases/latest/download/latest.json",
      ]);

      const nightly = yield* resolveBuildOptions({
        platform: Option.some("win"),
        target: Option.some("nsis"),
        arch: Option.some("x64"),
        buildVersion: Option.some("0.0.27-nightly.20260510.1"),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "ProtonDev-sys/t3code",
                TAURI_SIGNING_PUBLIC_KEY: "public-key",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(nightly.updaterEndpoints, [
        "https://github.com/ProtonDev-sys/t3code/releases/download/nightly/nightly.json",
      ]);
    }),
  );

  it.effect("preserves explicit updater endpoints over GitHub defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("win"),
        target: Option.some("nsis"),
        arch: Option.some("x64"),
        buildVersion: Option.some("0.0.27-nightly.20260510.1"),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "ProtonDev-sys/t3code",
                TAURI_SIGNING_PUBLIC_KEY: "public-key",
                T3CODE_TAURI_UPDATER_ENDPOINTS:
                  "https://updates.example/latest.json,https://fallback.example/latest.json",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(resolved.updaterEndpoints, [
        "https://updates.example/latest.json",
        "https://fallback.example/latest.json",
      ]);
    }),
  );

  it.effect("keeps unsigned local builds without default GitHub updater endpoints", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("win"),
        target: Option.some("nsis"),
        arch: Option.some("x64"),
        buildVersion: Option.some("0.0.27-nightly.20260510.1"),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "ProtonDev-sys/t3code",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(resolved.updaterEndpoints, []);
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
