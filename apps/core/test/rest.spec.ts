import { beforeEach, describe, expect, it } from "vitest";
import { TEST_ADMIN_PASSWORD, startServer, type TestCtx } from "./helpers.js";

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await startServer();
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** auth + json content-type — for fetch calls with a JSON body. */
function authJson(token: string): Record<string, string> {
  return { ...auth(token), "content-type": "application/json" };
}

type JsonBody = Record<string, unknown>;

async function jso(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: JsonBody }> {
  const res = await fetch(`${ctx.server.baseUrl}${path}`, {
    method,
    // Bodyless requests (DELETE) must NOT advertize application/json — a
    // json content-type with an empty body is a client-side 400 on Fastify.
    headers: body !== undefined ? authJson(token) : auth(token),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as JsonBody };
}

describe("REST auth + keys", () => {
  it("rejects missing/invalid bearer tokens", async () => {
    const noAuth = await fetch(`${ctx.server.baseUrl}/v1/models`);
    expect(noAuth.status).toBe(401);
    const bad = await fetch(`${ctx.server.baseUrl}/v1/models`, { headers: auth("fnd_wrong") });
    expect(bad.status).toBe(401);
    const health = await fetch(`${ctx.server.baseUrl}/healthz`);
    expect(health.status).toBe(200); // open endpoint
  });

  it("auth.login issues a session token that verifies (username + password)", async () => {
    const { status, body } = await jso("POST", "/v1/auth/login", "", {
      username: "admin",
      password: TEST_ADMIN_PASSWORD,
    });
    expect(status).toBe(200);
    const sessionToken = body.sessionToken as string;
    expect(sessionToken).toMatch(/^fnds_/);
    const user = ctx.server.rt.auth.verifyToken(sessionToken);
    expect(user).toBeDefined();
    // Logging in again (fresh login, same credentials) also verifies.
    const again = await jso("POST", "/v1/auth/login", "", {
      username: "admin",
      password: TEST_ADMIN_PASSWORD,
    });
    expect(again.status).toBe(200);
  });

  it("auth.login rejects bad credentials and the removed key shape", async () => {
    const badPw = await jso("POST", "/v1/auth/login", "", { username: "admin", password: "nope" });
    expect(badPw.status).toBe(401);
    const keyShape = await jso("POST", "/v1/auth/login", "", { apiKey: ctx.server.token });
    expect(keyShape.status).toBe(400);
    const empty = await jso("POST", "/v1/auth/login", "", { username: "", password: "" });
    expect(empty.status).toBe(400);
  });

  it("mints, lists and revokes API keys — plaintext shown exactly once", async () => {
    const minted = await jso("POST", "/v1/admin/keys", ctx.server.token, { name: "android" });
    expect(minted.status).toBe(200);
    const key = minted.body.key as string;
    const keyId = minted.body.id as string;
    expect(key).toMatch(/^fnd_/);
    const listed = await jso("GET", "/v1/admin/keys", ctx.server.token);
    const row = (listed.body.keys as { id: string; name: string }[]).find((k) => k.id === keyId);
    expect(row?.name).toBe("android");
    expect(JSON.stringify(listed.body)).not.toContain(key);
    // minted key authenticates
    const user = ctx.server.rt.auth.verifyToken(key);
    expect(user).toBeDefined();
    // revoke
    const del = await jso("DELETE", `/v1/admin/keys/${keyId}`, ctx.server.token);
    expect(del.body.ok).toBe(true);
    expect(ctx.server.rt.auth.verifyToken(key)).toBeUndefined();
    const delAgain = await jso("DELETE", `/v1/admin/keys/${keyId}`, ctx.server.token);
    expect(delAgain.status).toBe(404);
  });
});

describe("REST models + providers admin", () => {
  it("serves the seeded catalog at /v1/models", async () => {
    const { status, body } = await jso("GET", "/v1/models", ctx.server.token);
    expect(status).toBe(200);
    expect(body.object).toBe("list");
    const ids = (body.data as { id: string }[]).map((m) => m.id);
    expect(ids).toContain("dummy/scripted");
    expect(ids).toContain("dummy/scripted-slow");
  });

  it("upserts a provider with a vaulted key and never echoes it", async () => {
    const { status, body } = await jso("POST", "/v1/admin/providers", ctx.server.token, {
      kind: "openai_compat",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "vault-me-please",
      models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B", context: 131072, caps: { tools: false } }],
    });
    expect(status).toBe(201);
    const newId = body.id as string;
    expect(body.models).toEqual([`${newId}/llama3.1:8b`]);
    const listed = await jso("GET", "/v1/admin/providers", ctx.server.token);
    const p = (listed.body.providers as { id: string; hasKey: boolean }[]).find((x) => x.id === newId);
    expect(p?.hasKey).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain("vault-me-please");
    // vault roundtrip: the stored ciphertext decrypts to the key server-side
    const rec = ctx.server.rt.providers.record(newId, { withKey: true });
    expect(rec?.apiKey).toBe("vault-me-please");
    expect(rec?.baseUrl).toBe("http://127.0.0.1:11434");
    // and the model resolves by bare alias (protocol.md §2)
    expect(ctx.server.rt.providers.resolveModel("llama3.1:8b")?.modelId).toBe(`${newId}/llama3.1:8b`);
  });

  it("upserting with id updates an existing provider", async () => {
    const first = await jso("POST", "/v1/admin/providers", ctx.server.token, {
      kind: "openai_compat",
      baseUrl: "http://a",
    });
    const firstId = first.body.id as string;
    const second = await jso("POST", "/v1/admin/providers", ctx.server.token, {
      id: firstId,
      kind: "openai_compat",
      baseUrl: "http://b",
    });
    expect(second.status).toBe(200);
    const listed = await jso("GET", "/v1/admin/providers", ctx.server.token);
    const rows = listed.body.providers as { id: string; baseUrl: string }[];
    expect(rows.filter((p) => p.id === firstId).length).toBe(1);
    expect(rows.find((p) => p.id === firstId)?.baseUrl).toBe("http://b");
  });

  it("upserting a fresh explicit id CREATES it (idempotent operator config)", async () => {
    // First call with a stable id → 201 create; repeating it → 200 patch of
    // the SAME row (never a duplicate prov_*).
    const first = await jso("POST", "/v1/admin/providers", ctx.server.token, {
      id: "ollama",
      kind: "openai_compat",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(first.status).toBe(201);
    expect(first.body.id).toBe("ollama");
    const repeat = await jso("POST", "/v1/admin/providers", ctx.server.token, {
      id: "ollama",
      kind: "openai_compat",
      baseUrl: "http://o2",
    });
    expect(repeat.status).toBe(200);
    const listed = await jso("GET", "/v1/admin/providers", ctx.server.token);
    const rows = listed.body.providers as { id: string; baseUrl: string }[];
    const ollamaRows = rows.filter((p) => p.id === "ollama");
    expect(ollamaRows.length).toBe(1);
    expect(ollamaRows[0]?.baseUrl).toBe("http://o2");
  });

  it("deletes providers; unknown id → 404", async () => {
    const created = await jso("POST", "/v1/admin/providers", ctx.server.token, { kind: "anthropic", baseUrl: "https://api.anthropic.com" });
    const createdId = created.body.id as string;
    const del = await jso("DELETE", `/v1/admin/providers/${createdId}`, ctx.server.token);
    expect(del.body.ok).toBe(true);
    const delAgain = await jso("DELETE", `/v1/admin/providers/${createdId}`, ctx.server.token);
    expect(delAgain.status).toBe(404);
  });

  it("refuses network providers without baseUrl", async () => {
    const bad = await jso("POST", "/v1/admin/providers", ctx.server.token, { kind: "openai_compat" });
    expect(bad.status).toBe(400);
    const badKind = await jso("POST", "/v1/admin/providers", ctx.server.token, { kind: "weird" });
    expect(badKind.status).toBe(400);
  });
});

describe("REST completions", () => {
  it("non-stream completion via the dummy provider", async () => {
    const { status, body } = await jso("POST", "/v1/chat/completions", ctx.server.token, {
      model: "dummy/scripted",
      messages: [{ role: "user", content: "hi rest" }],
    });
    expect(status).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("dummy/scripted");
    const completion = (body.choices as { message: { content: string }; finish_reason: string }[])[0];
    expect(completion?.message.content).toBe('You said: "hi rest"');
    expect(completion?.finish_reason).toBe("stop");
    const usage = body.usage as { total_tokens: number };
    expect(usage.total_tokens).toBeGreaterThan(0);
  });

  it("unknown model → 404 openai-style error", async () => {
    const { status, body } = await jso("POST", "/v1/chat/completions", ctx.server.token, {
      model: "nope/none",
      messages: [{ role: "user", content: "x" }],
    });
    expect(status).toBe(404);
    expect((body.error as { type: string }).type).toBe("not_found_error");
  });

  it("validates messages", async () => {
    const missing = await jso("POST", "/v1/chat/completions", ctx.server.token, { model: "dummy/scripted" });
    expect(missing.status).toBe(400);
    const empty = await jso("POST", "/v1/chat/completions", ctx.server.token, {
      model: "dummy/scripted",
      messages: [],
    });
    expect(empty.status).toBe(400);
    const invalid = await jso("POST", "/v1/chat/completions", ctx.server.token, {
      model: "dummy/scripted",
      messages: [{ role: "warp", content: "x" }],
    });
    expect(invalid.status).toBe(400);
  });

  it("normalizes content:null (OpenAI tool-call turns)", async () => {
    const { status, body } = await jso("POST", "/v1/chat/completions", ctx.server.token, {
      model: "dummy/scripted",
      messages: [{ role: "assistant", content: "earlier" }, { role: "user", content: null }],
    });
    expect(status).toBe(200);
    expect((body.choices as { message: { content: string } }[])[0]?.message.content).toBe('You said: ""');
  });

  it("streams SSE with true incremental chunks, usage, [DONE]", async () => {
    const res = await fetch(`${ctx.server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authJson(ctx.server.token),
      body: JSON.stringify({
        model: "dummy/scripted",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi stream" }],
      }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const lines = text.replace(/\r/g, "").split("\n\n").filter((l) => l.startsWith("data: "));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.at(-1)).toBe("data: [DONE]");
    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
    const content = chunks
      .flatMap((c) => ((c["choices"] as { delta?: { content?: string } }[] | undefined) ?? []).flatMap((ch) => (typeof ch.delta?.content === "string" ? [ch.delta.content] : [])))
      .join("");
    expect(content).toBe('You said: "hi stream"');
    expect(chunks[0]?.["model"]).toBe("dummy/scripted");
    const usageChunk = chunks.find((c) => Array.isArray(c["choices"]) && (c["choices"] as unknown[]).length === 0 && c["usage"] !== undefined);
    expect(usageChunk).toBeDefined();
  });

  it("hides the usage-only chunk when include_usage is not requested", async () => {
    const res = await fetch(`${ctx.server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authJson(ctx.server.token),
      body: JSON.stringify({
        model: "dummy/scripted",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      }),
    });
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(text).not.toContain('"prompt_tokens"');
  });

  it("stores raw provider request/response events for the run (guardrail #4)", async () => {
    const { body } = await jso("POST", "/v1/chat/completions", ctx.server.token, {
      model: "dummy/scripted",
      messages: [{ role: "user", content: "audit" }],
      frequency_penalty: 0.25,
    });
    // response id embeds the foundry run id
    const runId = (body as { id: string }).id.replace("chatcmpl-foundry-", "");
    const evs = ctx.server.rt.chat.runEvents(runId);
    const types = evs.map((e) => e.type);
    expect(types).toContain("raw_provider_request");
    expect(types).toContain("raw_provider_response");
    expect(types).toContain("delta");
    expect(types).toContain("usage");
    expect(types).toContain("status");
    const reqEvt = evs.find((e) => e.type === "raw_provider_request");
    const reqPayload = reqEvt?.payload as { headers: Record<string, string>; body: Record<string, unknown> };
    expect(reqPayload.headers["Authorization"]).toBe("[REDACTED]");
    expect(reqPayload.body.frequency_penalty).toBe(0.25); // passthrough landed upstream
  });

  it("aborts the provider stream when the client disconnects", async () => {
    // slow model streams at 120ms/chunk; abort early and confirm the run ends cancelled
    const controller = new AbortController();
    const resPromise = fetch(`${ctx.server.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: authJson(ctx.server.token),
      body: JSON.stringify({
        model: "dummy/scripted-slow",
        stream: true,
        messages: [{ role: "user", content: "cancel me" }],
      }),
      signal: controller.signal,
    });
    // read one chunk then abort the fetch client
    const res = await resPromise;
    const reader = res.body?.getReader();
    await reader?.read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 300));
    const runs = ctx.server.rt.db.sqlite
      .prepare("SELECT status FROM runs WHERE model = 'dummy/scripted-slow' LIMIT 1")
      .get() as { status: string } | undefined;
    expect(["cancelled", "failed"]).toContain(runs?.status ?? "");
  });
});