import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { users } from "../src/db/schema.js";
import { bootstrapServices } from "../src/runtime.js";
import { startServer, TEST_ADMIN_PASSWORD, type TestCtx } from "./helpers.js";

/**
 * Password auth (ADR-006): user-facing login = username + password → session
 * token. API keys remain a separate credential class for programmatic
 * OpenAI-compatible clients (Bearer /v1/chat/completions) but are NOT a
 * login method. Boot semantics: generated password → admin_credentials.txt
 * (only copy); env-provided password → no file. Bootstrap never rotates an
 * existing credential. Each test boots its own server (helpers' afterEach
 * tears the registry down between tests).
 */

describe("password auth (ADR-006)", () => {
  async function login(server: TestCtx["server"], user: string, pass: string): Promise<Response> {
    return fetch(`${server.baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });
  }

  it("fresh boot backfills owner credentials; generated password → credentials file", async () => {
    const ctx = await startServer({ adminUser: "owner", adminPassword: undefined });
    const row = ctx.server.rt.db.db.select().from(users).limit(1).get();
    expect(row?.username).toBe("owner");
    expect(row?.passwordHash ?? "").toMatch(/^scrypt:32768:8:1:/);
    const path = join(resolve(ctx.server.dataDir), "admin_credentials.txt");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("username: owner");
    expect(text).toMatch(/^password: [A-Za-z0-9_-]{20,}$/m); // generated, not from env
    expect((await login(ctx.server, "owner", "wrong-password")).status).toBe(401);
  });

  it("env-provided password initializes WITHOUT a credentials file", async () => {
    const ctx = await startServer({ adminUser: "owner", adminPassword: "correct-horse-battery" });
    const row = ctx.server.rt.db.db.select().from(users).limit(1).get();
    expect(row?.username).toBe("owner");
    expect(existsSync(join(resolve(ctx.server.dataDir), "admin_credentials.txt"))).toBe(false);
    const res = await login(ctx.server, "owner", "correct-horse-battery");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; expiresAt: string };
    expect(body.sessionToken.startsWith("fnds_")).toBe(true);
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
  });

  it("rejections: wrong password, unknown user, removed key login, empty params", async () => {
    const ctx = await startServer();
    expect((await login(ctx.server, "admin", "nope-nope")).status).toBe(401);
    expect((await login(ctx.server, "nobody", TEST_ADMIN_PASSWORD)).status).toBe(401);
    const keyShape = await fetch(`${ctx.server.baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: ctx.server.token }),
    });
    expect(keyShape.status).toBe(400);
    const empty = await fetch(`${ctx.server.baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "", password: "" }),
    });
    expect(empty.status).toBe(400);
  });

  it("session token authenticates REST; API keys still authenticate the OpenAI-compatible plane", async () => {
    const ctx = await startServer();
    const { sessionToken } = (await (await login(ctx.server, "admin", TEST_ADMIN_PASSWORD)).json()) as {
      sessionToken: string;
    };
    expect(
      (await fetch(`${ctx.server.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${sessionToken}` } })).status,
    ).toBe(200);
    expect((await fetch(`${ctx.server.baseUrl}/v1/models`)).status).toBe(401);
    expect(
      (await fetch(`${ctx.server.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ctx.server.token}` } }))
        .status,
    ).toBe(200);
  });

  it("password change requires the current password and takes effect", async () => {
    const ctx = await startServer();
    const { sessionToken } = (await (await login(ctx.server, "admin", TEST_ADMIN_PASSWORD)).json()) as {
      sessionToken: string;
    };
    const authed = { "content-type": "application/json", authorization: `Bearer ${sessionToken}` };

    expect(
      (
        await fetch(`${ctx.server.baseUrl}/v1/auth/password`, {
          method: "POST",
          headers: authed,
          body: JSON.stringify({ currentPassword: "wrong", newPassword: "brand-new-password" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${ctx.server.baseUrl}/v1/auth/password`, {
          method: "POST",
          headers: authed,
          body: JSON.stringify({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: "short" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${ctx.server.baseUrl}/v1/auth/password`, {
          method: "POST",
          headers: authed,
          body: JSON.stringify({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: "brand-new-password" }),
        })
      ).status,
    ).toBe(200);

    expect((await login(ctx.server, "admin", TEST_ADMIN_PASSWORD)).status).toBe(401);
    expect((await login(ctx.server, "admin", "brand-new-password")).status).toBe(200);
  });

  it("re-running bootstrap does not reset credentials", async () => {
    const ctx = await startServer({ adminUser: "owner", adminPassword: undefined });
    const path = join(resolve(ctx.server.dataDir), "admin_credentials.txt");
    const before = readFileSync(path, "utf8");
    const mtimeBefore = statSync(path).mtimeMs;
    await bootstrapServices(ctx.server.rt.db, ctx.server.rt.vault, ctx.server.rt.config, { warn: () => {} });
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});