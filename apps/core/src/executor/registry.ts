import { randomBytes } from "node:crypto";
import type { ExecutorInfo } from "@foundry/protocol";
import { SandboxError } from "../sandbox/types.js";

/**
 * ExecutorRegistry (ADR-015): tracks the desktop runner's WS connection — the
 * ONE live executor per user, latest wins — and carries server→client calls:
 * `call()` sends a `req` frame to the executor socket and resolves with the
 * reply, with a caller-side timeout (no idem, no auto-retry: a re-run could
 * double-execute; read-only callers may retry with fresh ids). When the
 * connection drops/replaces, every pending call rejects and every proxied PTY
 * exits via `onConnGone` (the LocalExecutorDriver owns that wiring).
 */

export interface ExecutorConn {
  userId: string;
  /** Sends a raw frame to the executor's WS (hub-owned closure). */
  send(frame: unknown): void;
}

interface PendingCall {
  resolve(payload: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface ExecutorEntry {
  conn: ExecutorConn;
  info: ExecutorInfo;
  pending: Map<string, PendingCall>;
}

export type ExitReason = "closed" | "replaced" | "dropped";

export class ExecutorRegistry {
  private readonly byUser = new Map<string, ExecutorEntry>();
  private readonly byConn = new Map<ExecutorConn, ExecutorEntry>();
  private seq = 0;
  /** Assigned by runtime wiring: emits `executor.status` on the sys channel. */
  onExecutorStatus?: (info: ExecutorInfo) => void;
  /** Assigned by LocalExecutorDriver: fires PTY onExit for the departing conn. */
  onConnGone?: (userId: string, info: ExecutorInfo, reason: ExitReason) => void;

  register(conn: ExecutorConn, info: ExecutorInfo): { replaced: boolean } {
    const old = this.byUser.get(conn.userId);
    if (old !== undefined) {
      this.dropEntry(old, "replaced");
    }
    const entry: ExecutorEntry = { conn, info, pending: new Map() };
    this.byUser.set(conn.userId, entry);
    this.byConn.set(conn, entry);
    this.announce(conn.userId);
    return { replaced: old !== undefined };
  }

  /** The executor connection died (or was dropped): reject its pendings, exit its PTYs. */
  drop(conn: ExecutorConn, reason: ExitReason): void {
    const entry = this.byConn.get(conn);
    if (entry === undefined) return;
    this.dropEntry(entry, reason);
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  info(userId: string): ExecutorInfo | undefined {
    return this.byUser.get(userId)?.info;
  }

  /**
   * Server→client call. Fresh req id per attempt; rejects with SandboxError
   * (503 offline / 504 timeout). `onSent` hands the caller the request id so
   * abort flows can send a matching cancel (`exec.exec.cancel {ref}`).
   */
  call(
    userId: string,
    method: string,
    params: unknown,
    timeoutMs: number,
    onSent?: (reqId: string) => void,
  ): Promise<unknown> {
    const entry = this.byUser.get(userId);
    if (entry === undefined) {
      return Promise.reject(new SandboxError("local executor is offline", 503));
    }
    const id = `x_${Date.now().toString(36)}${(this.seq++).toString(36)}${randomBytes(3).toString("hex")}`;
    onSent?.(id);
    return new Promise((resolve, reject) => {
      const pending: PendingCall = {
        resolve,
        reject: (err) => {
          clearTimeout(pending.timer);
          reject(err);
        },
        timer: setTimeout(() => {
          entry.pending.delete(id);
          reject(new SandboxError(`local executor call timed out: ${method}`, 504));
        }, timeoutMs),
      };
      pending.timer.unref?.();
      entry.pending.set(id, pending);
      entry.conn.send({ type: "req", id, method, params });
    });
  }

  /** Wire the executor's `res` frame back to a pending call (sync; unknown ids ignored). */
  onRes(userId: string, res: { id: string; ok: boolean; payload?: unknown; error?: { message?: string } }): boolean {
    const entry = this.byUser.get(userId);
    if (entry === undefined) return false;
    const pending = entry.pending.get(res.id);
    if (pending === undefined) return false;
    entry.pending.delete(res.id);
    if (res.ok) pending.resolve(res.payload);
    else pending.reject(new SandboxError(res.error?.message ?? "local executor call failed", 502));
    return true;
  }

  private dropEntry(entry: ExecutorEntry, reason: ExitReason): void {
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SandboxError(`local executor ${reason}`, 503));
    }
    entry.pending.clear();
    if (this.byUser.get(entry.conn.userId) === entry) this.byUser.delete(entry.conn.userId);
    this.byConn.delete(entry.conn);
    this.onConnGone?.(entry.conn.userId, entry.info, reason);
    this.announceOffline(entry.conn.userId, reason);
  }

  private announce(userId: string): void {
    const info = this.byUser.get(userId)?.info;
    if (info === undefined) return;
    this.onExecutorStatus?.({ ...info, online: true });
  }

  private announceOffline(userId: string, reason: ExitReason): void {
    this.onExecutorStatus?.({ online: false, reason });
  }
}