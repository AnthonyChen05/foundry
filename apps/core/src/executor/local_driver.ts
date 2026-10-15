import type {
  ExecEnvCreateParams,
  ExecEnvStatusResult,
  ExecExecParams,
  ExecExecResult,
  ExecFilesReadResult,
  ExecFilesWriteParams,
  ExecFilesPathParams,
  ExecOpenPtyParams,
  ExecOpenPtyResult,
  ExecPtyDataParams,
  ExecPtyExitParams,
  ExecutorInfo,
} from "@foundry/protocol";
import {
  DEFAULT_CAPS,
  SandboxError,
  type CreateEnvOpts,
  type EnvHandle,
  type ExecResult,
  type FileApi,
  type FileStat,
  type PtyHandle,
  type SandboxDriver,
  quoteArg,
} from "../sandbox/types.js";
import type { ExitReason } from "./registry.js";

/**
 * LocalExecutorDriver (ADR-015): a SandboxDriver that delegates EVERYTHING to
 * the desktop's runner over the executor bridge. Agent tools, TermService and
 * FilesService consume it exactly like the OpenTerminalDriver — they never
 * know the container lives on the user's machine. Lifecycle nuances:
 *  - env ids are minted core-side (the DB row id IS the driver envId, the
 *    same invariant as the cloud path) and the owning user comes in via
 *    CreateEnvOpts.userId (the row may not exist yet at create time);
 *  - `status` reports "dead" while the executor is offline (never throws) so
 *    re-materialization paths degrade cleanly;
 *  - PTY fan-out from the runner (exec.pty.data/exit) is SYNCHRONOUS — the
 *    hub routes those frames into these handlers with no awaits before the
 *    callbacks, preserving byte order (a stated invariant, tested);
 *  - run cancellation: callers pass `signal`; on abort we fire
 *    `exec.exec.cancel {ref}` to the runner and reject with an
 *    AbortError-shaped error that executeToolCall maps to "tool cancelled".
 */

/** Wire chunking: well under WS frame limits and JSON overhead. */
const FILE_WRITE_CHUNK = 768 * 1024;
const FILE_READ_CAP = 8 * 1024 * 1024;
/** Container launch + OT readiness can take up to 120 s on the runner side. */
const ENV_CREATE_TIMEOUT_MS = 150_000;
const EXEC_TIMEOUT_MS = 30_000;
const FILE_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 5_000;

/** The registry surface this driver needs (narrowed for tests/loopback reuse). */
export interface DriverRegistry {
  call(userId: string, method: string, params: unknown, timeoutMs: number, onSent?: (reqId: string) => void): Promise<unknown>;
  isOnline(userId: string): boolean;
  info(userId: string): ExecutorInfo | undefined;
  /** Assigned BY the driver: fire PTY exits when an executor connection died. */
  onConnGone?: (userId: string, info: ExecutorInfo, reason: ExitReason) => void;
}

class ExecAbort extends SandboxError {
  constructor() {
    super("local exec cancelled", 499);
    this.name = "AbortError";
  }
}

class ProxyPty implements PtyHandle {
  private dataCbs: ((chunk: Buffer) => void)[] = [];
  private exitCbs: ((code: number | null) => void)[] = [];

  constructor(
    readonly ptyId: string,
    private readonly envId: string,
    private readonly send: (method: string, params: unknown, timeoutMs?: number) => Promise<void>,
  ) {}

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }

  write(chunk: Buffer): void {
    void this.send("exec.pty.write", { ptyId: this.ptyId, data: chunk.toString("base64") }).catch(() => undefined);
  }

  resize(cols: number, rows: number): void {
    void this.send("exec.pty.resize", { ptyId: this.ptyId, cols, rows }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.send("exec.pty.close", { ptyId: this.ptyId }).catch(() => undefined);
    this.finish(null);
  }

  /** Sync fan-out from the hub's pump handler (byte order is a contract). */
  data(chunk: Buffer): void {
    for (const cb of this.dataCbs) cb(chunk);
  }

  /** Resolves exactly once (executor exit or explicit close). */
  exit(code: number | null): void {
    this.finish(code);
  }

  private finish(code: number | null): void {
    if (this.exitCbs.length === 0) return;
    const cbs = this.exitCbs;
    this.exitCbs = [];
    this.dataCbs = [];
    for (const cb of cbs) cb(code);
  }
}

export class LocalExecutorDriver implements SandboxDriver {
  readonly name = "executor" as const;
  private readonly ptyOf = new Map<string, ProxyPty>();
  private readonly envOfPty = new Map<string, string>();

  constructor(
    private readonly deps: {
      registry: DriverRegistry;
      /** env row → owning user (injected; the row exists for post-create calls). */
      userFor: (envId: string) => string | undefined;
      log?: (obj: object, msg?: string) => void;
    },
  ) {
    deps.registry.onConnGone = (userId, _info, _reason) => {
      for (const [ptyId, pty] of [...this.ptyOf]) {
        if (this.deps.userFor(this.envOfPty.get(ptyId) ?? "") === userId) {
          this.ptyOf.delete(ptyId);
          this.envOfPty.delete(ptyId);
          pty.exit(1);
        }
      }
    };
  }

  // -- SandboxDriver ----------------------------------------------------------

  async create(opts: CreateEnvOpts): Promise<EnvHandle> {
    const envId = opts.envId ?? `env_${Date.now().toString(36)}${Math.abs(Math.random() * 0xffffffff)  .toString(36)}`;
    const userId = opts.userId ?? this.deps.userFor(envId);
    if (userId === undefined) throw new SandboxError("local env has no owning user", 500);
    const params: ExecEnvCreateParams = {
      envId,
      ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
      caps: { ...DEFAULT_CAPS, ...(opts.caps ?? {}) },
      ...(opts.image !== undefined ? { image: opts.image } : {}),
    };
    const res = (await this.deps.registry.call(userId, "exec.env.create", params, ENV_CREATE_TIMEOUT_MS)) as {
      containerRef?: string;
      workspaceDir?: string;
    };
    if (typeof res !== "object" || res === null || typeof res.workspaceDir !== "string" || res.workspaceDir === "") {
      throw new SandboxError("local executor did not report a workspace dir", 502);
    }
    return {
      envId,
      driver: this,
      ...(res.containerRef !== undefined ? { containerRef: res.containerRef } : {}),
      workspaceDir: res.workspaceDir,
      // Local containers never call an LLM — NO egress env at all (guardrail #2;
      // and OT refuses to start under ipset allowlist on Docker Desktop).
      env: {},
    };
  }

  async exec(envId: string, cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    // The wire carries only command strings; quoting mirrors OpenTerminalDriver.
    return this.execShell(envId, cmd.map(quoteArg).join(" "), opts);
  }

  async execShell(
    envId: string,
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const userId = this.deps.userFor(envId);
    if (userId === undefined) throw new SandboxError("unknown env", 404);

    const params: Partial<ExecExecParams> & { envId: string; command: string } = {
      envId,
      command,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.env !== undefined ? { env: opts.env } : {}),
      timeoutMs,
    };
    let ref: string | undefined;
    const work = this.deps.registry
      .call(userId, "exec.exec", params, timeoutMs + 15_000, (id) => { ref = id; })
      .then((res) => {
        const r = res as ExecExecResult;
        if (
          typeof r !== "object" || r === null ||
          typeof r.stdout !== "string" || typeof r.stderr !== "string" || typeof r.timedOut !== "boolean"
        ) {
          throw new SandboxError("local executor: malformed exec reply", 502);
        }
        return r;
      });
    if (opts?.signal === undefined) return work;
    if (opts.signal.aborted) throw new ExecAbort();
    return Promise.race([
      work,
      new Promise<ExecExecResult>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          if (ref !== undefined) {
            void this.deps.registry
              .call(userId, "exec.exec.cancel", { ref }, CANCEL_TIMEOUT_MS)
              .catch(() => undefined);
          }
          reject(new ExecAbort());
        }, { once: true });
      }),
    ]);
  }

  async openPty(envId: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<PtyHandle> {
    const userId = this.deps.userFor(envId);
    if (userId === undefined) throw new SandboxError("unknown env", 404);
    const params: ExecOpenPtyParams = {
      envId,
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts?.rows !== undefined ? { rows: opts.rows } : {}),
    };
    const res = (await this.deps.registry.call(userId, "exec.openPty", params, EXEC_TIMEOUT_MS)) as ExecOpenPtyResult;
    const pty = new ProxyPty(
      res.ptyId,
      envId,
      (method, p, t) =>
        this.deps.registry
          .call(this.deps.userFor(envId) ?? userId, method, p, t ?? EXEC_TIMEOUT_MS)
          .then(() => undefined),
    );
    this.ptyOf.set(res.ptyId, pty);
    this.envOfPty.set(res.ptyId, envId);
    return pty;
  }

  async destroy(envId: string): Promise<void> {
    const userId = this.deps.userFor(envId);
    if (userId === undefined || !this.deps.registry.isOnline(userId)) return; // offline: row death only
    await this.deps.registry.call(userId, "exec.env.destroy", { envId }, EXEC_TIMEOUT_MS).catch(() => undefined);
  }

  /** Never throws — callers degrade cleanly; offline = "dead". */
  async status(envId: string): Promise<"ready" | "dead"> {
    const userId = this.deps.userFor(envId);
    if (userId === undefined || !this.deps.registry.isOnline(userId)) return "dead";
    try {
      const res = (await this.deps.registry.call(userId, "exec.env.status", { envId }, EXEC_TIMEOUT_MS)) as ExecEnvStatusResult;
      return res.status === "ready" ? "ready" : "dead";
    } catch {
      return "dead";
    }
  }

  // -- files ------------------------------------------------------------------

  readonly files: FileApi = {
    list: (envId, dir) => this.filesCall<FileStat[]>("exec.files.list", { envId, dir }),
    read: async (envId, path) => {
      const res = (await this.filesCall<ExecFilesReadResult>("exec.files.read", { envId, path })) as ExecFilesReadResult;
      const content = Buffer.from(res.b64, "base64");
      if (content.length > FILE_READ_CAP) {
        throw new SandboxError("file too large over the executor bridge (8 MB cap)", 413);
      }
      return { content, isText: res.isText === true };
    },
    write: async (envId, path, data) => {
      const b64 = data.toString("base64");
      if (b64.length <= FILE_WRITE_CHUNK) {
        const p: ExecFilesWriteParams = { envId, path, b64 };
        return this.filesCall<FileStat>("exec.files.write", p);
      }
      // Chunked writes: first call truncates, continuations append (runner-side).
      let off = 0;
      for (;;) {
        const slice = b64.slice(off, off + FILE_WRITE_CHUNK);
        const p: ExecFilesWriteParams = {
          envId,
          path,
          b64: slice,
          ...(off > 0 ? { append: true } : {}),
        };
        const stat = (await this.filesCall<FileStat>("exec.files.write", p, 60_000)) as FileStat;
        off += FILE_WRITE_CHUNK;
        if (off >= b64.length) return stat;
      }
    },
    mkdir: async (envId, path, recursive) => {
      const p: ExecFilesPathParams = { envId, path, ...(recursive !== undefined ? { recursive } : {}) };
      await this.filesCall<void>("exec.files.mkdir", p);
    },
    rm: async (envId, path, recursive) => {
      const p: ExecFilesPathParams = { envId, path, ...(recursive !== undefined ? { recursive } : {}) };
      await this.filesCall<void>("exec.files.rm", p);
    },
    stat: (envId, path) => this.filesCall<FileStat>("exec.files.stat", { envId, path }),
  };

  // -- hub-facing pump (client → server) --------------------------------------

  /** exec.pty.data — SYNC: no awaits before fan-out; returns ok=false when the
   * ptyId is stale (post-reconnect race) so the runner stops its pump. */
  handlePtyData(params: ExecPtyDataParams): boolean {
    let chunk: Buffer;
    try {
      chunk = Buffer.from(params.data, "base64");
    } catch {
      return false;
    }
    const pty = this.ptyOf.get(params.ptyId);
    if (pty === undefined) return false;
    pty.data(chunk);
    return true;
  }

  /** exec.pty.exit — clears the pty; result tells the runner whether it existed. */
  handlePtyExit(params: ExecPtyExitParams): boolean {
    const pty = this.ptyOf.get(params.ptyId);
    if (pty === undefined) return false;
    this.ptyOf.delete(params.ptyId);
    this.envOfPty.delete(params.ptyId);
    pty.exit(params.code);
    return true;
  }

  // -- internals ---------------------------------------------------------------

  private async filesCall<R>(method: string, params: unknown, timeoutMs = FILE_TIMEOUT_MS): Promise<R> {
    const envId = (params as { envId?: string }).envId ?? "";
    const userId = this.deps.userFor(envId);
    if (userId === undefined) throw new SandboxError("unknown env", 404);
    return (await this.deps.registry.call(userId, method, params, timeoutMs)) as R;
  }
}