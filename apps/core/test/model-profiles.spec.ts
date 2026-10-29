import { setTimeout as delay } from "node:timers/promises";
import { FoundryClient } from "@foundry/sdk-ts";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Model profiles (personality pages): a profile wraps a base catalog model —
 * its system prompt PREPENDS the system turn and its advanced params serve
 * as REQUEST DEFAULTS (explicit caller values win) — at the ONE choke-point
 * (stepCompletion), so WS chats, agent runs, the completions plane AND the
 * egress plane all get it. Selectable everywhere via sys.models + /v1/models.
 */

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

async function boot(overrides?: Parameters<typeof startServer>[0]): Promise<TestCtx> {
  const c = await startServer(overrides);
  ctxs.push(c);
  return c;
}

/** Drive a non-agent streamed chat through WS and return the raw request event. */
async function rawRequestFor(sock: ReturnType<FoundryClient["socket"]>, chatId: string, content: string, idem: string): Promise<{ body: Record<string, unknown>; runId: string }> {
  const res = (await sock.req("chat.send", { chatId, content }, idem)) as { runId: string };
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = (await sock.req("run.get", { runId: res.runId })) as { status: string };
    if (["done", "failed", "cancelled"].includes(run.status)) break;
    await delay(50);
  }
  const evs = (await sock.req("run.events", { runId: res.runId })) as { type: string; payload: unknown }[];
  const raw = evs.find((e) => e.type === "raw_provider_request");
  if (raw === undefined) throw new Error("no raw_provider_request event");
  return { body: (raw.payload as { body: Record<string, unknown> }).body, runId: res.runId };
}

describe("model profiles", () => {
  it("a profile's system prompt + params apply; explicit caller params win", async () => {
    const c = await boot();
    const rt = c.server.rt;
    const uid = rt.auth.verifyToken(c.server.token)?.userId as string;

    const made = rt.providers.upsertProfile({
      userId: uid,
      baseModelId: "dummy/scripted",
      name: "Pirate",
      avatar: "🏴‍☠️",
      systemPrompt: "You are a grumpy pirate captain. Answer as one.",
      params: { temperature: 0.5, top_p: 0.9, presence_penalty: 0.2 },
    });
    expect(made.created).toBe(true);
    const pid = made.id;
    expect(pid).toMatch(/^mp_/);

    // selectable via sys.models with the avatar + the base's caps
    const models = rt.providers.listModels();
    const entry = models.find((m) => m.id === pid);
    expect(entry?.name).toBe("Pirate");
    expect(entry?.avatar).toBe("🏴‍☠️");
    expect((entry?.providerId ?? "").length).toBeGreaterThan(0);

    const sock = new FoundryClient({ baseUrl: c.server.baseUrl, token: c.server.token }).socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: pid })) as { id: string };
    const { body } = await rawRequestFor(sock, chat.id, "who are you?", "mp-1");

    expect(body["model"]).toBe("scripted"); // upstream gets the BASE model
    const messages = body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(String(messages[0]?.content).startsWith("You are a grumpy pirate captain.")).toBe(true);
    expect(body["temperature"]).toBe(0.5);
    expect(body["top_p"]).toBe(0.9);
    // a param the profile doesn't set stays unset
    expect("max_tokens" in body).toBe(false);
    sock.close();
  });

  it("explicit caller params override the profile's defaults", async () => {
    const c = await boot();
    const rt = c.server.rt;
    const uid = rt.auth.verifyToken(c.server.token)?.userId as string;
    const made = rt.providers.upsertProfile({
      userId: uid,
      baseModelId: "dummy/scripted",
      name: "Cool",
      params: { temperature: 0.5 },
    });

    // the completions plane: temperature explicit → wins (the model = the PROFILE id)
    const res = await fetch(`${c.server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.server.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: made.id,
        temperature: 1.25,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const runId = ((await res.json()) as { id: string }).id.replace("chatcmpl-foundry-", "");
    const evs = rt.chat.runEvents(runId);
    const raw = evs.find((e) => e.type === "raw_provider_request");
    expect(((raw?.payload as { body: Record<string, unknown> }).body)["temperature"]).toBe(1.25);
  });

  it("profiles nest (the inner persona wins) and deleting falls back to unknown-model", async () => {
    const c = await boot({ sandboxDriver: "fake" });
    const rt = c.server.rt;
    const uid = rt.auth.verifyToken(c.server.token)?.userId as string;
    const inner = rt.providers.upsertProfile({ userId: uid, baseModelId: "dummy/scripted", name: "Inner", systemPrompt: "INNER PERSONA." });
    const outer = rt.providers.upsertProfile({
      userId: uid,
      baseModelId: inner.id,
      name: "Outer",
      systemPrompt: "OUTER PERSONA.",
    });

    const sock = new FoundryClient({ baseUrl: c.server.baseUrl, token: c.server.token }).socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: outer.id })) as { id: string };
    const { body } = await rawRequestFor(sock, chat.id, "hi", "mp-nest-1");
    const messages = body["messages"] as { role: string; content: string }[];
    expect(String(messages[0]?.content)).toContain("INNER PERSONA.");
    expect(String(messages[0]?.content)).not.toContain("OUTER PERSONA.");
    expect(rt.providers.removeProfile(outer.id)).toBe(true);
    expect(rt.providers.profileById(outer.id)).toBeUndefined();
    // the DELETED profile ids answer the normal unknown-model error
    const chat2 = (await sock.req("chat.create", { model: outer.id })) as { id: string };
    expect(chat2.id).toBeDefined();
    await expect(sock.req("chat.send", { chatId: chat2.id, content: "x" }, "mp-nest-2")).rejects.toMatchObject({
      code: "not_found",
    });
    sock.close();
  });

  it("admin REST CRUD + the audit trail", async () => {
    const c = await boot();
    const rt = c.server.rt;
    const jso = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const r = await fetch(`${c.server.baseUrl}${path}`, {
        method,
        headers: body === undefined
          ? { authorization: `Bearer ${c.server.token}` }
          : { authorization: `Bearer ${c.server.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const made = await jso("POST", "/v1/admin/profiles", {
      baseModelId: "dummy/scripted",
      name: "Teacher",
      avatar: "🧑‍🏫",
      systemPrompt: "Explain slowly.",
      params: { temperature: 0.3 },
    });
    expect(made.status).toBe(201);
    const pid = made.body.id as string;

    const patch = await jso("POST", "/v1/admin/profiles", { id: pid, name: "Teacher Prime" });
    expect(patch.status).toBe(200);
    const list = await jso("GET", "/v1/admin/profiles");
    const row = (list.body.profiles as { id: string; name: string }[]).find((p) => p.id === pid);
    expect(row?.name).toBe("Teacher Prime");

    const del = await jso("DELETE", `/v1/admin/profiles/${pid}`);
    expect(del.body.ok).toBe(true);
    expect(rt.audit.list().some((e) => e.action === "admin.profiles.upsert")).toBe(true);
    expect(rt.audit.list().some((e) => e.action === "admin.profiles.delete")).toBe(true);
    // junk base → 400
    const bad = await jso("POST", "/v1/admin/profiles", { baseModelId: "nope/none", name: "X" });
    expect(bad.status).toBe(400);
  });
});