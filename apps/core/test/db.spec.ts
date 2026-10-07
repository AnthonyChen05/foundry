import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/open.js";
import { ALL_TABLES } from "../src/db/schema.js";

const dir = mkdtempSync(join(tmpdir(), "foundry-db-"));
const dbPath = join(dir, "foundry.db");

describe("db", () => {
  const foundry = openDatabase(dbPath);

  afterAll(() => {
    foundry.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates all tables from data-model.md", () => {
    const rows = foundry.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const present = new Set(rows.map((r) => r.name));
    for (const t of ALL_TABLES) {
      expect(present.has(t), `missing table ${t}`).toBe(true);
    }
  });

  it("runs in WAL mode with foreign keys on", () => {
    expect(foundry.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(foundry.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("re-opens idempotently (migrations never duplicate)", () => {
    foundry.sqlite.close();
    const again = openDatabase(dbPath);
    expect(again.vecAvailable).toBe(true);
    expect(again.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    again.sqlite.close();
  });
});