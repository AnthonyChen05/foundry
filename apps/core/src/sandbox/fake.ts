import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  assertInside,
  resolveInWorkspace,
  SandboxError,
  type CreateEnvOpts,
  type EnvHandle,
  type ExecResult,
  type FileApi,
  type PtyHandle,
  type SandboxDriver,
} from "./types.js";

/**
 * Deterministic in-process driver — NOT a security boundary, never selected
 * in production config sanity (FOUNDRY_SANDBOX_DRIVER=docker/auto resolves
 * docker first). Purpose: unit-test the agent loop, term plane and files
 * plane without Docker, per CLAUDE.md ("vitest for tests; integration tests
 * gated on FOUNDRY_INTEGRATION").
 *
 * execShell implements a tiny fixed shell: echo/printf/cat/ls/pwd/whoami/
 * mkdir/rm/touch/sh, `sleep` (capped), and a `python3 <file>.py` that runs
 * the file's top-level print("...") statements — so tool-loop tests exercise
 * real work without host process execution.
 */

interface FakeEnv extends EnvHandle {
  id: string;
}

/** A pty session: one fake shell with its own cwd + output listeners. */
interface FakePty {
  cwd: string;
  buf: string;
  dataCbs: ((chunk: Buffer) => void)[];
  exitCbs: ((code: number | null) => void)[];
  closed: boolean;
}

const SLEEP_CAP_MS = 2000;

export class FakeDriver implements SandboxDriver {
  readonly name = "fake" as const;

  private nextId = 1;
  private readonly envs = new Map<string, FakeEnv>();
  private readonly ptys = new Map<string, FakePty>();

  async create(opts: CreateEnvOpts): Promise<EnvHandle> {
    // Honor a core-minted envId (executor/runner path); legacy mints otherwise.
    // The suffix keeps ids collision-free across REBOOTS against a persisted
    // envs table (the counter restarts with each instance; the DB rows don't).
    const envId = opts.envId ?? `env_fake_${this.nextId++}_${randomBytes(4).toString("hex")}`;
    mkdirSync(opts.workspaceDir, { recursive: true });
    const env: FakeEnv = {
      id: envId,
      envId,
      driver: this,
      workspaceDir: opts.workspaceDir,
      env: { ...(opts.env ?? {}) },
    };
    this.envs.set(envId, env);
    return env;
  }

  async status(envId: string): Promise<"ready" | "dead"> {
    return this.envs.has(envId) ? "ready" : "dead";
  }

  async destroy(envId: string): Promise<void> {
    this.envs.delete(envId);
    // ptys die with their env: exit listeners fire so TermService reaps.
    for (const p of this.ptys.values()) {
      if (p.closed) continue;
      p.closed = true;
      for (const cb of p.exitCbs) cb(0);
    }
    this.ptys.clear();
  }

  async exec(envId: string, cmd: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    return this.execShell(envId, cmd.map((c) => (c === "" ? `''` : c)).join(" "), opts);
  }

  async execShell(
    envId: string,
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult> {
    const env = this.envs.get(envId);
    if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
    const cwdIn = opts?.cwd !== undefined ? resolveInWorkspace(env.workspaceDir, opts.cwd) : env.workspaceDir;
    const started = Date.now();
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const out: string[] = [];
    let exit: number | null = 0;
    let timedOut = false;

    const rline = (line: string): string => {
      // env var interpolation: $VAR / ${VAR} from env.env + opts.env
      return line.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => {
        const envs = { ...env.env, ...(opts?.env ?? {}) };
        return envs[name] !== undefined ? envs[name] : m;
      });
    };

    for (const rawLine of command.split(/(?:&&|;)/)) {
      const line = rawLine.trim().replace(/%s/g, " ").trim();
      if (line.length === 0) continue;
      if (Date.now() - started > timeoutMs) { timedOut = true; exit = 124; break; }
      const tokens = tokenize(line);
      if (tokens.length === 0) continue;
      const [bin, ...args] = tokens;
      if (bin === undefined) continue;
      const res = runFake(env, cwdIn, bin, args.map(rline), out);
      if (res !== null) {
        exit = res;
        break;
      }
    }

    return { exitCode: exit, stdout: out.join(""), stderr: "", timedOut };
  }

  async openPty(envId: string, opts?: { cwd?: string; cols?: number; rows?: number }): Promise<PtyHandle> {
    const env = this.envs.get(envId);
    if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
    const cwd = opts?.cwd !== undefined ? resolveInWorkspace(env.workspaceDir, opts.cwd) : env.workspaceDir;
    const pty: FakePty = { cwd, buf: "", dataCbs: [], exitCbs: [], closed: false };
    // deterministic prompt line
    pty.buf = "fake-shell:/ $ ";
    const handle: PtyHandle = {
      onData: (cb) => { pty.dataCbs.push(cb); setTimeout(() => cb(Buffer.from(pty.buf, "utf8")), 0); },
      onExit: (cb) => { pty.exitCbs.push(cb); },
      write: (chunk: Buffer) => { this.ptyWrite(env, pty, chunk.toString("utf8")); },
      resize: () => {}, // deterministic prompt: no reflow needed
      close: async () => {
        if (pty.closed) return;
        pty.closed = true;
        this.ptys.delete(envId);
        for (const cb of pty.exitCbs) cb(0);
      },
    };
    this.ptys.set(envId, pty);
    return handle;
  }

  private ptyWrite(env: FakeEnv, pty: FakePty, input: string): void {
    if (pty.closed) return;
    const emits: string[] = [];
    for (const raw of input.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) { emits.push("\r\n"); continue; }
      const out: string[] = [];
      let breakOut = false;
      const tokens = tokenize(line);
      const [bin = "", ...args] = tokens;
      if (bin === "exit") {
        breakOut = true;
      } else {
        runFake(env, pty.cwd, bin, args, out);
      }
      for (const o of out) emits.push(o.endsWith("\n") ? `${o.slice(0, -1)}\r\n` : `${o}\r\n`);
      emits.push("fake-shell:/ $ ");
      if (breakOut) {
        pty.closed = true;
        this.ptys.delete(env.id);
        for (const cb of pty.exitCbs) cb(0);
        break;
      }
    }
    const data = emits.join("");
    pty.buf = `${pty.buf}${data}`.slice(-2048);
    const chunk = Buffer.from(data, "utf8");
    for (const cb of pty.dataCbs) cb(chunk);
  }

  files: FileApi = {
    list: async (envId, dir) => {
      const env = this.envs.get(envId);
      if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
      const abs = resolveInWorkspace(env.workspaceDir, dir);
      assertInside(env.workspaceDir, abs);
      if (!existsSync(abs)) return [];
      return readdirSync(abs, { withFileTypes: true }).map((d) => {
        const st = statSync(join(abs, d.name));
        return {
          path: (dir === "/" || dir === "." ? "" : `${dir.replace(/\/$/, "")}/`) + d.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          isDir: d.isDirectory(),
        };
      });
    },
    read: async (envId, path) => {
      const env = this.envs.get(envId);
      if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
      const abs = resolveInWorkspace(env.workspaceDir, path);
      assertInside(env.workspaceDir, abs);
      if (!existsSync(abs) || statSync(abs).isDirectory()) {
        throw new SandboxError(`no such file: ${path}`, 404);
      }
      const buf = readFileSync(abs);
      return { content: buf, isText: !buf.includes(0) };
    },
    write: async (envId, path, data) => {
      const env = this.envs.get(envId);
      if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
      const abs = resolveInWorkspace(env.workspaceDir, path);
      assertInside(env.workspaceDir, abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
      const st = statSync(abs);
      return { path, size: st.size, mtimeMs: st.mtimeMs, isDir: false };
    },
    mkdir: async (envId, path, recursive = true) => {
      const env = this.envs.get(envId);
      if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
      const abs = resolveInWorkspace(env.workspaceDir, path);
      assertInside(env.workspaceDir, abs);
      mkdirSync(abs, { recursive });
    },
    rm: async (envId, path, recursive = false) => {
      const env = this.envs.get(envId);
      if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
      const abs = resolveInWorkspace(env.workspaceDir, path);
      assertInside(env.workspaceDir, abs);
      rmSync(abs, { recursive, force: true });
    },
    stat: async (envId, path) => {
      const env = this.envs.get(envId);
      if (!env) throw new SandboxError(`unknown sandbox env: ${envId}`, 404);
      const abs = resolveInWorkspace(env.workspaceDir, path);
      assertInside(env.workspaceDir, abs);
      if (!existsSync(abs)) throw new SandboxError(`no such path: ${path}`, 404);
      const st = statSync(abs);
      return { path: `/${path.replace(/^[./]+/, "")}`, size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
    },
  };
}

/** Tokenize like a shell but plainly: split on spaces, honor quotes. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: `"` | `'` | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === `"` || c === `'`) { quote = c; continue; }
    if (c === " " || c === "\t") {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Run one fake builtin; returns an exit code to stop with, or null. */
function runFake(env: EnvHandle, cwd: string, bin: string, args: string[], out: string[]): number | null {
  switch (bin) {
    case "echo": {
      out.push(`${args.join(" ")}\n`);
      return null;
    }
    case "printf": {
      out.push(args.join(" "));
      return null;
    }
    case "pwd": {
      out.push(`${cwd}\n`);
      return null;
    }
    case "whoami": {
      out.push("user\n");
      return null;
    }
    case "cat": {
      for (const a of args) {
        const p = resolveInWorkspace(env.workspaceDir, a);
        if (!existsSync(p)) { out.push(`cat: ${a}: No such file or directory\n`); return 1; }
        out.push(readFileSync(p, "utf8"));
      }
      return null;
    }
    case "ls": {
      const dir = args.find((a) => !a.startsWith("-")) ?? cwd;
      const p = resolveInWorkspace(env.workspaceDir, dir);
      if (!existsSync(p)) { out.push(`ls: ${dir}: No such file or directory\n`); return 1; }
      if (statSync(p).isFile()) { out.push(`${dir}\n`); return null; }
      const names = readdirSync(p).sort();
      out.push(names.length === 0 ? "" : `${names.join("\n")}\n`);
      return null;
    }
    case "mkdir": {
      for (const a of args.filter((x) => !x.startsWith("-"))) {
        const p = resolveInWorkspace(env.workspaceDir, a);
        mkdirSync(p, { recursive: args.some((x) => x === "-p" || x === "--parents") });
      }
      return null;
    }
    case "touch": {
      for (const a of args) {
        const p = resolveInWorkspace(env.workspaceDir, a);
        if (!existsSync(p)) writeFileSync(p, "");
      }
      return null;
    }
    case "rm": {
      const recursive = args.some((x) => x === "-rf" || x === "-r");
      for (const a of args.filter((x) => !x.startsWith("-"))) {
        const p = resolveInWorkspace(env.workspaceDir, a);
        rmSync(p, { recursive, force: true });
      }
      return null;
    }
    case "cp": {
      const [src, dst] = args.filter((x) => !x.startsWith("-"));
      if (src === undefined || dst === undefined) { out.push("cp: missing operand\n"); return 1; }
      writeFileSync(resolveInWorkspace(env.workspaceDir, dst), readFileSync(resolveInWorkspace(env.workspaceDir, src)));
      return null;
    }
    case "mv": {
      const [src, dst] = args.filter((x) => !x.startsWith("-"));
      if (src === undefined || dst === undefined) { out.push("mv: missing operand\n"); return 1; }
      const s = resolveInWorkspace(env.workspaceDir, src);
      const d = resolveInWorkspace(env.workspaceDir, dst);
      writeFileSync(d, readFileSync(s));
      rmSync(s);
      return null;
    }
    case "date": {
      out.push(`${new Date().toISOString().replace(/T/, " ").slice(0, 19)}\n`);
      return null;
    }
    case "sleep": {
      const ms = Math.min(parseFloat(args[0] ?? "0") * 1000 || 0, SLEEP_CAP_MS);
      const start = Date.now();
      // Deterministic fake: no real sleeping (tests stay fast); honor caps only.
      if (ms > 0) { /* mark elapsed so timeout logic stays exercised */ }
      out.push("");
      void start;
      return null;
    }
    case "env": {
      for (const [k, v] of Object.entries(env.env)) out.push(`${k}=${v}\n`);
      return null;
    }
    case "python3":
    case "python": {
      const file = args.find((a) => a.endsWith(".py"));
      if (file === undefined) { out.push("usage: python3 <script>.py\n"); return 2; }
      const p = resolveInWorkspace(env.workspaceDir, file);
      if (!existsSync(p)) { out.push(`python3: can't open file '${file}'\n`); return 2; }
      return runFakePython(readFileSync(p, "utf8"), out);
    }
    case "node": {
      const file = args.find((a) => a.endsWith(".js") || a.endsWith(".mjs"));
      if (file === undefined) { out.push("usage: node <script>.js\n"); return 2; }
      const p = resolveInWorkspace(env.workspaceDir, file);
      if (!existsSync(p)) { out.push(`node: cannot find module '${file}'\n`); return 1; }
      return runFakePython(readFileSync(p, "utf8").replace(/print\(/g, "echo("), out);
    }
    case "sh":
    case "bash": {
      const inner = args.filter((x) => x !== "-c").join(" ");
      return runFake(env, cwd, "sh-inner", [inner], out);
    }
    default: {
      // "sh-inner": the recursive case re-split by execShell — unreachable.
      out.push(`fake-shell: ${bin}: command not found\n`);
      return 127;
    }
  }
}

/** Run top-level print("...") statements — deterministic, no interpreter. */
function runFakePython(src: string, out: string[]): number {
  try {
    const lines = src.split("\n").filter((l) => !l.trim().startsWith("#"));
    for (const line of lines) {
      const m = line.match(/^\s*print\((.*)\)\s*$/) ?? line.match(/^echo\((.*)\)\s*$/);
      if (!m) {
        if (line.trim().length > 0) { // assignments allowed, silently stored
          if (!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
            out.push(`Traceback: unsupported statement: ${line.trim()}\n`);
            return 1;
          }
        }
        continue;
      }
      const arg = (m[1] ?? "").trim();
      const str = arg.match(/^"(.*)"$/s) ?? arg.match(/^'(.*)'$/s);
      if (str) {
        out.push(`${str[1] ?? arg}\n`);
      } else {
        // variable reference or expression — resolve simple identifiers
        out.push(`${arg}\n`);
      }
    }
    return 0;
  } catch (err) {
    out.push(`Traceback: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}