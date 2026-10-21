import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FoundryClient } from "@foundry/sdk-ts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "../src/config.js";
import { messages, users } from "../src/db/schema.js";
import { DockerLauncher } from "../src/sandbox/docker.js";
import { TEST_ADMIN_PASSWORD, startServer, type TestCtx } from "./helpers.js";

/**
 * P5 hardening, wired end-to-end: chat rate limit + concurrent-run quota
 * (denies BEFORE any persistence, and the audit rows to prove who/why),
 * the REST-plane 429, the backup job + its admin routes, audit on admin
 * mutations and logins, and the multi-user ownership asserts (foreign
 * run/env/chat → indistinguishable 404s).
 */

const tmpCtxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of tmpCtxs.splice(0)) await c.cleanup();
});

async function boot(overrides: Parameters<typeof startServer>[0]): Promise<TestCtx> {
  const c = await startServer(overrides);
  tmpCtxs.push(c);
  return c;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function sockFor(c: TestCtx, token: string): ReturnType<FoundryClient["socket"]> {
  return new FoundryClient({ baseUrl: c.server.baseUrl, token }).socket();
}

function eventsOf(seen: { event: string; payload: unknown }[], name: string): Record<string, unknown>[] {
  return seen.filter((e) => e.event === name).map((e) => e.payload as Record<string, unknown>);
}

/** json column meta: object (drizzle parses) or a string — normalize. */
function asMeta(m: unknown): Record<string, unknown> {
  return typeof m === "string" ? (JSON.parse(m) as Record<string, unknown>) : (m ?? {}) as Record<string, unknown>;
}

/** A second user born straight in the db (multi-user-ready, single real owner). */
function secondUser(c: TestCtx): { userId: string; token: string } {
  const rt = c.server.rt;
  const userId = `u_${randomBytes(6).toString("hex")}`;
  rt.db.db.insert(users).values({ id: userId, name: "attacker", createdAt: Date.now() }).run();
  return { userId, token: rt.auth.mintKey(userId, "attacker-key").plaintext };
}

describe("P5 chat rate limit (WS)", () => {
  it("denies sends past the per-minute bucket BEFORE any persistence", async () => {
    const c = await boot({ rateChatPerMin: 1 });
    const rt = c.server.rt;
    const sock = sockFor(c, c.server.token);
    await sock.connect();
    const chat1 = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const chat2 = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };

    expect((await sock.req("chat.send", { chatId: chat1.id, content: "one" }, "rate-1")) as { runId: string }).toBeDefined();
    await expect(sock.req("chat.send", { chatId: chat2.id, content: "two" }, "rate-2")).rejects.toMatchObject({ code: "capacity" });

    // nothing persisted for the rejected send — retries are clean
    expect(rt.db.db.select().from(messages).where(eq(messages.conversationId, chat2.id)).all()).toHaveLength(0);

    const denial = rt.audit.list().find((e) => e.action === "chat.send" && e.outcome === "denied");
    expect(denial?.action).toBe("chat.send");
    expect(asMeta(denial?.meta).reason).toBe("rate");
    expect(asMeta(denial?.meta).chatId).toBe(chat2.id);
    // successful sends are traffic, not audit — only the denials land
    expect(rt.audit.list().some((e) => e.action === "chat.send" && e.outcome === "ok")).toBe(false);
    sock.close();
  });
});

describe("P5 concurrent-run quota (WS)", () => {
  it("denies a new run while one is parked on a gate; frees up when it ends", async () => {
    const c = await boot({ maxConcurrentRuns: 1, rateChatPerMin: 1000 });
    const rt = c.server.rt;
    const sock = sockFor(c, c.server.token);
    await sock.connect();
    const seen: { event: string; payload: unknown }[] = [];
    sock.on((event, channel, seq, payload) => seen.push({ event, payload }));

    const chatA = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const parked = (await sock.req("chat.send", {
      chatId: chatA.id,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "quota-1")) as { runId: string };
    await waitFor(() => eventsOf(seen, "run.gate_request").length === 1, 5000, "gate to park run A");
    expect(rt.chat.getRun(parked.runId)?.status).toBe("waiting_approval");

    // the SAME user cannot start another run now
    const chatB = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    await expect(sock.req("chat.send", { chatId: chatB.id, content: "blocked" }, "quota-2")).rejects.toMatchObject({ code: "capacity" });
    expect(rt.db.db.select().from(messages).where(eq(messages.conversationId, chatB.id)).all()).toHaveLength(0);
    const denial = rt.audit.list().find((e) => e.action === "chat.send" && e.outcome === "denied");
    expect(asMeta(denial?.meta).reason).toBe("concurrency");

    // resolve the gate → the run finishes → the quota frees up
    const gateId = eventsOf(seen, "run.gate_request")[0]?.gateId as string;
    expect(typeof gateId).toBe("string");
    await sock.req("run.approve", { runId: parked.runId, gateId, approve: true }, "quota-approve");
    await waitFor(() => rt.chat.getRun(parked.runId)?.status === "done", 8000, "parked run to finish");
    const next = (await sock.req("chat.send", { chatId: chatB.id, content: "now fine" }, "quota-3")) as { runId: string };
    await waitFor(() => rt.chat.getRun(next.runId)?.status === "done", 8000, "post-quota run");
    // gate resolution itself is audited
    expect(rt.audit.list().some((e) => e.action === "gate.resolve")).toBe(true);
    sock.close();
  });
});

describe("P5 REST rate limit", () => {
  it("429s past the bucket in the OpenAI envelope; non-limited routes still serve", async () => {
    const c = await boot({ rateApiPerMin: 2 });
    const post = (): Promise<{ status: number; body: Record<string, unknown> }> =>
      fetch(`${c.server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "dummy/scripted", messages: [{ role: "user", content: "x" }] }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const third = await post();
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: { message: "rate limit exceeded", type: "api_error" } });
    // GET /v1/models is not metered by the completions bucket
    const models = await fetch(`${c.server.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${c.server.token}` } });
    expect(models.status).toBe(200);
  });
});

describe("P5 backup job + admin routes", () => {
  it("triggers a manual backup, lists it, audits it", async () => {
    // Job OFF here so the manual trigger can't race the boot-time run
    // (the periodic/boot behavior itself is covered in backup.spec.ts).
    const c = await boot({ backupMin: 0 });

    const manual = await fetch(`${c.server.baseUrl}/v1/admin/backup`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.server.token}` },
    });
    if (manual.status !== 200) console.error("BACKUP RESPONSE:", manual.status, await manual.clone().text());
    expect(manual.status).toBe(200);
    const mbody = (await manual.json()) as { dir: string; dbBytes: number };
    expect(mbody.dbBytes).toBeGreaterThan(0);

    const listR = await fetch(`${c.server.baseUrl}/v1/admin/backups`, { headers: { authorization: `Bearer ${c.server.token}` } });
    const lbody = (await listR.json()) as { backups: { dir: string; bytes: number }[] };
    expect(lbody.backups.length).toBeGreaterThanOrEqual(1);
    expect(lbody.backups.every((b) => b.bytes > 0)).toBe(true);

    const auditR = await fetch(`${c.server.baseUrl}/v1/admin/audit`, { headers: { authorization: `Bearer ${c.server.token}` } });
    const abody = (await auditR.json()) as { events: { action: string }[] };
    expect(abody.events.map((e) => e.action)).toContain("admin.backup");
  });
});

describe("P5 audit log", () => {
  it("records admin mutations — and no secret ever reaches it", async () => {
    const c = await boot({});
    const rt = c.server.rt;
    const jso = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const r = await fetch(`${c.server.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${c.server.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };

    expect((await jso("POST", "/v1/admin/providers", {
      kind: "openai_compat",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "vault-me-please",
    })).status).toBe(201);
    expect((await jso("POST", "/v1/admin/keys", { name: "audit-probe" })).status).toBe(200);

    const actions = rt.audit.list().map((e) => e.action);
    expect(actions).toContain("admin.providers.upsert");
    expect(actions).toContain("admin.keys.create");
    expect(JSON.stringify(rt.audit.list())).not.toContain("vault-me-please");
    expect(JSON.stringify(rt.audit.list())).not.toMatch(/fnd_[A-Za-z0-9_-]{20,}/);
  });

  it("logins land as ok/denied", async () => {
    const c = await boot({});
    const rt = c.server.rt;
    expect(await rt.auth.loginWithPassword("admin", "wrong")).toBeUndefined();
    expect(await rt.auth.loginWithPassword("admin", TEST_ADMIN_PASSWORD)).toBeDefined();
    const denied = rt.audit.list().find((e) => e.action === "auth.login" && e.outcome === "denied");
    expect(rt.audit.list().find((e) => e.action === "auth.login" && e.outcome === "ok")).toBeDefined();
    expect(denied).toBeDefined();
  });

  it("admin route serves the log newest-first", async () => {
    const c = await boot({});
    const rt = c.server.rt;
    rt.audit.record({ action: "probe.first" });
    rt.audit.record({ action: "probe.second" });
    const r = await fetch(`${c.server.baseUrl}/v1/admin/audit`, { headers: { authorization: `Bearer ${c.server.token}` } });
    const body = (await r.json()) as { events: { action: string }[] };
    const actions = body.events.map((e) => e.action);
    expect(actions.indexOf("probe.second")).toBeLessThan(actions.indexOf("probe.first"));
  });
});

describe("P5 multi-user ownership", () => {
  it("a foreign user's run/env/chat all answer 404 — indistinguishable from unknown", async () => {
    const c = await boot({});
    const rt = c.server.rt;
    const adminUid = rt.auth.verifyToken(c.server.token)?.userId as string;
    const att = secondUser(c);
    const admin = sockFor(c, c.server.token);
    const attSock = sockFor(c, att.token);
    await admin.connect();
    await attSock.connect();

    const chat = (await admin.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await admin.req("chat.send", { chatId: chat.id, content: "own work" }, "own-1")) as { runId: string };
    await waitFor(() => rt.chat.getRun(send.runId)?.status === "done", 5000, "admin run to finish");
    expect(((await admin.req("run.get", { runId: send.runId })) as { id: string }).id).toBe(send.runId);

    // foreign + unknown are the SAME 404, for every run.* method (run.cancel
    // needs its idem first — that gate sits ahead of dispatch)
    await expect(attSock.req("run.get", { runId: send.runId })).rejects.toMatchObject({ code: "not_found" });
    await expect(attSock.req("run.events", { runId: send.runId })).rejects.toMatchObject({ code: "not_found" });
    await expect(attSock.req("run.cancel", { runId: send.runId }, "att-cancel")).rejects.toMatchObject({ code: "not_found" });
    await expect(attSock.req("run.approve", { runId: send.runId, gateId: "gate_none", approve: true }, "att-approve")).rejects.toMatchObject({ code: "not_found" });
    await expect(attSock.req("run.get", { runId: "run_nope" })).rejects.toMatchObject({ code: "not_found" });

    await expect(attSock.req("chat.history", { chatId: chat.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(attSock.req("chat.send", { chatId: chat.id, content: "intrude" }, "att-1")).rejects.toMatchObject({ code: "not_found" });

    // an explicit foreign envId no longer passes term/files either
    const adminEnv = await rt.sandbox.ensureEnv(adminUid);
    await expect(attSock.req("files.list", { envId: adminEnv.envId, path: "." })).rejects.toMatchObject({ code: "not_found" });
    await expect(attSock.req("term.open", { envId: adminEnv.envId }, "att-term")).rejects.toMatchObject({ code: "not_found" });
    // while the attacker's own implicit env works
    expect(Array.isArray(await attSock.req("files.list", { path: "." }))).toBe(true);
    admin.close();
    attSock.close();
  });
});

describe("P5 sandbox runtime + config knobs", () => {
  it("DockerLauncher.runtimeField: {} for the default, Runtime field otherwise", () => {
    expect(DockerLauncher.runtimeField("")).toEqual({});
    expect(DockerLauncher.runtimeField("runc")).toEqual({});
    expect(DockerLauncher.runtimeField("runsc")).toEqual({ Runtime: "runsc" });
  });

  it("P5 knobs parse; blanks fall back to defaults; negatives and junk rejected", () => {
    const c = loadConfig({
      FOUNDRY_SANDBOX_RUNTIME: " runsc ",
      FOUNDRY_SANDBOX_OT_HOST: " host.docker.internal ",
      FOUNDRY_RATE_CHAT_PER_MIN: "7",
      FOUNDRY_RATE_API_PER_MIN: "70",
      FOUNDRY_MAX_CONCURRENT_RUNS: "3",
      FOUNDRY_BACKUP_MIN: "0",
    });
    expect(c.sandboxRuntime).toBe("runsc");
    expect(c.sandboxOtHost).toBe("host.docker.internal");
    expect(c.rateChatPerMin).toBe(7);
    expect(c.rateApiPerMin).toBe(70);
    expect(c.maxConcurrentRuns).toBe(3);
    expect(c.backupMin).toBe(0);

    const blank = loadConfig({});
    expect(blank.sandboxRuntime).toBe("runc");
    expect(blank.sandboxOtHost).toBe("127.0.0.1");
    expect(blank.rateChatPerMin).toBe(60);
    expect(blank.rateApiPerMin).toBe(600);
    expect(blank.maxConcurrentRuns).toBe(8);
    expect(blank.backupMin).toBe(1440);

    expect(() => loadConfig({ FOUNDRY_BACKUP_MIN: "-5" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ FOUNDRY_RATE_CHAT_PER_MIN: "x" })).toThrow(ConfigValidationError);
  });
});