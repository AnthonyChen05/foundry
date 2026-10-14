import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // SPA mode: no SSR, everything served by core from `build/` with the
    // index.html fallback handling deep links.
    adapter: adapter({
      fallback: "index.html",
      pages: "build",
      assets: "build",
      strict: false,
    }),
  },
};

export default config;