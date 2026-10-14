import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { gates as gatesTable } from "../src/db/schema.js";
import { FoundryClient } from "@foundry/sdk-ts";
import { startServer, type TestCtx } from "./helpers.js";

/** Approval gates (build-order P3 #1): park/approve/deny/timeout + scope
 * caches + the restart wake path. Provider flows use the dummy "gate-me"
 * scenario (shell `rm -rf ./build`); cache semantics are asserted at the
 * service level (resolveEffective) since the dummy script is per-conversation
 * stateful and can't re-issue calls in an established conversation. */

let ctx: TestCtx;

interface Seen {
  event: string;
  channel: string;
  seq: number;
  payload: Record<string, unknown>;
}

async function boot(overrides?: Parameters<typeof startServer>[0]): Promise<{
  sock: ReturnType<FoundryClient["socket"]>;
  seen: Seen[];
  waitFor: (cond: () => boolean | Promise<boolean>, what?: string, timeoutMs?: number) => Promise<void>;
  userId: string;
}> {
  ctx = await startServer(overrides);
  const userId = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId;
  if (userId === undefined) throw new Error("test token doesn't resolve to a user");
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
  return { sock, seen, waitFor, userId };
}

interface RunStatusEvent {
  payload: { runId: string; status: string };
}

function statusesFor(seen: Seen[], runId: string): string[] {
  return seen
    .filter((e) => e.event === "run.status" && e.channel === `run:${runId}`)
    .map((e) => (e as unknown as RunStatusEvent).payload.status);
}

function gateEvents(seen: Seen[], runId: string, event: string): { payload: { gateId: string; approved?: boolean; state?: string; tool?: string; args?: unknown } }[] {
  return seen.filter((e) => e.event === event && e.channel === `run:${runId}`) as unknown as {
    payload: { gateId: string; approved?: boolean; state?: string; tool?: string; args?: unknown };
  }[];
}

describe("Approval gates", () => {
  it("parks a gated destructive call, approve resumes it, run completes", async () => {
    const { sock, seen, waitFor } = await boot();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };

    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "gate-approve")) as { runId: string };

    // Run parks first, then the gate request lands.
    await waitFor(
      () => statusesFor(seen, send.runId).includes("waiting_approval"),
      "run parked in waiting_approval",
    );
    await waitFor(() => gateEvents(seen, send.runId, "run.gate_request").length === 1, "run.gate_request");
    const gateReq = gateEvents(seen, send.runId, "run.gate_request")[0]?.payload as { gateId: string; tool: string; args: unknown };
    expect(gateReq.tool).toBe("shell");
    expect(JSON.stringify(gateReq.args)).toContain("rm -rf ./build");

    // Nothing executed: no tool_result while parked.
    const parkedEvs = (await sock.req("run.events", { runId: send.runId })) as { type: string }[];
    expect(parkedEvs.some((e) => e.type === "tool_result")).toBe(false);

    const runWithGate = (await sock.req("run.get", { runId: send.runId })) as { status: string; gates: { gateId: string; tool: string; state: string }[] };
    expect(runWithGate.status).toBe("waiting_approval");
    expect(runWithGate.gates.length).toBe(1);
    expect(runWithGate.gates[0]?.state).toBe("open");

    const approved = (await sock.req("run.approve", {
      runId: send.runId,
      gateId: gateReq.gateId,
      approve: true,
      scope: "session",
    }, "gate-approve-1")) as { gateId: string; state: string };
    expect(approved.state).toBe("approved");

    await waitFor(
      () => statusesFor(seen, send.runId).includes("done"),
      "run completes after approval",
    );
    // parked once across the run (no re-asks); the sequence ends in done —
    // "running" appears twice (loop start + resume-after-approval), that's fine.
    const statuses = statusesFor(seen, send.runId);
    expect(statuses.filter((s) => s === "waiting_approval").length).toBe(1);
    expect(statuses).toContain("running");
    expect(statuses[statuses.length - 1]).toBe("done");

    const evs = (await sock.req("run.events", { runId: send.runId })) as { type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { id: string; ok: boolean; content: string });
    expect(results.some((r) => r.id === "call_dummy_gate" && r.ok)).toBe(true);

    const gateRow = ctx.server.rt.db.db.select().from(gatesTable).all().find((g) => g.id === gateReq.gateId);
    expect(gateRow?.state).toBe("approved");
    sock.close();
  });

  it("deny → rejected tool_result, run finishes gracefully", async () => {
    const { sock, seen, waitFor } = await boot();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "gate-deny")) as { runId: string };
    await waitFor(() => gateEvents(seen, send.runId, "run.gate_request").length === 1, "run.gate_request");
    const gateId = gateEvents(seen, send.runId, "run.gate_request")[0]?.payload.gateId as string;

    await sock.req("run.approve", { runId: send.runId, gateId, approve: false }, "gate-deny-1");

    await waitFor(
      () => statusesFor(seen, send.runId).includes("done"),
      "run completes after denial",
    );
    const evs = (await sock.req("run.events", { runId: send.runId })) as { type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { ok: boolean; content: string });
    expect(results.some((r) => !r.ok && r.content.includes("rejected: denied by user"))).toBe(true);
    // The operator's rejection is on the timeline too.
    const resolved = evs.filter((e) => e.type === "gate_resolved").map((e) => e.payload as { approved: boolean; state: string });
    expect(resolved[0]).toMatchObject({ approved: false, state: "denied" });
    const run = ctx.server.rt.chat.getRun(send.runId);
    expect(run?.status).toBe("done");
    sock.close();
  });

  it("timeout auto-denies — gate row closed, run still completes", async () => {
    const { sock, seen, waitFor } = await boot({ gateTimeoutMs: 500 });
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "gate-timeout")) as { runId: string };
    await waitFor(() => gateEvents(seen, send.runId, "run.gate_request").length === 1, "run.gate_request");
    const gateId = gateEvents(seen, send.runId, "run.gate_request")[0]?.payload.gateId as string;

    await waitFor(
      () => statusesFor(seen, send.runId).includes("done"),
      "run completes after timeout auto-deny",
    );

    const evs = (await sock.req("run.events", { runId: send.runId })) as { type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { ok: boolean; content: string });
    expect(results.some((r) => !r.ok && r.content.includes("auto-denied: approval timed out"))).toBe(true);
    const resolved = evs.filter((e) => e.type === "gate_resolved").map((e) => e.payload as { approved: boolean; state: string });
    expect(resolved).toContainEqual(expect.objectContaining({ approved: false, state: "timeout" }));

    const gateRow = ctx.server.rt.db.db.select().from(gatesTable).all().find((g) => g.id === gateId);
    expect(gateRow?.state).toBe("timeout");
    expect(gateRow?.resolvedBy).toContain("timeout");
    expect(gateRow?.resolvedAt).not.toBeNull();
    expect(runStatusInEvent(seen, send.runId, "timeout")).toBe(false);
    sock.close();
  });

  it("session scope caches per conversation; always scope persists per user", async () => {
    const { sock, seen, waitFor, userId } = await boot();
    const gates = ctx.server.rt.gates;
    const chatA = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const chatB = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const reqBase = { userId, chatId: chatA.id, toolName: "shell", toolPolicy: { shell: "ask" } };

    expect(gates.resolveEffective(reqBase)).toBe("ask");
    expect(gates.resolveEffective({ ...reqBase, chatId: chatB.id })).toBe("ask");

    // Approve with session scope in chat A.
    const sendA = (await sock.req("chat.send", {
      chatId: chatA.id,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "gate-sess")) as { runId: string };
    await waitFor(() => gateEvents(seen, sendA.runId, "run.gate_request").length === 1, "gate for chat A");
    const gateA = gateEvents(seen, sendA.runId, "run.gate_request")[0]?.payload.gateId as string;
    await sock.req("run.approve", { runId: sendA.runId, gateId: gateA, approve: true, scope: "session" }, "gate-sess-1");
    await waitFor(
      () => (ctx.server.rt.chat.getRun(sendA.runId)?.status ?? "") === "done",
      "chat A run done",
    );

    // Same conversation+tool now auto-passes; chat B still asks.
    expect(gates.resolveEffective(reqBase)).toBe("always");
    expect(gates.resolveEffective({ ...reqBase, chatId: chatB.id })).toBe("ask");
    // New session (different conversation) → gates again for the same tool:
    const reqC = { userId, chatId: (await sock.req("chat.create", { model: "dummy/scripted" }) as { id: string }).id, toolName: "shell", toolPolicy: { shell: "ask" } };
    expect(gates.resolveEffective(reqC)).toBe("ask");
    // No persisted approval happened for the session scope.
    const alwaysRow = ctx.server.rt.db.db.select().from(gatesTable).all().filter((g) => g.tool === "shell").length;
    expect(alwaysRow).toBe(1); // just chat A's gate

    // Approve with always scope → persists in settings for the user.
    const sendC = (await sock.req("chat.send", {
      chatId: reqC.chatId,
      content: "gate-me",
      agent: { enabled: true, toolPolicy: { shell: "ask" } },
    }, "gate-always")) as { runId: string };
    await waitFor(() => gateEvents(seen, sendC.runId, "run.gate_request").length === 1, "gate for chat C");
    const gateC = gateEvents(seen, sendC.runId, "run.gate_request")[0]?.payload.gateId as string;
    await sock.req("run.approve", { runId: sendC.runId, gateId: gateC, approve: true, scope: "always" }, "gate-always-1");
    await waitFor(
      () => (ctx.server.rt.chat.getRun(sendC.runId)?.status ?? "") === "done",
      "chat C run done",
    );
    // Now even a brand-new chat skips the gate.
    const reqD = { userId, chatId: (await sock.req("chat.create", { model: "dummy/scripted" }) as { id: string }).id, toolName: "shell", toolPolicy: { shell: "ask" } };
    expect(gates.resolveEffective(reqD)).toBe("always");

    // Explicit policy still wins over the cache — deny stays deny.
    expect(gates.resolveEffective({ ...reqD, toolPolicy: { shell: "deny" } })).toBe("deny");
    sock.close();
  });

  it("approve with no parked loop wakes the run (external resolve path)", async () => {
    // Gate resolved while NO loop waits in-process (e.g. approve raced the boot
    // resume) → onGateResolvedExternal re-enters via resume.
    const { sock, waitFor } = await boot();
    const uid = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId as string;
    const conv = ctx.server.rt.chat.createConversation(uid, "parked", "dummy/scripted");
    ctx.server.rt.chat.appendMessage(conv.id, { role: "user", content: "gate-me" });
    const runId = ctx.server.rt.chat.createRun({ userId: uid, conversationId: conv.id, model: "dummy/scripted", trigger: "chat", agent: true });
    ctx.server.rt.chat.appendMessage(conv.id, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_seed_gate",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: "rm -rf ./build" }) },
      }],
    }, runId);
    ctx.server.rt.db.db.insert(gatesTable).values({
      id: "gate_seed_wake", runId, tool: "shell", args: { command: "rm -rf ./build" },
      policy: "ask", callId: "call_seed_gate", state: "open", createdAt: Date.now(),
    }).run();
    ctx.server.rt.chat.bumpStatus(runId, "waiting_approval");

    const ok = (await sock.req("run.approve", { runId, gateId: "gate_seed_wake", approve: true }, "gate-wake-1")) as { state: string };
    expect(ok.state).toBe("approved");

    await waitFor(async () => (ctx.server.rt.chat.getRun(runId)?.status ?? "") === "done", "parked run wakes and completes");
    const evs = ctx.server.rt.chat.runEvents(runId);
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { id: string; ok: boolean });
    expect(results.some((r) => r.id === "call_seed_gate" && r.ok)).toBe(true);
    const run = ctx.server.rt.chat.getRun(runId);
    expect(run?.summary ?? "").toContain("Handled the gated command.");
    sock.close();
  });

  it("run.approve rejects unknown gates / runs and bad params", async () => {
    await boot();
    const uid = ctx.server.rt.auth.verifyToken(ctx.server.token)?.userId as string;
    const conv = ctx.server.rt.chat.createConversation(uid);
    const runId = ctx.server.rt.chat.createRun({ userId: uid, conversationId: conv.id, model: "dummy/scripted", trigger: "chat" });
    ctx.server.rt.chat.bumpStatus(runId, "done");
    const sock0 = ctx.server.rt;
    void sock0;

    const client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
    const s = client.socket();
    await s.connect();
    await expect(s.req("run.approve", { runId, gateId: "gate_none", approve: true }, "ra-1")).rejects.toMatchObject({ code: "not_found" });
    await expect(s.req("run.approve", { runId, approve: true }, "ra-2")).rejects.toMatchObject({ code: "bad_request" });
    await expect(s.req("run.approve", { runId, gateId: "gate_none", approve: true, scope: "forever" }, "ra-3")).rejects.toMatchObject({ code: "bad_request" });
    s.close();
  });
});

function runStatusInEvent(seen: Seen[], runId: string, status: string): boolean {
  return statusesFor(seen, runId).includes(status);
}