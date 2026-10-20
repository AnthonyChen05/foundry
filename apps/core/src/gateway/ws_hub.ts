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
  TermOpenParamsSchema,
  TermInputParamsSchema,
  TermResizeParamsSchema,
  TermCloseParamsSchema,
  FilesListParamsSchema,
  FilesReadParamsSchema,
  FilesWriteParamsSchema,
  FilesMkdirParamsSchema,
  FilesRmParamsSchema,
  FilesStatParamsSchema,
  RunApproveParamsSchema,
  requiresIdempotencyKey,
  ExecRegisterParamsSchema,
  ExecStatusParamsSchema,
  ExecPtyDataParamsSchema,
  ExecPtyExitParamsSchema,
} from "@foundry/protocol";
import type {
  AuthLoginParams,
  ChatCreateParams,
  ChatHistoryParams,
  ChatSendParams,
  ConnectParams,
  ExecPtyDataParams,
  ExecPtyExitParams,
  Message,
  ProtocolError,
  RunApproveParams,
} from "@foundry/protocol";
import { and, eq, or } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";
import { conversations, runs } from "../db/schema.js";
import type { AuthService } from "../auth/auth.js";
import { UnknownModelError } from "./chat.js";
import type { AuditService } from "../audit/audit.js";
import type { Limits } from "./limits.js";
import { ProviderError } from "../providers/types.js";
import { SandboxError } from "../sandbox/types.js";
import type { ChatService } from "./chat.js";
import type { ProviderStore } from "../providers/store.js";
import { GateService } from "../agent/gates.js";
import type { AgentRunner } from "../agent/runtime.js";
import type { TermService } from "./term.js";
import type { FilesService } from "./files.js";
import type { LocalExecutorDriver } from "../executor/local_driver.js";
import type { ExecutorConn, ExecutorRegistry } from "../executor/registry.js";

/** Executor plane wiring (ADR-015): registry + delegating driver, built by
 *  buildRuntime and handed over via wireServices (like agents/term/files). */
export interface ExecutorWiring {
  registry: ExecutorRegistry;
  driver: LocalExecutorDriver;
}

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
  /** Set by exec.register (ADR-015): this connection is the user's executor. */
  role?: "executor";
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
  /** In-flight run aborters, runId → controller (run.cancel). Shared with the
   *  AgentRunner (cancellations registry) so resumed runs are cancellable. */
  readonly inFlight = new Map<string, AbortController>();
  /** Executor-role connections → the registry's conn wrapper (ADR-015). */
  private readonly executorConns = new Map<HConn, ExecutorConn>();

  constructor(private readonly deps: {
    config: AppConfig;
    dbx: FoundryDb;
    chat: ChatService;
    providers: ProviderStore;
    auth: AuthService;
    version: string;
    /** Agent runtime — wired after construction (buildRuntime). */
    agents?: AgentRunner;
    /** Terminal service — wired after construction (buildRuntime). */
    term?: TermService;
    /** Client file plane — wired after construction (buildRuntime). */
    files?: FilesService;
    /** Approval gates (P3) — wired after construction (buildRuntime). */
    gates?: GateService;
    /** P5 audit + limits — wired after construction (buildRuntime). */
    audit?: AuditService;
    limits?: Limits;
    /** Executor plane (ADR-015) — wired after construction (buildRuntime). */
    executor?: ExecutorWiring;
  }) {}

  /** Late wiring: the hub is built before the services that need its maps. */
  wireServices(services: { agents?: AgentRunner; term?: TermService; files?: FilesService; gates?: GateService; executor?: ExecutorWiring; audit?: AuditService; limits?: Limits }): void {
    if (services.agents !== undefined) this.deps.agents = services.agents;
    if (services.term !== undefined) this.deps.term = services.term;
    if (services.files !== undefined) this.deps.files = services.files;
    if (services.gates !== undefined) this.deps.gates = services.gates;
    if (services.executor !== undefined) this.deps.executor = services.executor;
    if (services.audit !== undefined) this.deps.audit = services.audit;
    if (services.limits !== undefined) this.deps.limits = services.limits;
  }

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
      socket.on("close", () => this.reapConn(conn));
      socket.on("error", () => this.reapConn(conn));
    });
  }

  /** Connection teardown + executor-registry cleanup (ADR-015). */
  private reapConn(conn: HConn): void {
    this.conns.delete(conn);
    if (conn.role === "executor") {
      const wrapper = this.executorConns.get(conn);
      if (wrapper !== undefined) {
        this.deps.executor?.registry.drop(wrapper, "closed");
        this.executorConns.delete(conn);
      }
    }
  }

  /** The registry-facing view of a hub connection (stable per conn). */
  private executorConnOf(conn: HConn): ExecutorConn {
    let wrapper = this.executorConns.get(conn);
    if (wrapper === undefined) {
      wrapper = {
        userId: conn.userId,
        send: (frame) => this.send(conn.socket, frame),
      };
      this.executorConns.set(conn, wrapper);
    }
    return wrapper;
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
    // Executor plane (ADR-015): a connection registered as the user's executor
    // answers res frames to the server→client reqs we sent it. Everyone else
    // keeps today's non-req behavior below.
    if (
      conn.role === "executor" && typeof frame === "object" && frame !== null &&
      (frame as Record<string, unknown>)["type"] === "res"
    ) {
      const res = frame as { id?: unknown; ok?: unknown; payload?: unknown; error?: unknown };
      this.deps.executor?.registry.onRes(
        conn.userId,
        {
          id: typeof res.id === "string" ? res.id : "",
          ok: res.ok === true,
          ...(res.payload !== undefined ? { payload: res.payload } : {}),
          ...(res.error !== undefined ? { error: res.error as { message?: string } } : {}),
        },
      );
      return;
    }
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
        const session = await this.deps.auth.loginWithPassword(p.username, p.password);
        if (!session) throw errOf("unauthorized", "invalid username or password");
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
        this.assertRunOwner(conn.userId, runId);
        const run = this.deps.chat.getRun(runId);
        if (run === undefined) throw errOf("not_found", `unknown run: ${runId}`);
        // Open gates ride along (P3) so a reconnecting client can render its
        // approve/deny UI without replaying the whole timeline.
        const openGates = this.deps.gates?.listForRun(runId) ?? [];
        return openGates.length === 0 ? run : { ...run, gates: openGates.map((g) => GateService.toWire(g)) };
      }
      case "run.events": {
        const runId = strParam(params, "runId");
        this.assertRunOwner(conn.userId, runId);
        const since = numParam(params, "since");
        return this.deps.chat.runEvents(runId, since);
      }
      case "run.cancel": {
        const runId = strParam(params, "runId");
        this.assertRunOwner(conn.userId, runId);
        const run = this.deps.chat.getRun(runId);
        if (run === undefined) throw errOf("not_found", `unknown run: ${runId}`);
        const controller = this.inFlight.get(runId);
        if (controller === undefined) {
          throw errOf("bad_request", `run ${runId} is not running in this process`);
        }
        this.deps.audit?.record({ userId: conn.userId, action: "run.cancel", target: runId });
        controller.abort();
        return {};
      }
      case "run.approve": {
        if (!Value.Check(RunApproveParamsSchema, params)) throw errOf("bad_request", "invalid run.approve params");
        if (this.deps.gates === undefined) throw errOf("internal", "gate service unavailable");
        const p = params as RunApproveParams;
        // Ownership FIRST: the gate service only knows gates/runs by id.
        this.assertRunOwner(conn.userId, p.runId);
        const row = this.deps.gates.resolve({
          runId: p.runId,
          gateId: p.gateId,
          approve: p.approve,
          ...(p.scope !== undefined ? { scope: p.scope } : {}),
          by: conn.sessionId,
        });
        return GateService.toWire(row);
      }
      case "term.open": {
        if (!Value.Check(TermOpenParamsSchema, params)) throw errOf("bad_request", "invalid term.open params");
        if (this.deps.term === undefined) throw errOf("internal", "terminal service unavailable");
        const t = params as { envId?: string };
        return this.deps.term.open(conn.userId, t.envId);
      }
      case "term.input": {
        if (!Value.Check(TermInputParamsSchema, params)) throw errOf("bad_request", "invalid term.input params");
        if (this.deps.term === undefined) throw errOf("internal", "terminal service unavailable");
        const t = params as { termId: string; data: string; b64?: boolean };
        this.deps.term.input(conn.userId, t.termId, t.data, t.b64);
        return {};
      }
      case "term.resize": {
        if (!Value.Check(TermResizeParamsSchema, params)) throw errOf("bad_request", "invalid term.resize params");
        if (this.deps.term === undefined) throw errOf("internal", "terminal service unavailable");
        const t = params as { termId: string; cols: number; rows: number };
        this.deps.term.resize(conn.userId, t.termId, t.cols, t.rows);
        return {};
      }
      case "term.close": {
        if (!Value.Check(TermCloseParamsSchema, params)) throw errOf("bad_request", "invalid term.close params");
        if (this.deps.term === undefined) throw errOf("internal", "terminal service unavailable");
        const t = params as { termId: string };
        await this.deps.term.close(conn.userId, t.termId);
        return {};
      }
      case "files.list": {
        if (!Value.Check(FilesListParamsSchema, params)) throw errOf("bad_request", "invalid files.list params");
        if (this.deps.files === undefined) throw errOf("internal", "file service unavailable");
        const t = params as { envId?: string; path: string };
        return this.deps.files.list(conn.userId, t.envId, t.path);
      }
      case "files.read": {
        if (!Value.Check(FilesReadParamsSchema, params)) throw errOf("bad_request", "invalid files.read params");
        if (this.deps.files === undefined) throw errOf("internal", "file service unavailable");
        const t = params as { envId?: string; path: string };
        return this.deps.files.read(conn.userId, t.envId, t.path);
      }
      case "files.write": {
        if (!Value.Check(FilesWriteParamsSchema, params)) throw errOf("bad_request", "invalid files.write params");
        if (this.deps.files === undefined) throw errOf("internal", "file service unavailable");
        const t = params as { envId?: string; path: string; content: string; b64?: boolean };
        await this.deps.files.write(conn.userId, t.envId, t.path, t.content, t.b64);
        return {};
      }
      case "files.mkdir": {
        if (!Value.Check(FilesMkdirParamsSchema, params)) throw errOf("bad_request", "invalid files.mkdir params");
        if (this.deps.files === undefined) throw errOf("internal", "file service unavailable");
        const t = params as { envId?: string; path: string; recursive?: boolean };
        await this.deps.files.mkdir(conn.userId, t.envId, t.path, t.recursive);
        return {};
      }
      case "files.rm": {
        if (!Value.Check(FilesRmParamsSchema, params)) throw errOf("bad_request", "invalid files.rm params");
        if (this.deps.files === undefined) throw errOf("internal", "file service unavailable");
        const t = params as { envId?: string; path: string; recursive?: boolean };
        await this.deps.files.rm(conn.userId, t.envId, t.path, t.recursive);
        return {};
      }
      case "files.stat": {
        if (!Value.Check(FilesStatParamsSchema, params)) throw errOf("bad_request", "invalid files.stat params");
        if (this.deps.files === undefined) throw errOf("internal", "file service unavailable");
        const t = params as { envId?: string; path: string };
        return this.deps.files.stat(conn.userId, t.envId, t.path);
      }
      case "exec.register": {
        if (!Value.Check(ExecRegisterParamsSchema, params)) throw errOf("bad_request", "invalid exec.register params");
        if (this.deps.executor === undefined) throw errOf("internal", "executor plane not wired");
        const p = params as { name: string; version: string; dockerAvailable: boolean; workspaceRoot?: string };
        const res = this.deps.executor.registry.register(this.executorConnOf(conn), {
          online: true,
          name: p.name,
          version: p.version,
          dockerAvailable: p.dockerAvailable,
          ...(p.workspaceRoot !== undefined ? { workspaceRoot: p.workspaceRoot } : {}),
        });
        conn.role = "executor";
        this.deps.audit?.record({
          userId: conn.userId,
          action: "executor.register",
          target: p.name,
          meta: { replaced: res.replaced === true, dockerAvailable: p.dockerAvailable },
        });
        return { ...(res.replaced ? { replaced: true } : {}) };
      }
      case "exec.status": {
        if (!Value.Check(ExecStatusParamsSchema, params)) throw errOf("bad_request", "invalid exec.status params");
        if (this.deps.executor === undefined) return { online: false };
        const info = this.deps.executor.registry.info(conn.userId);
        return info ?? { online: false };
      }
      // Executor PTY pump (client → server): transport frames, NOT idempotent.
      // Byte order is a contract — the handlers below are synchronous map
      // lookups + callback fan-out with no awaits before them.
      case "exec.pty.data": {
        if (!Value.Check(ExecPtyDataParamsSchema, params)) throw errOf("bad_request", "invalid exec.pty.data params");
        if (this.deps.executor === undefined) throw errOf("internal", "executor plane not wired");
        const ok = this.deps.executor.driver.handlePtyData(params as ExecPtyDataParams);
        if (!ok) throw errOf("not_found", `unknown pty: ${(params as ExecPtyDataParams).ptyId}`);
        return {};
      }
      case "exec.pty.exit": {
        if (!Value.Check(ExecPtyExitParamsSchema, params)) throw errOf("bad_request", "invalid exec.pty.exit params");
        if (this.deps.executor === undefined) throw errOf("internal", "executor plane not wired");
        this.deps.executor.driver.handlePtyExit(params as ExecPtyExitParams);
        return {};
      }
      default:
        throw errOf("bad_request", `unknown method: ${method}`);
    }
  }

  private chatSend(conn: HConn, p: ChatSendParams, _idem: string): { runId: string; conversationId: string } {
    const conv = this.assertConversation(conn.userId, p.chatId);

    // P5 limits: rate + concurrency BEFORE any persistence (a rejected send
    // leaves no user message behind, so retries are clean).
    const limits = this.deps.limits;
    if (limits !== undefined && !limits.chat.take(conn.userId)) {
      this.deps.audit?.record({ userId: conn.userId, action: "chat.send", outcome: "denied", meta: { reason: "rate", chatId: p.chatId } });
      throw errOf("capacity", "chat rate limit exceeded");
    }
    if (limits !== undefined && !limits.runs.tryAcquire(conn.userId)) {
      this.deps.audit?.record({ userId: conn.userId, action: "chat.send", outcome: "denied", meta: { reason: "concurrency", chatId: p.chatId } });
      throw errOf("capacity", "concurrent run limit reached");
    }

    // Server-authoritative context: persist the user turn, then load history
    // from the DB — the client sends one message, the server builds the rest.
    const userMessage: Message = { role: "user", content: p.content };
    this.deps.chat.appendMessage(p.chatId, userMessage);

    const model = p.model ?? conv.model;
    if (model === undefined || model.length === 0) {
      throw errOf("bad_request", "no model: pass model or create the chat with one");
    }

    const agentRun = p.agent?.enabled === true;
    if (agentRun && this.deps.agents === undefined) {
      throw errOf("bad_request", "agent runtime unavailable");
    }

    // ADR-015: local execution requires a connected executor with Docker.
    // Fast-fail here (in the send res) instead of failing slowly mid-run.
    const location = p.agent?.location;
    if (agentRun && location === "local") {
      const executor = this.deps.executor;
      const info = executor?.registry.info(conn.userId);
      if (!executor?.registry.isOnline(conn.userId) || info === undefined) {
        throw errOf("bad_request", "local execution requested but no local executor is connected — start the desktop app");
      }
      if (info.dockerAvailable !== true) {
        throw errOf("bad_request", "the local executor has no Docker daemon — start Docker Desktop on that machine");
      }
      this.deps.chat.setConversationBinding(p.chatId, { location: "local" });
    } else if (agentRun) {
      // Plain cloud run: a chat previously local-flipped is re-bound back to
      // the shared primary env (meta drops envId on "cloud").
      if (this.deps.chat.getConversationBinding(p.chatId)?.location === "local") {
        this.deps.chat.setConversationBinding(p.chatId, { location: "cloud" });
      }
    }

    const controller = new AbortController();
    const runId = this.deps.chat.createRun({
      userId: conn.userId,
      conversationId: p.chatId,
      model,
      trigger: "chat",
      ...(agentRun ? { agent: true } : {}),
    });
    this.inFlight.set(runId, controller);
    const emit: (event: string, channel: string, payload: unknown) => void = (event, channel, payload) =>
      this.publish(event, channel, payload);

    const finish = (): void => {
      this.inFlight.delete(runId);
    };

    if (agentRun) {
      // Agent run: respond {runId} now; the loop streams run.* timeline events
      // and appends assistant/tool messages server-side (chat.final on done).
      const agents = this.deps.agents;
      if (agents === undefined) throw errOf("bad_request", "agent runtime unavailable");
      const toolPolicy =
        p.agent?.toolPolicy !== undefined && typeof p.agent.toolPolicy === "object" && !Array.isArray(p.agent.toolPolicy)
          ? (p.agent.toolPolicy as Record<string, unknown>)
          : undefined;
      void agents
        .startRun({
          runId,
          userId: conn.userId,
          wireModel: model,
          conversationId: p.chatId,
          emit,
          signal: controller.signal,
          ...(toolPolicy !== undefined ? { toolPolicy } : {}),
          ...(location === "local" ? { location: "local" } : {}),
        })
        .then(finish, finish);
      return { runId, conversationId: p.chatId };
    }

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
        emit,
        signal: controller.signal,
      })
      .then(finish, finish);
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

  /**
   * P5 multi-user audit: every run.* request resolves its run THROUGH this —
   * unknown and foreign runs are indistinguishable (404 either way).
   * Returns nothing; getRun callers re-resolve.
   */
  private assertRunOwner(userId: string, runId: string): void {
    const row = this.deps.dbx.db
      .select({ userId: runs.userId })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (row === undefined || row.userId !== userId) {
      throw errOf("not_found", `unknown run: ${runId}`);
    }
  }

  private activeRunIds(): string[] {
    // waiting_approval counts as active: a parked run needs its gate resolved.
    return this.deps.dbx.db
      .select({ id: runs.id })
      .from(runs)
      .where(or(eq(runs.status, "running"), eq(runs.status, "waiting_approval")))
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
  if (err instanceof SandboxError) {
    const code: ProtocolError["code"] = err.status === 404 ? "not_found" : err.status === 400 ? "bad_request" : err.status === 401 ? "unauthorized" : "internal";
    return { code, message: err.message };
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