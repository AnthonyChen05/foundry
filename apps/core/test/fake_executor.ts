import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PtyHandle, SandboxDriver } from "../src/sandbox/types.js";

/**
 * FakeExecutor (ADR-015 test harness): stands in for the desktop runner over
 * the real WS handshake — connects, registers (exec.register), and answers
 * every server→client `req` by executing against a plain SandboxDriver. This
 * IS the executor protocol's reference shape; apps/runner's ExecServer is the
 * production implementation of the same mapping.
 *
 * Records every server→client call it sees (`seen`) so tests can prove
 * bridge crossing. exec.tar.* is served by tarring the local workspace dir
 * directly (the runner does it inside the container; the fake workspace is
 * core-host fs).
 */

const TAR_CHUNK = 256 * 1024;

export class FakeExecutor {
  private ws: WebSocket | undefined;
  private pending = new Map<string, { resolve(p: unknown): void; reject(e: unknown): void }>();
  private ptys = new Map<string, PtyHandle>();
  private tars = new Map<string, { chunks: string[] }>();
  private reqSeq = 0;
  private closed = false;
  readonly root = mkdtempSync(join(tmpdir(), "foundry-executor-"));
  /** Every server→client method+params seen (bridge-crossing proof). */
  readonly seen: { method: string; params: unknown }[] = [];
  /** Test hooks: what exec.register reports, and a pre-send transformer. */
  dockerAvailable = true;

  constructor(
    private readonly opts: { port: number; token: string; driver: SandboxDriver; userId?: string },
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/ws`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e instanceof Error ? e : new Error(String(e)));
    });
    ws.onmessage = (m: MessageEvent) => void this.onFrame(String(m.data));
    await this.req("connect", {
      protocol: 0,
      auth: { token: this.opts.token },
      client: { kind: "executor", version: "0.0.0-fake" },
    });
    await this.req("exec.register", {
      name: "test-executor",
      version: "0.0.0-fake",
      dockerAvailable: this.dockerAvailable,
      workspaceRoot: this.root,
    });
  }

  /** Server→client request handler: map to the driver (reference shape). */
  private async handle(method: string, params: unknown): Promise<unknown> {
    const driver = this.opts.driver;
    const p = (params ?? {}) as Record<string, unknown>;
    const envId = typeof p.envId === "string" ? p.envId : "";
    switch (method) {
      case "exec.env.create": {
        mkdirSync(this.root, { recursive: true });
        const handle = await driver.create({
          envId,
          workspaceDir: join(this.root, envId),
          caps: (p.caps as { cpus: number; memMib: number; pids: number }) ?? undefined,
          ...(p.chatId !== undefined ? { chatId: p.chatId as string } : {}),
        });
        return { containerRef: handle.containerRef, workspaceDir: handle.workspaceDir };
      }
      case "exec.env.destroy": {
        await driver.destroy(envId);
        return {};
      }
      case "exec.env.status": {
        return { status: await driver.status(envId) };
      }
      case "exec.exec": {
        return driver.execShell(envId, p.command as string, {
          ...(p.cwd !== undefined ? { cwd: p.cwd as string } : {}),
          ...(p.env !== undefined ? { env: p.env as Record<string, string> } : {}),
          ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs as number } : {}),
        });
      }
      case "exec.exec.cancel": {
        return {}; // FakeDriver execs are unkillable; the ref is recorded
      }
      case "exec.openPty": {
        const pty = await driver.openPty(envId, {
          ...(p.cwd !== undefined ? { cwd: p.cwd as string } : {}),
          ...(p.cols !== undefined ? { cols: p.cols as number } : {}),
          ...(p.rows !== undefined ? { rows: p.rows as number } : {}),
        });
        const ptyId = `pty_${++this.reqSeq}`;
        this.ptys.set(ptyId, pty);
        // Pump driver output BACK to core (client→server reqs, no retransmit).
        pty.onData((chunk) => {
          this.fire("exec.pty.data", { ptyId, data: chunk.toString("base64") });
        });
        pty.onExit((code) => {
          this.ptys.delete(ptyId);
          this.fire("exec.pty.exit", { ptyId, code });
        });
        return { ptyId };
      }
      case "exec.pty.write": {
        const pty = this.ptys.get(p.ptyId as string);
        if (pty === undefined) throw new Error(`unknown pty: ${String(p.ptyId)}`);
        pty.write(Buffer.from(p.data as string, "base64"));
        return {};
      }
      case "exec.pty.resize": {
        return {}; // FakeDriver resize is a no-op
      }
      case "exec.pty.close": {
        await this.ptys.get(p.ptyId as string)?.close();
        this.ptys.delete(p.ptyId as string);
        return {};
      }
      case "exec.files.list": {
        return driver.files.list(envId, p.dir as string);
      }
      case "exec.files.read": {
        const f = await driver.files.read(envId, p.path as string);
        return { b64: f.content.toString("base64"), isText: f.isText };
      }
      case "exec.files.write": {
        const data = Buffer.from(p.b64 as string, "base64");
        const stat = await driver.files.write(envId, p.path as string, data);
        return { path: stat.path, size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.isDir };
      }
      case "exec.files.mkdir": {
        await driver.files.mkdir(envId, p.path as string, p.recursive as boolean | undefined);
        return {};
      }
      case "exec.files.rm": {
        await driver.files.rm(envId, p.path as string, p.recursive as boolean | undefined);
        return {};
      }
      case "exec.files.stat": {
        return driver.files.stat(envId, p.path as string);
      }
      case "exec.tar.start": {
        // Tar the local workspace dir directly (the runner does it INSIDE its
        // container via shell; the fake workspace is core-host fs).
        const { create } = await import("tar");
        const tmp = join(this.root, "workspace.tar.gz");
        rmSync(tmp, { force: true });
        await create({ file: tmp, gzip: true, portable: true, cwd: join(this.root, envId) }, ["."]);
        const buf = readFileSync(tmp);
        rmSync(tmp, { force: true });
        const b64 = buf.toString("base64");
        const chunks: string[] = [];
        for (let i = 0; i < b64.length; i += TAR_CHUNK) chunks.push(b64.slice(i, i + TAR_CHUNK));
        const tarId = `tar_${Date.now().toString(36)}${this.reqSeq++}`;
        this.tars.set(tarId, { chunks });
        return { tarId, size: buf.length, chunkSize: TAR_CHUNK };
      }
      case "exec.tar.chunk": {
        const tar = this.tars.get(p.tarId as string);
        if (tar === undefined) throw new Error(`unknown tar: ${String(p.tarId)}`);
        const idx = p.index as number;
        return { index: idx, b64: tar.chunks[idx] ?? "" };
      }
      case "exec.tar.free": {
        this.tars.delete(p.tarId as string);
        return {};
      }
      default:
        throw new Error(`fake executor: unhandled server request ${method}`);
    }
  }

  private onFrame(raw: string): Promise<void> | void {
    if (this.closed || this.ws === undefined) return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const f = frame as Record<string, unknown>;
    if (f.type === "res") {
      const pending = this.pending.get(f.id as string);
      if (pending === undefined) return;
      this.pending.delete(f.id as string);
      if (f.ok === true) pending.resolve(f.payload);
      else pending.reject(new Error(JSON.stringify(f.error)));
      return;
    }
    if (f.type === "req") {
      const id = f.id as string;
      // Record for bridge-crossing assertions BEFORE handling.
      this.seen.push({ method: f.method as string, params: f.params });
      return this.handle(f.method as string, f.params).then(
        (payload) => this.reply({ type: "res", id, ok: true, payload }),
        (err: unknown) =>
          this.reply({ type: "res", id, ok: false, error: { code: "internal", message: err instanceof Error ? err.message : String(err) } }),
      );
    }
    // events (executor.status / run timeline / term.data…) — ignored here;
    // PTY DATA flows to core via exec.pty.data requests, not the run channel.
    return;
  }

  /** Fire a client→server req to core without tracking the result (PTY pump). */
  private fire(method: string, params: unknown): void {
    if (this.closed || this.ws === undefined || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ type: "req", id: `fep_${++this.reqSeq}`, method, params }));
  }

  private reply(frame: unknown): void {
    if (this.closed || this.ws === undefined || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private req(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const ws = this.ws;
    if (ws === undefined) return Promise.reject(new Error("not connected"));
    const id = `fe_${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`fake executor req timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close(): void {
    this.closed = true;
    for (const p of this.ptys.values()) void p.close();
    this.ptys.clear();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = undefined;
  }
}