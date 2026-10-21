import { randomBytes } from "node:crypto";
import { SandboxError } from "./types.js";

/**
 * Node ≥22 ships undici's WebSocket as a runtime global, so core needs no
 * `ws`/`undici` dependency. Minimal structural typing for the surface we use.
 */
interface WsMessageEvent {
  data: unknown;
}
interface WsSocket {
  addEventListener(type: string, cb: (ev: WsMessageEvent) => void, opts?: { once?: boolean }): void;
  send(data: string | Uint8Array): void;
  close(): void;
}
const WebSocket: new (url: string) => WsSocket =
  globalThis.WebSocket as unknown as new (url: string) => WsSocket;

/**
 * Thin client over the Open Terminal container's HTTP + WS API (driver #1).
 * Endpoint shapes captured live from the OT OpenAPI spec (/openapi.json) and
 * its source (open_terminal/main.py) — see PR notes. All auth: Bearer
 * <container-scoped API key> on HTTP; first-frame {"type":"auth"} on WS.
 *
 * Notes derived from the probed spec/source:
 * - exec merges stdout+stderr into output entries ({type:"output",data});
 *   `wait` (≤300s) returns when done or after the wait; long commands poll
 *   /execute/{id}/status with `offset` paging.
 * - files/read returns line-text JSON; binary reads fall back to
 *   `exec base64 -w0`, binary writes chunk `base64 -d` through exec.
 * - PTY sessions: POST /api/terminals → id; WS attach (ONE client per OT
 *   session, 4009 otherwise); binary frames = terminal bytes; text
 *   {"type":"resize"} resizes.
 */

export interface OtExecOutput {
  type: string;
  data: string;
}

export interface OtExecStatus {
  id: string;
  command: string;
  status: string;
  exit_code: number | null;
  output: OtExecOutput[];
  truncated: boolean;
  next_offset: number;
}

export interface OtFileEntry {
  name: string;
  type: string;
  size: number;
  modified: number;
  writable: boolean;
}

export interface OtListResult {
  dir: string;
  writable: boolean;
  entries: OtFileEntry[];
}

const BASE64_CHUNK = 48_000; // per-exec command payload cap (shell ARG_MAX is ~2MB; stay safe)
export { BASE64_CHUNK };

export class OtClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async http<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(65_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new SandboxError(`open-terminal ${method} ${pathAndQuery} → ${res.status}: ${text.slice(0, 200)}`, res.status === 404 ? 404 : 502);
    }
    return (await res.json()) as T;
  }

  // -- exec ---------------------------------------------------------------------

  /**
   * Run a shell command until completion or timeout. stdout+stderr merged
   * (OT limitation — documented in the ExecResult contract). An incoming
   * `signal` (executor cancel path, ADR-015) races the timeout and kills the
   * process when it fires.
   */
  async exec(command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<OtExecStatus> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const started = Date.now();
    const waitS = Math.min(Math.max(timeoutMs / 1000, 0), 300);
    const cwd = opts?.cwd;
    const first = await this.http<OtExecStatus>(
      "POST",
      `/execute?wait=${waitS.toFixed(0)}`,
      { command, ...(cwd !== undefined ? { cwd } : {}), ...(opts?.env !== undefined ? { env: opts.env } : {}) },
    );
    // ADR-015 cancel: an external abort kills the OT process and surfaces a
    // 137/truncated result — same shape the timeout path produces.
    const external = opts?.signal;
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      void this.kill(first.id).catch(() => {});
    };
    if (external !== undefined) {
      if (external.aborted) {
        onAbort();
        return {
          id: first.id,
          command: first.command,
          status: "done",
          exit_code: 137,
          truncated: true,
          next_offset: first.next_offset,
          output: [],
        };
      }
      external.addEventListener("abort", onAbort, { once: true });
    }
    let cur = first;
    while (cur.status === "running" && Date.now() - started < timeoutMs && !aborted) {
      const remainS = Math.min(Math.max((timeoutMs - (Date.now() - started)) / 1000, 0), 300);
      await new Promise<void>((r) => setTimeout(r, 200));
      if (aborted) break;
      cur = await this.http<OtExecStatus>(
        "GET",
        `/execute/${encodeURIComponent(cur.id)}/status?wait=${remainS.toFixed(0)}&offset=${cur.next_offset}`,
      );
    }
    if (cur.status === "running" || aborted) {
      await this.kill(cur.id);
      // drain whatever landed before the kill
      const after = await this.http<OtExecStatus>("GET", `/execute/${encodeURIComponent(cur.id)}/status?wait=1&offset=${cur.next_offset}`).catch(() => cur);
      return { ...after, status: "done", exit_code: 137, truncated: true };
    }
    // Proxy hops (a containerized core reaching the sandbox via the host
    // gateway / docker-proxy) can deliver the terminal inline response with
    // the output lines still unflushed. The status endpoint (offset 0)
    // retrieves whatever landed; commands that truly print nothing pay one
    // extra request. Bounded so genuine hangs fail on schedule.
    const collectDeadline = Date.now() + 3000;
    while (cur.output.length === 0 && Date.now() < collectDeadline) {
      await new Promise<void>((r) => setTimeout(r, 250));
      cur = await this.http<OtExecStatus>(
        "GET",
        `/execute/${encodeURIComponent(cur.id)}/status?wait=1&offset=0`,
      ).catch(() => cur);
    }
    return cur;
  }

  private async kill(processId: string): Promise<void> {
    await this.http<unknown>("DELETE", `/execute/${encodeURIComponent(processId)}?force=true`).catch(() => {});
  }

  // -- files ----------------------------------------------------------------------

  async listDir(containerDir: string): Promise<OtListResult> {
    return this.http<OtListResult>("GET", `/files/list?directory=${encodeURIComponent(containerDir)}`);
  }

  async readFile(containerPath: string): Promise<Buffer> {
    try {
      const text = await this.http<{ path: string; total_lines: number; content: string }>(
        "GET",
        `/files/read?path=${encodeURIComponent(containerPath)}`,
      );
      const buf = Buffer.from(text.content, "utf8");
      // Replacement chars ⇒ the bytes weren't valid UTF-8 (binary) → re-read
      // through base64 so binary files survive the wire.
      if (!text.content.includes("�")) return buf;
    } catch {
      // fall through to base64 read
    }
    const b64 = await this.exec(`base64 -w0 ${shellQuote(containerPath)}`, { cwd: "/" });
    return Buffer.from(b64.output.map((o) => o.data).join(""), "base64");
  }

  async writeFile(containerPath: string, data: Buffer): Promise<{ size: number }> {
    if (!data.includes(0)) {
      return this.http<{ path: string; size: number }>("POST", "/files/write", {
        path: containerPath,
        content: data.toString("utf8"),
      });
    }
    // Binary: chunk base64 through the shell (append mode for tail pieces).
    for (let i = 0; i < Math.max(data.length, 1); i += BASE64_CHUNK) {
      const part = data.subarray(i, i + BASE64_CHUNK);
      const op = i === 0 ? ">" : ">>";
      const cmd = `echo ${part.toString("base64")} | tr -d '\\n' | base64 -d ${op} ${shellQuote(containerPath)}`;
      await this.exec(cmd, { cwd: "/" });
    }
    return { size: data.length };
  }

  // -- terminal sessions ------------------------------------------------------------

  async createTerminal(): Promise<{ id: string; created_at: string; pid: number }> {
    return this.http<{ id: string; created_at: string; pid: number }>("POST", "/api/terminals");
  }

  async deleteTerminal(sessionId: string): Promise<void> {
    await this.http<unknown>("DELETE", `/api/terminals/${encodeURIComponent(sessionId)}`).catch(() => {});
  }

  /**
   * Attach to a PTY session. First WS message authenticates; subsequent
   * binary frames are terminal bytes; a text {"type":"resize"} resizes.
   */
  async attachTerminal(
    sessionId: string,
    handlers: { onData: (chunk: Buffer) => void; onExit: (code: number | null) => void },
  ): Promise<{ resize: (cols: number, rows: number) => void; write: (chunk: Buffer) => void; close: () => void }> {
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/api/terminals/${sessionId}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("close", () => reject(new SandboxError("open-terminal terminal ws closed before auth", 502)), { once: true });
      ws.addEventListener("error", () => reject(new SandboxError("open-terminal terminal ws error", 502)), { once: true });
    });
    ws.addEventListener("message", async (ev) => {
      const d: unknown = ev.data;
      // Binary frames per runtime: ArrayBuffer (Node 22) or Blob (Node 24+);
      // text frames are auth/control echoes — ignore them all.
      if (typeof d === "string") return;
      let chunk: Buffer;
      if (d instanceof ArrayBuffer) {
        chunk = Buffer.from(new Uint8Array(d));
      } else if (typeof Blob !== "undefined" && d instanceof Blob) {
        chunk = Buffer.from(await d.arrayBuffer());
      } else if (d instanceof Buffer) {
        chunk = d;
      } else {
        return;
      }
      handlers.onData(chunk);
    });
    ws.addEventListener("close", () => handlers.onExit(0));
    ws.addEventListener("error", () => handlers.onExit(1));
    // first-message auth, then the socket is live
    ws.send(JSON.stringify({ type: "auth", token: this.apiKey }));
    return {
      resize: (cols: number, rows: number) => {
        try {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        } catch {
          // socket shutting down
        }
      },
      write: (chunk: Buffer) => {
        try {
          ws.send(new Uint8Array(chunk));
        } catch {
          // socket shutting down
        }
      },
      close: () => {
        try {
          ws.close();
        } catch {
          // already closed
        }
      },
    };
  }

  /** container-scoped API key is generated per env at launch. */
  static newApiKey(): string {
    return `otk_${randomBytes(24).toString("hex")}`;
  }
}

function shellQuote(a: string): string {
  if (/^[A-Za-z0-9_\-./:=@%,+]+$/.test(a)) return a;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

export const OT_MOUNT_ROOT = "/home/user";