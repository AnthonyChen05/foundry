import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { makeLogger } from "./logger.js";
import { openDatabase } from "./db/open.js";
import { Vault, VaultNotConfiguredError } from "./vault/vault.js";
import { bootstrapServices, buildRuntime } from "./runtime.js";

interface CorePackageInfo {
  version: string;
}

function readVersion(): string {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as CorePackageInfo;
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = makeLogger(config).child({ mod: "boot" });
  const version = readVersion();

  // Vault first: no master key → no keys at rest. Hard guardrail #2.
  let vault: Vault;
  try {
    vault = Vault.fromEnv();
  } catch (err) {
    if (err instanceof VaultNotConfiguredError) {
      logger.fatal({ err }, "vault unavailable — refusing to start");
    } else {
      logger.fatal({ err }, "vault construction failed");
    }
    process.exitCode = 1;
    return;
  }

  const db = openDatabase(config.dbPath, {
    log: (obj, msg) => logger.info(obj, msg),
    logWarn: (obj, msg) => logger.warn(obj, msg),
  });

  await bootstrapServices(db, vault, config, logger);
  const rt = await buildRuntime({ config, version, db, vault });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    try {
      await rt.app.close();
      db.sqlite.close();
      process.exitCode = 0;
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exitCode = 1;
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await rt.app.listen({ port: config.port, host: config.host });
  logger.info(
    { host: config.host, port: config.port, dataDir: resolve(config.dataDir), version },
    "foundry ready",
  );
}

void main();