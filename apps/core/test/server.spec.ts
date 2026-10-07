import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/open.js";
import { Vault } from "../src/vault/vault.js";
import { buildApp } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "foundry-srv-"));
const openHandles: { close(): void }[] = [];

function makeDeps(masterKey?: string) {
  const env: Record<string, string | undefined> = { ...process.env, FOUNDRY_DATA_DIR: dir, FOUNDRY_LOG_LEVEL: "warn" };
  if (masterKey !== undefined) {
    env.FOUNDRY_MASTER_KEY = masterKey;
  }
  const config = loadConfig(env);
  const db = openDatabase(join(dir, "test.db"));
  openHandles.push(db.sqlite);
  const vault = masterKey === undefined ? undefined : new Vault(masterKey);
  return buildApp({ config, db, vault });
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await makeDeps("test-key");
});

describe("server", () => {
  afterAll(async () => {
    await app.close();
    // Windows: close sqlite before removing the temp dir (EPERM on open files).
    for (const h of openHandles) h.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("GET /healthz returns ok + protocol version", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; protocol: number; uptimeS: number };
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(0);
    expect(body.uptimeS).toBeGreaterThanOrEqual(0);
  });

  it("GET /readyz is ready when db + vault are configured", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      checks: { db: true, vault: true, migration: true },
    });
  });

  it("GET /readyz reports 503 without the vault", async () => {
    const appNoVault = await makeDeps();
    try {
      const res = await appNoVault.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, checks: { vault: false } });
    } finally {
      await appNoVault.close();
    }
  });
});