import {
  PROTOCOL_VERSION,
  type ChatCreateParams,
  type ChatHistoryParams,
  type ChatSendParams,
  type ChatSendResult,
  type ChatSummary,
  type ConnectResult,
  type FileEntry,
  type FilesListParams,
  type FilesMkdirParams,
  type FilesPathParams,
  type FilesReadParams,
  type FilesRmParams,
  type FilesReadResult,
  type FilesWriteParams,
  type Gate,
  type Message,
  type Model,
  type Run,
  type RunApproveParams,
  type RunCancelParams,
  type RunEventItem,
  type RunGetParams,
  type TermCloseParams,
  type TermInputParams,
  type TermOpenParams,
  type TermOpenResult,
  type TermResizeParams,
} from "@foundry/protocol";
import { FoundryError } from "./errors.js";

/** Public alias so clients can type their own handshake consumers. */
export type ConnectResultView = ConnectResult;

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Handler receiving every server event frame. Return value is ignored. */
export type EventHandler = (event: string, channel: string, seq: number, payload: unknown) => void;

/** Normalized `type: "event"` frame as passed to handlers. */
interface EventFrame {
  event: string;
  channel: string;
  seq: number;
  payload: unknown;
}

export interface SocketOptions {
  /** Reconnect with backoff on unexpected close, resuming from per-channel cursors. */
  autoReconnect?: boolean;
  /** Max backoff between reconnect attempts (default 15_000). */
  reconnectMaxMs?: number;
}

/**
 * WS `req`/`res`/`event` client. Server-authoritative (CLAUDE.md): the SDK
 * never owns state — it sends commands, receives events, and refetches on
 * sys.resync.
 *
 * Uses only platform primitives: global fetch (Node 22+/browsers) and
 * global WebSocket (Node 22.4+/browsers).
 */
export class FoundrySocket {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: FoundryError) => void }>();
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
  /** Called on every socket state transition (auto-reconnect UI state). */
  onStatus: ((status: SocketStatus, error?: FoundryError) => void) | undefined;
  private readonly token: string;
  private readonly url: string;
  private readonly clientKind: string;
  private readonly clientVersion: string;
  private readonly autoReconnect: boolean;
  private readonly reconnectMaxMs: number;
  private userClosed = false;
  private authFailed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handshake: ConnectResult | undefined;

  constructor(opts: { baseUrl: string; token: string; clientKind?: string; clientVersion?: string } & SocketOptions) {
    this.url = opts.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.token = opts.token;
    this.clientKind = opts.clientKind ?? "cli";
    this.clientVersion = opts.clientVersion ?? "0.0.0";
    this.autoReconnect = opts.autoReconnect === true;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 15_000;
  }

  /** Open + handshake. Rejects on protocol/auth/close failures. */
  connect(resume?: { channel: string; lastSeq: number }[]): Promise<ConnectResultView> {
    this.userClosed = false;
    this.authFailed = false;
    const cursors = resume ?? [...this.cursors.entries()].map(([channel, lastSeq]) => ({ channel, lastSeq }));
    const settled = new Promise<ConnectResultView>((resolve, reject) => {
      let done = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.onStatus?.("connecting");
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
        this.handshake = undefined;
        const err = protocolError("internal", `socket closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (!done) {
          done = true;
          reject(err);
        }
        this.onStatus?.("closed", err);
        // With a fixed token an auth rejection can never succeed on retry.
        if (!this.authFailed) this.scheduleReconnect();
      };
      ws.onerror = () => {
        if (ws !== this.ws) return;
        const err = protocolError("internal", "socket error");
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        if (done) return;
        done = true;
        reject(err);
      };
      const connectResolve = (payload: unknown): void => {
        if (done) return;
        done = true;
        this.reconnectAttempt = 0;
        this.handshake = payload as ConnectResult;
        this.onStatus?.("open");
        resolve(payload as ConnectResultView);
      };
      this.pending.set("connect", { resolve: connectResolve, reject });
    });
    return settled;
  }

  /** Backoff reconnect: resumes from cursors; handlers live on this instance. */
  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.userClosed) return;
    if (this.reconnectTimer !== undefined) return;
    const attempt = this.reconnectAttempt++;
    const backoff = Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 250), this.reconnectMaxMs);
    this.onStatus?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.userClosed) return;
      void this.connect().catch(() => undefined);
    }, backoff);
  }

  /** Resolve when the socket is open; connects it if it isn't. */
  async ensureConnected(): Promise<ConnectResultView> {
    if (this.handshake !== undefined && this.isOpen) return this.handshake;
    return this.connect();
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
      if (f["id"] === "connect" && f["ok"] !== true) {
        // A protocol/auth handshake failure is permanent for this socket's
        // fixed token — never auto-retry it.
        this.authFailed = true;
      }
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

  /** Send a req frame; resolves the res payload or throws FoundryError. */
  req(method: string, params?: unknown, idem?: string, timeoutMs = 60_000): Promise<unknown> {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(protocolError("internal", "socket not connected"));
    }
    const id = `r${(this.nextId++).toString(36)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(protocolError("capacity", `timeout waiting for ${method} response`, { retryable: true }));
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
    this.userClosed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      this.ws?.close(1000, "client closing");
    } catch {
      // already closed
    }
    this.queuedEvents.length = 0; // stale payloads never reach a new connection
  }

  get isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Typed method helpers (protocol §1.3). Side-effecting calls still take an
  // explicit `idem`; the wire form comes from raw req().
  // ---------------------------------------------------------------------------

  sysHealth(): Promise<{ ok: boolean; version: string; uptimeS: number }> {
    return this.req("sys.health") as Promise<{ ok: boolean; version: string; uptimeS: number }>;
  }

  sysModels(): Promise<Model[]> {
    return this.req("sys.models") as Promise<Model[]>;
  }

  chatList(): Promise<ChatSummary[]> {
    return this.req("chat.list") as Promise<ChatSummary[]>;
  }

  chatCreate(params: ChatCreateParams): Promise<ChatSummary> {
    return this.req("chat.create", params) as Promise<ChatSummary>;
  }

  chatSend(params: ChatSendParams, idem: string): Promise<ChatSendResult> {
    return this.req("chat.send", params, idem) as Promise<ChatSendResult>;
  }

  chatHistory(params: ChatHistoryParams): Promise<Message[]> {
    return this.req("chat.history", params) as Promise<Message[]>;
  }

  runGet(params: RunGetParams): Promise<Run & { gates?: Gate[] }> {
    return this.req("run.get", params) as Promise<Run & { gates?: Gate[] }>;
  }

  runEvents(params: { runId: string; since?: number }): Promise<RunEventItem[]> {
    return this.req("run.events", params) as Promise<RunEventItem[]>;
  }

  runCancel(params: RunCancelParams, idem: string): Promise<void> {
    return this.req("run.cancel", params, idem) as Promise<void>;
  }

  runApprove(params: RunApproveParams, idem: string): Promise<Gate> {
    return this.req("run.approve", params, idem) as Promise<Gate>;
  }

  termOpen(params: TermOpenParams, idem: string): Promise<TermOpenResult> {
    return this.req("term.open", params, idem) as Promise<TermOpenResult>;
  }

  termInput(params: TermInputParams, idem: string): Promise<void> {
    return this.req("term.input", params, idem) as Promise<void>;
  }

  termResize(params: TermResizeParams, idem: string): Promise<void> {
    return this.req("term.resize", params, idem) as Promise<void>;
  }

  termClose(params: TermCloseParams, idem: string): Promise<void> {
    return this.req("term.close", params, idem) as Promise<void>;
  }

  filesList(params: FilesListParams): Promise<FileEntry[]> {
    return this.req("files.list", params) as Promise<FileEntry[]>;
  }

  filesRead(params: FilesReadParams): Promise<FilesReadResult> {
    return this.req("files.read", params) as Promise<FilesReadResult>;
  }

  filesWrite(params: FilesWriteParams, idem: string): Promise<void> {
    return this.req("files.write", params, idem) as Promise<void>;
  }

  filesMkdir(params: FilesMkdirParams, idem: string): Promise<void> {
    return this.req("files.mkdir", params, idem) as Promise<void>;
  }

  filesRm(params: FilesRmParams, idem: string): Promise<void> {
    return this.req("files.rm", params, idem) as Promise<void>;
  }

  filesStat(params: FilesPathParams): Promise<FileEntry> {
    return this.req("files.stat", params) as Promise<FileEntry>;
  }
}

function protocolError(code: string, message: string, retryableOrOpts?: boolean | { retryable?: boolean }): FoundryError {
  const retryable = retryableOrOpts === true || (typeof retryableOrOpts === "object" && retryableOrOpts.retryable === true);
  return new FoundryError(code, message, { retryable });
}