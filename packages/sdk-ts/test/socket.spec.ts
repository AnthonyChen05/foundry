import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { FoundrySocket } from "../src/index.js";

/**
 * The SDK talks to a real WS endpoint because the behavior under test is
 * delivery timing of a real client stack: the fake hub answers `connect` and
 * immediately bursts event frames — the same shape WsHub sends (res + replay
 * back to back) — which the client runtime may drain synchronously in one
 * flush before any awaiting code runs on the client.
 */

interface ResumeEntry {
  channel: string;
  lastSeq: number;
}

interface HubHandle {
  port: number;
  resumes: ResumeEntry[][];
  close(): void;
}

function eventFrame(event: string, channel: string, seq: number): string {
  return JSON.stringify({ type: "event", event, channel, seq, payload: {} });
}

async function startHub(burst: (sock: WsSocket, resumes: ResumeEntry[][]) => void): Promise<HubHandle> {
  const resumes: ResumeEntry[][] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/ws" });
  await new Promise<void>((r) => wss.once("listening", r));
  wss.on("connection", (sock: WsSocket) => {
    sock.on("message", (raw: unknown) => {
      const f = JSON.parse(String(raw)) as {
        type: string;
        id: string;
        method: string;
        params?: { resume?: ResumeEntry[] };
      };
      if (f.type !== "req") return;
      if (f.method !== "connect") {
        sock.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {} }));
        return;
      }
      const resume = f.params?.resume ?? [];
      resumes.push(resume);
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
      burst(sock, resumes);
    });
  });
  const addr = wss.address() as AddressInfo;
  return {
    port: addr.port,
    resumes,
    close: () => wss.close(),
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${what}`);
}

afterEach(() => {
  hub?.close();
  hub = undefined;
});

let hub: HubHandle | undefined;

describe("FoundrySocket event delivery", () => {
  it("delivers the post-connect burst to a handler that subscribes late", async () => {
    hub = await startHub((sock) => {
      sock.send(eventFrame("chat.delta", "chat:ch_1", 1));
      sock.send(eventFrame("chat.final", "chat:ch_1", 2));
    });
    const s = new FoundrySocket({ baseUrl: `http://127.0.0.1:${hub.port}`, token: "t" });
    await s.connect();
    // Registered AFTER connect() resolves — the common connect-then-subscribe
    // order. Must still receive the whole burst, in order.
    const got: { event: string; seq: number }[] = [];
    s.on((event, _channel, seq) => got.push({ event, seq }));
    await waitFor(() => got.length === 2, 2000, "burst delivered to late subscriber");
    expect(got.map((g) => g.event)).toEqual(["chat.delta", "chat.final"]);
    expect(got.map((g) => g.seq)).toEqual([1, 2]);
    s.close();
  });

  it("flushes a queued sys.resync to both the hook and late handlers", async () => {
    hub = await startHub((sock) => {
      sock.send(eventFrame("sys.resync", "chat:ch_2", 1));
    });
    const s = new FoundrySocket({ baseUrl: `http://127.0.0.1:${hub.port}`, token: "t" });
    await s.connect();
    let hookedChannel = "";
    s.onResync = (channel: string) => {
      hookedChannel = channel;
    };
    const got: { event: string; channel: string }[] = [];
    s.on((event, channel) => got.push({ event, channel }));
    await waitFor(() => got.length === 1 && hookedChannel !== "", 2000, "queued resync flushed");
    expect(hookedChannel).toBe("chat:ch_2");
    expect(got[0]?.event).toBe("sys.resync");
    s.close();
  });

  it("drops held frames on disconnect and resumes the reconnect from cursors", async () => {
    hub = await startHub((sock, resumes) => {
      if (resumes.length === 1) {
        // First connection: burst lands with nobody subscribed.
        sock.send(eventFrame("chat.delta", "chat:ch_3", 1));
        sock.send(eventFrame("chat.final", "chat:ch_3", 2));
        return;
      }
      // Reconnect: the new replay marker continues AFTER the held frames.
      sock.send(eventFrame("chat.delta", "chat:ch_3", 3));
    });
    const s = new FoundrySocket({ baseUrl: `http://127.0.0.1:${hub.port}`, token: "t" });
    await s.connect();
    s.close();
    await s.connect(); // implicit cursors from the lost burst
    expect(hub?.resumes[1]).toEqual([{ channel: "chat:ch_3", lastSeq: 2 }]);
    const got: { event: string; seq: number }[] = [];
    s.on((event, _channel, seq) => got.push({ event, seq }));
    await waitFor(() => got.length === 1, 2000, "fresh replay after reconnect");
    // Stale held frames (seq 1, 2) must NOT be redelivered on top of the new
    // replay — only the reconnect burst survives.
    expect(got).toEqual([{ event: "chat.delta", seq: 3 }]);
    s.close();
  });
});