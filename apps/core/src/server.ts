import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import websocket from "@fastify/websocket";
import { PROTOCOL_VERSION } from "@foundry/protocol";
import type { AppConfig } from "./config.js";
import { makeLogger } from "./logger.js";
import type { FoundryDb } from "./db/open.js";
import type { Vault } from "./vault/vault.js";

export interface AppDeps {
  config: AppConfig;
  db: FoundryDb;
  /** Present when FOUNDRY_MASTER_KEY is configured. */
  vault?: Vault;
}

export interface Readiness {
  ok: boolean;
  checks: { db: boolean; vault: boolean; migration: boolean };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, vault } = deps;
  const app = Fastify({
    // pino.Logger satisfies FastifyBaseLogger structurally; the generic-level
    // cast avoids fastify's msgPrefix typing friction.
    loggerInstance: makeLogger(config) as FastifyBaseLogger,
    // Remote access is via Tailscale/loopback proxies (ADR-009); trust their hops.
    trustProxy: true,
  });

  // The plugin's onRoute hook rewrites `{ websocket: true }` routes and only
  // applies to routes added AFTER registration completes — awaiting is what
  // makes ws_hub's `/ws` handler receive a WebSocket instead of (request, reply).
  await app.register(websocket);

  const startedAt = Date.now();

  app.get("/healthz", async () => {
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      uptimeS: Math.floor((Date.now() - startedAt) / 1000),
    };
  });

  app.get("/readyz", async (_, reply) => {
    let migration = false;
    try {
      const row = db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'")
        .get() as { n: number } | undefined;
      migration = (row?.n ?? 0) > 0;
    } catch {
      migration = false;
    }
    const readiness: Readiness = {
      ok: migration && vault !== undefined,
      checks: {
        db: db.sqlite.open,
        vault: vault !== undefined,
        migration,
      },
    };
    if (!readiness.ok) {
      await reply.code(503).send(readiness);
      return;
    }
    return readiness;
  });

  return app;
}