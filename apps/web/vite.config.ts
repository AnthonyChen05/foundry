import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Dev server proxies the backend planes to core on 8787 — the app itself is
// written same-origin-only (works identically when served by core, no CORS).
const target = process.env.FOUNDRY_DEV_BACKEND ?? "http://127.0.0.1:8787";
const wsTarget = target.replace(/^http/, "ws");

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      "/v1": { target, changeOrigin: true },
      "/hook": { target, changeOrigin: true },
      "/ws": { target: wsTarget, ws: true },
    },
  },
});