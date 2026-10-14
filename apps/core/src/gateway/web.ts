import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/**
 * Web serving (P4): the SvelteKit SPA (apps/web → Svelte 5 + adapter-static SPA) is
 * served by core from a static build dir on the SAME origin — no CORS and no
 * separate deployment. API paths (rest/egress/ws/term pages) are never
 * swallowed by the SPA fallback; unknown API routes still answer with the
 * OpenAI error envelope.
 *
 * The SPA shell is public on purpose: the login page must load before the
 * user has a session, and built assets carry no secrets (config arrives via
 * authed /v1 calls at runtime).
 */

declare module "fastify" {
  interface FastifyInstance {
    /** Set when the SPA is served; undefined → API-only mode (no fallback). */
    foundryWebDir?: string;
  }
}

/** Prefixes that are API surface — the SPA fallback never answers these. */
const API_PREFIXES = ["/v1", "/hook", "/ws", "/term", "/healthz", "/readyz"];

/**
 * Where is the web build? `FOUNDRY_WEB_DIR` must point at a real build when
 * set (invalid → undefined, no silent fallback); otherwise standard repo
 * locations are probed in order. A candidate counts as a web root only if it
 * contains index.html.
 */
export function resolveWebDir(configured: string | undefined): string | undefined {
  if (configured !== undefined && configured.trim() !== "") {
    const dir = resolve(configured.trim());
    return existsSync(join(dir, "index.html")) ? dir : undefined;
  }
  const candidates = [
    // apps/core/src/gateway/web.ts → ../../../web/build = apps/web/build
    fileURLToPath(new URL("../../../web/build", import.meta.url)),
    join(process.cwd(), "apps", "web", "build"),
    join(process.cwd(), "build"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return resolve(candidate);
  }
  return undefined;
}

/** True when this request must fall through to static serving (or the SPA
 * fallback) instead of the API auth gate. */
export function isSpaPath(app: FastifyInstance, method: string, pathname: string): boolean {
  if (app.foundryWebDir === undefined) return false;
  if (method !== "GET" && method !== "HEAD") return false;
  return !API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function notFoundEnvelope(): { error: { message: string; type: string; param: null } } {
  return { error: { message: "route not found", type: "not_found_error", param: null } };
}

export function registerWeb(app: FastifyInstance, dir: string): void {
  app.foundryWebDir = dir;
  app.register(fastifyStatic, {
    root: dir,
    // Wildcard mount so the filesystem is consulted per request: SPA asset
    // names are content-hashed and change on every rebuild, so routes frozen
    // at boot (wildcard:false) would strand files added later. Unmatched
    // paths still fall to the SPA handler below. Traversal protection is the
    // plugin's own (it rejects paths escaping root).
    wildcard: true,
    setHeaders: (reply) => {
      reply.header("x-content-type-options", "nosniff");
    },
  });

  // One root-scope 404 handler: API paths get the OpenAI envelope, everything
  // else (deep links) gets the SPA shell. Without a web dir this handler is
  // never installed — API-only mode keeps Fastify's default 404 JSON.
  let indexCache: string | undefined;
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = (request.raw.url ?? "/").split("?")[0] ?? "/";
    if (!isSpaPath(app, request.method, pathname)) {
      await reply.code(404).send(notFoundEnvelope());
      return;
    }
    if (indexCache === undefined) {
      indexCache = await readFile(join(dir, "index.html"), "utf8");
    }
    await reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(indexCache);
  });
}