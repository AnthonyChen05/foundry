import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { FoundrySocket } from "../src/index.js";

/**
 * autoReconnect: an unexpected close must reconnect with a backoff, carry the
 * per-channel cursors into the handshake `resume[]`, keep handlers, and — on
 * an auth handshake failure with a fixed token — give up instead of looping.
 */

interface ResumeEntry {
  channel: string;
  lastSeq: number;
}

interface HubHandle {
  port: number;
  resumes: ResumeEntry[][];
  conns: WsSocket[];
  close(): void;
  broadcast(frame: object): void;
}

let hub: HubHandle | undefined;
const extra: HubHandle[] = [];

afterEach(() => {
  hub?.close();
  hub = undefined;
  for (const h of extra) h.close();
  extra.length = 0;
});

async function startHub(opts: { authFail?: boolean } = {}): Promise<HubHandle> {
  const resumes: ResumeEntry[][] = [];
  const conns: WsSocket[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/ws" });
  await new Promise<void>((r) => wss.once("listening", r));
  wss.on("connection", (sock: WsSocket) => {
    conns.push(sock);
    sock.on("message", (raw: unknown) => {
      const f = JSON.parse(String(raw)) as {
        type: string;
        id: string;
        method: string;
        params?: { resume?: ResumeEntry[] };
      };
      if (f.type !== "req" || f.method !== "connect") return;
      const resume = f.params?.resume ?? [];
      resumes.push(resume);
      if (opts.authFail) {
        sock.send(JSON.stringify({ type: "res", id: f.id, ok: false, error: { code: "unauthorized", message: "bad token" } }));
        return;
      }
      sock.send(JSON.stringify({
        type: "res",
        id: f.id,
        ok: true,
        payload: {
          sessionId: "s_test",
          protocol: 0,
          features: { methods: [], events: [] },
          snapshot: { activeRuns: [], unread: 0 },
        },
      }));
      if (resumes.length === 1) {
        sock.send(JSON.stringify({ type: "event", event: "chat.delta", channel: "chat:c1", seq: 1, payload: {} }));
        sock.send(JSON.stringify({ type: "event", event: "chat.final", channel: "chat:c1", seq: 2, payload: {} }));
      }
    });
  });
  const addr = wss.address() as AddressInfo;
  const handle: HubHandle = {
    port: addr.port,
    resumes,
    conns,
    close: () => wss.close(),
    broadcast: (frame) => {
      for (const c of conns) c.send(JSON.stringify(frame));
    },
  };
  return handle;
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe("FoundrySocket autoReconnect", () => {
  it("reconnects after a server-side drop, resuming from cursors, handlers intact", async () => {
    hub = await startHub();
    const s = new FoundrySocket({ baseUrl: `http://127.0.0.1:${hub.port}`, token: "t", autoReconnect: true });
    const statuses: string[] = [];
    s.onStatus = (st) => statuses.push(st);
    await s.connect();
    const seen: { event: string; seq: number }[] = [];
    s.on((event, _channel, seq) => seen.push({ event, seq }));
    await waitFor(() => seen.length === 2, 2000, "initial burst");
    expect(seen.map((x) => x.event)).toEqual(["chat.delta", "chat.final"]);

    // Server drops the (single) live connection without a client close().
    hub.conns[hub.conns.length - 1]?.terminate();
    await waitFor(() => hub !== undefined && hub.resumes.length === 2, 5000, "reconnect handshake");
    // Cursors carried into resume: everything up to the last seen seq (2).
    expect(hub.resumes[1]).toEqual([{ channel: "chat:c1", lastSeq: 2 }]);
    expect(statuses).toContain("reconnecting");
    expect(statuses).toContain("open");
    s.close();
  });

  it("gives up after an auth handshake failure (no reconnect loop on a bad token)", async () => {
    hub = await startHub({ authFail: true });
    const s = new FoundrySocket({ baseUrl: `http://127.0.0.1:${hub.port}`, token: "bad", autoReconnect: true });
    await expect(s.connect()).rejects.toMatchObject({ code: "unauthorized" });
    // The ws library closes the socket after our error response; reconnects
    // must NOT happen — authFailed is sticky.
    await new Promise((r) => setTimeout(r, 600));
    expect(hub.resumes.length).toBe(1);
    s.close();
  });

  it("no reconnect when autoReconnect is off or close() was deliberate", async () => {
    hub = await startHub();
    const s = new FoundrySocket({ baseUrl: `http://127.0.0.1:${hub.port}`, token: "t" });
    await s.connect();
    s.close();
    expect(hub.resumes.length).toBe(1);

    const h2 = await startHub();
    extra.push(h2);
    const s2 = new FoundrySocket({ baseUrl: `http://127.0.0.1:${h2.port}`, token: "t", autoReconnect: true });
    await s2.connect();
    await waitFor(() => s2.isOpen, 2000, "open");
    s2.close(); // deliberate
    await new Promise((r) => setTimeout(r, 250));
    expect(h2.resumes.length).toBe(1); // close() suppresses retry
  });
});