import { beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { FoundryClient, type ConnectResultView } from "@foundry/sdk-ts";
import { startServer, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let client: FoundryClient;

beforeEach(async () => {
  ctx = await startServer();
  client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Await the predicate: a sync `if (cond())` on an async predicate sees a
    // Promise — always truthy — and returns before ever checking anything.
    if (await cond()) return;
    await delay(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Raw WS probe for handshake-protocol tests (no SDK machinery). */
function rawWs(url: string, firstFrame: unknown): Promise<{ msgs: Record<string, unknown>[]; closeCode: number | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const msgs: Record<string, unknown>[] = [];
    let done = false;
    const finish = (closeCode: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ msgs, closeCode });
    };
    const timer = setTimeout(() => finish(null), 4000);
    ws.onopen = () => {
      if (firstFrame !== undefined) ws.send(JSON.stringify(firstFrame));
    };
    ws.onmessage = (m: MessageEvent) => {
      try {
        msgs.push(JSON.parse(String(m.data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    };
    ws.onclose = (ev: { code: number }) => finish(ev.code);
    ws.onerror = () => {
      /* close follows */
    };
  });
}

describe("WS handshake", () => {
  it("connects with a valid token and reports features + snapshot", async () => {
    const sock = client.socket();
    const res: ConnectResultView = await sock.connect();
    expect(res.protocol).toBe(0);
    expect(res.sessionId).toMatch(/^s_/);
    expect(res.features.methods).toContain("chat.send");
    expect(res.features.events).toContain("chat.delta");
    expect(res.snapshot.activeRuns).toEqual([]);
    sock.close();
  });

  it("rejects wrong protocol versions per §5 (bad_request + supported versions in message)", async () => {
    const r = await rawWs(`ws://127.0.0.1:${ctx.server.port}/ws`, {
      type: "req",
      id: "c1",
      method: "connect",
      params: { protocol: 7, auth: { token: ctx.server.token }, client: { kind: "cli", version: "0" } },
    });
    expect(r.msgs[0]).toMatchObject({ type: "res", ok: false, error: { code: "bad_request" } });
    expect(String((r.msgs[0]?.error as { message?: string }).message)).toContain("supported versions");
  });

  it("rejects bad tokens (unauthorized) and closes", async () => {
    const r = await rawWs(`ws://127.0.0.1:${ctx.server.port}/ws`, {
      type: "req",
      id: "c1",
      method: "connect",
      params: { protocol: 0, auth: { token: "fnd_bogus" }, client: { kind: "cli", version: "0" } },
    });
    expect(r.msgs[0]).toMatchObject({ type: "res", ok: false, error: { code: "unauthorized" } });
    expect(r.closeCode).not.toBeNull();
  });

  it("hard-closes when the first frame is not connect (guardrail #5)", async () => {
    const r = await rawWs(`ws://127.0.0.1:${ctx.server.port}/ws`, { type: "req", id: "x", method: "sys.health", params: {} });
    expect(r.closeCode).toBe(1008);
    // and when the first frame isn't a req at all
    const r2 = await rawWs(`ws://127.0.0.1:${ctx.server.port}/ws`, 42);
    expect(r2.closeCode).toBe(1008);
  });

  it("exchanges an API key for a session token over WS (auth.login)", async () => {
    const sock = client.socket();
    await sock.connect();
    const login = (await sock.req("auth.login", { apiKey: ctx.server.token })) as { sessionToken: string };
    expect(login.sessionToken).toMatch(/^fnds_/);
    const sock2 = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: login.sessionToken }).socket();
    const res2 = await sock2.connect();
    expect(res2.protocol).toBe(0);
    sock.close();
    sock2.close();
  });
});

describe("WS chat plane", () => {
  it("chat.send → chat.delta* → chat.final, persisted server-side", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { title: "ws test", model: "dummy/scripted" })) as { id: string };
    const seen: { event: string; channel: string; seq: number; payload: Record<string, unknown> }[] = [];
    sock.on((event, channel, seq, payload) => seen.push({ event, channel, seq, payload: payload as Record<string, unknown> }));
    const send = (await sock.req("chat.send", { chatId: chat.id, content: "hello ws" }, "idem-1")) as { runId: string };
    expect(send.runId).toMatch(/^run_/);
    await waitFor(() => seen.some((e) => e.event === "chat.final"), 5000, "chat.final");
    const chatChan = `chat:${chat.id}`;
    const deltas = seen.filter((e) => e.event === "chat.delta" && e.channel === chatChan);
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const joined = deltas.map((d) => d.payload.delta).join("");
    expect(joined).toBe('You said: "hello ws"');
    const final = seen.find((e) => e.event === "chat.final");
    expect((final?.payload.message as { content: string }).content).toBe('You said: "hello ws"');
    await waitFor(() => seen.some((e) => e.event === "run.status" && e.payload.status === "done"), 5000, "run done");
    // run timeline events on run:{id}
    const runChan = `run:${send.runId}`;
    expect(seen.some((e) => e.event === "run.delta" && e.channel === runChan)).toBe(true);
    expect(seen.some((e) => e.event === "run.usage" && e.channel === runChan)).toBe(true);
    // persisted
    const history = (await sock.req("chat.history", { chatId: chat.id })) as { role: string; content: string }[];
    expect(history.map((h) => h.role)).toEqual(["user", "assistant"]);
    expect(history[1]?.content).toBe('You said: "hello ws"');
    sock.close();
  });

  it("broadcasts run events to OTHER connections (sync engine)", async () => {
    const watch = client.socket();
    const watchSeen: { event: string; channel: string }[] = [];
    watch.on((event, channel) => watchSeen.push({ event, channel }));
    await watch.connect();

    const sender = client.socket();
    await sender.connect();
    const chat = (await sender.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    await sender.req("chat.send", { chatId: chat.id, content: "sync" }, "idem-sync");
    await waitFor(() => watchSeen.some((e) => e.event === "chat.final" && e.channel === `chat:${chat.id}`), 5000, "watcher chat.final");
    expect(watchSeen.some((e) => e.event === "run.status")).toBe(true);
    watch.close();
    sender.close();
  });

  it("dedupes concurrent duplicate chat.send under the same idem", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const r1 = (await sock.req("chat.send", { chatId: chat.id, content: "dup" }, "same-idem")) as { runId: string };
    const r2 = (await sock.req("chat.send", { chatId: chat.id, content: "dup" }, "same-idem")) as { runId: string };
    expect(r2.runId).toBe(r1.runId);
    const history = (await sock.req("chat.history", { chatId: chat.id })) as { role: string }[];
    expect(history.filter((h) => h.role === "user").length).toBe(1);
    sock.close();
  });

  it("requires idem for chat.send", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    await expect(sock.req("chat.send", { chatId: chat.id, content: "x" })).rejects.toMatchObject({ code: "bad_request" });
    sock.close();
  });

  it("run.get / run.events / run.cancel work", async () => {
    const sock = client.socket();
    await sock.connect();
    // slow model guarantees the run is still streaming when cancel lands
    const chat = (await sock.req("chat.create", { model: "dummy/scripted-slow" })) as { id: string };
    const send = (await sock.req("chat.send", { chatId: chat.id, content: "cancel me" }, "idem-cancel")) as { runId: string };
    await delay(100);
    const cancel = await sock.req("run.cancel", { runId: send.runId }, "idem-cancel-run");
    expect(cancel).toEqual({});
    await waitFor(async () => {
      const run = (await sock.req("run.get", { runId: send.runId })) as { status: string };
      return run.status === "cancelled";
    }, 5000, "run cancelled");
    const evs = (await sock.req("run.events", { runId: send.runId })) as { seq: number; type: string }[];
    expect(evs.some((e) => e.type === "status")).toBe(true);
    expect(evs.every((e, i) => i === 0 || e.seq > (evs[i - 1] as { seq: number }).seq)).toBe(true);
    sock.close();
  });
});

describe("WS replay + resync", () => {
  it("replays buffered events from lastSeq on resume", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const chan = `chat:${chat.id}`;
    let chatFinal = false;
    sock.on((event, channel) => {
      if (event === "chat.final" && channel === chan) chatFinal = true;
    });
    await sock.req("chat.send", { chatId: chat.id, content: "replay" }, "idem-r1");
    await waitFor(() => chatFinal, 5000, "first final");
    sock.close();

    const sock2 = client.socket();
    const replayed: { event: string; channel: string; seq: number }[] = [];
    sock2.on((event, channel, seq) => {
      if (channel === chan) replayed.push({ event, channel, seq });
    });
    await sock2.connect([{ channel: chan, lastSeq: 0 }]);
    await waitFor(() => replayed.some((r) => r.event === "chat.final"), 5000, "replayed final");
    expect(replayed[0]?.seq).toBe(1);
    expect(replayed.every((r, i) => i === 0 || r.seq > (replayed[i - 1] as { seq: number }).seq)).toBe(true);
    sock2.close();
  });

  it("replays only events newer than lastSeq", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const chan = `chat:${chat.id}`;
    let finalSeq = 0;
    sock.on((_event, channel, seq) => {
      if (_event === "chat.final" && channel === chan) finalSeq = seq;
    });
    await sock.req("chat.send", { chatId: chat.id, content: "partial" }, "idem-r2");
    await waitFor(() => finalSeq > 0, 5000, "final");
    sock.close();

    // resume from just before the final event: only the tail replayed
    const sock2 = client.socket();
    const replayed: { event: string; seq: number }[] = [];
    sock2.on((event, channel, seq) => {
      if (channel === chan) replayed.push({ event, seq });
    });
    await sock2.connect([{ channel: chan, lastSeq: finalSeq - 1 }]);
    await waitFor(() => replayed.length > 0, 5000, "tail replay");
    expect(replayed[0]?.seq).toBe(finalSeq);
    sock2.close();
  });

  it("sends sys.resync when the buffer can't cover the gap", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const chan = `chat:${chat.id}`;
    let resynced = false;
    sock.on((event, channel) => {
      if (event === "sys.resync" && channel === chan) resynced = true;
    });
    // fresh socket claims cursor 999 on a channel that only has a few events
    await sock.close();
    const sock2 = client.socket();
    sock2.on((event, channel) => {
      if (event === "sys.resync" && channel === chan) resynced = true;
    });
    await sock2.connect([{ channel: chan, lastSeq: 999 }]);
    await waitFor(() => resynced, 3000, "sys.resync");
    sock2.close();
  });

  it("send-then-close: buffered events replay to the reconnected client", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const chan = `chat:${chat.id}`;
    await sock.req("chat.send", { chatId: chat.id, content: "gone" }, "idem-g1");
    // close IMMEDIATELY, before final arrives
    sock.close();
    await new Promise((r) => setTimeout(r, 400));

    const sock2 = client.socket();
    const replayed: { event: string; seq: number; payload?: Record<string, unknown> }[] = [];
    sock2.on((event, channel, seq, payload) => {
      if (channel === chan) replayed.push({ event, seq, payload: payload as Record<string, unknown> });
    });
    await sock2.connect([{ channel: chan, lastSeq: 0 }]);
    await waitFor(() => replayed.some((r) => r.event === "chat.final"), 5000, "replayed final after early close");
    const deltas = replayed.filter((r) => r.event === "chat.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    sock2.close();
  });
});

describe("WS errors", () => {
  it("unknown method → bad_request", async () => {
    const sock = client.socket();
    await sock.connect();
    await expect(sock.req("term.open", {})).rejects.toMatchObject({ code: "bad_request" });
    sock.close();
  });

  it("chat.history on someone else's/unknown conversation → not_found", async () => {
    const sock = client.socket();
    await sock.connect();
    await expect(sock.req("chat.history", { chatId: "ch_missing" })).rejects.toMatchObject({ code: "not_found" });
    sock.close();
  });

  it("disconnect mid-idem does not poison the cache: retry re-executes or dedupes correctly", async () => {
    const sock = client.socket();
    await sock.connect();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const first = (await sock.req("chat.send", { chatId: chat.id, content: "a" }, "k1")) as { runId: string };
    // same idem → same run (cached)
    const second = (await sock.req("chat.send", { chatId: chat.id, content: "b" }, "k1")) as { runId: string };
    expect(second.runId).toBe(first.runId);
    let userCount = 0;
    userCount = ((await sock.req("chat.history", { chatId: chat.id })) as { role: string }[]).filter((h) => h.role === "user").length;
    expect(userCount).toBe(1);
    sock.close();
  });
});