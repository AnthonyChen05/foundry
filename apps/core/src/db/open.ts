import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";
import type BetterSqlite3 from "better-sqlite3";
import * as schema from "./schema.js";

export interface FoundryDb {
  sqlite: BetterSqlite3.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** True if the sqlite-vec extension loaded (memory embeddings usable). */
  vecAvailable: boolean;
}

export interface OpenDbOptions {
  /** pino-style logger; when omitted, logs go nowhere. */
  log?: (obj: object, msg: string) => void;
  logWarn?: (obj: object, msg: string) => void;
}

const migrationsFolder = resolve(import.meta.dirname, "..", "..", "drizzle");

/**
 * Opens (creating if needed) the SQLite database and applies migrations.
 * - WAL mode, foreign_keys ON, busy_timeout (ADR-007)
 * - loads the sqlite-vec extension; creates the `memory_vec` virtual table
 *   when the extension is present (it cannot live in drizzle migrations).
 * Idempotent: safe to call on every boot.
 */
export function openDatabase(dbPath: string, opts: OpenDbOptions = {}): FoundryDb {
  const log = opts.log ?? (() => {});
  const logWarn = opts.logWarn ?? log;
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  let vecAvailable = false;
  try {
    sqliteVec.load(sqlite);
    vecAvailable = true;
    log({ mod: "db" }, "sqlite-vec loaded");
  } catch (err) {
    // Non-fatal: memory features (P3) degrade; nothing in P0–P2 needs vec.
    logWarn({ mod: "db", err }, "sqlite-vec unavailable — memory_vec table will not be created");
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  if (vecAvailable) {
    // Embedding row id = memories.id (data-model.md).
    sqlite.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding_id TEXT PRIMARY KEY, embedding FLOAT[768])",
    );
  }

  log({ mod: "db", dbPath, vecAvailable }, "database ready");
  return { sqlite, db, vecAvailable };
}