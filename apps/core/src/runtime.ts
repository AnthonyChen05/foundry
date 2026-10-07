import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { FoundryDb } from "./db/open.js";
import type { Vault } from "./vault/vault.js";
import { newApiKey } from "./vault/vault.js";
import { buildApp } from "./server.js";
import { AuthService, type IssuedKey } from "./auth/auth.js";
import { ProviderStore } from "./providers/store.js";
import { ChatService, type EmitFn } from "./gateway/chat.js";
import { registerRest } from "./gateway/rest.js";
import { WsHub } from "./gateway/ws_hub.js";

/**
 * Wire-up shared by `main.ts`, tests, and the smoke script: services, routes,
 * and the single event router (hub.publish is THE emit path — REST runs
 * broadcast too, so every client stays consistent with server state).
 */

export interface FoundryRuntime {
  config: AppConfig;
  version: string;
  db: FoundryDb;
  vault: Vault;
  auth: AuthService;
  providers: ProviderStore;
  chat: ChatService;
  hub: WsHub;
  app: FastifyInstance;
}

export async function buildRuntime(deps: {
  config: AppConfig;
  version: string;
  db: FoundryDb;
  vault: Vault;
}): Promise<FoundryRuntime> {
  const { config, version, db, vault } = deps;
  const auth = new AuthService(db);
  const providers = new ProviderStore(db, vault);
  const chat = new ChatService(db, providers);
  const emit: EmitFn = (event, channel, payload) => hub.publish(event, channel, payload);
  const app = await buildApp({ config, db, vault });
  const hub = new WsHub({ config, dbx: db, chat, providers, auth, version });
  hub.register(app);
  registerRest(app, { chat, providers, auth, version, emit });
  return { config, version, db, vault, auth, providers, chat, hub, app };
}

export interface BootstrapResult {
  userId: string;
  /** Plaintext ONLY on first boot (root key auto-minted); undefined after. */
  rootKey?: IssuedKey;
}

/** Narrow log surface for bootstrap (pino or a trivial silent impl). */
export interface BootstrapLog {
  warn: (obj: object, msg?: string) => void;
}

/**
 * First-boot bootstrap: owner user + one root admin key (written to
 * admin_key.txt under the data dir, whose path — never the key — is logged)
 * + the dummy provider seed. Idempotent on every later boot.
 */
export async function bootstrapServices(
  db: FoundryDb,
  vault: Vault,
  config: AppConfig,
  log: BootstrapLog,
): Promise<BootstrapResult> {
  const auth = new AuthService(db);
  const providers = new ProviderStore(db, vault);
  const minter = (name: string): IssuedKey => ({
    id: randomBytes(4).toString("hex"),
    name,
    plaintext: newApiKey(),
  });
  const boot = await auth.ensureBootstrap(minter);
  const rootKey = boot.issuedKey;
  if (rootKey !== undefined) {
    const keyPath = join(resolve(config.dataDir), "admin_key.txt");
    // A fresh mint means no valid key exists anywhere — overwrite any stale file.
    writeFileSync(keyPath, `${rootKey.plaintext}\n`);
    log.warn({ path: keyPath }, "root admin key auto-minted at first boot — file contains the ONLY copy");
  }
  providers.seedDummy();
  return { userId: boot.userId, ...(rootKey !== undefined ? { rootKey } : {}) };
}