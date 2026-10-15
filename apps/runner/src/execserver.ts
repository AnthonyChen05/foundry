import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import type {
  ExecEnvCreateParams,
  ExecEnvIdParams,
  ExecExecParams,
  ExecFilesListParams,
  ExecFilesPathParams,
  ExecFilesReadParams,
  ExecFilesWriteParams,
  ExecOpenPtyParams,
  ExecPtyIdParams,
  ExecPtyResizeParams,
  ExecPtyWriteParams,
  ExecRefParams,
  ExecTarChunkParams,
  ExecTarFreeParams,
  ExecTarStartParams,
} from "@foundry/protocol";
import type { PtyHandle, SandboxDriver } from "@foundry/core/sandbox";
import { SandboxError, quoteArg } from "@foundry/core/sandbox";

/**
 * ExecServer (ADR-015): the runner-side mapping of the server→client executor
 * plane onto a SandboxDriver. Driver-agnostic (production = core's
 * OpenTerminalDriver against the LOCAL Docker engine; tests = FakeDriver) and
 * transport-agnostic (production pipes `send()` into the sdk-ts socket;
 * tests use an in-memory pair).
 *
 * Lifecycle:
 *  - local envs are per-CHAT: create {envId, chatId?} → dir = join(workspaceRoot,
 *    chatId ?? envId). The dir persists across runner restarts so dead envs
 *    re-materialize core-side with their files intact.
 *  - PTY output pumps back as exec.pty.data (fire-and-forget via transport.send;
 *    no retransmit) and exec.pty.exit exactly once; exec.exec.cancel {ref} aborts
 *    the underlying driver exec (OT kills the process → exit 137).
 *  - workspace tar (push-to-cloud): mode "exec" runs in-container
 *    (tar/dd/base64 — production); mode "host" uses the Node tar package on the
 *    workspace dir (tests/smoke with the FakeDriver). Excludes + 512 MB cap,
 *    chunked b64 pull, tar.free releases the temp state.
 */

const TAR_CHUNK_BYTES = 512 * 1024;
const TAR_SIZE_CAP = 512 * 1024 * 1024;
const DEFAULT_TAR_EXCLUDES = ["node_modules", ".venv", "__pycache__"];
const TAR_FILE_NAME = "_foundry_push.tar.gz";

export interface RunnerTransport {
  /** One-way client→server call (PTY data pump). Fire-and-forget. */
  send(method: string, params: unknown): void;
}

/** Path/size/format error the core maps to 4xx; offline shapes map 503. */
export class RunnerRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "RunnerRequestError";
  }
}

export class NotFoundRunnerError extends RunnerRequestError {
  constructor(msg: string) {
    super(msg, 404);
    this.name = "NotFoundError";
  }
}

function dirFor(root: string, envId: string, chatId?: string): string {
  const key = chatId ?? envId;
  // Docker Desktop binds accept forward-slashed Windows paths.
  return join(root, key).replace(/\\/g, "/");
}

export interface ExecServerOpts {
  driver: SandboxDriver;
  workspaceRoot: string;
  transport: RunnerTransport;
  /* Tar source: "exec" (in-container, production) or "host" (Node tar pkg). */
  tarMode?: "exec" | "host";
  log?: (msg: string) => void;
}

export class ExecServer {
  private readonly ptys = new Map<string, { pty: PtyHandle; envId: string; exitSent: boolean }>();
  private readonly execs = new Map<string, AbortController>();
  private readonly tars = new Map<string, { envId: string; hostPath?: string; containerPath?: string; chunks: number }>();
  /** envId → the dir its create reported (tar/append bookkeeping). */
  private readonly envDirs = new Map<string, string>();
  /** Chunked writes accumulate here until the final chunk lands. */
  private readonly pendingWrites = new Map<string, Buffer>();
  private seq = 0;
  /** Requests served (test/smoke assertions on bridge crossing). */
  handled = 0;

  constructor(private readonly opts: ExecServerOpts) {
    mkdirSync(opts.workspaceRoot, { recursive: true });
  }

  /** Entry for the socket's onServerRequest hook: (req.id, method, params). */
  async handle(reqId: string, method: string, params: unknown): Promise<unknown> {
    this.handled += 1;
    switch (method) {
      // -- env lifecycle -----------------------------------------------------
      case "exec.env.create": {
        const c = params as ExecEnvCreateParams;
        const dir = dirFor(this.opts.workspaceRoot, c.envId, c.chatId);
        const handle = await this.opts.driver.create({
          workspaceDir: dir,
          caps: c.caps,
          ...(c.image !== undefined ? { image: c.image } : {}),
          envId: c.envId,
          // Runner-owned containers: the boot sweep reclaims orphans only.
          labels: { "foundry.runner": "1" },
        });
        this.envDirs.set(c.envId, dir);
        this.opts.log?.(`env ${c.envId} created at ${dir}`);
        return { containerRef: handle.containerRef, workspaceDir: handle.workspaceDir };
      }
      case "exec.env.destroy": {
        const e = params as ExecEnvIdParams;
        for (const [ptyId, entry] of [...this.ptys]) {
          if (entry.envId === e.envId) {
            this.ptys.delete(ptyId);
            await entry.pty.close().catch(() => {});
          }
        }
        for (const [key] of [...this.pendingWrites]) {
          if (key.startsWith(`${e.envId}\u0000`)) this.pendingWrites.delete(key);
        }
        this.envDirs.delete(e.envId);
        await this.opts.driver.destroy(e.envId);
        return {};
      }
      case "exec.env.status": {
        const e = params as ExecEnvIdParams;
        return { status: await this.opts.driver.status(e.envId) };
      }
      // -- exec ---------------------------------------------------------------
      case "exec.exec": {
        const x = params as ExecExecParams;
        const ac = new AbortController();
        this.execs.set(reqId, ac);
        try {
          return await this.opts.driver.execShell(x.envId, x.command, {
            ...(x.cwd !== undefined ? { cwd: x.cwd } : {}),
            ...(x.env !== undefined ? { env: x.env } : {}),
            ...(x.timeoutMs !== undefined ? { timeoutMs: x.timeoutMs } : {}),
            signal: ac.signal,
          });
        } finally {
          this.execs.delete(reqId);
        }
      }
      case "exec.exec.cancel": {
        const c = params as ExecRefParams;
        this.execs.get(c.ref)?.abort();
        return {};
      }
      // -- PTY ----------------------------------------------------------------
      case "exec.openPty": {
        const o = params as ExecOpenPtyParams;
        const pty = await this.opts.driver.openPty(o.envId, {
          ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
          ...(o.cols !== undefined ? { cols: o.cols } : {}),
          ...(o.rows !== undefined ? { rows: o.rows } : {}),
        });
        const ptyId = `pty_${Date.now().toString(36)}_${++this.seq}`;
        this.ptys.set(ptyId, { pty, envId: o.envId, exitSent: false });
        pty.onData((chunk: Buffer) => {
          // No retransmit: core replies error on a stale ptyId and the pump
          // entry was already forgotten there.
          this.opts.transport.send("exec.pty.data", { ptyId, data: chunk.toString("base64") });
        });
        pty.onExit((code: number | null) => {
          const entry = this.ptys.get(ptyId);
          if (entry === undefined || entry.exitSent) return;
          entry.exitSent = true;
          this.ptys.delete(ptyId);
          this.opts.transport.send("exec.pty.exit", { ptyId, code });
        });
        return { ptyId };
      }
      case "exec.pty.write": {
        const w = params as ExecPtyWriteParams;
        const entry = this.ptyMust(w.ptyId);
        await entry.pty.write(Buffer.from(w.data, "base64"));
        return {};
      }
      case "exec.pty.resize": {
        const r = params as ExecPtyResizeParams;
        this.ptyMust(r.ptyId).pty.resize(r.cols, r.rows);
        return {};
      }
      case "exec.pty.close": {
        const c = params as ExecPtyIdParams;
        const entry = this.ptys.get(c.ptyId);
        if (entry === undefined) return {}; // already exited
        entry.exitSent = true;
        this.ptys.delete(c.ptyId);
        await entry.pty.close().catch(() => undefined);
        return {};
      }
      // -- files ---------------------------------------------------------------
      case "exec.files.list": {
        const f = params as ExecFilesListParams;
        return this.opts.driver.files.list(f.envId, f.dir);
      }
      case "exec.files.read": {
        const f = params as ExecFilesReadParams;
        const out = await this.opts.driver.files.read(f.envId, f.path);
        return { b64: out.content.toString("base64"), isText: out.isText };
      }
      case "exec.files.write": {
        const w = params as ExecFilesWriteParams;
        // The bridge chunks big writes (b64 + append:true); FileApi.write is
        // full-replace, so chunks accumulate here and the final state is what
        // hits disk each time (intermediate stats satisfy flow control).
        const key = `${w.envId}\u0000${w.path}`;
        const chunk = Buffer.from(w.b64, "base64");
        if (w.append === true) {
          this.pendingWrites.set(key, Buffer.concat([this.pendingWrites.get(key) ?? Buffer.alloc(0), chunk]));
        } else {
          this.pendingWrites.set(key, chunk);
        }
        const stat = await this.opts.driver.files.write(w.envId, w.path, this.pendingWrites.get(key) ?? chunk);
        const statWire = { path: stat.path, size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.isDir };
        return statWire;
      }
      case "exec.files.mkdir": {
        const f = params as ExecFilesPathParams;
        await this.opts.driver.files.mkdir(f.envId, f.path, f.recursive);
        return {};
      }
      case "exec.files.rm": {
        const f = params as ExecFilesPathParams;
        await this.opts.driver.files.rm(f.envId, f.path, f.recursive);
        return {};
      }
      case "exec.files.stat": {
        const f = params as ExecFilesReadParams;
        return this.opts.driver.files.stat(f.envId, f.path);
      }
      // -- workspace tar --------------------------------------------------------
      case "exec.tar.start": {
        const t = params as ExecTarStartParams;
        return this.tarStart(t);
      }
      case "exec.tar.chunk": {
        const t = params as ExecTarChunkParams;
        return this.tarChunk(t);
      }
      case "exec.tar.free": {
        const t = params as ExecTarFreeParams;
        await this.tarFree(t);
        return {};
      }
      default:
        throw new RunnerRequestError(`unknown executor method: ${method}`);
    }
  }

  // -- tar ----------------------------------------------------------------------

  private async tarStart(t: ExecTarStartParams): Promise<{ tarId: string; size: number; chunkSize: number }> {
    const excludes = [...(t.excludes ?? DEFAULT_TAR_EXCLUDES)];
    const tarId = `tar_${Date.now().toString(36)}_${++this.seq}`;
    if (this.opts.tarMode === "host") {
      // Host mode: tar THIS env's dir (not the root) with the Node tar package.
      const base = await import("tar");
      const tmp = join(mkdtempSync(join(tmpdir(), "foundry-tar-")), "ws.tar.gz");
      const dir = this.envDirs.get(t.envId) ?? join(this.opts.workspaceRoot, t.envId);
      await base.create({ file: tmp, gzip: true, portable: true, cwd: dir }, ["."]);
      const size = statSync(tmp).size;
      if (size > TAR_SIZE_CAP) {
        rmSync(tmp, { force: true });
        throw new SandboxError("workspace too large to push (512 MB cap)", 503);
      }
      const chunks = Math.ceil(size / TAR_CHUNK_BYTES);
      this.tars.set(tarId, { envId: t.envId, hostPath: tmp, chunks });
      this.opts.log?.(`tar (host) ${dir} → ${tmp} (${size} bytes, ${chunks} chunks)`);
      return { tarId, size, chunkSize: TAR_CHUNK_BYTES };
    }
    // Exec mode: tar INSIDE the container (POSIX paths, /home/user), exclude
    // dependency dirs (they are reinstalled by the reconcile run, not shipped).
    const excl = excludes.flatMap((e) => [`--exclude=${e}`, `--exclude=./${e}`]).join(" ");
    await this.opts.driver.execShell(t.envId, `tar czf ${TAR_FILE_NAME} ${excl} .`, { timeoutMs: 120_000 });
    const statOut = await this.opts.driver.execShell(t.envId, `stat -c %s ${quoteArg(TAR_FILE_NAME)}`);
    const size = Number.parseInt(statOut.stdout.trim(), 10);
    if (!Number.isFinite(size)) {
      throw new SandboxError("could not determine workspace size for push", 502);
    }
    if (size > TAR_SIZE_CAP) {
      await this.opts.driver.execShell(t.envId, `rm -f ${TAR_FILE_NAME}`);
      throw new SandboxError("workspace too large to push (512 MB cap)", 503);
    }
    const chunks = Math.ceil(size / TAR_CHUNK_BYTES);
    this.tars.set(tarId, { envId: t.envId, containerPath: TAR_FILE_NAME, chunks });
    this.opts.log?.(`tar (exec) env ${t.envId} → ${TAR_FILE_NAME} (${size} bytes, ${chunks} chunks)`);
    return { tarId, size, chunkSize: TAR_CHUNK_BYTES };
  }

  private async tarChunk(t: ExecTarChunkParams): Promise<{ index: number; b64: string }> {
    const tar = this.tars.get(t.tarId);
    if (tar === undefined) throw new NotFoundRunnerError(`unknown tar: ${t.tarId}`);
    if (tar.hostPath !== undefined) {
      // Host mode: direct slice of the tmp file.
      const fh = await open(tar.hostPath, "r");
      try {
        const buf = Buffer.alloc(TAR_CHUNK_BYTES);
        const { bytesRead } = await fh.read(buf, 0, TAR_CHUNK_BYTES, t.index * TAR_CHUNK_BYTES);
        return { index: t.index, b64: buf.subarray(0, bytesRead).toString("base64") };
      } finally {
        await fh.close();
      }
    }
    const envId = tar.envId;
    if (envId === "" || tar.containerPath === undefined) {
      throw new SandboxError("tar state lost its env", 502);
    }
    // Exec mode: dd the byte slice inside the container, base64 in-process.
    const r = await this.opts.driver.execShell(
      envId,
      `dd if=${quoteArg(tar.containerPath)} bs=${TAR_CHUNK_BYTES} skip=${t.index} count=1 2>/dev/null | base64 -w0`,
    );
    return { index: t.index, b64: r.stdout.replace(/\s+/g, "") };
  }

  private async tarFree(t: ExecTarFreeParams): Promise<void> {
    const tar = this.tars.get(t.tarId);
    if (tar === undefined) return;
    this.tars.delete(t.tarId);
    if (tar.hostPath !== undefined) rmSync(tar.hostPath, { force: true });
    else if (tar.containerPath !== undefined) {
      await this.opts.driver.execShell(tar.envId, `rm -f ${quoteArg(tar.containerPath)}`).catch(() => undefined);
    }
  }

  private ptyMust(ptyId: string): { pty: PtyHandle; envId: string; exitSent: boolean } {
    const entry = this.ptys.get(ptyId);
    if (entry === undefined) throw new NotFoundRunnerError(`unknown pty: ${ptyId}`);
    return entry;
  }
}