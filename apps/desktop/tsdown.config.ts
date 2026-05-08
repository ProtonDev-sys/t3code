import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "ssh-helper": "src/sshHelper.ts",
  },
  format: ["esm"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) =>
    id.startsWith("@effect/") ||
    id === "effect" ||
    id.startsWith("@t3tools/") ||
    id.startsWith("effect-acp"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
