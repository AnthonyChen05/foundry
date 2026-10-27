import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Model auto-pull (operator ask): an upsert WITHOUT models discovers them
 * from the provider's OpenAI-compatible /models; a model LIST replaces the
 * provider's rows (what's gone upstream leaves the catalog); a failed pull
 * saves the provider and surfaces `pullError` instead of failing.
 */

let ctx: TestCtx;
const ctxs: TestCtx[] = [];
const fixtures: Server[] = [];

afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
  for (const s of fixtures.splice(0)) s.close();
});

async function modelsFixture(list: { id: string; display_name?: string }[]): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: list }));
      return;
    }
    res.writeHead(404).end();
  });
  fixtures.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function boot(overrides?: Parameters<typeof startServer>[0]): Promise<void> {
  ctx = await startServer(overrides);
  ctxs.push(ctx);
}

async function jso(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  // Authorization-only for bodyless calls: content-type + no body 400s (FST_ERR_CTP_EMPTY_JSON_BODY).
  const r = await fetch(`${ctx.server.baseUrl}${path}`, {
    method,
    headers: body === undefined
      ? { authorization: `Bearer ${ctx.server.token}` }
      : { authorization: `Bearer ${ctx.server.token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (r.status === 204 ? {} : (await r.json()) as Record<string, unknown>) };
}

describe("provider model auto-pull", () => {
  it("upserting without models pulls them from the provider's /v1/models (both base forms)", async () => {
    await boot();
    const base = await modelsFixture([{ id: "llama3:8b" }, { id: "qwen2.5:7b" }]);

    // ROOT-form baseUrl (repo convention — core attaches /v1)
    const up = await jso("POST", "/v1/admin/providers", { kind: "openai_compat", baseUrl: base, apiKey: "k-1" });
    expect(up.status).toBe(201);
    expect(up.body.pulled).toBe(true);
    expect(up.body.pullError).toBeUndefined();
    const pid = up.body.id as string;
    expect(up.body.models).toEqual([`${pid}/llama3:8b`, `${pid}/qwen2.5:7b`]);

    // /v1-SUFFIXED baseUrl (copy-pasted OpenAI clients) — normalized, not doubled
    const up2 = await jso("POST", "/v1/admin/providers", { kind: "openai_compat", baseUrl: `${base}/v1`, apiKey: "k-2" });
    expect(up2.status).toBe(201);
    expect(up2.body.pulled).toBe(true);
    expect(up2.body.models).toEqual([`${up2.body.id}/llama3:8b`, `${up2.body.id}/qwen2.5:7b`]);

    const catalog = await jso("GET", "/v1/models");
    const ids = (catalog.body.data as { id: string }[]).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([`${pid}/llama3:8b`, `${pid}/qwen2.5:7b`]));
  });

  it("pulls anthropic providers with the shim's headers", async () => {
    await boot();
    const base = await modelsFixture([{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }]);
    const up = await jso("POST", "/v1/admin/providers", { kind: "anthropic", baseUrl: base, apiKey: "sk-ant-test" });
    expect(up.status).toBe(201);
    expect(up.body.pulled).toBe(true);
    const pid = up.body.id as string;
    expect(ctx.server.rt.providers.modelIds(pid)).toEqual([`${pid}/claude-sonnet-5-5`]);
    // display_name rode along as the model's name
    const catalog = ctx.server.rt.providers.listModels();
    expect(catalog.find((m) => m.id === `${pid}/claude-sonnet-5-5`)?.name).toBe("Claude Sonnet 5.5");
  });

  it("DELETE cascades the model rows (no FK 500) + the provider's vault ciphertext", async () => {
    await boot();
    const base = await modelsFixture([{ id: "m1" }]);
    const up = await jso("POST", "/v1/admin/providers", { kind: "openai_compat", baseUrl: base, apiKey: "k-3" });
    expect(up.status).toBe(201);
    const pid = up.body.id as string;
    expect(ctx.server.rt.providers.modelIds(pid)).toHaveLength(1);

    const del = await jso("DELETE", `/v1/admin/providers/${pid}`);
    expect(del.status).toBe(200);
    expect(ctx.server.rt.providers.modelIds(pid)).toEqual([]);
    expect(ctx.server.rt.providers.record(pid, { withKey: false })).toBeUndefined();
    const listed = await jso("GET", "/v1/admin/providers");
    expect((listed.body.providers as { id: string }[]).some((p) => p.id === pid)).toBe(false);
  });

  it("an upsert WITH models replaces the list; the provider's dropped models leave", async () => {
    await boot();
    const base = await modelsFixture([{ id: "m1" }, { id: "m2" }]);
    const first = await jso("POST", "/v1/admin/providers", { kind: "openai_compat", baseUrl: base, apiKey: "k-2" });
    const pid = first.body.id as string;
    expect(ctx.server.rt.providers.modelIds(pid)).toEqual([`${pid}/m1`, `${pid}/m2`]);

    // The operator now sends an explicit two-model list; a third is dropped.
    await jso("POST", "/v1/admin/providers", {
      id: pid,
      kind: "openai_compat",
      baseUrl: base,
      models: [{ id: "m2" }, { id: "m9" }],
    });
    expect(ctx.server.rt.providers.modelIds(pid).sort()).toEqual([`${pid}/m2`, `${pid}/m9`]);
  });

  it("a failed pull saves the provider and reports pullError", async () => {
    await boot();
    const up = await jso("POST", "/v1/admin/providers", { kind: "openai_compat", baseUrl: "http://127.0.0.1:1" });
    expect(up.status).toBe(201);
    expect(up.body.models).toEqual([]);
    expect(typeof up.body.pullError).toBe("string");
    const listed = await jso("GET", "/v1/admin/providers");
    expect((listed.body.providers as { id: string }[]).some((p) => p.id === up.body.id)).toBe(true);
  });
});