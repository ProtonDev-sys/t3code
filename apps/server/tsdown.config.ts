import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => {
    if (id.startsWith("node:")) return false;
    if (id === "node-pty") return false;
    if (id.startsWith("@effect/platform-bun")) return false;
    if (id.startsWith("@effect/sql-sqlite-bun")) return false;
    return true;
  },
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
