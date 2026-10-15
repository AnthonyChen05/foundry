import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorInfo } from "@foundry/protocol";
import { LocalExecutorDriver, type DriverRegistry, type ExitReason } from "@foundry/core/executor";
import { FakeDriver } from "@foundry/core/sandbox";
import type { SandboxDriver } from "@foundry/core/sandbox";
import { ExecServer, type RunnerTransport } from "../src/execserver.js";

/**
 * Loopback: LocalExecutorDriver (core side) wired DIRECTLY to ExecServer
 * (runner side) through an in-memory transport pair — the full executor
 * contract without a network. The runner-side driver is a FakeDriver in a
 * temp workspace root; every server→client op must map 1:1.
 */

class LoopbackRegistry implements DriverRegistry {
  onConnGone?: (userId: string, info: ExecutorInfo, reason: ExitReason) => void;
  readonly sent: { method: string; params: unknown }[] = [];
  private n = 0;
  /** Extra latency injected for exec/exec (tests the abort race). */
  delayExecMs = 0;

  constructor(
    private readonly server: ExecServer,
    private readonly online = true,
  ) {}

  call(userId: string, method: string, params: unknown, _timeoutMs: number, onSent?: (id: string) => void): Promise<unknown> {
    if (!this.online) return Promise.reject(new Error("local executor is offline"));
    const id = `x_${++this.n}`;
    onSent?.(id);
    this.sent.push({ method, params });
    const run = async (): Promise<unknown> => {
      if (this.delayExecMs > 0 && method === "exec.exec") {
        await new Promise((r) => setTimeout(r, this.delayExecMs));
      }
      return this.server.handle(id, method, params);
    };
    return run();
  }

  isOnline(): boolean {
    return this.online;
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "foundry-loopback-"));
}

function makePair(workspaceRoot: string, driver: SandboxDriver = new FakeDriver()): { driver: LocalExecutorDriver; server: ExecServer; registry: LoopbackRegistry } {
  let pump: (method: string, params: unknown) => void = () => {};
  const transport: RunnerTransport = { send: (method, params) => pump(method, params) };
  const server = new ExecServer({ driver, workspaceRoot, transport, tarMode: "host" });
  const registry = new LoopbackRegistry(server);
  const coreDriver = new LocalExecutorDriver({
    registry,
    userFor: () => "u_loop",
  });
  pump = (method, params) => {
    if (method === "exec.pty.data") coreDriver.handlePtyData(params as { ptyId: string; data: string });
    else if (method === "exec.pty.exit") coreDriver.handlePtyExit(params as { ptyId: string; code: number | null });
  };
  return { driver: coreDriver, server, registry };
}

describe("runner ⇆ core loopback (ADR-015)", () => {
  it("env create/exec/files roundtrip maps 1:1 and re-materializes over the same dir", async () => {
    const wsRoot = root();
    try {
      const { driver, registry } = makePair(wsRoot);
      const handle = await driver.create({ envId: "env_test1", workspaceDir: "", env: {}, chatId: "ch_1", userId: "u_loop" });
      expect(handle.workspaceDir.startsWith(wsRoot.replace(/\\/g, "/"))).toBe(true);
      expect(handle.workspaceDir).toContain("ch_1");

      const execRes = await driver.execShell("env_test1", "echo loopback-ok");
      expect(execRes.exitCode).toBe(0);
      expect(execRes.stdout.trim()).toBe("loopback-ok");

      await driver.files.write("env_test1", "notes/hello.txt", Buffer.from("local-hello"));
      const read = await driver.files.read("env_test1", "notes/hello.txt");
      expect(read.content.toString("utf8")).toBe("local-hello");
      expect(read.isText).toBe(true);

      const listing = await driver.files.list("env_test1", "");
      expect(listing.map((s: { path: string }) => s.path.replace(/^\//, ""))).toContain("notes");

      // The server→client method coverage (bridge proof).
      const methods = registry.sent.map((s) => s.method);
      expect(methods).toContain("exec.env.create");
      expect(methods).toContain("exec.exec");
      expect(methods).toContain("exec.files.write");
      expect(methods).toContain("exec.files.read");
      expect(methods).toContain("exec.files.list");

      // Status + destroy.
      expect(await driver.status("env_test1")).toBe("ready");
      await driver.destroy("env_test1");
      expect(readdirSync(wsRoot).length).toBeGreaterThanOrEqual(1); // dir persists
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("large file write chunks across the bridge and reassembles", async () => {
    const wsRoot = root();
    try {
      const { driver, registry } = makePair(wsRoot);
      await driver.create({ envId: "env_big", workspaceDir: "", env: {}, userId: "u_loop" });
      const big = Buffer.alloc(2 * 1024 * 1024, 97); // 2 MB of 'a'
      await driver.files.write("env_big", "big.bin", big);
      const read = await driver.files.read("env_big", "big.bin");
      expect(read.content.length).toBe(big.length);
      expect(read.content[0]).toBe(97);
      const chunkCalls = registry.sent.filter((s) => s.method === "exec.files.write").length;
      expect(chunkCalls).toBeGreaterThan(1); // chunked (≤768 KB per frame)
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("PTY: data pumps core-ward; cancel reaches the server as exec.exec.cancel", async () => {
    const wsRoot = root();
    try {
      const { driver, registry } = makePair(wsRoot);
      await driver.create({ envId: "env_pty", workspaceDir: "", env: {}, userId: "u_loop" });
      const pty = await driver.openPty("env_pty");
      const chunks: string[] = [];
      let exited = false;
      pty.onData((c) => chunks.push(c.toString("utf8")));
      pty.onExit(() => { exited = true; });
      pty.write(Buffer.from("echo pty-hello\n"));
      await new Promise((r) => setTimeout(r, 200));
      expect(chunks.join("").includes("pty-hello")).toBe(true);
      await pty.close();
      expect(exited).toBe(true);

      // Cancel: an aborted in-flight exec reaches the server as
      // exec.exec.cancel {ref: <the original req id>}. (The fake's sleep is a
      // no-op, so the loopback injects latency for exec.* — the abort must
      // win the race and the cancel must carry the req id.)
      registry.delayExecMs = 600;
      const ac = new AbortController();
      const work = driver.execShell("env_pty", "sleep 10", { timeoutMs: 5_000, signal: ac.signal });
      await new Promise((r) => setTimeout(r, 80));
      ac.abort();
      await expect(work).rejects.toMatchObject({ name: "AbortError" });
      const cancels = registry.sent.filter((s) => s.method === "exec.exec.cancel");
      expect(cancels.length).toBe(1);
      const refOf = (cancels[0]?.params as { ref?: string }).ref ?? "";
      expect(refOf.startsWith("x_")).toBe(true); // the req id the core sent
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("tar (host mode): start → chunks → free roundtrips a valid archive", async () => {
    const wsRoot = root();
    try {
      const { server } = makePair(wsRoot);
      await server.handle("t1", "exec.env.create", {
        envId: "env_tar",
        chatId: "ch_tar",
        caps: { cpus: 1, memMib: 64, pids: 32 },
      });
      await server.handle("t2", "exec.files.write", {
        envId: "env_tar",
        path: "push/me.txt",
        b64: Buffer.from("pushed").toString("base64"),
      });
      const start = (await server.handle("t3", "exec.tar.start", { envId: "env_tar" })) as { tarId: string; size: number; chunkSize: number };
      expect(start.tarId.startsWith("tar_")).toBe(true);
      expect(start.size).toBeGreaterThan(0);

      // Assemble the chunk stream.
      const pieces: Buffer[] = [];
      for (let i = 0; i < Math.ceil(start.size / start.chunkSize); i++) {
        const chunk = (await server.handle(`c${i}`, "exec.tar.chunk", { tarId: start.tarId, index: i })) as { b64: string };
        pieces.push(Buffer.from(chunk.b64, "base64"));
      }
      const full = Buffer.concat(pieces);
      expect(full.length).toBe(start.size);

      // Extract and find the pushed file — the push path's essential invariant.
      const base = await import("tar");
      const outDir = mkdtempSync(join(tmpdir(), "foundry-extract-"));
      const tmpTar = join(outDir, "ws.tar.gz");
      writeFileSync(tmpTar, full);
      await base.x({ file: tmpTar, cwd: outDir });
      expect(readFileSync(join(outDir, "push", "me.txt"), "utf8")).toBe("pushed");

      // Free: the runner's tar state is gone — further chunk pulls reject.
      await server.handle("t4", "exec.tar.free", { tarId: start.tarId });
      await expect(server.handle("t5", "exec.tar.chunk", { tarId: start.tarId, index: 0 })).rejects.toMatchObject({ name: "NotFoundError" });
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("executor death: registry drop fires pty exits core-side", async () => {
    const wsRoot = root();
    try {
      const { driver, registry } = makePair(wsRoot);
      await driver.create({ envId: "env_drop", workspaceDir: "", env: {}, userId: "u_loop" });
      const pty = await driver.openPty("env_drop");
      let exitCode: number | null | undefined;
      pty.onExit((code) => { exitCode = code; });
      registry.onConnGone?.("u_loop", { online: false, name: "x", version: "1" }, "closed");
      await new Promise((r) => setTimeout(r, 30));
      expect(exitCode).toBe(1);
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});