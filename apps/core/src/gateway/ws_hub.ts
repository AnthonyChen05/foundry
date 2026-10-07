import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { Value } from "@sinclair/typebox/value";
import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  EVENT_NAMES,
  METHOD_NAMES,
  ConnectParamsSchema,
  AuthLoginParamsSchema,
  ChatCreateParamsSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  requiresIdempotencyKey,
} from "@foundry/protocol";
import type {
  AuthLoginParams,
  ChatCreateParams,
  ChatHistoryParams,
  ChatSendParams,
  ConnectParams,
  Message,
  ProtocolError,
} from "@foundry/protocol";
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";
import { conversations, runs } from "../db/schema.js";
import type { AuthService } from "../auth/auth.js";
import { UnknownModelError } from "./chat.js";
import { ProviderError } from "../providers/types.js";
import type { ChatService } from "./chat.js";
import type { ProviderStore } from "../providers/store.js";

/**
 * WS hub (protocol.md §1): /ws — first frame MUST be `connect` (hard close
 * otherwise), token auth, per-channel seq + 500-event replay ring, idem
 * dedupe (10 min; concurrent duplicates share one in-flight promise), and
 * the v0 chat-plane methods. All authed connections receive ALL channel
 * events (single-user, ADR-008); the ring makes reconnects correct. After a
 * process restart seqs restart — stale cursors get sys.resync and clients
 * refetch from the DB (server-authoritative).
 */

interface ReqFrameView {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  idem?: string;
}

interface HConn {
  socket: WebSocket;
  userId: string;
  sessionId: string;
  ready: boolean;
}

const RING_MAX = 500;
const IDEM_TTL_MS = 10 * 60 * 1000;
const IDEM_MAX_ENTRIES = 1000;

type Settled = { ok: true; payload: unknown } | { ok: false; error: ProtocolError };

export class WsHub {
  private readonly conns = new Set<HConn>();
  /** Next seq per channel (events start at 1; seqs are NOT persisted). */
  private readonly seqs = new Map<string, number>();
  /** Replay ring per channel (in-memory; lost on restart → sys.resync). */
  private readonly buffers = new Map<string, { seq: number; frame: object }[]>();
  /** Dedupe cache: "method:idem" → settled success payload (10 min TTL). */
  private readonly idem = new Map<string, { expiresAt: number; payload: unknown }>();
  /** Same-idem requests racing while the first is in flight share this. */
  private readonly idemInFlight = new Map<string, Promise<Settled>>();
  /** In-flight run aborters, runId → controller (run.cancel). */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: {
    config: AppConfig;
    dbx: FoundryDb;
    chat: ChatService;
    providers: ProviderStore;
    auth: AuthService;
    version: string;
  }) {}

  // -- event publishing -------------------------------------------------------

  /**
   * The single event router: ChatService (and later the agent runtime) call
   * this; every ready connection receives the frame. Ring + seq advance
   * first so replay always matches what fresh subscribers see.
   */
  publish(event: string, channel: string, payload: unknown): void {
    if (channel.length === 0 || channel.endsWith(":")) return; // defensive
    const next = (this.seqs.get(channel) ?? 0) + 1;
    this.seqs.set(channel, next);
    const frame = { type: "event", event, channel, seq: next, payload };
    let buf = this.buffers.get(channel);
    if (buf === undefined) {
      buf = [];
      this.buffers.set(channel, buf);
    }
    buf.push({ seq: next, frame });
    if (buf.length > RING_MAX) buf.shift();
    for (const c of this.conns) this.send(c.socket, frame);
  }

  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // closing mid-write — close/error handlers reap the conn
    }
  }

  private sendResync(socket: WebSocket, channel: string, reason: string): void {
    this.send(socket, {
      type: "event",
      event: "sys.resync",
      channel,
      seq: Math.max(this.seqs.get(channel) ?? 0, 0),
      payload: { reason },
    });
  }

  // -- websocket route --------------------------------------------------------

  register(app: FastifyInstance): void {
    app.get("/ws", { websocket: true }, (socket, _request) => {
      const conn: HConn = { socket, userId: "", sessionId: "", ready: false };
      socket.on("message", (raw: unknown) => {
        this.onMessage(conn, typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
      });
      socket.on("close", () => this.conns.delete(conn));
      socket.on("error", () => this.conns.delete(conn));
    });
  }

  private onMessage(conn: HConn, raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // unparseable garbage: ignore; the first-frame rule still holds
    }
    if (!conn.ready) {
      this.onFirstFrame(conn, frame);
      return;
    }
    void this.dispatch(conn, frame);
  }

  /** Guardrail #5: first frame MUST be connect, else hard close. */
  private onFirstFrame(conn: HConn, frame: unknown): void {
    const hardClose = (why: string): void => {
      try {
        conn.socket.close(1008, why.slice(0, 123));
      } catch {
        // already closed
      }
    };
    if (
      typeof frame !== "object" || frame === null ||
      (frame as Record<string, unknown>)["type"] !== "req"
    ) {
      hardClose("first frame must be a connect req");
      return;
    }
    const req = frame as ReqFrameView;
    if (req.method !== "connect") {
      hardClose(`first frame must be connect, got ${req.method}`);
      return;
    }
    if (!Value.Check(ConnectParamsSchema, req.params)) {
      this.send(conn.socket, { type: "res", id: req.id, ok: false, error: { code: "bad_request", message: "invalid connect params" } });
      hardClose("invalid connect params");
      return;
    }
    const params = req.params as ConnectParams;

    if (params.protocol !== PROTOCOL_VERSION) {
      this.send(conn.socket, {
        type: "res",
        id: req.id,
        ok: false,
        error: {
          code: "bad_request",
          message: `unsupported protocol version ${String(params.protocol)}: supported versions are ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
        },
      });
      hardClose("protocol version mismatch");
      return;
    }

    const user = this.deps.auth.verifyToken(params.auth.token);
    if (!user) {
      this.send(conn.socket, { type: "res", id: req.id, ok: false, error: { code: "unauthorized", message: "invalid token" } });
      hardClose("unauthorized");
      return;
    }

    conn.ready = true;
    conn.userId = user.userId;
    conn.sessionId = `s_${randomBytes(8).toString("hex")}`;
    this.conns.add(conn);

    this.send(conn.socket, {
      type: "res",
      id: req.id,
      ok: true,
      payload: {
        sessionId: conn.sessionId,
        protocol: PROTOCOL_VERSION,
        features: { methods: [...METHOD_NAMES], events: [...EVENT_NAMES] },
        snapshot: { activeRuns: this.activeRunIds(), unread: 0 },
      },
    });

    // Resume: replay per channel from lastSeq+1, resync on gaps.
    for (const entry of params.resume ?? []) {
      this.replay(conn, entry.channel, entry.lastSeq);
    }
  }

  // -- replay -------------------------------------------------------------------

  private replay(conn: HConn, channel: string, lastSeq: number): void {
    const buf = this.buffers.get(channel);
    const current = this.seqs.get(channel) ?? 0;
    if (lastSeq < 0) {
      // Fresh subscription ("give me what you have").
      if (buf !== undefined) for (const f of buf) this.send(conn.socket, f.frame);
      return;
    }
    if (current === 0 && lastSeq > 0) {
      // Client claims prior events; this process has none (restart lost the ring).
      this.sendResync(conn.socket, channel, "gap_exceeds_buffer");
      return;
    }
    if (lastSeq > current) {
      // Client cursor ahead of this process' seq (seqs reset on restart).
      this.sendResync(conn.socket, channel, "cursor_ahead");
      return;
    }
    const first = buf?.[0];
    const oldest = first !== undefined ? first.seq : current + 1;
    if (lastSeq + 1 < oldest) {
      this.sendResync(conn.socket, channel, "gap_exceeds_buffer");
      return;
    }
    if (buf !== undefined) {
      for (const f of buf) {
        if (f.seq > lastSeq) this.send(conn.socket, f.frame);
      }
    }
  }

  // -- dispatch ---------------------------------------------------------------

  private async dispatch(conn: HConn, frame: unknown): Promise<void> {
    if (
      typeof frame !== "object" || frame === null ||
      (frame as Record<string, unknown>)["type"] !== "req"
    ) {
      this.send(conn.socket, { type: "res", id: "unknown", ok: false, error: { code: "bad_request", message: "frame must be { type:'req', id, method, params? }" } });
      return;
    }
    const req = frame as ReqFrameView;
    if (typeof req.id !== "string" || typeof req.method !== "string") {
      this.send(conn.socket, { type: "res", id: "unknown", ok: false, error: { code: "bad_request", message: "req requires string id and method" } });
      return;
    }
    if (requiresIdempotencyKey(req.method) && typeof req.idem !== "string") {
      this.send(conn.socket, { type: "res", id: req.id, ok: false, error: { code: "bad_request", message: `method ${req.method} requires an idem key` } });
      return;
    }
    const outcome = await this.settle(conn, req);
    if (outcome.ok) {
      this.send(conn.socket, { type: "res", id: req.id, ok: true, payload: outcome.payload });
    } else {
      this.send(conn.socket, { type: "res", id: req.id, ok: false, error: outcome.error });
    }
  }

  /** Runs the handler; identical-idem calls share one in-flight attempt. */
  private settle(conn: HConn, req: ReqFrameView): Promise<Settled> {
    if (req.idem === undefined) return this.attempt(conn, req);

    const key = `${req.method}:${req.idem}`;
    const cached = this.idem.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > Date.now()) return Promise.resolve({ ok: true, payload: cached.payload });
      this.idem.delete(key);
    }
    const inFlight = this.idemInFlight.get(key);
    if (inFlight !== undefined) return inFlight;

    const pending = this.attempt(conn, req);
    this.idemInFlight.set(key, pending);
    void pending.then((r) => {
      this.idemInFlight.delete(key);
      if (r.ok) {
        // Only successes are cached: failures stay retryable under the same idem.
        this.idem.set(key, { expiresAt: Date.now() + IDEM_TTL_MS, payload: r.payload });
        if (this.idem.size > IDEM_MAX_ENTRIES) this.pruneIdem();
      }
    });
    return pending;
  }

  private async attempt(conn: HConn, req: ReqFrameView): Promise<Settled> {
    try {
      const payload = await this.handle(conn, req);
      return { ok: true, payload };
    } catch (err) {
      return { ok: false, error: toProtocolError(err) };
    }
  }

  private pruneIdem(): void {
    const now = Date.now();
    for (const [k, v] of this.idem) {
      if (v.expiresAt <= now) this.idem.delete(k);
    }
  }

  // -- methods ----------------------------------------------------------------

  private async handle(conn: HConn, req: ReqFrameView): Promise<unknown> {
    const { method, params } = req;
    switch (method) {
      case "connect": {
        throw errOf("bad_request", "connect is only valid as the first frame");
      }
      case "sys.health": {
        return { ok: true, version: this.deps.version, uptimeS: Math.floor(process.uptime()) };
      }
      case "sys.models": {
        return this.deps.providers.listModels().map(mToProtocolModel);
      }
      case "auth.login": {
        if (!Value.Check(AuthLoginParamsSchema, params)) throw errOf("bad_request", "invalid auth.login params");
        const p = params as AuthLoginParams;
        const session = this.deps.auth.issueSession(p.apiKey);
        if (!session) throw errOf("unauthorized", "invalid api key");
        return { sessionToken: session.plaintext, expiresAt: new Date(session.expiresAt).toISOString() };
      }
      case "chat.list": {
        return this.deps.chat.listConversations(conn.userId);
      }
      case "chat.create": {
        if (!Value.Check(ChatCreateParamsSchema, params)) throw errOf("bad_request", "invalid chat.create params");
        const p = params as ChatCreateParams;
        return this.deps.chat.createConversation(conn.userId, p.title, p.model);
      }
      case "chat.history": {
        if (!Value.Check(ChatHistoryParamsSchema, params)) throw errOf("bad_request", "invalid chat.history params");
        const p = params as ChatHistoryParams;
        this.assertConversation(conn.userId, p.chatId);
        return this.deps.chat.history(p.chatId, p.before, p.limit);
      }
      case "chat.send": {
        if (!Value.Check(ChatSendParamsSchema, params)) throw errOf("bad_request", "invalid chat.send params");
        return this.chatSend(conn, params as ChatSendParams, req.idem as string);
      }
      case "run.get": {
        const runId = strParam(params, "runId");
        const run = this.deps.chat.getRun(runId);
        if (run === undefined) throw errOf("not_found", `unknown run: ${runId}`);
        return run;
      }
      case "run.events": {
        const runId = strParam(params, "runId");
        const since = numParam(params, "since");
        if (this.deps.chat.getRun(runId) === undefined) throw errOf("not_found", `unknown run: ${runId}`);
        return this.deps.chat.runEvents(runId, since);
      }
      case "run.cancel": {
        const runId = strParam(params, "runId");
        const run = this.deps.chat.getRun(runId);
        if (run === undefined) throw errOf("not_found", `unknown run: ${runId}`);
        const controller = this.inFlight.get(runId);
        if (controller === undefined) {
          throw errOf("bad_request", `run ${runId} is not running in this process`);
        }
        controller.abort();
        return {};
      }
      default:
        throw errOf("bad_request", `unknown method: ${method} (P2 adds run.approve, term.*, files.*)`);
    }
  }

  private chatSend(conn: HConn, p: ChatSendParams, _idem: string): { runId: string; conversationId: string } {
    const conv = this.assertConversation(conn.userId, p.chatId);

    // Server-authoritative context: persist the user turn, then load history
    // from the DB — the client sends one message, the server builds the rest.
    const userMessage: Message = { role: "user", content: p.content };
    this.deps.chat.appendMessage(p.chatId, userMessage);

    const model = p.model ?? conv.model;
    if (model === undefined || model.length === 0) {
      throw errOf("bad_request", "no model: pass model or create the chat with one");
    }

    const controller = new AbortController();
    const runId = this.deps.chat.createRun({
      userId: conn.userId,
      conversationId: p.chatId,
      model,
      trigger: "chat",
    });
    this.inFlight.set(runId, controller);

    // Async — chat.send responds immediately; deltas stream as events.
    const history = this.deps.chat.history(p.chatId, undefined, 50).map(canonicalMessage);
    void this.deps.chat
      .runChat({
        userId: conn.userId,
        wireModel: model,
        messages: history,
        runId,
        conversationId: p.chatId,
        trigger: "chat",
        emit: (event, channel, payload) => this.publish(event, channel, payload),
        signal: controller.signal,
      })
      .then(() => this.inFlight.delete(runId))
      .catch(() => this.inFlight.delete(runId));
    return { runId, conversationId: p.chatId };
  }

  private assertConversation(userId: string, chatId: string): { id: string; title: string; model?: string } {
    const row = this.deps.dbx.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, chatId), eq(conversations.userId, userId)))
      .get();
    if (!row) throw errOf("not_found", `unknown conversation: ${chatId}`);
    return { id: row.id, title: row.title, ...(row.model !== null ? { model: row.model } : {}) };
  }

  private activeRunIds(): string[] {
    return this.deps.dbx.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, "running"))
      .all()
      .map((r) => `run:${r.id}`);
  }
}

// -- helpers ------------------------------------------------------------------

/** Map a catalog row to the protocol Model shape. */
function mToProtocolModel(m: {
  id: string;
  providerId: string;
  name: string;
  context: number;
  caps: { vision: boolean; tools: boolean; reasoning: boolean; json: boolean };
  priceIn: number | null;
  priceOut: number | null;
  enabled: boolean;
}): Record<string, unknown> {
  return {
    id: m.id,
    provider: m.providerId,
    name: m.name,
    caps: m.caps,
    context: m.context,
    ...(m.priceIn !== null ? { priceInPerMtok: m.priceIn } : {}),
    ...(m.priceOut !== null ? { priceOutPerMtok: m.priceOut } : {}),
    enabled: m.enabled,
  };
}

/** History rows carry view extras (id/seq/createdAt); strip to canonical. */
function canonicalMessage(m: Message & { id?: string; seq?: number; createdAt?: string }): Message {
  return {
    role: m.role,
    content: m.content,
    ...(m.tool_calls !== undefined ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}),
  };
}

function strParam(params: unknown, key: string): string {
  if (typeof params !== "object" || params === null) throw errOf("bad_request", "params object required");
  const v = (params as Record<string, unknown>)[key];
  if (typeof v !== "string" || v.length === 0) throw errOf("bad_request", `${key} (string) required`);
  return v;
}

function numParam(params: unknown, key: string): number | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function errOf(code: ProtocolError["code"], message: string): Error & { protocolError: ProtocolError } {
  const e = new Error(message) as Error & { protocolError: ProtocolError };
  e.protocolError = { code, message };
  return e;
}

function toProtocolError(err: unknown): ProtocolError {
  if (err !== null && typeof err === "object" && "protocolError" in err) {
    return (err as { protocolError: ProtocolError }).protocolError;
  }
  if (err instanceof ProviderError || err instanceof UnknownModelError) {
    const code: ProtocolError["code"] = err.status === 401 ? "unauthorized"
      : err.status === 404 ? "not_found"
      : err.status === 400 ? "bad_request"
      : "provider_error";
    return { code, message: err.message, ...(err.retryable ? { retryable: true } : {}) };
  }
  return { code: "internal", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
}