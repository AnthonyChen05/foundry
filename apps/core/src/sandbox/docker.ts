import Dockerode from "dockerode";
import { type Readable } from "node:stream";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "../config.js";
import { OtClient, OT_MOUNT_ROOT, BASE64_CHUNK, type OtExecStatus } from "./ot.js";
import {
  resolveInWorkspace,
  quoteArg,
  SandboxError,
  type FileApi,
  type CreateEnvOpts,
  type EnvHandle,
  type ExecResult,
  type FileStat,
  type PtyHandle,
  type SandboxDriver,
} from "./types.js";

/**
 * Docker-backed sandbox plumbing (ADR-004):
 *  - `DockerLauncher`: dockerode control path — pulls the OT image, creates
 *    the container (resource caps, no docker socket, workspace bind mount,
 *    root→user drop handled by OT's own entrypoint), picks a host port, waits
 *    for the OT API to answer.
 *  - `OpenTerminalDriver` (driver #1): wraps the container's REST/WS API.
 *  - `DockerDriver` (driver #2): raw dockerode exec/tar PTY — tests and
 *    fallback; no OT server assumed.
 *
 * Containers NEVER see real provider keys (guardrails #2/#3): env passed to
 * `create` carries only the scoped egress token + proxy base URL; OT's
 * DNS-whitelist firewall (OPEN_TERMINAL_ALLOWED_DOMAINS) blocks everything
 * else.
 */

const OT_READY_TIMEOUT_MS = 120_000;

export class DockerLauncher {
  /**
   * P5: opt-in alternate OCI runtime for every sandbox container (gVisor's
   * `runsc`; the empty object for the daemon default keeps the request
   * byte-shape stable in tests).
   */
  static runtimeField(runtime: string): { Runtime: string } | Record<string, never> {
    return runtime === "" || runtime === "runc" ? {} : { Runtime: runtime };
  }
  readonly docker: Dockerode;

  constructor(private readonly config: Pick<AppConfig, "sandboxImage" | "sandboxRuntime">) {
    this.docker = new Dockerode();
  }

  async daemonReachable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async pullIfMissing(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // not present locally — pull
    }
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err !== null) reject(err);
        else resolve(stream);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => (err === null ? resolve() : reject(err)));
    });
  }

  /**
   * Launch an OT container for a workspace. Returns the handle + the OT
   * client (reachable at 127.0.0.1:<hostPort>).
   */
  async launchOt(opts: CreateEnvOpts & { apiKey: string }): Promise<Omit<EnvHandle, "driver"> & { ot: OtClient }> {
    const image = opts.image ?? this.config.sandboxImage;
    await this.pullIfMissing(image);
    const caps = { ...{ cpus: 2, memMib: 1024, pids: 256 }, ...(opts.caps ?? {}) };
    const hostPort = await freeTcpPort();
    const workspaceDir = opts.workspaceDir;
    mkdirSync(workspaceDir, { recursive: true });
    // guardrail #3: caps + no docker socket + only the workspace volume.
    const envEntries = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
    envEntries.push(`OPEN_TERMINAL_API_KEY=${opts.apiKey}`);
    const container = await this.docker.createContainer({
      Image: image,
      Cmd: ["run"],
      ExposedPorts: { "8000/tcp": {} },
      Env: envEntries,
      Labels: { "foundry.sandbox": "1", ...(opts.labels ?? {}) },
      HostConfig: {
        PortBindings: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] },
        Binds: [`${workspaceDir}:${OT_MOUNT_ROOT}`],
        Memory: caps.memMib * 1024 * 1024,
        NanoCpus: Math.round(caps.cpus * 1e9),
        PidsLimit: caps.pids,
        CapDrop: ["ALL"],
        // OT's entrypoint runs as `user` and escalates via passwordless sudo
        // for its egress firewall bootstrap; SETUID/SETGID are the minimal
        // caps sudo needs. OT itself drops NET_ADMIN after setup (capsh).
        CapAdd: ["SETUID", "SETGID", "NET_ADMIN"], // then drops NET_ADMIN
        ExtraHosts: ["host.docker.internal:host-gateway"],
        AutoRemove: false,
        ...DockerLauncher.runtimeField(this.config.sandboxRuntime),
      },
    });
    await container.start();
    const ot = new OtClient(`http://127.0.0.1:${hostPort}`, opts.apiKey);
    const deadline = Date.now() + OT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const ok = await ot
        .listDir("/")
        .then(() => true)
        .catch(() => false);
      if (ok) break;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    const probe = await ot.listDir("/").catch(() => undefined);
    if (probe === undefined) {
      await container.remove({ force: true }).catch(() => {});
      throw new SandboxError(`open-terminal container did not become ready (image ${image})`, 502);
    }
    return {
      envId: `docker-${container.id}`,
      containerRef: container.id,
      workspaceDir,
      env: { ...(opts.env ?? {}) },
      ot,
    };
  }
}

async function freeTcpPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new SandboxError("could not pick a host port", 500));
        return;
      }
      srv.close(() => resolve((addr as { port: number }).port));
    });
  });
}

// ---------------------------------------------------------------------------
// Driver #1: Open Terminal
// ---------------------------------------------------------------------------

export class OpenTerminalDriver implements SandboxDriver {
  readonly name = "open_terminal" as const;
  private readonly launcher: DockerLauncher;
  /** envId → live client + container id (in-memory; DB rows are service-level). */
  private readonly live = new Map<string, { ot: OtClient; containerId: string; workspaceDir: string }>();

  constructor(config: Pick<AppConfig, "sandboxImage" | "sandboxRuntime">) {
    this.launcher = new DockerLauncher(config);
  }

  async daemonReachable(): Promise<boolean> {
    return this.launcher.daemonReachable();
  }

  async create(opts: CreateEnvOpts): Promise<EnvHandle> {
    const launched = await this.launcher.launchOt({
      ...opts,
      apiKey: OtClient.newApiKey(),
    });
    // Honor a core-minted envId (executor/runner path): the executor bridge
    // keys all later calls by the id core minted (== DB row id).
    const envId = opts.envId ?? `env_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.live.set(envId, { ot: launched.ot, containerId: launched.containerRef ?? "", workspaceDir: opts.workspaceDir });
    return { envId, driver: this, containerRef: launched.containerRef, workspaceDir: opts.workspaceDir, env: { ...(opts.env ?? {}) } };
  }

  clientFor(envId: string): OtClient {
    const live = this.live.get(envId);
    if (live === undefined) throw new SandboxError(`driver has no live container for env: ${envId}`, 404);
    return live.ot;
  }

  private containerPath(envId: string, workspaceRelative: string | undefined): string {
    const live = this.live.get(envId);
    if (live === undefined) throw new SandboxError(`driver has no live container for env: ${envId}`, 404);
    if (workspaceRelative === undefined) return OT_MOUNT_ROOT;
    return `${OT_MOUNT_ROOT}/${workspaceRelative.replace(/\\/g, "/").replace(/^\//, "")}`;
  }

  async exec(envId: string, cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    return this.execShell(envId, cmd.map(quoteArg).join(" "), opts);
  }

  async execShell(
    envId: string,
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ExecResult> {
    const cwd = opts?.cwd !== undefined ? this.containerPath(envId, opts.cwd) : undefined;
    const status = await this.clientFor(envId).exec(command, {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(opts?.env !== undefined ? { env: opts.env } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      // Executor cancel path (ADR-015): killed via the OT exec API.
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return toExecResult(status);
  }

  async openPty(envId: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<PtyHandle> {
    const ot = this.clientFor(envId);
    const session = await ot.createTerminal();
    let live = true;
    const attach = await ot.attachTerminal(session.id, {
      onData: (chunk) => pty.onDataCbs.forEach((cb) => cb(chunk)),
      onExit: (code) => {
        if (!live) return;
        live = false;
        pty.exitCbs.forEach((cb) => cb(code));
      },
    });
    const cwdContainer = opts?.cwd !== undefined ? this.containerPath(envId, opts.cwd) : OT_MOUNT_ROOT;
    if (cwdContainer !== OT_MOUNT_ROOT) {
      attach.write(Buffer.from(`cd ${shellSafeQuote(cwdContainer)}\r`));
    }
    if (opts?.cols !== undefined && opts?.rows !== undefined) attach.resize(opts.cols, opts.rows);
    const pty: PtyHandle & { onDataCbs: ((b: Buffer) => void)[]; exitCbs: ((c: number | null) => void)[] } = {
      onDataCbs: [],
      exitCbs: [],
      onData: (cb) => pty.onDataCbs.push(cb),
      onExit: (cb) => pty.exitCbs.push(cb),
      write: (chunk: Buffer) => attach.write(chunk),
      resize: (cols: number, rows: number) => attach.resize(cols, rows),
      close: async () => {
        if (!live) return;
        live = false;
        attach.close();
        await ot.deleteTerminal(session.id);
        pty.exitCbs.forEach((cb) => cb(0));
      },
    };
    return pty;
  }

  files: FileApi = {
    list: async (envId, dir) => {
      const ot = this.clientFor(envId);
      const containerDir = this.containerPath(envId, dir);
      const res = await ot.listDir(containerDir);
      const base = normalizeRel(dir);
      return res.entries.map((e) => ({
        path: base.length === 0 ? e.name : `${base}/${e.name}`,
        size: e.size,
        mtimeMs: e.modified * 1000,
        isDir: e.type === "directory", // OT's literal (entry type: file|directory)
      }));
    },
    read: async (envId, path) => {
      const ot = this.clientFor(envId);
      const content = await ot.readFile(this.containerPath(envId, path));
      return { content, isText: !content.includes(0) };
    },
    write: async (envId, path, data) => {
      const ot = this.clientFor(envId);
      const res = await ot.writeFile(this.containerPath(envId, path), data);
      // Docker Desktop's shared-fs writes can lag a beat before in-container
      // execs see them: retry the post-write stat so a fresh write is never
      // reported missing (a REAL missing path still fails after ~1.2 s).
      let stat: FileStat;
      for (let attempt = 0; ; attempt++) {
        try {
          stat = await this.files.stat(envId, path);
          break;
        } catch (err) {
          if (attempt >= 4 || !(err instanceof SandboxError) || err.status !== 404) throw err;
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      }
      void res;
      return stat;
    },
    mkdir: async (envId, path, recursive = true) => {
      const r = recursive ? "-p" : "";
      await this.execShell(envId, `mkdir ${r} ${quoteArg(this.containerPath(envId, path))}`.trim(), { timeoutMs: 10_000 });
    },
    rm: async (envId, path, recursive = false) => {
      const flags = recursive ? "-rf" : "-f";
      await this.execShell(envId, `rm ${flags} ${quoteArg(this.containerPath(envId, path))}`, { timeoutMs: 30_000 });
    },
    stat: async (envId, path) => {
      const containerPath = this.containerPath(envId, path);
      const r = await this.execShell(
        envId,
        `stat -c '%s|%Y|%F' -- ${quoteArg(containerPath)}`,
        { timeoutMs: 10_000 },
      );
      if (r.exitCode !== 0 || r.stdout.trim().length === 0) throw new SandboxError(`no such path: ${path}`, 404);
      const [sizeS, mtimeS, kind] = r.stdout.trim().split("|");
      const isDir = (kind ?? "").toLowerCase().includes("directory");
      return { path: `/${normalizeRel(path)}`, size: Number(sizeS ?? "0"), mtimeMs: Number(mtimeS ?? "0") * 1000, isDir };
    },
  };

  async destroy(envId: string): Promise<void> {
    const live = this.live.get(envId);
    if (live === undefined) return;
    const container = this.launcher.docker.getContainer(live.containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    this.live.delete(envId);
  }

  async status(envId: string): Promise<"ready" | "dead"> {
    const live = this.live.get(envId);
    if (live === undefined) return "dead";
    try {
      const info = await this.launcher.docker.getContainer(live.containerId).inspect();
      return info.State.Running ? "ready" : "dead";
    } catch {
      return "dead";
    }
  }
}

// ---------------------------------------------------------------------------
// Driver #2: raw dockerode (tests + fallback)
// ---------------------------------------------------------------------------

export class DockerDriver implements SandboxDriver {
  readonly name = "docker" as const;
  private readonly launcher: DockerLauncher;
  private readonly config: Pick<AppConfig, "sandboxImage" | "sandboxRuntime">;
  private readonly live = new Map<string, { containerId: string; workspaceDir: string }>();

  constructor(config: Pick<AppConfig, "sandboxImage" | "sandboxRuntime">) {
    this.config = config;
    this.launcher = new DockerLauncher(config);
  }

  async daemonReachable(): Promise<boolean> {
    return this.launcher.daemonReachable();
  }

  async create(opts: CreateEnvOpts): Promise<EnvHandle> {
    // Raw mode reuses the OT image (already pulled in production installs)
    // but NOT its server: plain shell env, caps enforced, root dropped via
    // user: spec (uid 1000 — same uid OT drops to; files stay compatible).
    await this.launcher.pullIfMissing(opts.image ?? this.launcherImage());
    mkdirSync(opts.workspaceDir, { recursive: true });
    const container = await this.launcher.docker.createContainer({
      Image: opts.image ?? this.launcherImage(),
      Cmd: ["sleep", "infinity"],
      Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      User: "1000:1000",
      WorkingDir: OT_MOUNT_ROOT,
      HostConfig: {
        Binds: [`${opts.workspaceDir}:${OT_MOUNT_ROOT}`],
        Memory: 1024 * 1024 * 1024,
        NanoCpus: 2e9,
        PidsLimit: 256,
        CapDrop: ["ALL"],
        ExtraHosts: ["host.docker.internal:host-gateway"],
        ...DockerLauncher.runtimeField(this.config.sandboxRuntime),
      },
    });
    await container.start();
    // Honor a core-minted envId when provided (executor/runner path).
    const envId = opts.envId ?? `env_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.live.set(envId, { containerId: container.id, workspaceDir: opts.workspaceDir });
    return { envId, driver: this, containerRef: container.id, workspaceDir: opts.workspaceDir, env: { ...(opts.env ?? {}) } };
  }

  private launcherImage(): string {
    return this.configFallbackImage();
  }

  private configFallbackImage(): string {
    // Raw mode shares the OT image by default (one pull serves both drivers).
    return "ghcr.io/open-webui/open-terminal:slim";
  }

  private containerFor(envId: string): Dockerode.Container {
    const live = this.live.get(envId);
    if (live === undefined) throw new SandboxError(`driver has no live container for env: ${envId}`, 404);
    return this.launcher.docker.getContainer(live.containerId);
  }

  private cwdAbs(envId: string, cwd: string | undefined): string {
    const live = this.live.get(envId);
    if (live === undefined) throw new SandboxError(`driver has no live container for env: ${envId}`, 404);
    if (cwd === undefined) return OT_MOUNT_ROOT;
    const rel = workspaceRelativeOf(live.workspaceDir, cwd);
    return rel.length === 0 ? OT_MOUNT_ROOT : `${OT_MOUNT_ROOT}/${rel}`;
  }

  async exec(envId: string, cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const timeoutS = Math.max(Math.ceil((opts?.timeoutMs ?? 30_000) / 1000), 1);
    const container = this.containerFor(envId);
    const e = await container.exec({
      Cmd: ["sh", "-c", `timeout ${timeoutS} ${cmd.map(quoteArg).join(" ")}`],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.cwdAbs(envId, opts?.cwd),
    });
    const stream = await e.start({ hijack: true, stdin: false });
    const { stdout, stderr } = await drain(stream);
    const info = await e.inspect();
    return { exitCode: info.ExitCode, stdout, stderr, timedOut: info.ExitCode === 124 };
  }

  async execShell(envId: string, command: string, opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ExecResult> {
    const timeoutS = Math.max(Math.ceil((opts?.timeoutMs ?? 30_000) / 1000), 1);
    const container = this.containerFor(envId);
    const envEntries = Object.entries(opts?.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const e = await container.exec({
      Cmd: ["sh", "-c", `timeout ${timeoutS} sh -c ${quoteArg(command)}`],
      AttachStdout: true,
      AttachStderr: true,
      Env: envEntries,
      WorkingDir: this.cwdAbs(envId, opts?.cwd),
    });
    const stream = await e.start({ hijack: true, stdin: false });
    const { stdout, stderr } = await drain(stream);
    const info = await e.inspect();
    return { exitCode: info.ExitCode, stdout, stderr, timedOut: info.ExitCode === 124 };
  }

  async openPty(envId: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<PtyHandle> {
    const container = this.containerFor(envId);
    const e = await container.exec({
      Cmd: ["script", "-qfc", "sh", "/dev/null"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: this.cwdAbs(envId, opts?.cwd),
    });
    const stream = await e.start({ hijack: true, stdin: true });
    const pty: PtyHandle & { dataCbs: ((b: Buffer) => void)[]; exitCbs: ((c: number | null) => void)[] } = {
      dataCbs: [],
      exitCbs: [],
      onData: (cb) => pty.dataCbs.push(cb),
      onExit: (cb) => pty.exitCbs.push(cb),
      write: (chunk: Buffer) => stream.write(chunk),
      resize: (cols: number, rows: number) => e.resize({ h: cols, w: rows }).catch(() => {}),
      close: async () => {
        stream.end();
        pty.exitCbs.forEach((cb) => cb(0));
      },
    };
    void opts?.cols;
    stream.on("data", (c: Buffer) => pty.dataCbs.forEach((cb) => cb(Buffer.from(c))));
    stream.on("end", () => pty.exitCbs.forEach((cb) => cb(0)));
    const info = await e.inspect();
    void info;
    if (opts?.cols !== undefined && opts?.rows !== undefined) e.resize({ h: opts.cols, w: opts.rows }).catch(() => {});
    return pty;
  }

  files: FileApi = {
    list: async (envId, dir) => {
      const r = await this.execShell(
        envId,
        `find ${quoteArg(this.cwdAbs(envId, dir))} -maxdepth 1 -mindepth 1 -printf '%y|%s|%T@|%f\\n'`,
        { timeoutMs: 15_000 },
      );
      if (r.exitCode !== 0 && r.stdout.trim().length === 0) return [];
      const base = normalizeRel(dir);
      const rows: FileStat[] = [];
      for (const line of r.stdout.trimStart().split("\n")) {
        if (line.trim().length === 0) continue;
        const [ty, size, mtime, name] = line.split("|");
        rows.push({
          path: base.length === 0 ? (name ?? "") : `${base}/${name ?? ""}`,
          size: Number(size) || 0,
          mtimeMs: Math.round(Number(mtime) * 1000),
          isDir: ty === "d",
        });
      }
      return rows;
    },
    read: async (envId, path) => {
      const r = await this.execShell(envId, `base64 -w0 ${quoteArg(this.cwdAbs(envId, path))}`, { timeoutMs: 30_000 });
      if (r.exitCode !== 0) throw new SandboxError(`no such file: ${path}`, 404);
      const content = Buffer.from(r.stdout.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
      return { content, isText: !content.includes(0) };
    },
    write: async (envId, path, data) => {
      // Base64 chunked via exec — mirrors the OT client's binary write path,
      // one code path for text and binary (no tar staging).
      const dest = this.cwdAbs(envId, path);
      await this.execShell(envId, `mkdir -p ${quoteArg(dirname(dest))}`);
      for (let i = 0; i < Math.max(data.length, 1); i += BASE64_CHUNK) {
        const part = data.subarray(i, i + BASE64_CHUNK);
        const op = i === 0 ? ">" : ">>";
        await this.execShell(envId, `echo ${part.toString("base64")} | tr -d '\\n' | base64 -d ${op} ${quoteArg(dest)}`);
      }
      return this.files.stat(envId, path);
    },
    mkdir: async (envId, path, recursive = true) => {
      await this.execShell(envId, `mkdir ${recursive ? "-p" : ""} ${quoteArg(this.cwdAbs(envId, path))}`.trim());
    },
    rm: async (envId, path, recursive = false) => {
      await this.execShell(envId, `rm ${recursive ? "-rf" : "-f"} ${quoteArg(this.cwdAbs(envId, path))}`);
    },
    stat: async (envId, path) => {
      const r = await this.execShell(envId, `stat -c '%s|%Y|%F' -- ${quoteArg(this.cwdAbs(envId, path))}`, { timeoutMs: 10_000 });
      if (r.exitCode !== 0 || r.stdout.trim().length === 0) throw new SandboxError(`no such path: ${path}`, 404);
      const parts = r.stdout.trim().split("|");
      const kind = parts[2] ?? "";
      return {
        path: `/${normalizeRel(path)}`,
        size: Number(parts[0] ?? "0"),
        mtimeMs: Number(parts[1] ?? "0") * 1000,
        isDir: kind.toLowerCase().includes("directory"),
      };
    },
  };

  async destroy(envId: string): Promise<void> {
    const live = this.live.get(envId);
    if (live === undefined) return;
    const container = this.launcher.docker.getContainer(live.containerId);
    await container.stop({ t: 3 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    this.live.delete(envId);
  }

  async status(envId: string): Promise<"ready" | "dead"> {
    const live = this.live.get(envId);
    if (live === undefined) return "dead";
    try {
      const info = await this.launcher.docker.getContainer(live.containerId).inspect();
      return info.State.Running ? "ready" : "dead";
    } catch {
      return "dead";
    }
  }
}

// -- helpers --------------------------------------------------------------------

async function drain(stream: Readable): Promise<{ stdout: string; stderr: string }> {
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    // docker multiplexes stdout/stderr on non-tty execs via the modem; for
    // simple string results we treat everything as stdout unless a separate
    // error stream event exists.
    stream.on("error", (e: Error) => reject(e));
    stream.on("end", () => {
      void errChunks;
      resolve({ stdout: Buffer.concat(chunks).toString("utf8"), stderr: "" });
    });
  });
}

function toExecResult(status: OtExecStatus): ExecResult {
  const text = status.output.map((o) => o.data).join("");
  return {
    exitCode: status.exit_code,
    stdout: text.trimEnd().length > 0 ? text : "",
    stderr: "",
    timedOut: status.status === "timeout",
  };
}

function normalizeRel(dir: string): string {
  const s = dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  // "." and "" both mean the workspace root.
  return s === "." ? "" : s;
}

function workspaceRelativeOf(workspaceRoot: string, p: string): string {
  const rel = resolveInWorkspace(workspaceRoot, p);
  return rel.slice(workspaceRoot.length).replace(/\\/g, "/").replace(/^\/+/, "");
}

function shellSafeQuote(a: string): string {
  return quoteArg(a);
}