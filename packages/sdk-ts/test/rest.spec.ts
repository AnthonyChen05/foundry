import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { FoundryClient, FoundryError } from "../src/index.js";

/**
 * REST helper surface: a tiny in-process HTTP server stands in for core and
 * asserts the SDK normalizes envelopes (errors → FoundryError with the
 * OpenAI `error.type` as `code` + HTTP `status`) and round-trips the
 * schedules/hooks admin payloads.
 */

interface Route {
  method: string;
  path: string;
  handler: (ctx: { body: unknown; headers: Record<string, string | string[] | undefined> }) => { status: number; json: unknown };
}

function startServer(routes: Route[]): Promise<{ port: number; server: Server; hits: { path: string; method: string }[] }> {
  const hits: { path: string; method: string }[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyRaw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      try {
        body = bodyRaw.length > 0 ? JSON.parse(bodyRaw) : undefined;
      } catch {
        body = undefined;
      }
      hits.push({ path: url, method: req.method ?? "" });
      const route = routes.find((r) => r.method === req.method && url.startsWith(r.path));
      const out = route === undefined
        ? { status: 404, json: { error: { message: `no route for ${url}`, type: "not_found_error", param: null } } }
        : route.handler({ body, headers: req.headers });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as AddressInfo).port, server, hits });
    });
  });
}

const started: { port: number; server: Server; hits: { path: string; method: string }[] }[] = [];

afterEach(() => {
  for (const s of started) s.server.close();
  started.length = 0;
});

async function boot(routes: Route[]): Promise<{ client: FoundryClient; hits: { path: string; method: string }[] }> {
  const s = await startServer(routes);
  started.push(s);
  return { client: new FoundryClient({ baseUrl: `http://127.0.0.1:${s.port}`, token: "tok" }), hits: s.hits };
}

describe("REST helpers + error surface", () => {
  it("health, schedules roundtrip, hooks roundtrip", async () => {
    const schedules: unknown[] = [];
    const { client, hits } = await boot([
      {
        method: "GET",
        path: "/healthz",
        handler: () => ({ status: 200, json: { ok: true, version: "0.0.0-test", uptimeS: 5 } }),
      },
      {
        method: "POST",
        path: "/v1/admin/schedules",
        handler: ({ body }) => {
          const s = { ...(body as object), id: "sch_t", nextRunAt: "2030-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" };
          schedules.push(s);
          return { status: 201, json: s };
        },
      },
      {
        method: "GET",
        path: "/v1/admin/schedules",
        handler: () => ({ status: 200, json: { schedules } }),
      },
      {
        method: "PATCH",
        path: "/v1/admin/schedules/sch_t",
        handler: () => {
          const first = schedules[0] as { prompt?: string; enabled?: boolean };
          first.prompt = "patched";
          first.enabled = false;
          return { status: 200, json: first };
        },
      },
      {
        method: "DELETE",
        path: "/v1/admin/schedules/sch_t",
        handler: () => {
          schedules.pop();
          return { status: 200, json: { ok: true } };
        },
      },
      {
        method: "POST",
        path: "/v1/admin/hooks",
        handler: () => ({
          status: 201,
          json: {
            hook: { id: "hook_t", name: "n", target: "chat", createdAt: "2026-01-01T00:00:00.000Z" },
            secret: "fndwhsec_test",
            url: "/hook/hook_t",
          },
        }),
      },
      {
        method: "GET",
        path: "/v1/admin/hooks",
        handler: () => ({ status: 200, json: { hooks: [{ id: "hook_t", name: "n", target: "chat", createdAt: "2026-01-01T00:00:00.000Z" }] } }),
      },
      {
        method: "DELETE",
        path: "/v1/admin/hooks/hook_t",
        handler: () => ({ status: 200, json: { ok: true } }),
      },
    ]);

    expect((await client.health()).ok).toBe(true);

    const made = await client.adminCreateSchedule({ name: "s", kind: "cron", spec: "0 9 * * 1-5", prompt: "hello" });
    expect(made).toMatchObject({ id: "sch_t", spec: "0 9 * * 1-5" });
    const patched = await client.adminPatchSchedule("sch_t", { prompt: "patched", enabled: false });
    expect(patched).toMatchObject({ prompt: "patched", enabled: false });
    expect((await client.adminListSchedules()).schedules).toHaveLength(1);
    await client.adminDeleteSchedule("sch_t");
    expect((await client.adminListSchedules()).schedules).toHaveLength(0);

    const hook = await client.adminCreateHook("n");
    expect(hook.secret).toMatch(/^fndwhsec_/);
    expect(hook.url).toBe("/hook/hook_t");
    expect((await client.adminListHooks()).hooks[0]?.target).toBe("chat");
    await client.adminDeleteHook("hook_t");

    // Path encoding + DELETE bodies: never send a stray JSON content-type.
    expect(hits.filter((h) => h.method === "DELETE").map((h) => h.path).sort()).toEqual(["/v1/admin/hooks/hook_t", "/v1/admin/schedules/sch_t"]);
  });

  it("normalizes REST errors: OpenAI envelope → FoundryError{code,type→not_found_error,status:404}", async () => {
    const { client } = await boot([
      {
        method: "GET",
        path: "/v1/admin/schedules/sch_nope",
        handler: () => ({ status: 404, json: { error: { message: "unknown schedule: sch_nope", type: "not_found_error", param: null } } }),
      },
    ]);
    const err = await client.adminGetSchedule("sch_nope").then(
      () => null,
      (e: unknown) => e as FoundryError,
    );
    expect(err).toBeInstanceOf(FoundryError);
    expect(err?.status).toBe(404);
    expect(err?.code).toBe("not_found_error");
    expect(err?.message).toContain("sch_nope");
  });

  it("socket() requires a token", () => {
    const c = new FoundryClient({ baseUrl: "http://127.0.0.1:1" });
    expect(() => c.socket()).toThrow(/token required/);
  });
});