/**
 * True when running inside a desktop bridge, false in a regular browser.
 */
export const isDesktopShell =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || window.nativeApi !== undefined);
