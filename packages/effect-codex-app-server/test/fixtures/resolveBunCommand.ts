import { existsSync } from "node:fs";
import * as NodePath from "node:path";

function readPathEnvironment(): string {
  return process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
}

export function resolveBunCommand(): string {
  if (process.platform !== "win32") {
    return "bun";
  }

  for (const rawEntry of readPathEnvironment().split(NodePath.delimiter)) {
    const entry = rawEntry.trim().replace(/^"+|"+$/g, "");
    if (entry.length === 0) continue;

    const direct = NodePath.join(entry, "bun.exe");
    if (existsSync(direct)) return direct;

    const npmShimTarget = NodePath.join(entry, "node_modules", "bun", "bin", "bun.exe");
    if (existsSync(npmShimTarget)) return npmShimTarget;
  }

  return "bun";
}
