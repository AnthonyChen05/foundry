import { randomBytes } from "node:crypto";
import type { SandboxService } from "../sandbox/service.js";
import type { EnvHandle, PtyHandle } from "../sandbox/types.js";
import { SandboxError } from "../sandbox/types.js";

/**
 * Terminal service (protocol.md §4): one live session per env — `term.open`
 * on the same env returns the SAME termId + scrollback replay (reconnect
 * semantics). PTY bytes flow as `term.data` events with `b64:true`
 * (binary-safe; ANSI survives). Scrollback is a 2000-line ring rebuilt from
 * the byte chunks (decoded lossy — the client's terminal is authoritative;
 * replay is a courtesy).
 */

const SCROLLBACK_LINES = 2000;

export interface TermSession {
  termId: string;
  /** Owning user (single-user v0, but checked on every access). */
  userId: string;
  envId: string;
  pty: PtyHandle;
  /** Decoded scrollback ring (newest last, partial line not included). */
  lines: string[];
  /** Accumulator for a line split across chunks. */
  pending: string;
  closed: boolean;
}

interface TermDeps {
  sandbox: SandboxService;
  emit: (event: string, channel: string, payload: unknown) => void;
  log?: (obj: object, msg: string) => void;
}

export class TermService {
  private readonly byEnv = new Map<string, TermSession>();
  private readonly byTerm = new Map<string, TermSession>();

  constructor(private readonly deps: TermDeps) {}

  /**
   * Resolve the target env: explicit envId must exist AND belong to the
   * caller (multi-user audit, P5) — otherwise the user's default env.
   */
  private async envFor(userId: string, envId?: string): Promise<EnvHandle> {
    if (envId === undefined) return this.deps.sandbox.ensureEnv(userId);
    const owner = this.deps.sandbox.envOwner(envId);
    if (owner === undefined || owner !== userId) {
      throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
    }
    return this.deps.sandbox.getEnvMust(envId);
  }

  async open(userId: string, envId?: string): Promise<{ termId: string; envId: string; replay: string }> {
    const env = await this.envFor(userId, envId);
    const existing = this.byEnv.get(env.envId);
    if (existing !== undefined && !existing.closed) {
      return { termId: existing.termId, envId: env.envId, replay: existing.lines.join("\n") };
    }

    const termId = `term_${randomBytes(8).toString("hex")}`;
    const pty = await env.driver.openPty(env.envId, { cwd: "." });
    this.deps.sandbox.markActive(env.envId);

    const session: TermSession = { termId, userId, envId: env.envId, pty, lines: [], pending: "", closed: false };
    this.byEnv.set(env.envId, session);
    this.byTerm.set(termId, session);

    pty.onData((chunk) => {
      if (session.closed) return;
      // Broadcast first (b64 — binary-safe), record scrollback second.
      this.deps.emit("term.data", `term:${termId}`, { data: chunk.toString("base64"), b64: true });
      session.pending += chunk.toString("utf8");
      const parts = session.pending.split("\n");
      session.pending = parts.pop() ?? "";
      if (parts.length > 0) {
        session.lines.push(...parts);
        if (session.lines.length > SCROLLBACK_LINES) {
          session.lines.splice(0, session.lines.length - SCROLLBACK_LINES);
        }
      }
    });
    pty.onExit((code) => {
      if (session.closed) return;
      session.closed = true;
      const chan = `term:${session.termId}`;
      this.deps.emit("term.exit", chan, { code: code ?? null });
      this.byTerm.delete(session.termId);
      if (this.byEnv.get(session.envId)?.termId === session.termId) this.byEnv.delete(session.envId);
    });

    return { termId, envId: env.envId, replay: session.lines.join("\n") };
  }

  /** Look up + authorize a session reference. */
  private get(userId: string, termId: string): TermSession {
    const session = this.byTerm.get(termId);
    if (session === undefined || session.userId !== userId) {
      throw new SandboxError(`no live terminal session: ${termId}`, 404);
    }
    return session;
  }

  input(userId: string, termId: string, data: string, b64?: boolean): void {
    const session = this.get(userId, termId);
    const bytes = b64 === true ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
    try {
      session.pty.write(bytes);
    } catch {
      // exiting PTY — the exit event lands soon
    }
    this.deps.sandbox.markActive(session.envId);
  }

  resize(userId: string, termId: string, cols: number, rows: number): void {
    const session = this.get(userId, termId);
    try {
      session.pty.resize(cols, rows);
    } catch {
      // exiting PTY — ignore
    }
  }

  async close(userId: string, termId: string): Promise<void> {
    const session = this.get(userId, termId);
    session.closed = true;
    await session.pty.close().catch(() => {});
    this.byTerm.delete(session.termId);
    if (this.byEnv.get(session.envId)?.termId === session.termId) this.byEnv.delete(session.envId);
    // Explicit close: tell the client the session is gone (the pty's own
    // onExit is suppressed by the closed flag — emit here, exactly once).
    this.deps.emit("term.exit", `term:${termId}`, { code: null });
  }
}