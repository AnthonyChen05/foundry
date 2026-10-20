import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/drizzle/**",
      "packages/protocol/schema/**",
      // P4 Android build outputs (generated HTML unit-test reports).
      "apps/android/app/build/**",
      // Scratch probe scripts for the manual smoke stack (gitignored).
      "tmp-smoke/**",
      // P4 web app build outputs (generated) — eslint has no .svelte parser.
      "apps/web/.svelte-kit/**",
      "apps/web/build/**",
      "**/*.svelte",
      // P4 desktop shell: Rust target dir emits generated JS (tauri glue).
      "apps/desktop/src-tauri/target/**",
      "apps/desktop/src-tauri/gen/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // `_`-prefixed args are intentional: required positional slots in typed
      // callbacks (e.g. a ws handler that ignores the request param).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);