import { PROTOCOL_VERSION } from "@foundry/protocol";

/**
 * @foundry/sdk-ts — thin client SDK: WS `req`/`res`/`event` frames + REST
 * helpers, shared by the Android, Windows and web frontends and the smoke
 * test. Server-authoritative (CLAUDE.md): the SDK never owns state — it
 * sends commands, receives events, and refetches on sys.resync.
 *
 * Uses only platform primitives: global fetch (Node 22+/browsers) and
 * global WebSocket (Node 22.4+/browsers).
 */

export interface FoundryClientOptions {
  /** Default `http://127.0.0.1:8787`. */
  baseUrl?: string;
  /** API key (fnd_…) or session token (fnds_…); Bearer + WS auth. */
  token?: string;
  clientKind?: string;
  clientVersion?: string;
}

export interface ConnectResultView {
  sessionId: string;
  protocol: number;
  features: { methods: string[]; events: string[] };
  snapshot: { activeRuns: string[]; unread: number };
}

export interface WSRequestError extends Error {
  code: string;
  retryable?: boolean;
}

/** Handler receiving every server event frame. Return value is ignored. */
export type EventHandler = (event: string, channel: string, seq: number, payload: unknown) => void;

/** Normalized `type: "event"` frame as passed to handlers. */
interface EventFrame {
  event: string;
  channel: string;
  seq: number;
  payload: unknown;
}

export class FoundrySocket {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Set<EventHandler>();
  /**
   * Event frames received while no subscriber existed. The server delivers
   * the connect res and the resume/replay burst back to back; the runtime can
   * drain that whole burst synchronously inside one `onmessage` flush, so a
   * handler registered after `await connect()` would otherwise miss it. Held
   * frames are flushed in order on the first `on()` registration (bounded;
   * overflow drops the oldest — the server's replay ring is 500/channel).
   */
  private readonly queuedEvents: EventFrame[] = [];
  private static readonly EVENT_QUEUE_MAX = 1024;
  /** Per-channel last-seen seq — the reconnect resume cursors. */
  private readonly cursors = new Map<string, number>();
  /** Called on sys.resync: pass the channel; caller refetches from REST/WS. */
  onResync: ((channel: string) => void) | undefined;
  private readonly token: string;
  private readonly url: string;
  private readonly clientKind: string;
  private readonly clientVersion: string;

  constructor(opts: { baseUrl: string; token: string; clientKind?: string; clientVersion?: string }) {
    this.url = opts.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.token = opts.token;
    this.clientKind = opts.clientKind ?? "cli";
    this.clientVersion = opts.clientVersion ?? "0.0.0";
  }

  /** Open + handshake. Rejects on protocol/auth/close failures. */
  connect(resume?: { channel: string; lastSeq: number }[]): Promise<ConnectResultView> {
    const cursors = resume ?? [...this.cursors.entries()].map(([channel, lastSeq]) => ({ channel, lastSeq }));
    return new Promise<ConnectResultView>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: "req",
          id: "connect",
          method: "connect",
          params: {
            protocol: PROTOCOL_VERSION,
            auth: { token: this.token },
            client: { kind: this.clientKind, version: this.clientVersion },
            resume: cursors,
          },
        }));
      };
      ws.onmessage = (msg: MessageEvent) => {
        // connect() on this instance replaces the socket; late frames/closes
        // from the previous one must not touch current state.
        if (ws !== this.ws) return;
        this.onFrame(msg.data as string);
      };
      ws.onclose = (ev: { code: number; reason?: string }) => {
        if (ws !== this.ws) return;
        // Held (unsubscribed) frames die with the connection: a later
        // connect() replays them from the cursors — flushing stale copies
        // would double-deliver.
        this.queuedEvents.length = 0;
        const err = protocolError("internal", `socket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      ws.onerror = () => {
        if (ws !== this.ws) return;
        const err = protocolError("internal", "socket error");
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const connectResolve = (payload: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(payload as ConnectResultView);
      };
      this.pending.set("connect", { resolve: connectResolve, reject });
    });
  }

  private onFrame(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    if (f["type"] === "event" && typeof f["event"] === "string" && typeof f["channel"] === "string" && typeof f["seq"] === "number") {
      this.cursors.set(f["channel"], f["seq"]);
      const frame: EventFrame = {
        event: f["event"],
        channel: f["channel"],
        seq: f["seq"],
        payload: f["payload"],
      };
      if (this.handlers.size === 0) {
        this.queuedEvents.push(frame);
        if (this.queuedEvents.length > FoundrySocket.EVENT_QUEUE_MAX) {
          this.queuedEvents.shift();
        }
        return;
      }
      this.dispatchEvent(frame);
      return;
    }
    if (f["type"] === "res" && typeof f["id"] === "string") {
      const p = this.pending.get(f["id"]);
      if (p === undefined) return;
      this.pending.delete(f["id"]);
      if (f["ok"] === true) {
        p.resolve(f["payload"]);
      } else {
        const e = f["error"] as { code?: string; message?: string; retryable?: boolean } | undefined;
        p.reject(protocolError(
          typeof e?.code === "string" ? e.code : "internal",
          typeof e?.message === "string" ? e.message : "request failed",
          e?.retryable === true,
        ));
      }
    }
  }

  /** Send a req frame; resolves the res payload or throws WSRequestError. */
  req(method: string, params?: unknown, idem?: string, timeoutMs = 60_000): Promise<unknown> {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(protocolError("internal", "socket not connected"));
    }
    const id = `r${(this.nextId++).toString(36)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError("capacity", `timeout waiting for ${method} response`));
      }, timeoutMs);
      const onCleanup = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (v) => {
          onCleanup();
          resolve(v);
        },
        reject: (e) => {
          onCleanup();
          reject(e);
        },
      });
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params, ...(idem !== undefined ? { idem } : {}) }));
      } catch (err) {
        onCleanup();
        reject(protocolError("internal", err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /** One dispatch path for live and flushed frames (sys.resync included). */
  private dispatchEvent(frame: EventFrame): void {
    if (frame.event === "sys.resync") {
      // Resync routes to the dedicated hook AND to regular handlers: it is a
      // normal event on its channel (§1.4), observability shouldn't require
      // subscribing twice.
      this.onResync?.(frame.channel);
    }
    for (const h of this.handlers) {
      h(frame.event, frame.channel, frame.seq, frame.payload);
    }
  }

  /**
   * Subscribe to events; returns an unsubscribe function. Frames that arrived
   * before any subscription existed (typical: the post-`connect()` resume
   * replay burst) are delivered to the new handler in order.
   */
  on(handler: EventHandler): () => void {
    const firstSubscriber = this.handlers.size === 0;
    this.handlers.add(handler);
    if (firstSubscriber) {
      // Splice before dispatching: dispatch runs user code synchronously, and
      // during it handlers.size >= 1, so nothing can re-enter the queue.
      const queued = this.queuedEvents.splice(0);
      for (const frame of queued) this.dispatchEvent(frame);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  close(): void {
    try {
      this.ws?.close(1000, "client closing");
    } catch {
      // already closed
    }
    this.queuedEvents.length = 0; // stale payloads never reach a new connection
  }
}

export class FoundryClient {
  private readonly baseUrl: string;
  private token: string | undefined;

  constructor(opts: FoundryClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    this.token = opts.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  socket(opts: FoundryClientOptions & { clientKind?: string; clientVersion?: string } = {}): FoundrySocket {
    if (this.token === undefined) throw new Error("token required for WS");
    return new FoundrySocket({ baseUrl: this.baseUrl, token: this.token, ...opts });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = { raw: text };
    }
    if (!res.ok) {
      const msg = (parsed as { error?: { message?: string } })?.error?.message ?? `${method} ${path} failed (${res.status})`;
      throw protocolError("internal", msg);
    }
    return parsed as T;
  }

  // -- auth / models ----------------------------------------------------------

  login(apiKey: string): Promise<{ sessionToken: string; expiresAt: string }> {
    return this.json("POST", "/v1/auth/login", { apiKey });
  }

  models(): Promise<{ object: string; data: { id: string; name: string }[] }> {
    return this.json("GET", "/v1/models");
  }

  // -- chat -------------------------------------------------------------------

  /** Non-stream OpenAI-compatible completion. */
  chat(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json("POST", "/v1/chat/completions", body);
  }

  /** Streaming SSE completion — yields chunk objects, ends after [DONE]. */
  async *chatStream(body: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
    const res = await fetch(this.baseUrl + "/v1/chat/completions", {
      method: "POST",
      headers: {
        ...(this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || res.body === null) {
      const text = res.body === null ? "" : await res.text();
      const msg = (JSON.parse(text || "{}") as { error?: { message?: string } }).error?.message ?? `chat failed (${res.status})`;
      throw protocolError("internal", msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // keep-alive or non-JSON line — skip
        }
      }
    }
  }

  // -- admin ------------------------------------------------------------------

  adminUpsertProvider(body: {
    id?: string;
    kind: string;
    baseUrl?: string;
    apiKey?: string;
    models?: { id: string; name?: string; context?: number; caps?: Record<string, boolean>; priceIn?: number; priceOut?: number }[];
  }): Promise<{ id: string; models: string[] }> {
    return this.json("POST", "/v1/admin/providers", body);
  }

  adminListProviders(): Promise<{ providers: { id: string; kind: string; baseUrl: string | null; enabled: boolean; hasKey: boolean }[] }> {
    return this.json("GET", "/v1/admin/providers");
  }

  adminDeleteProvider(id: string): Promise<{ ok: boolean }> {
    return this.json("DELETE", `/v1/admin/providers/${encodeURIComponent(id)}`);
  }

  adminCreateKey(name?: string): Promise<{ id: string; name: string; key: string }> {
    return this.json("POST", "/v1/admin/keys", { ...(name !== undefined ? { name } : {}) });
  }

  adminListKeys(): Promise<{ keys: { id: string; name: string }[] }> {
    return this.json("GET", "/v1/admin/keys");
  }

  adminRevokeKey(id: string): Promise<{ ok: boolean }> {
    return this.json("DELETE", `/v1/admin/keys/${encodeURIComponent(id)}`);
  }
}

function protocolError(code: string, message: string, retryable = false): WSRequestError {
  const e = new Error(message) as WSRequestError;
  e.name = "WSRequestError";
  e.code = code;
  if (retryable) e.retryable = true;
  return e;
}