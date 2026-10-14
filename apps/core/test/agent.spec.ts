import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshots } from "../src/db/schema.js";
import { FoundryClient } from "@foundry/sdk-ts";
import { startServer, type TestCtx } from "./helpers.js";

/** Agent-runtime specs (build-order P2 #3/#4/#6). Runs use the deterministic
 * dummy provider's `done`-scenario: fs_write hello.py → shell python3 → stop.
 * The FakeDriver's mini-shell runs the print() lines, so the loop is fully
 * exercised without Docker; the REAL sandbox acceptance is docker.spec.ts. */

let ctx: TestCtx;

async function boot(): Promise<{
  sock: ReturnType<FoundryClient["socket"]>;
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
  return { sock, waitFor };
}

interface Seen {
  event: string;
  channel: string;
  seq: number;
  payload: Record<string, unknown>;
}

function userIdOf(): string {
  const uid = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId;
  if (uid === undefined) throw new Error("test token doesn't resolve to a user");
  return uid;
}

describe("Agent run loop (acceptance scenario)", () => {
  it('completes "create hello.py in the sandbox and run it" — events, workspace file, snapshot', async () => {
    const { sock: s, waitFor } = await boot();
    const chat = (await s.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const seen: Seen[] = [];
    s.on((event, channel, seq, payload) => seen.push({ event, channel, seq, payload: payload as Record<string, unknown> }));

    const send = (await s.req("chat.send", {
      chatId: chat.id,
      content: "create hello.py in the sandbox and run it",
      agent: { enabled: true },
    }, "agent-accept")) as { runId: string };
    expect(send.runId).toMatch(/^run_/);

    await waitFor(
      () => seen.some((e) => e.event === "run.status" && e.channel === `run:${send.runId}` && e.payload.status === "done"),
      "agent run done",
    );

    // Conversation is server-authoritative: user + assistant turns + tool msgs.
    const history = (await s.req("chat.history", { chatId: chat.id })) as { role: string; content: string }[];
    const roles = history.map((h) => h.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
    const finalMsg = history[history.length - 1];
    expect(finalMsg?.content).toContain("Done: created hello.py and ran it.");

    // Journal (ADR-003): replayable run_events — tool_call/tool_result pairs.
    const evs = (await s.req("run.events", { runId: send.runId })) as { seq: number; type: string; payload: unknown }[];
    const calls = evs.filter((e) => e.type === "tool_call").map((e) => e.payload as { id: string; name: string });
    expect(calls.map((c) => c.name)).toEqual(["fs_write", "shell"]);
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { id: string; ok: boolean; content: string });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[1]?.content.replace(/\r/g, "")).toContain("hello from the sandbox");

    // The file actually landed in the workspace dir.
    const wdir = ctx.server.rt.sandbox.ensureWorkspace(userIdOf()).dir;
    expect(readFileSync(join(wdir, "hello.py"), "utf8")).toContain("hello from the sandbox");

    // Snapshot taken at run end (build-order P2 acceptance): a snapshots row
    // referencing the workspace, whose blob holds a tar.gz you can open.
    await waitFor(() => ctx.server.rt.db.db.select().from(snapshots).all().length === 1, "snapshot row", 4000);
    const rows = ctx.server.rt.db.db.select().from(snapshots).all();
    expect(rows[0]?.note).toContain(send.runId);
    s.close();
  });
});

describe("Tool policy", () => {
  it("deny policy returns a denied tool_result and the run still finishes", async () => {
    const { waitFor } = await boot();
    const client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const seen: Seen[] = [];
    sock.on((event, channel, seq, payload) => seen.push({ event, channel, seq, payload: payload as Record<string, unknown> }));
    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "create hello.py in the sandbox and run it",
      agent: { enabled: true, toolPolicy: { shell: "deny" } },
    }, "agent-deny")) as { runId: string };
    await waitFor(
      () => seen.some((e) => e.event === "run.status" && e.channel === `run:${send.runId}` && e.payload.status === "done"),
      "done (with denial)",
    );
    const evs = (await sock.req("run.events", { runId: send.runId })) as { seq: number; type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { id: string; ok: boolean; content: string });
    const denied = results.filter((r) => r.content.includes("denied by policy"));
    expect(denied.length).toBe(1);
    expect(denied[0]?.ok).toBe(false);
    sock.close();
  });
});

describe("Boot resume (ADR-003)", () => {
  function seedParkedRun(): { runId: string; chatId: string } {
    const uid = userIdOf();
    const conv = ctx.server.rt.chat.createConversation(uid, "resume", "dummy/scripted");
    const chatId = conv.id;
    const runId = ctx.server.rt.chat.createRun({ userId: uid, conversationId: chatId, model: "dummy/scripted", trigger: "chat", agent: true });
    // The crash hit after the assistant's tool_calls persisted but before the
    // tool executed: no tool_result events at all.
    ctx.server.rt.chat.appendMessage(chatId, { role: "user", content: "create hello.py in the sandbox and run it" }, runId);
    ctx.server.rt.chat.appendMessage(chatId, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_seed_1",
        type: "function",
        function: { name: "fs_write", arguments: JSON.stringify({ path: "hello.py", content: "print('hello from the sandbox')\n" }) },
      }],
    }, runId);
    return { runId, chatId };
  }

  it("re-executes pending tool calls and the run completes", async () => {
    await boot();
    const { runId } = seedParkedRun();
    expect(ctx.server.rt.chat.getRun(runId)?.status).toBe("running");

    await ctx.server.rt.agents.resumeRunningRuns();

    const run = ctx.server.rt.chat.getRun(runId);
    expect(run?.status).toBe("done");
    const evs = ctx.server.rt.chat.runEvents(runId);
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { id: string; ok: boolean });
    expect(results.some((r) => r.id === "call_seed_1" && r.ok)).toBe(true);
    // The loop carried on past the replayed call (dummy scenario steps 2+3).
    expect(run?.summary ?? "").toContain("Done:");
    // And the replays actually wrote the file.
    const wdir = ctx.server.rt.sandbox.ensureWorkspace(userIdOf()).dir;
    expect(readFileSync(join(wdir, "hello.py"), "utf8")).toContain("hello from the sandbox");
  });

  it("marks non-agent interrupted runs failed", async () => {
    await boot();
    const uid = userIdOf();
    const runId = ctx.server.rt.chat.createRun({ userId: uid, model: "dummy/scripted", trigger: "chat" });
    await ctx.server.rt.agents.resumeRunningRuns();
    const run = ctx.server.rt.chat.getRun(runId);
    expect(run?.status).toBe("failed");
    const evs = ctx.server.rt.chat.runEvents(runId);
    expect(evs.some((e) => e.type === "error" && JSON.stringify(e.payload).includes("interrupted by restart"))).toBe(true);
  });
});

describe("Admin MCP endpoints", () => {
  it("rejects invalid server lists with 400", async () => {
    await boot();
    const auth = { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" };
    const bodies = ["not-array", { servers: [{ name: "../evil" }] }, { servers: [{ name: "ok", command: "" }] }];
    for (const body of bodies) {
      const res = await fetch(`${ctx.server.baseUrl}/v1/admin/mcp/servers`, {
        method: "PUT",
        headers: auth,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("connects a stdio server, lists it, and the agent can call its tool", async () => {
    const { waitFor } = await boot();
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixture", "mcp-echo-server.mjs");
    const resp = await fetch(`${ctx.server.baseUrl}/v1/admin/mcp/servers`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ctx.server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ servers: [{ name: "echo", command: process.execPath, args: [fixture] }] }),
    });
    expect(resp.status).toBe(200);

    // reload() is async — poll the status endpoint until connected.
    await waitFor(async () => {
      const res = await fetch(`${ctx.server.baseUrl}/v1/admin/mcp/servers`, { headers: { Authorization: `Bearer ${ctx.server.token}` } });
      const j = (await res.json()) as { status: { name: string; connected: boolean; error?: string }[] };
      return j.status.length === 1 && j.status[0]?.connected === true;
    }, "echo mcp server connected");

    // And the agent loop can call it (namespaced tool).
    const client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", { chatId: chat.id, content: "use the echo tool", agent: { enabled: true } }, "agent-mcp")) as { runId: string };
    await waitFor(async () => {
      const run = ctx.server.rt.chat.getRun(send.runId);
      return run?.status === "done" || run?.status === "failed";
    }, "mcp run terminal");
    const run = ctx.server.rt.chat.getRun(send.runId);
    expect(run?.status).toBe("done");
    const evs = (await sock.req("run.events", { runId: send.runId })) as { seq: number; type: string; payload: unknown }[];
    const calls = evs.filter((e) => e.type === "tool_call").map((e) => e.payload as { name: string });
    expect(calls.some((c) => c.name === "mcp__echo__echo")).toBe(true);
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { ok: boolean; content: string });
    expect(results.some((r) => r.content.includes("ECHO: ping from the agent"))).toBe(true);
    sock.close();
  });
});