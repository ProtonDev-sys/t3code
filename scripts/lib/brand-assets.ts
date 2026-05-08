export const BRAND_ASSET_PATHS = {
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",

  nightlyMacIconPng: "assets/nightly/blueprint-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/blueprint-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/blueprint-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/blueprint-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/blueprint-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/blueprint-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/blueprint-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "production" | "nightly";

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

export interface WebIconSource {
  readonly sourceRelativePath: string;
  readonly targetFileName: string;
}

export const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconSources(brand: WebAssetBrand): ReadonlyArray<WebIconSource> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetFileName: WEB_ICON_TARGET_FILENAMES.faviconIco,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetFileName: WEB_ICON_TARGET_FILENAMES.favicon16Png,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetFileName: WEB_ICON_TARGET_FILENAMES.favicon32Png,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetFileName: WEB_ICON_TARGET_FILENAMES.appleTouchIconPng,
    },
  ];
}

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  return resolveWebIconSources(brand).map((source) => ({
    sourceRelativePath: source.sourceRelativePath,
    targetRelativePath: `${targetDirectory}/${source.targetFileName}`,
  }));
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const PUBLISH_ICON_OVERRIDES = resolveWebIconOverrides("production", "dist/client");
