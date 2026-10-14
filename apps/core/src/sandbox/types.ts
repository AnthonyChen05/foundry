/**
 * Sandbox driver interface (architecture.md §5, ADR-004/010). EVERY exec,
 * file op and PTY for agent/tool traffic goes through this interface —
 * nothing else in core touches containers or process execution (guardrail
 * #1). Drivers: open_terminal (wrapper over the OT container's HTTP/WS API),
 * docker (raw dockerode), fake (deterministic in-process — tests only).
 *
 * All paths in `files` and `exec.cwd` are WORKSPACE-RELATIVE and resolved
 * against a fixed workspace root by the driver/service layer — no env can
 * touch anything outside its workspace dir.
 */

export type DriverName = "open_terminal" | "docker" | "fake";

/** Resource caps (guardrail #3). */
export interface Caps {
  cpus: number;
  memMib: number;
  pids: number;
}

export const DEFAULT_CAPS: Caps = { cpus: 2, memMib: 1024, pids: 256 };

export interface ExecResult {
  exitCode: number | null;
  /** Combined output text (drivers may merge stderr — OT merges streams). */
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface FileStat {
  path: string;
  size: number;
  /** Unix epoch milliseconds. */
  mtimeMs: number;
  isDir: boolean;
}

/**
 * Workspace file API. Paths are workspace-relative ("/"-separated); absolute
 * paths or `..` components are rejected with SandboxPathError before the
 * driver is called.
 */
export interface FileApi {
  list(envId: string, dir: string): Promise<FileStat[]>;
  read(envId: string, path: string): Promise<{ content: Buffer; isText: boolean }>;
  write(envId: string, path: string, data: Buffer): Promise<FileStat>;
  mkdir(envId: string, path: string, recursive?: boolean): Promise<void>;
  rm(envId: string, path: string, recursive?: boolean): Promise<void>;
  stat(envId: string, path: string): Promise<FileStat>;
}

/** An executed sandbox env ("VM" in CLAUDE.md terms). `driver` carries the
 * live driver object itself — consumers (tools, term, files) call THROUGH it
 * (guardrail #1); the DB row stores only the name. */
export interface EnvHandle {
  envId: string;
  driver: SandboxDriver;
  /** Container name/id reference (drivers other than fake). */
  containerRef?: string;
  /** Host-side workspace dir backing this env. */
  workspaceDir: string;
  /** Public env vars injected at create (egress token, base URLs). */
  env: Record<string, string>;
}

export interface CreateEnvOpts {
  workspaceDir: string;
  /** Env vars injected at create (egress token + base URLs — never keys). */
  env?: Record<string, string>;
  caps?: Partial<Caps>;
  image?: string;
}

export interface PtyHandle {
  /** PTY output chunks (raw terminal bytes, ANSI included). */
  onData(cb: (chunk: Buffer) => void): void;
  /** Called exactly once when the shell exits. */
  onExit(cb: (code: number | null) => void): void;
  write(chunk: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}

export class SandboxError extends Error {
  constructor(message: string, readonly status: number = 500) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Path escaped the workspace (or was malformed) — rejected before drivers. */
export class SandboxPathError extends SandboxError {
  constructor(path: string) {
    super(`path escapes the sandbox workspace: ${path}`, 400);
    this.name = "SandboxPathError";
  }
}

/**
 * The one execution surface everything else must go through (guardrail #1).
 * `execShell` takes a full shell command string (chaining/pipes supported);
 * `exec` runs an argv array safely quoted into `execShell`.
 */
export interface SandboxDriver {
  readonly name: DriverName;
  create(opts: CreateEnvOpts): Promise<EnvHandle>;
  exec(envId: string, cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  execShell(
    envId: string,
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult>;
  openPty(envId: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<PtyHandle>;
  files: FileApi;
  destroy(envId: string): Promise<void>;
  status(envId: string): Promise<"ready" | "dead">;
}

// ---------------------------------------------------------------------------
// path safety (shared by all drivers — the workspace jail)
// ---------------------------------------------------------------------------

import { join, relative } from "node:path";

/**
 * Resolve a workspace-relative path to an absolute path inside `root`, or
 * throw SandboxPathError. A leading `/` anchors at the workspace root
 * (client habit); drive letters and any `..` leaving the root are rejected.
 */
export function resolveInWorkspace(root: string, path: string): string {
  let p = path.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(p)) throw new SandboxPathError(path);
  if (p.startsWith("/")) p = p.slice(1);
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) throw new SandboxPathError(path);
      out.pop();
      continue;
    }
    out.push(part);
  }
  return join(root, ...out);
}

/** Defensive post-check (defense in depth after resolveInWorkspace). */
export function assertInside(root: string, abs: string): void {
  const rel = relative(root, abs);
  if (rel.startsWith("..") || /^([a-zA-Z]:)?[\\/]/.test(rel)) {
    throw new SandboxPathError(abs);
  }
}

/** Minimal POSIX single-quote quoting for argv joins. */
export function quoteArg(a: string): string {
  if (/^[A-Za-z0-9_\-./:=@%,+]+$/.test(a)) return a;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}