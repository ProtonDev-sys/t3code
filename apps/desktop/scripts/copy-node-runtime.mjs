#!/usr/bin/env node

import { mkdir, stat, writeFile, copyFile, chmod } from "node:fs/promises";
import path from "node:path";

const desktopDir = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(desktopDir, "dist", "node");
const executableName = process.platform === "win32" ? "node.exe" : "node";
const targetPath = path.join(outputDir, executableName);

if (!process.versions.node) {
  throw new Error("copy-node-runtime must be executed with Node.js.");
}

const sourceStat = await stat(process.execPath);
if (!sourceStat.isFile()) {
  throw new Error(`Node executable is not a file: ${process.execPath}`);
}

await mkdir(outputDir, { recursive: true });
await copyFile(process.execPath, targetPath);
if (process.platform !== "win32") {
  await chmod(targetPath, 0o755);
}
await writeFile(path.join(outputDir, "VERSION"), `${process.version}\n`, "utf8");

console.log(`[desktop] Copied Node runtime to ${targetPath}`);
