import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.spec.ts", "apps/*/test/**/*.spec.ts"],
    setupFiles: ["./test.setup.ts"],
    // Integration tests (Docker etc.) gate themselves on FOUNDRY_INTEGRATION.
    pool: "forks",
  },
});