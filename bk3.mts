// Full-runtime repro of the boot-time backup: buildRuntime + start(1440).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FOUNDRY_MASTER_KEY ??= "probe-master-key";
const { loadConfig } = await import("@foundry/core/config");
const { openDatabase } = await import("@foundry/core/db");
const { Vault } = await import("@foundry/core/vault");
const { bootstrapServices, buildRuntime } = await import("@foundry/core/runtime");
const dataDir = mkdtempSync(join(tmpdir(), "bk3-"));
const config = {
  ...loadConfig(),
  port: 0,
  host: "127.0.0.1",
  dataDir,
  dbPath: join(dataDir, "foundry.db"),
  adminPassword: "bk3-admin-pw",
  sandboxDriver: "fake",
  logLevel: "info",
};
const db = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
const boot = await bootstrapServices(db, Vault.fromEnv(), config, { warn: () => {} });
const rt = await buildRuntime({ config, version: "bk3", db, vault: Vault.fromEnv() });
// The runtime already called start(1440) at line 213 — watch the outcome:
await new Promise((r) => setTimeout(r, 2000));
const dirs = rt.backup.list();
console.log("boot backup dirs:", dirs.length, dirs[0]?.dir.split(/[\/]/).pop() ?? "NONE");
await rt.shutdownServices();
await rt.app.close();
db.sqlite.close();
console.log("BK3_DONE");
