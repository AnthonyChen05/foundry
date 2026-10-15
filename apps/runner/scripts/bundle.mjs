// Single-file runner bundle for the desktop shell's supervisor.
// Everything here is pure JS (dockerode, sdk-ts, protocol) — no native modules
// are reachable from the ./sandbox barrel. Static imports only: dynamic
// imports would break single-file esbuild bundling.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/main.js",
  sourcemap: true,
  // ssh2's OPTIONAL native helper (dockerode → ssh2 for SSH remotes): guarded
  // at require-time in ssh2, never used in our local-docker path.
  external: ["cpu-features"],
  logLevel: "info",
});