import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/open.js";
import { Vault } from "../src/vault/vault.js";
import { bootstrapServices, buildRuntime, type FoundryRuntime } from "../src/runtime.js";

/**
 * Test harness: isolated data dir + db + full runtime on an ephemeral port,
 * torn down cleanly per test (Windows: close sqlite BEFORE rmSync).
 */

const MASTER_KEY = "test-master-key-not-a-secret";

export interface TestServer {
  rt: FoundryRuntime;
  port: number;
  baseUrl: string;
  /** Plaintext root admin key (or a freshly minted one). */
  token: string;
  dataDir: string;
}

export interface TestCtx {
  server: TestServer;
  cleanup(): Promise<void>;
}

const openCtxs: TestCtx[] = [];

afterEach(async () => {
  for (const c of openCtxs.splice(0)) {
    await c.cleanup();
  }
});

/** Boot a full runtime on an ephemeral port in a fresh temp dir. Unit specs
 * always get the fake sandbox driver; docker.spec.ts opts into the real one. */
export async function startServer(overrides?: Partial<AppConfig>): Promise<TestCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), "foundry-test-"));
  const config: AppConfig = {
    ...loadConfig(),
    port: 0,
    host: "127.0.0.1",
    dataDir,
    dbPath: join(dataDir, "foundry.db"),
    logLevel: "warn",
    // Unit tests must never touch Docker even when the local daemon runs.
    sandboxDriver: "fake",
    ...overrides,
  };
  process.env.FOUNDRY_MASTER_KEY = MASTER_KEY;
  const vault = Vault.fromEnv();
  const db = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
  const boot = await bootstrapServices(db, vault, config, { warn: () => {} });
  const rt = await buildRuntime({ config, version: "0.0.0-test", db, vault });
  await rt.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = rt.app.server.address();
  if (addr === null || typeof addr !== "object") throw new Error("no server address");
  const port = addr.port;
  const token = boot.rootKey?.plaintext ?? rt.auth.mintKey(boot.userId, "test").plaintext;
  const server: TestServer = { rt, port, baseUrl: `http://127.0.0.1:${port}`, token, dataDir };
  const ctx: TestCtx = {
    server,
    async cleanup(): Promise<void> {
      try {
        await rt.app.close();
      } catch {
        // already closed
      }
      try {
        db.sqlite.close();
      } catch {
        // already closed
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
  openCtxs.push(ctx);
  return ctx;
}

export { MASTER_KEY };