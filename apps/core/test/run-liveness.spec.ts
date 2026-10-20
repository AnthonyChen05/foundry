import { setTimeout as delay } from "node:timers/promises";
import { FoundryClient } from "@foundry/sdk-ts";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDriver } from "../src/sandbox/fake.js";
import { SandboxError, type CreateEnvOpts, type EnvHandle } from "../src/sandbox/types.js";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Run liveness (post-P5 follow-up): an agent run must NOT sit in
 * "running" forever when its sandbox env never comes up. The driver-level
 * fast-fail (container dead during startup → SandboxError 502 immediately,
 * not after the 120s OT-ready window) is asserted in docker.spec.ts
 * (needs a real daemon); here the run-level contract is locked in unit-level
 * with an injected driver whose create() fails.
 */

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

/** FakeDriver whose env creation fails like a dead OT container does. */
class DeadEnvDriver extends FakeDriver {
  override async create(_opts: CreateEnvOpts): Promise<EnvHandle> {
    throw new SandboxError("open-terminal container exited during startup (exit code 1)", 502);
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe("run liveness — env creation failure", () => {
  it("fails the run (status + error event) instead of hanging", async () => {
    const ctx = await startServer({ sandboxDriver: "fake" }, { driver: new DeadEnvDriver() });
    ctxs.push(ctx);
    const rt = ctx.server.rt;
    const sock = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token }).socket();
    await sock.connect();
    const seen: { event: string; payload: Record<string, unknown> }[] = [];
    sock.on((event, channel, seq, payload) => {
      if (channel.startsWith("run:")) seen.push({ event, payload: payload as Record<string, unknown> });
    });

    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "liveness-1")) as { runId: string };

    await waitFor(
      () => seen.some((e) => e.event === "run.status" && e.payload.status === "failed"),
      "run.status failed",
      4000,
    );
    expect(rt.chat.getRun(send.runId)?.status).toBe("failed");
    expect((rt.chat.getRun(send.runId)?.error ?? null)).toContain("exited during startup");
    // the timeline carries the error too
    const types = rt.chat.runEvents(send.runId).map((e) => e.type);
    expect(types).toContain("error");
    sock.close();
  });

  it("a SUBSEQUENT plain-chat send still works (service stays healthy)", async () => {
    const ctx = await startServer({ sandboxDriver: "fake" }, { driver: new DeadEnvDriver() });
    ctxs.push(ctx);
    const sock = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token }).socket();
    await sock.connect();
    // plain chat (agent:false) needs no sandbox — the gateway path is healthy
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", { chatId: chat.id, content: "hello" }, "liveness-2")) as { runId: string };
    await waitFor(() => (ctx.server.rt.chat.getRun(send.runId)?.status ?? "") === "done", "plain run done");
    const history = (await sock.req("chat.history", { chatId: chat.id })) as { role: string; content: string }[];
    expect(history.some((m) => m.role === "assistant")).toBe(true);
    sock.close();
  });
});