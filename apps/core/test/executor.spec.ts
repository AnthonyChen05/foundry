import { beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { FoundryClient } from "@foundry/sdk-ts";
import { ExecutorRegistry } from "../src/executor/registry.js";
import { conversations, runs } from "../src/db/schema.js";
import { FakeDriver } from "../src/sandbox/fake.js";
import { FakeExecutor } from "./fake_executor.js";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Executor bridge (ADR-015): the desktop runner registers over WS and every
 * SandboxDriver call on a "local" env delegates to it. The harness connects a
 * FakeExecutor (the runner's reference mapping) over the REAL hub with a
 * FakeDriver on the executor side — no Docker anywhere.
 */

let ctx: TestCtx;
let client: FoundryClient;
let executor: FakeExecutor | undefined;
let execDriver: FakeDriver;
const executorsCreated: FakeExecutor[] = [];

beforeEach(async () => {
  ctx = await startServer();
  execDriver = new FakeDriver();
  client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
  executor = new FakeExecutor({ port: ctx.server.port, token: ctx.server.token, driver: execDriver });
  executorsCreated.push(executor);
});

async function boot() {
  const sock = client.socket();
  await sock.connect();
  return sock;
}

/** beforeEach guarantees the executor; satisfies the no-non-null rule. */
function ex(): FakeExecutor {
  if (executor === undefined) throw new Error("executor not booted");
  return executor;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 6000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await delay(25);
  }
  throw new Error(`executor.spec timeout waiting for ${what}`);
}

async function newChat(model = "dummy/scripted"): Promise<string> {
  const sock = await boot();
  const created = (await sock.req("chat.create", { model })) as { id: string };
  sock.close();
  return created.id;
}

function bindingOf(chatId: string): { location?: string; envId?: string } {
  const row = ctx.server.rt.db.db.select().from(conversations).where(eq(conversations.id, chatId)).get();
  const meta = row?.meta ?? {};
  return { location: meta["location"] as string | undefined, envId: meta["envId"] as string | undefined };
}

function runRowOf(runId: string): { status: string; envId: string | null } | undefined {
  const row = ctx.server.rt.db.db.select().from(runs).where(eq(runs.id, runId)).get();
  return row === undefined ? undefined : { status: row.status, envId: row.envId };
}

describe("executor registry (unit)", () => {
  it("latest wins: the replaced executor's pendings reject", async () => {
    const registry = new ExecutorRegistry();
    const sentA: { id: string }[] = [];
    const sentB: { id: string }[] = [];
    const connA = { userId: "u1", send: (f: unknown) => void sentA.push(f as never) };
    const connB = { userId: "u1", send: (f: unknown) => void sentB.push(f as never) };
    expect(registry.register(connA, { online: true, name: "a", version: "1", dockerAvailable: true }).replaced ?? false).toBe(false);
    const hanging = registry.call("u1", "exec.exec", {}, 10_000);
    expect(sentA.length).toBe(1);
    const res = registry.register(connB, { online: true, name: "b", version: "1", dockerAvailable: true });
    expect(res.replaced).toBe(true);
    await expect(hanging).rejects.toMatchObject({ status: 503 });
    // A can no longer answer; B's calls resolve.
    expect(registry.onRes("u1", { id: sentA[0]?.id ?? "", ok: true })).toBe(false);
    const p = registry.call("u1", "exec.exec", { x: 1 }, 10_000);
    registry.onRes("u1", { id: sentB[0]?.id ?? "", ok: true, payload: { done: 1 } });
    await expect(p).resolves.toMatchObject({ done: 1 });
  });

  it("timeout → 504; drop → pending rejected + onConnGone; offline calls → 503", async () => {
    const registry = new ExecutorRegistry();
    let gone = 0;
    registry.onConnGone = () => { gone += 1; };
    const conn = { userId: "u2", send: () => {} };
    registry.register(conn, { online: true, name: "a", version: "1", dockerAvailable: true });
    await expect(registry.call("u2", "exec.exec", {}, 40)).rejects.toMatchObject({ status: 504 });
    const hang = registry.call("u2", "exec.exec", {}, 10_000);
    registry.drop(conn, "closed");
    await expect(hang).rejects.toMatchObject({ status: 503 });
    expect(gone).toBe(1);
    await expect(registry.call("u2", "exec.exec", {}, 10_000)).rejects.toMatchObject({ status: 503 });
  });
});

describe("executor bridge over the real hub (ADR-015)", () => {
  it("exec.status sees presence; executor drops → offline; executor.status event broadcast", async () => {
    // Subscribe FIRST: the register-time publication must land in this window.
    const sock = await boot();
    const seenExecutorStatus: boolean[] = [];
    sock.on((event) => {
      if (event === "executor.status") seenExecutorStatus.push(true);
    });
    await ex().connect();
    const st = (await sock.req("exec.status", {})) as { online: boolean; name?: string };
    expect(st.online).toBe(true);
    expect(st.name).toBe("test-executor");
    await waitFor(() => seenExecutorStatus.length >= 1, 3000, "executor.status event");
    sock.close();
    ex().close();
    await delay(50);
    const sock2 = await boot();
    const off = (await sock2.req("exec.status", {})) as { online: boolean };
    expect(off.online).toBe(false);
    sock2.close();
  });

  it("local agent run: tool calls cross the bridge; env + chat binding recorded", async () => {
    await ex().connect();
    const chatId = await newChat();
    const sock = await boot();
    const send = (await sock.req(
      "chat.send",
      { chatId, content: "create hello.py in the sandbox and run it", agent: { enabled: true, location: "local" } },
      "exec-run-1",
    )) as { runId: string };
    expect(send.runId.startsWith("run_")).toBe(true);

    await waitFor(() => runRowOf(send.runId)?.status === "done", 8000, "local run done");
    sock.close();

    // Bridge crossing proved on the executor side.
    const methods = ex().seen.map((s) => s.method);
    expect(methods).toContain("exec.env.create");
    expect(methods).toContain("exec.exec");
    // The workspace dir the executor reported lives in the executor's root.
    const create = ex().seen.find((s) => s.method === "exec.env.create")?.params as { envId: string; chatId: string; caps: unknown };
    expect(create.envId).toBeTruthy();
    expect(create.chatId).toBe(chatId);
    expect(create.caps).toBeTruthy();

    // DB: run.envId + conversation binding match the executor-created env.
    const { location, envId } = bindingOf(chatId);
    expect(location).toBe("local");
    expect(envId).toBe(create.envId);
    expect(runRowOf(send.runId)?.envId).toBe(create.envId);

    // The run's tool results came from the executor's FakeDriver shell.
    const sock2 = await boot();
    const evs = await sock2.runEvents({ runId: send.runId });
    sock2.close();
    expect(evs.some((e) => e.type === "tool_result" && JSON.stringify(e.payload).includes("hello from the sandbox"))).toBe(true);
  });

  it("cloud agent run keeps the shared primary env; binding untouched", async () => {
    await ex().connect();
    const chatId = await newChat();
    const sock = await boot();
    const send = (await sock.req("chat.send", { chatId, content: "create hello.py in the sandbox and run it", agent: { enabled: true } }, "exec-cloud-1")) as { runId: string };
    await waitFor(() => runRowOf(send.runId)?.status === "done", 8000, "cloud run done");
    sock.close();
    const binding = bindingOf(chatId);
    expect(binding.location).toBeUndefined(); // no local binding recorded
    // Agent cloud runs bind an env too — but it is a CLOUD (backend fake) env,
    // created by the server's own driver, not the executor bridge.
    expect(runRowOf(send.runId)?.envId).toBeTruthy();
    const envRow = ctx.server.rt.db.db.select().from(runs).where(eq(runs.id, send.runId)).get();
    void envRow;
    expect(ctx.server.rt.sandbox.driverName).toBe("fake");
    // The executor saw NOTHING (bridge not crossed).
    expect(ex().seen.length).toBe(0);
  });

  it("local send with no executor → bad_request fast-fail; docker:false → bad_request", async () => {
    // (not connected — the beforeEach executor has not registered yet)
    const chatId = await newChat();
    const sock = await boot();
    await expect(
      sock.req("chat.send", { chatId, content: "go local", agent: { enabled: true, location: "local" } }, "exec-ff-1"),
    ).rejects.toMatchObject({ code: "bad_request" });

    // An executor with docker:false registers (replaces nothing) — still rejected.
    const ex2 = new FakeExecutor({ port: ctx.server.port, token: ctx.server.token, driver: execDriver });
    ex2.dockerAvailable = false;
    executorsCreated.push(ex2);
    await ex2.connect();
    await expect(
      sock.req("chat.send", { chatId, content: "go local", agent: { enabled: true, location: "local" } }, "exec-ff-2"),
    ).rejects.toMatchObject({ code: "bad_request" });
    sock.close();
    ex2.close();
  });

  it("term.open on a local env streams bytes through the bridge; executor death exits the PTY", async () => {
    await ex().connect();
    const chatId = await newChat();
    const sock = await boot();
    const send = (await sock.req("chat.send", {
      chatId,
      content: "create hello.py in the sandbox and run it",
      agent: { enabled: true, location: "local" },
    }, "exec-term-1")) as { runId: string };
    await waitFor(() => runRowOf(send.runId)?.status === "done", 8000, "local run done");
    sock.close();

    const { envId } = bindingOf(chatId);
    expect(envId).toBeTruthy();

    const sock2 = await boot();
    const opened = (await sock2.req("term.open", { envId }, "exec-term-open")) as { termId: string; envId: string };
    expect(opened.envId).toBe(envId);
    let exited: number | null | undefined;
    sock2.on((event, channel, _seq, payload) => {
      if (event === "term.exit" && channel === `term:${opened.termId}`) {
        exited = (payload as { code: number | null }).code;
      }
    });

    // Type into the local pty through the bridge.
    await sock2.req("term.input", { termId: opened.termId, data: "echo hi-local\n" }, "exec-term-in");
    let sawEcho = false;
    sock2.on((_event, channel, _seq, payload) => {
      if (channel === `term:${opened.termId}`) {
        const p = payload as { data?: string; b64?: boolean };
        if (p.b64 !== true || p.data === undefined) return;
        if (Buffer.from(p.data, "base64").toString("utf8").includes("hi-local")) sawEcho = true;
      }
    });
    await waitFor(() => sawEcho, 5000, "term bytes through the bridge");

    ex().close();
    await waitFor(() => exited !== undefined, 5000, "term.exit after executor death");
    expect(exited).toBe(1);
    sock2.close();
  });
});