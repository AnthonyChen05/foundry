import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/core/src/db/schema.ts",
  out: "./apps/core/drizzle",
  // Migrations are additive only (data-model.md); we commit generated SQL.
  strict: true,
  verbose: true,
});