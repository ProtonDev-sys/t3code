const DESKTOP_UPDATE_INSTALL_EXPECTED_KEY = "t3code.desktopUpdateInstallExpectedAt";
const DESKTOP_UPDATE_INSTALL_EXPECTED_TTL_MS = 2 * 60 * 1000;

function getDesktopUpdateInstallStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function markDesktopUpdateInstallExpected(): void {
  getDesktopUpdateInstallStorage()?.setItem(
    DESKTOP_UPDATE_INSTALL_EXPECTED_KEY,
    String(Date.now()),
  );
}

export function clearDesktopUpdateInstallExpected(): void {
  getDesktopUpdateInstallStorage()?.removeItem(DESKTOP_UPDATE_INSTALL_EXPECTED_KEY);
}

export function isDesktopUpdateInstallExpected(nowMs = Date.now()): boolean {
  const raw = getDesktopUpdateInstallStorage()?.getItem(DESKTOP_UPDATE_INSTALL_EXPECTED_KEY);
  if (!raw) return false;
  const startedAt = Number(raw);
  if (!Number.isFinite(startedAt)) {
    clearDesktopUpdateInstallExpected();
    return false;
  }
  if (nowMs - startedAt > DESKTOP_UPDATE_INSTALL_EXPECTED_TTL_MS) {
    clearDesktopUpdateInstallExpected();
    return false;
  }
  return true;
}
