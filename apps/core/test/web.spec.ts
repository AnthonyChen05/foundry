import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServer, type TestCtx } from "./helpers.js";
import { resolveWebDir } from "../src/gateway/web.js";

/**
 * P4: core serves the SPA build from the same origin. The shell is public
 * (login gate must load before auth), API paths never fall through to it,
 * and unknown API routes still answer with the OpenAI error envelope.
 */

function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foundry-web-"));
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><html><body><h1>FAKE-SHELL</h1></body></html>",
  );
  writeFileSync(join(dir, "app.js"), "console.log('hi');");
  mkdirSync(join(dir, "_app", "immutable"), { recursive: true });
  writeFileSync(join(dir, "_app", "immutable", "chunk.js"), "export {};");
  return dir;
}

let ctx: TestCtx | undefined;

describe("web serving (P4)", () => {
  it("serves the shell at /, deep links, and hashed assets (no auth)", async () => {
    ctx = await startServer({ webDir: makeWebDir() });
    const { baseUrl } = ctx.server;

    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("FAKE-SHELL");

    // Deep link: no such file — the not-found handler re-serves the shell.
    const deep = await fetch(`${baseUrl}/settings`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("FAKE-SHELL");

    const asset = await fetch(`${baseUrl}/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");

    const nested = await fetch(`${baseUrl}/_app/immutable/chunk.js`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe("export {};");
  });

  it("keeps API paths out of the SPA fallback (auth + envelopes intact)", async () => {
    ctx = await startServer({ webDir: makeWebDir() });
    const { baseUrl, token } = ctx.server;

    // Unauthenticated API request: the auth gate still answers, not the shell.
    const noAuth = await fetch(`${baseUrl}/v1/definitely-not-real`);
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as { error: { type: string } }).error.type).toBe(
      "authentication_error",
    );

    // Authenticated: unknown /v1 route keeps the OpenAI envelope shape.
    const authed = await fetch(`${baseUrl}/v1/definitely-not-real`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(404);
    const authedBody = (await authed.json()) as { error: { type: string; message: string } };
    expect(authedBody.error.type).toBe("not_found_error");
    expect(authedBody.error.message).toBe("route not found");

    // POST (not GET/HEAD) never falls through to the shell either.
    const post = await fetch(`${baseUrl}/junk`, { method: "POST", body: "{}" });
    expect(post.status).toBe(401); // auth gate first

    const postAuthed = await fetch(`${baseUrl}/junk`, {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(postAuthed.status).toBe(404);
    expect(((await postAuthed.json()) as { error: { type: string } }).error.type).toBe(
      "not_found_error",
    );

    // healthz unaffected by the fallback.
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("resolveWebDir: explicit path must be a real build (no fallback)", async () => {
    const good = makeWebDir();
    expect(resolveWebDir(good)).toBe(good);
    const missing = join(tmpdir(), `foundry-missing-${Date.now()}`);
    expect(resolveWebDir(missing)).toBeUndefined();
  });

  it("API-only mode (no web dir): no SPA fallback — auth gate + default 404 as before", async () => {
    // Explicit-but-invalid webDir → resolveWebDir returns undefined (no
    // fallback), so runtime skips web serving even though the repo has a
    // real apps/web/build for the auto-detect path to pick up.
    ctx = await startServer({ webDir: join(tmpdir(), "foundry-web-missing-1") });
    const { baseUrl, token } = ctx.server;

    // Unmatched paths still hit the auth gate first (pre-existing behavior).
    const noAuth = await fetch(`${baseUrl}/junk`);
    expect(noAuth.status).toBe(401);

    // With a token: no shell — Fastify's own (non-envelope) default 404,
    // exactly as in API-only mode before P4.
    const authed = await fetch(`${baseUrl}/junk`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(404);
    const body = (await authed.json()) as { message?: string; error?: string };
    expect(typeof body.message).toBe("string");
    expect(body.message).toContain("not found");
    expect(body.error).not.toBe("route not found");
  });
});