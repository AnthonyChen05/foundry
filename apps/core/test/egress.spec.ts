import { describe, expect, it } from "vitest";
import { startServer, type TestCtx } from "./helpers.js";

/** Egress-plane specs (ADR-005, build-order P2 #2): sandboxes carry a scoped
 * esc_ token, NOT real keys; this plane routes their LLM calls through the
 * provider pipeline (metering + redacted journal) and nothing else. */

let ctx: TestCtx;

async function boot(): Promise<{ uid: string; token: string }> {
  ctx = await startServer();
  const auth = ctx.server.rt.auth.verifyToken(ctx.server.token);
  if (auth === undefined) throw new Error("test token doesn't resolve");
  const uid = auth.userId;
  // The esc_ token is only ever returned inside the env vars injected at
  // create (live handles carry a marker) — exactly how the container gets it.
  const handle = await ctx.server.rt.sandbox.createEnv(uid);
  const token = handle.env["OPENAI_API_KEY"] ?? "";
  expect(token.startsWith("esc_")).toBe(true);
  return { uid, token };
}

describe("Egress auth", () => {
  it("rejects missing, non-esc_, and unknown tokens with OpenAI 401 bodies", async () => {
    const { token } = await boot();
    const url = `${ctx.server.baseUrl}/v1/egress/models`;
    const cases: (string | undefined)[] = [undefined, `Bearer ${token.slice(0, -4)}AAAA`, "Bearer not_esc_token", `Bearer ${token}`, `bearer ${token.toUpperCase()}`];
    const resNoAuth = await fetch(url);
    expect(resNoAuth.status).toBe(401);
    expect(((await resNoAuth.json()) as { error?: { type?: string } }).error?.type).toBe("authentication_error");
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, { headers: { Authorization: cases[i] ?? "" } });
      expect(res.status).toBe(401);
    }
    // The real token works.
    const good = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(good.status).toBe(200);
  });

  it("never accepts a user/REST API key as an egress token", async () => {
    await boot();
    const res = await fetch(`${ctx.server.baseUrl}/v1/egress/models`, { headers: { Authorization: `Bearer ${ctx.server.token}` } });
    expect(res.status).toBe(401);
  });
});

describe("Egress completions", () => {
  it("routes models + completions with sandbox attribution (trigger 'sandbox')", async () => {
    const { token } = await boot();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const models = await fetch(`${ctx.server.baseUrl}/v1/egress/models`, { headers: { Authorization: `Bearer ${token}` } });
    const modelList = (await models.json()) as { data: { id: string }[] };
    expect(modelList.data.some((m) => m.id === "dummy/scripted")).toBe(true);

    const res = await fetch(`${ctx.server.baseUrl}/v1/egress/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model: "dummy/scripted", messages: [{ role: "user", content: "hi from the sandbox" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; choices: { message: { content: string } }[]; usage: { total_tokens: number } };
    expect(body.choices[0]?.message.content).toBe('You said: "hi from the sandbox"');
    expect(body.usage.total_tokens).toBeGreaterThanOrEqual(1);

    // Metering + journal (guardrail #4): a trigger-sandbox run with raw,
    // redacted request/response events.
    const runId = body.id.replace("chatcmpl-foundry-", "");
    const run = ctx.server.rt.chat.getRun(runId);
    expect(run?.status).toBe("done");
    expect(run?.trigger).toBe("sandbox");
    const evs = ctx.server.rt.chat.runEvents(runId);
    expect(evs.some((e) => e.type === "raw_provider_request")).toBe(true);
    expect(evs.some((e) => e.type === "raw_provider_response")).toBe(true);
    const raw = evs.find((e) => e.type === "raw_provider_request");
    expect(JSON.stringify(raw?.payload)).not.toContain("esc_"); // keys redacted
  });

  it("journals under X-Foundry-Run-Id when the run is live and owned by the token's user", async () => {
    const { uid, token } = await boot();
    const liveRun = ctx.server.rt.chat.createRun({ userId: uid, model: "dummy/scripted", trigger: "chat", agent: true });

    const res = await fetch(`${ctx.server.baseUrl}/v1/egress/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Foundry-Run-Id": liveRun },
      body: JSON.stringify({ model: "dummy/scripted", messages: [{ role: "user", content: "linked call" }] }),
    });
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(`chatcmpl-foundry-${liveRun}`);
    // Journal attached to the live run — which stays running (owned by its loop).
    expect(ctx.server.rt.chat.runEvents(liveRun).some((e) => e.type === "raw_provider_request")).toBe(true);
    expect(ctx.server.rt.chat.getRun(liveRun)?.status).toBe("running");

    // Terminal runs can't be linked either — the loop owns their status.
    const finished = ctx.server.rt.chat.createRun({ userId: uid, model: "dummy/scripted", trigger: "chat", agent: true });
    ctx.server.rt.chat.bumpStatus(finished, "done");
    const res2 = await fetch(`${ctx.server.baseUrl}/v1/egress/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Foundry-Run-Id": finished },
      body: JSON.stringify({ model: "dummy/scripted", messages: [{ role: "user", content: "not mine" }] }),
    });
    const body2 = (await res2.json()) as { id: string };
    expect(body2.id.startsWith("chatcmpl-foundry-run_")).toBe(true);
    expect(body2.id).not.toBe(`chatcmpl-foundry-${finished}`);
  });

  it("streams SSE chunks + [DONE] when stream:true", async () => {
    const { token } = await boot();
    const res = await fetch(`${ctx.server.baseUrl}/v1/egress/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dummy/scripted", stream: true, messages: [{ role: "user", content: "stream it" }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text.startsWith("data: ")).toBe(true);
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
    expect(text).toContain("chat.completion.chunk");
  });
});