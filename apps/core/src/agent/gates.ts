import { and, desc, eq } from "drizzle-orm";
import type { GateScope, GateState } from "@foundry/protocol";
import type { FoundryDb } from "../db/open.js";
import { gates as gatesTable, settings } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import type { EmitFn } from "../gateway/chat.js";
import type { ChatService } from "../gateway/chat.js";
import type { NotifyService } from "../gateway/notify.js";
import type { AuditService } from "../audit/audit.js";
import { toIso } from "../gateway/chat.js";
import type { ToolPolicyValue } from "./tools.js";
import { ulid } from "../util/ulid.js";

/**
 * Approval gates (build-order P3 task 1). A tool call whose effective policy
 * is `ask` or an un-approved `session` is PARKED: a gates row (state open) is
 * written, run.gate_request fires on the run channel, the run moves to
 * `waiting_approval`, and the agent loop awaits the resolution — racing the
 * caller's cancel signal and the gate timeout (default 15 min → auto-deny,
 * state `timeout`). `run.approve` (WS) resolves an open gate; scope `session`
 * caches the approval per CONVERSATION (in-memory — "session" means the chat
 * session the operator was actually shown), scope `always` persists per
 * user+tool in settings. The gates table is the truth: on boot-restart a
 * parked run re-enters the loop through the normal resume path and awaitGate
 * re-arms the still-open row (gate_request re-emitted, timeout rescaled to
 * whatever remains of the original window).
 */

/** Resolution sources for one call, in precedence order. */
export interface GatePolicyRequest {
  userId: string;
  chatId: string;
  toolName: string;
  /** Per-run map from chat.send {agent:{toolPolicy}} — entries also via "*". */
  toolPolicy?: Record<string, unknown>;
}

export interface GateRow {
  id: string;
  runId: string;
  tool: string;
  args: unknown;
  policy: string;
  callId: string | null;
  state: GateState;
  resolvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

type WaiterResolution = "approved" | "denied" | "timeout" | "cancelled";

export type GateDecision =
  | { kind: "proceed"; via: "policy" | "approved" | "session" | "always" }
  | { kind: "blocked"; reason: string; state: Exclude<GateState, "open"> }
  | { kind: "cancelled" };

/** run.gate_request payload (protocol §3 Gate shape). */
interface GateRequestWire {
  gateId: string;
  runId: string;
  tool: string;
  args: unknown;
  policy: ToolPolicyValue;
  createdAt: string;
}

export class GateService {
  /** gateId → waiter armed by awaitGate (in-process loop side). */
  private readonly waiters = new Map<string, (r: WaiterResolution) => void>();
  /** `${chatId}:${tool}` — scope=session approvals (conversation lifetime). */
  private readonly sessionCache = new Set<string>();
  private readonly onGateResolvedExternal?: (runId: string) => void;

  constructor(
    private readonly deps: {
      dbx: FoundryDb;
      chat: ChatService;
      config: AppConfig;
      emit: EmitFn;
      notify?: NotifyService;
      /** P5 audit log (optional). */
      audit?: AuditService;
      log?: (obj: object, msg: string) => void;
    },
    opts?: { onGateResolvedExternal?: (runId: string) => void },
  ) {
    this.onGateResolvedExternal = opts?.onGateResolvedExternal;
  }

  // -- policy resolution -------------------------------------------------------

  /**
   * Effective policy for one call. Precedence:
   *   explicit map (tool > "*") — except that `ask`/`session` are BYPASSED by
   *     approval caches (a scope=session/always approval answers the ask);
   *   always-cache (settings, user+tool) → "always";
   *   session-cache (chat+tool) → "always";
   *   default "always" (P2 compatibility — no map entry, no gate).
   */
  resolveEffective(req: GatePolicyRequest): ToolPolicyValue {
    const map = req.toolPolicy;
    const rawValue = map === undefined ? undefined : (map[req.toolName] ?? map["*"]);
    const raw = rawValue === "ask" || rawValue === "session" || rawValue === "always" || rawValue === "deny" ? rawValue : undefined;
    if (raw === "deny" || raw === "always") return raw;
    if (this.cachedAlways(req.userId, req.toolName)) return "always";
    if (this.sessionCache.has(`${req.chatId}:${req.toolName}`)) return "always";
    // No map entry (or junk in the map): default always — an approval cache
    // alone never introduces a gate.
    if (raw === undefined) return "always";
    return raw; // "ask" | "session" — explicit intent to consult the operator
  }

  private alwaysKey(userId: string, tool: string): string {
    return `gate.always:${userId}:${tool}`;
  }

  private cachedAlways(userId: string, tool: string): boolean {
    const row = this.deps.dbx.db
      .select()
      .from(settings)
      .where(eq(settings.key, this.alwaysKey(userId, tool)))
      .get();
    if (row === undefined) return false;
    const v = row.value as { on?: unknown } | null;
    return v?.on === true;
  }

  /** Does this call need a gate at all? */
  needsGate(policy: ToolPolicyValue): boolean {
    return policy === "ask" || policy === "session";
  }

  // -- gate lifecycle ------------------------------------------------------------

  /**
   * Decide + drive the gate lifecycle for one tool call. Call when the
   * effective policy says gate; an existing gates row for (runId, callId)
   * is authoritative — boot-resumed parked calls re-arm instead of re-asking.
   */
  async awaitGate(opts: {
    runId: string;
    userId: string;
    chatId: string;
    callId: string;
    tool: string;
    args: unknown;
    policy: ToolPolicyValue;
    signal: AbortSignal;
  }): Promise<GateDecision> {
    const dbx = this.deps.dbx;
    const chanRun = `run:${opts.runId}`;
    const existing = this.rowFor(opts.runId, opts.callId);
    let gateId: string;
    let createdAt: number;
    if (existing !== undefined) {
      if (existing.state === "approved") return { kind: "proceed", via: "approved" };
      if (existing.state !== "open") {
        return { kind: "blocked", reason: this.blockReason(existing.state), state: existing.state };
      }
      // Boot re-arm on a still-open row: same gate, resumed waiting.
      gateId = existing.id;
      createdAt = existing.createdAt;
      this.deps.log?.({ mod: "agent", runId: opts.runId, gateId }, "re-arming open gate after restart");
    } else {
      gateId = `gate_${ulid()}`;
      createdAt = Date.now();
      dbx.db
        .insert(gatesTable)
        .values({
          id: gateId,
          runId: opts.runId,
          tool: opts.tool,
          args: opts.args,
          policy: opts.policy,
          callId: opts.callId,
          state: "open",
          createdAt,
        })
        .run();
    }

    const wire: GateRequestWire = {
      gateId,
      runId: opts.runId,
      tool: opts.tool,
      args: opts.args,
      policy: opts.policy,
      createdAt: toIso(createdAt),
    };
    this.deps.chat.recordRunEvent(opts.runId, "gate_request", wire);
    this.deps.emit("run.gate_request", chanRun, wire);
    this.deps.notify?.gateOpen(opts.runId, opts.tool); // ntfy (fires again on re-arm — acceptable nudge)

    // Park the run (idempotent if a re-arm already did).
    if (this.deps.chat.getRun(opts.runId)?.status !== "waiting_approval") {
      this.deps.chat.bumpStatus(opts.runId, "waiting_approval");
      this.deps.emit("run.status", chanRun, { runId: opts.runId, status: "waiting_approval" });
    }

    // Timeout is absolute from createdAt (re-arms respect time already waited).
    const remaining = Math.max(createdAt + this.deps.config.gateTimeoutMs - Date.now(), 0);

    const resolution = await new Promise<WaiterResolution>((resolve) => {
      let settled = false;
      const settle = (r: WaiterResolution): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(gateId);
        opts.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = (): void => settle("cancelled");
      const timer = setTimeout(() => settle("timeout"), remaining);
      this.waiters.set(gateId, settle);
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    });

    // Resumed work (approved or denied → loop continues; cancelled → abort).
    if (resolution !== "cancelled") {
      this.deps.chat.bumpStatus(opts.runId, "running");
      this.deps.emit("run.status", chanRun, { runId: opts.runId, status: "running" });
    }

    if (resolution === "cancelled") return { kind: "cancelled" };
    if (resolution === "approved") return { kind: "proceed", via: "approved" };
    const state: Exclude<GateState, "open"> = resolution === "timeout" ? "timeout" : "denied";
    if (resolution === "timeout") {
      // Nobody resolved it — close the row ourselves (acceptance: "timeout →
      // auto-deny recorded") and tell clients why via run.gate_resolved.
      dbx.db
        .update(gatesTable)
        .set({ state: "timeout", resolvedBy: "auto-deny: timeout", resolvedAt: Date.now() })
        .where(and(eq(gatesTable.id, gateId), eq(gatesTable.state, "open")))
        .run();
      this.deps.chat.recordRunEvent(opts.runId, "gate_resolved", {
        gateId,
        runId: opts.runId,
        tool: opts.tool,
        approved: false,
        state,
        scope: "once",
        by: "auto-deny: timeout",
        resolvedAt: toIso(Date.now()),
      });
      this.deps.emit("run.gate_resolved", chanRun, { gateId, approved: false, state });
    }
    return { kind: "blocked", reason: this.blockReason(state), state };
  }

  private blockReason(state: Exclude<GateState, "open">): string {
    return state === "timeout" ? "auto-denied: approval timed out" : "denied by user";
  }

  private rowFor(runId: string, callId: string): GateRow | undefined {
    const row = this.deps.dbx.db
      .select()
      .from(gatesTable)
      .where(and(eq(gatesTable.runId, runId), eq(gatesTable.callId, callId)))
      .orderBy(desc(gatesTable.createdAt))
      .get();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      runId: row.runId,
      tool: row.tool,
      args: row.args,
      policy: row.policy,
      callId: row.callId,
      state: row.state as GateState,
      resolvedBy: row.resolvedBy,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }

  /** Wire shape of a gate row (protocol §3 Gate + lifecycle extras). */
  static toWire(row: GateRow): {
    gateId: string;
    runId: string;
    tool: string;
    args: unknown;
    policy: string;
    state: GateState;
    resolvedBy?: string;
    createdAt: string;
    resolvedAt?: string;
  } {
    return {
      gateId: row.id,
      runId: row.runId,
      tool: row.tool,
      args: row.args,
      policy: row.policy,
      state: row.state,
      ...(row.resolvedBy !== null ? { resolvedBy: row.resolvedBy } : {}),
      createdAt: toIso(row.createdAt),
      ...(row.resolvedAt !== null ? { resolvedAt: toIso(row.resolvedAt) } : {}),
    };
  }

  /**
   * Resolve an open gate (WS run.approve). Returns the final row state.
   * Throws a bad_request protocol error for unknown/not-open gates.
   */
  resolve(opts: { runId: string; gateId: string; approve: boolean; scope?: GateScope; by: string }): GateRow {
    const row = this.deps.dbx.db
      .select()
      .from(gatesTable)
      .where(eq(gatesTable.id, opts.gateId))
      .get();
    if (row === undefined || row.runId !== opts.runId) {
      throw errProtocol("not_found", `unknown gate: ${opts.gateId}`);
    }
    if (row.state !== "open") {
      throw errProtocol("bad_request", `gate ${opts.gateId} is already ${row.state}`);
    }
    const run = this.deps.chat.getRun(opts.runId);
    if (run === undefined) throw errProtocol("not_found", `unknown run: ${opts.runId}`);

    const state: Exclude<GateState, "open"> = opts.approve ? "approved" : "denied";
    this.deps.dbx.db
      .update(gatesTable)
      .set({ state, resolvedBy: opts.by, resolvedAt: Date.now() })
      .where(eq(gatesTable.id, opts.gateId))
      .run();

    this.deps.audit?.record({
      userId: run.userId,
      action: "gate.resolve",
      target: opts.gateId,
      meta: { runId: opts.runId, tool: row.tool, approved: opts.approve, scope: opts.scope ?? "once" },
    });

    if (opts.approve) {
      const chatId = run.conversationId;
      if (chatId !== null) {
        if (opts.scope === "session") {
          this.sessionCache.add(`${chatId}:${row.tool}`);
        } else if (opts.scope === "always") {
          this.deps.dbx.db
            .insert(settings)
            .values({ key: this.alwaysKey(run.userId, row.tool), value: { on: true } })
            .onConflictDoUpdate({ target: settings.key, set: { value: { on: true } } })
            .run();
        }
        this.deps.log?.({ mod: "agent", tool: row.tool, chatId, scope: opts.scope ?? "once" }, "gate approved");
      }
    }

    this.deps.chat.recordRunEvent(opts.runId, "gate_resolved", {
      gateId: opts.gateId,
      runId: opts.runId,
      tool: row.tool,
      approved: opts.approve,
      state,
      scope: opts.scope ?? "once",
      by: opts.by,
      resolvedAt: toIso(Date.now()),
    });
    this.deps.emit("run.gate_resolved", `run:${opts.runId}`, {
      gateId: opts.gateId,
      approved: opts.approve,
      scope: opts.scope ?? "once",
      state,
    });

    const waiter = this.waiters.get(opts.gateId);
    if (waiter !== undefined) {
      waiter(opts.approve ? "approved" : "denied");
    } else if (run.status === "waiting_approval" && this.onGateResolvedExternal !== undefined) {
      // Resolved with no loop parked on it — wake the run.
      this.onGateResolvedExternal(opts.runId);
    }

    const fresh = this.rowFor(opts.runId, row.callId ?? "");
    return fresh !== undefined
      ? { ...fresh, state }
      : {
          id: row.id,
          runId: row.runId,
          tool: row.tool,
          args: row.args,
          policy: row.policy,
          callId: row.callId,
          state,
          resolvedBy: opts.by,
          createdAt: row.createdAt,
          resolvedAt: Date.now(),
        };
  }

  /**
   * Run went terminal: any still-open gates close as denied (resolvedBy
   * records why). No gate_resolved ceremony — the run's terminal status event
   * already explains the outcome to clients.
   */
  closeForRun(runId: string, resolvedBy: string): void {
    const open = this.deps.dbx.db
      .select()
      .from(gatesTable)
      .where(and(eq(gatesTable.runId, runId), eq(gatesTable.state, "open")))
      .all();
    for (const row of open) {
      this.waiters.get(row.id)?.("cancelled");
      this.deps.dbx.db
        .update(gatesTable)
        .set({ state: "denied", resolvedBy, resolvedAt: Date.now() })
        .where(and(eq(gatesTable.id, row.id), eq(gatesTable.state, "open")))
        .run();
    }
  }

  listForRun(runId: string): GateRow[] {
    return this.deps.dbx.db
      .select()
      .from(gatesTable)
      .where(and(eq(gatesTable.runId, runId), eq(gatesTable.state, "open")))
      .all()
      .map((raw) => ({
        id: raw.id,
        runId: raw.runId,
        tool: raw.tool,
        args: raw.args,
        policy: raw.policy,
        callId: raw.callId,
        state: raw.state as GateState,
        resolvedBy: raw.resolvedBy,
        createdAt: raw.createdAt,
        resolvedAt: raw.resolvedAt,
      }));
  }
}

function errProtocol(
  code: "bad_request" | "not_found",
  message: string,
): Error & { protocolError: { code: "bad_request" | "not_found"; message: string } } {
  const e = new Error(message) as Error & { protocolError: { code: "bad_request" | "not_found"; message: string } };
  e.protocolError = { code, message };
  return e;
}