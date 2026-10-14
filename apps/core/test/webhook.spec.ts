import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { runs } from "../src/db/schema.js";
import { FoundryClient } from "@foundry/sdk-ts";
import { startServer, type TestCtx } from "./helpers.js";

/** Webhooks (build-order P3 #3): POST /hook/:id verifies HMAC-SHA256 over the
 * RAW body (`X-Foundry-Signature: sha256=<hex>`), then fires an agent run on
 * a fresh conversation. Secrets are minted server-side, shown once, stored
 * vault-encrypted. ntfy pushes go to a local stub HTTP server. */

let ctx: TestCtx;

interface NtfyHit {
  title: string;
  body: string;
}

async function boot(): Promise<{
  waitFor: (cond: () => boolean | Promise<boolean>, what?: string, timeoutMs?: number) => Promise<void>;
  pushes: NtfyHit[];
  stopNtfy(): Promise<void>;
}> {
  const pushes: NtfyHit[] = [];
  const ntfy = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += String(c);
    });
    req.on("end", () => {
      pushes.push({ title: String(req.headers["title"] ?? ""), body });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, "127.0.0.1", resolve));
  const addr = ntfy.address();
  if (addr === null || typeof addr !== "object") throw new Error("no ntfy address");
  const ntfyPort = addr.port;

  ctx = await startServer({
    notifyNtfyUrl: `http://127.0.0.1:${ntfyPort}/`,
    notifyNtfyTopic: "foundry-test",
  });

  const waitFor = async (
    cond: () => boolean | Promise<boolean>,
    what = "condition",
    timeoutMs = 8000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await delay(25);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  const stopNtfy = (): Promise<void> => new Promise((resolve) => ntfy.close(() => resolve()));
  return { waitFor, pushes, stopNtfy };
}

describe("webhooks", () => {
  it("admin CRUD — secret shown exactly once, never echoed", async () => {
    const { stopNtfy } = await boot();
    const auth = { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" };
    const res = await fetch(`${ctx.server.baseUrl}/v1/admin/hooks`, {
      method: "POST", headers: auth, body: JSON.stringify({ name: "deploy-pinger" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { hook: { id: string; name: string; target: string }; secret: string; url: string };
    expect(created.hook.name).toBe("deploy-pinger");
    expect(created.hook.target).toBe("chat");
    expect(created.url).toBe(`/hook/${created.hook.id}`);
    expect(created.secret.startsWith("fndwhsec_")).toBe(true);

    // List never carries the secret.
    const list = await fetch(`${ctx.server.baseUrl}/v1/admin/hooks`, { headers: { Authorization: `Bearer ${ctx.server.token}` } });
    const listed = (await list.json()) as { hooks: (Record<string, unknown> & { id: string })[] };
    expect(listed.hooks.map((h) => h.id)).toContain(created.hook.id);
    expect(JSON.stringify(listed).includes(created.secret)).toBe(false);

    const del = await fetch(`${ctx.server.baseUrl}/v1/admin/hooks/${created.hook.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ctx.server.token}` } });
    expect(del.status).toBe(200);
    const delAgain = await fetch(`${ctx.server.baseUrl}/v1/admin/hooks/${created.hook.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ctx.server.token}` } });
    expect(delAgain.status).toBe(404);
    await stopNtfy();
  });

  it("valid HMAC triggers a run; the run completes; ntfy + WS both see it", async () => {
    const { waitFor, pushes, stopNtfy } = await boot();
    const auth = { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" };
    const created = (await (
      await fetch(`${ctx.server.baseUrl}/v1/admin/hooks`, { method: "POST", headers: auth, body: JSON.stringify({ name: "ci-failhook", model: null }) })
    ).json()) as { hook: { id: string }; secret: string; url: string };

    const client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
    const sock = client.socket();
    await sock.connect();
    const seen: { event: string; channel: string }[] = [];
    sock.on((event, channel) => seen.push({ event, channel }));

    const body = JSON.stringify({ content: "create hello.py in the sandbox and run it", title: "CI failure review", model: null });
    const sig = createHmac("sha256", created.secret).update(Buffer.from(body, "utf8")).digest("hex");
    const res = await fetch(`${ctx.server.baseUrl}${created.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Foundry-Signature": `sha256=${sig}` },
      body,
    });
    expect(res.status).toBe(200);
    const fired = (await res.json()) as { ok: boolean; runId: string; conversationId: string };
    expect(fired.ok).toBe(true);

    // Fresh conversation, titled by the payload; run stored with trigger=webhook.
    const run = ctx.server.rt.db.db.select().from(runs).all().find((r) => r.id === fired.runId);
    expect(run?.trigger).toBe("webhook");
    await waitFor(async () => (ctx.server.rt.chat.getRun(fired.runId)?.status ?? "") === "done", "webhook run done", 10_000);

    // The signed body drove the agent: hello.py loop executed, then finished.
    const events = (await sock.req("run.events", { runId: fired.runId })) as { type: string }[];
    expect(events.some((e) => e.type === "tool_call")).toBe(true);

    // ntfy stub got the webhook push (run-done fires once the loop completes).
    await waitFor(() => pushes.some((p) => p.title.includes("Webhook fired: ci-failhook")), "ntfy push for webhook", 5000);
    await waitFor(() => pushes.some((p) => p.title === "Run finished"), "ntfy push for run done", 5000);
    // And the WS notify channel mirrors exactly what the phone saw.
    expect(seen.some((e) => e.event === "notify.push")).toBe(true);
    sock.close();
    await stopNtfy();
  });

  it("bad signature → 401; missing header → 401; unknown hook → 404", async () => {
    const { stopNtfy } = await boot();
    const auth = { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" };
    const created = (await (
      await fetch(`${ctx.server.baseUrl}/v1/admin/hooks`, { method: "POST", headers: auth, body: JSON.stringify({ name: "sig-test" }) })
    ).json()) as { hook: { id: string }; secret: string; url: string };

    const body = JSON.stringify({ content: "hello" });
    const goodSig = createHmac("sha256", created.secret).update(Buffer.from(body, "utf8")).digest("hex");

    const cases: { headers: Record<string, string>; body: string; url: string; status: number }[] = [
      // Tampered body — signature no longer matches.
      { headers: { "Content-Type": "application/json", "X-Foundry-Signature": `sha256=${goodSig}` }, body: JSON.stringify({ content: "TAMPERED" }), url: created.url, status: 401 },
      { headers: { "Content-Type": "application/json", "X-Foundry-Signature": `sha256=${goodSig}` }, body, url: "/hook/hook_doesnotexist", status: 404 },
      { headers: { "Content-Type": "application/json" }, body, url: created.url, status: 401 },
      { headers: { "Content-Type": "application/json", "X-Foundry-Signature": "sha256=deadbeef" }, body, url: created.url, status: 401 },
    ];
    for (const c of cases) {
      const res = await fetch(`${ctx.server.baseUrl}${c.url}`, { method: "POST", headers: c.headers, body: c.body });
      expect(res.status, `${c.url} with sig ${c.headers["X-Foundry-Signature"] ?? "(none)"}`).toBe(c.status);
    }

    // And a valid round on the same hook still verifies (nothing poisoned).
    const ok = await fetch(`${ctx.server.baseUrl}${created.url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Foundry-Signature": `sha256=${goodSig}` },
      body,
    });
    expect(ok.status).toBe(200);
    await stopNtfy();
  });
});