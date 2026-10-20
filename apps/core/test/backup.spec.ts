import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService } from "../src/backup/backup.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/open.js";

/**
 * P5 backup job: online .backup() snapshot (a valid sqlite db), incremental
 * blob copy keyed off the prior manifest, rotation, re-entry guard, and the
 * FOUNDRY_BACKUP_MIN scheduler (0 = off).
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort (Windows file locks)
    }
  }
});

const BLOB_A = Buffer.alloc(64, 1).toString("hex").slice(0, 64); // sha256-shape name
const BLOB_B = Buffer.alloc(64, 2).toString("hex").slice(0, 64);

function makeSvc(): { svc: BackupService; dataDir: string; close(): void } {
  const dataDir = mkdtempSync(join(tmpdir(), "foundry-backup-"));
  tmpDirs.push(dataDir);
  const config = { ...loadConfig({}), dataDir, dbPath: join(dataDir, "foundry.db") };
  const db = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
  return { svc: new BackupService(db, config), dataDir, close: () => db.sqlite.close() };
}

function backupDirs(dataDir: string): string[] {
  const root = join(dataDir, "backups");
  return existsSync(root) ? readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)) : [];
}

describe("backup job (P5)", () => {
  it("produces a valid sqlite snapshot (readable, with the schema)", async () => {
    const { svc, dataDir, close } = makeSvc();
    const r =
      await svc.runOnce();
    expect(existsSync(r.dir)).toBe(true);
    expect(r.dbBytes).toBeGreaterThan(0);
    expect(r.blobFiles).toBe(0); // no blobs dir yet — tolerated, not fatal
    const snapshot = new Database(join(r.dir, "foundry.db"), { readonly: true });
    expect((snapshot.prepare("select count(*) as n from sqlite_master").get() as { n: number }).n).toBeGreaterThan(0);
    snapshot.close();
    const manifests = readdirSync(r.dir).filter((f) => f === "manifest.json");
    expect(manifests).toEqual(["manifest.json"]);
    expect(backupDirs(dataDir)).toHaveLength(1);
    close();
  });

  it("copies new blobs once, skips what the prior manifest has", async () => {
    const { svc, dataDir, close } = makeSvc();
    const blobs = join(dataDir, "blobs");
    expect((await svc.runOnce()).blobFiles).toBe(0);

    mkdirSync(blobs, { recursive: true });
    writeFileSync(join(blobs, BLOB_A), "aaa");
    await delay(30); // distinct dir stamps (Windows clock granularity)
    const r2 = await svc.runOnce();
    expect(r2.blobFiles).toBe(1);
    expect(r2.blobsSkippedFromPrior).toBe(0);
    expect(r2.blobBytes).toBe(3);
    expect(existsSync(join(r2.dir, "blobs", BLOB_A))).toBe(true);

    writeFileSync(join(blobs, BLOB_B), "bbbb");
    await delay(30);
    const r3 = await svc.runOnce();
    expect(r3.blobFiles).toBe(2); // reported: copied + carried-forward count
    expect(r3.blobsSkippedFromPrior).toBe(1); // BLOB_A was in the prior manifest
    expect(r3.blobBytes).toBe(4); // BLOB_B copied; BLOB_A not re-copied
    close();
  });

  it("rotates: keeps the newest N dirs", async () => {
    const { svc, dataDir, close } = makeSvc();
    for (let i = 0; i < 4; i++) {
      await svc.runOnce(2);
      await delay(30);
    }
    expect(backupDirs(dataDir)).toHaveLength(2);
    close();
  });

  it("refuses overlapping runs", async () => {
    const { svc, close } = makeSvc();
    // Second call's re-entry check throws synchronously (first is mid-flight).
    const both = Promise.all([svc.runOnce(), svc.runOnce()]);
    await expect(both).rejects.toThrow("already running");
    close();
  });

  it("FOUNDRY_BACKUP_MIN=0 means off; a positive interval backs up at boot", async () => {
    const { svc, dataDir, close } = makeSvc();
    svc.start(0);
    expect(svc.timerArmed).toBe(false);
    expect(backupDirs(dataDir)).toHaveLength(0);

    svc.start(5);
    expect(svc.timerArmed).toBe(true);
    const deadline = Date.now() + 3000;
    while (backupDirs(dataDir).length === 0 && Date.now() < deadline) await delay(25);
    expect(backupDirs(dataDir).length).toBeGreaterThanOrEqual(1); // boot-time run
    svc.stop();
    expect(svc.timerArmed).toBe(false);
    close();
  });
});