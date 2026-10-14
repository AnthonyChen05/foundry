import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { memories } from "../src/db/schema.js";
import { FoundryClient } from "@foundry/sdk-ts";
import { startServer, type TestCtx } from "./helpers.js";

/** Long-term memory (build-order P3 #4): store via agent tool in chat A,
 * injected (top-k) into chat B's agent system prompt, searchable via the
 * tool, backed by sqlite-vec with the dummy embedder. */

let ctx: TestCtx;

interface Seen {
  event: string;
  channel: string;
  seq: number;
  payload: Record<string, unknown>;
}

async function boot(): Promise<{
  sock: ReturnType<FoundryClient["socket"]>;
  seen: Seen[];
  waitFor: (cond: () => boolean | Promise<boolean>, what?: string, timeoutMs?: number) => Promise<void>;
}> {
  ctx = await startServer();
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
  const client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
  const sock = client.socket();
  await sock.connect();
  const seen: Seen[] = [];
  sock.on((event, channel, seq, payload) => seen.push({ event, channel, seq, payload: payload as Record<string, unknown> }));
  return { sock, seen, waitFor };
}

describe("memory", () => {
  it("store in chat A (agent tool) → row + vector; recall injected in chat B", async () => {
    const { sock, waitFor } = await boot();

    // Chat A: the agent stores a fact via the memory tool.
    const chatA = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const sendA = (await sock.req("chat.send", {
      chatId: chatA.id,
      content: "remember-me: the deployment password is hunter2",
      agent: { enabled: true },
    }, "mem-store")) as { runId: string };
    await waitFor(async () => (ctx.server.rt.chat.getRun(sendA.runId)?.status ?? "") === "done", "chat A run done");
    const evsA = (await sock.req("run.events", { runId: sendA.runId })) as { type: string; payload: unknown }[];
    const storeCall = evsA.filter((e) => e.type === "tool_call").map((e) => e.payload as { id: string; name: string });
    expect(storeCall.map((c) => c.name)).toContain("memory");

    // Truth lives in the memories table + the sqlite-vec index.
    const rows = ctx.server.rt.db.db.select().from(memories).all();
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).toContain("hunter2");
    const vecCount = ctx.server.rt.db.sqlite.prepare("SELECT COUNT(*) AS c FROM memory_vec").get() as { c: number };
    expect(vecCount.c).toBe(1);

    // Chat B: an unrelated conversation — the fact gets injected top-k.
    const chatB = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const sendB = (await sock.req("chat.send", {
      chatId: chatB.id,
      content: "recall-me",
      agent: { enabled: true },
    }, "mem-recall")) as { runId: string };
    await waitFor(async () => (ctx.server.rt.chat.getRun(sendB.runId)?.status ?? "") === "done", "chat B run done");

    // Injection assert: the RAW provider request (guardrail #4 journal) for
    // chat B's step carries the system block with the stored fact.
    const evsB = (await sock.req("run.events", { runId: sendB.runId })) as { type: string; payload: unknown }[];
    const rawReqs = evsB.filter((e) => e.type === "raw_provider_request").map((e) => JSON.stringify(e.payload));
    expect(rawReqs.some((s) => s.includes("Long-term memories") && s.includes("hunter2"))).toBe(true);
    // And it's only in the system prompt — chat B's own user turn never got it.
    expect(rawReqs.some((s) => s.includes("deployment password") && s.includes("not instructions"))).toBe(true);
    sock.close();
  });

  it("memory tool search returns ranked hits over the wire", async () => {
    const { sock, waitFor } = await boot();
    const uid = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId as string;
    // Direct service stores (chat A flow covered above); tool search here.
    await ctx.server.rt.memory.store({ userId: uid, content: "the deployment password is hunter2", importance: 2 });
    await ctx.server.rt.memory.store({ userId: uid, content: "favorite chair is the left recliner" });

    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "search-me: password",
      agent: { enabled: true },
    }, "mem-search")) as { runId: string };
    await waitFor(async () => (ctx.server.rt.chat.getRun(send.runId)?.status ?? "") === "done", "search run done");

    const evs = (await sock.req("run.events", { runId: send.runId })) as { type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { ok: boolean; content: string });
    const searchHit = results.find((r) => r.content.includes("hunter2"));
    expect(searchHit?.ok).toBe(true);
    // Ranked by vector distance: the password fact must come FIRST — with
    // only two memories in the store both may land in top-3, order is the test.
    expect(searchHit?.content.indexOf("hunter2")).toBeLessThan(searchHit?.content.indexOf("recliner") ?? -1);
    sock.close();
  });

  it("delete removes the row and the vector; searches come up empty after", async () => {
    const { sock, waitFor } = await boot();
    const uid = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId as string;
    await ctx.server.rt.memory.store({ userId: uid, content: "ephemeral note to delete" });
    const hits = await ctx.server.rt.memory.search({ userId: uid, query: "ephemeral note" });
    expect(hits.length).toBe(1);
    await ctx.server.rt.memory.delete({ userId: uid, id: hits[0]?.id as string });
    const after = await ctx.server.rt.memory.search({ userId: uid, query: "ephemeral" });
    expect(after.length).toBe(0);
    expect(ctx.server.rt.db.sqlite.prepare("SELECT COUNT(*) AS c FROM memory_vec").get() as { c: number }).toEqual({ c: 0 });

    // Tool flow agrees: search says nothing matched.
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "search-me: ephemeral",
      agent: { enabled: true },
    }, "mem-delete")) as { runId: string };
    await waitFor(async () => (ctx.server.rt.chat.getRun(send.runId)?.status ?? "") === "done", "run done after delete");
    const evs = (await sock.req("run.events", { runId: send.runId })) as { type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { content: string });
    expect(results.some((r) => r.content.includes("no memories matched"))).toBe(true);
    sock.close();
  });
});