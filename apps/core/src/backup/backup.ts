import { readdirSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";

/**
 * P5 backup job: SQLite online backup (`.backup()` — WAL-safe, consistent
 * snapshot) + incremental blob copy. Blobs are content-addressed
 * (sha256 = filename), so "rsync" degenerates to: copy what the previous
 * backup's manifest doesn't already contain. Backups live under
 * `<dataDir>/backups/<ts>/` with the db + blobs + manifest.json; keep N.
 *
 * Manual trigger via `POST /v1/admin/backup`; the periodic job runs when
 * FOUNDRY_BACKUP_MIN > 0 (default 1440 = daily).
 */

export interface BackupResult {
  dir: string;
  dbBytes: number;
  blobFiles: number;
  blobBytes: number;
  durationMs: number;
  blobsSkippedFromPrior: number;
}

/**
 * Backup dir name — millisecond precision (Windows clock can't be trusted
 * below ~15ms, so same-second runs would otherwise collide) and ':' dropped
 * (illegal in a Windows filename).
 */
function stamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

export class BackupService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly dbx: FoundryDb,
    private readonly config: AppConfig,
    private readonly log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
  ) {}

  /** Backups dir = <dataDir>/backups; the data dir itself is never backed into. */
  private backupRoot(): string {
    return join(resolve(this.config.dataDir), "backups");
  }

  /** Newest backup dirs, newest first — rotation keeps the first N. */
  private existingDirs(): string[] {
    if (!existsSync(this.backupRoot())) return [];
    return readdirSync(this.backupRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse();
  }

  async runOnce(keep = 7): Promise<BackupResult> {
    if (this.running) throw new Error("backup already running");
    this.running = true;
    const startedAt = Date.now();
    try {
      // Baseline BEFORE this run's dir exists — it would otherwise sort as
      // the newest dir (no manifest yet) and shadow the real prior backup.
      const prior = this.priorManifest();
      const dir = join(this.backupRoot(), stamp(new Date(startedAt)));
      mkdirSync(dir, { recursive: true });

      // 1. Online snapshot of the DB (safe under concurrent writes).
      const dbFile = join(dir, basename(this.config.dbPath));
      await this.dbx.sqlite.backup(dbFile);
      const dbBytes = statSync(dbFile).size;

      // 2. Blobs: copy files the prior manifest doesn't have (content-addressed).
      const blobsDir = join(resolve(this.config.dataDir), "blobs");
      let blobFiles = 0;
      let blobBytes = 0;
      let blobsSkippedFromPrior = 0;
      // Fresh installs have no blobs dir yet — an empty set is fine.
      const files = existsSync(blobsDir) ? readdirSync(blobsDir).filter((f) => f.length === 64) : []; // sha256 hex names only
      if (files.length > 0) mkdirSync(join(dir, "blobs"), { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: startedAt, files }));
      for (const f of files) {
        if (prior.has(f)) {
          blobsSkippedFromPrior += 1;
          continue;
        }
        copyFileSync(join(blobsDir, f), join(dir, "blobs", f));
        blobFiles += 1;
        blobBytes += statSync(join(blobsDir, f)).size;
      }

      const result: BackupResult = {
        dir,
        dbBytes,
        blobFiles: blobFiles + blobsSkippedFromPrior,
        blobBytes,
        durationMs: Date.now() - startedAt,
        blobsSkippedFromPrior,
      };
      this.log?.info({ mod: "backup", ...result }, "backup complete");
      this.rotate(keep);
      return result;
    } finally {
      this.running = false;
    }
  }

  /** The previous backup's blob manifest set (incremental baseline). */
  private priorManifest(): Set<string> {
    const dir = this.existingDirs()[0];
    if (dir === undefined) return new Set();
    try {
      const m = JSON.parse(readFileSync(join(this.backupRoot(), dir, "manifest.json"), "utf8")) as { files?: string[] };
      return new Set(m.files ?? []);
    } catch {
      return new Set();
    }
  }

  /** Keep the newest `keep` backup dirs. */
  rotate(keep: number): void {
    const dirs = this.existingDirs();
    for (const old of dirs.slice(keep)) {
      try {
        rmSync(join(this.backupRoot(), old), { recursive: true, force: true });
      } catch (err) {
        this.log?.warn?.({ mod: "backup", dir: old, err: String(err) }, "backup rotation failed");
      }
    }
  }

  list(): { dir: string; bytes: number }[] {
    return this.existingDirs()
      .slice(0, 20)
      .map((d) => {
        const full = join(this.backupRoot(), d);
        return { dir: d, bytes: this.dirSize(full) };
      });
  }

  private dirSize(dir: string): number {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      total += entry.isDirectory() ? this.dirSize(full) : statSync(full).size;
    }
    return total;
  }

  /** Whether a periodic job is currently armed (tests). */
  get timerArmed(): boolean {
    return this.timer !== undefined;
  }

  /** Periodic job; FOUNDRY_BACKUP_MIN minutes (0 = off). */
  start(intervalMin: number): void {
    if (intervalMin <= 0) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) =>
        this.log?.warn?.({ mod: "backup", err: String(err) }, "scheduled backup failed"),
      );
    }, intervalMin * 60_000);
    // also capture a backup at boot (cheap: incremental blobs)
    void this.runOnce().catch(() => undefined);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}