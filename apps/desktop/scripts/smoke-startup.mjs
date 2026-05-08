import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const exeName = process.platform === "win32" ? "t3code.exe" : "t3code";
const candidates = [
  join(desktopDir, "src-tauri", "target", "debug", exeName),
  join(desktopDir, "src-tauri", "target", "release", exeName),
  join(desktopDir, "src-tauri", "target", "x86_64-pc-windows-msvc", "debug", exeName),
  join(desktopDir, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", exeName),
];
const executablePath = candidates.find((candidate) => existsSync(candidate));

if (!executablePath) {
  throw new Error(`Could not find a built T3 Code executable. Checked:\n${candidates.join("\n")}`);
}

const t3Home = mkdtempSync(join(tmpdir(), "t3code-desktop-smoke-"));

try {
  const result = spawnSync(executablePath, [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      T3CODE_DESKTOP_STARTUP_SMOKE: "1",
      T3CODE_HOME: t3Home,
      T3CODE_REPO_ROOT: repoRoot,
    },
    timeout: 90_000,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Desktop startup smoke failed with exit code ${result.status}.`);
  }
} finally {
  rmSync(t3Home, { force: true, recursive: true });
}
