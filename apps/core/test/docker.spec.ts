import { describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { FoundryClient } from "@foundry/sdk-ts";
import { DockerLauncher, OtClient } from "@foundry/core/sandbox";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Real Open Terminal sandbox integration (build-order P2 acceptance).
 * Gated on FOUNDRY_INTEGRATION=1 + a running Docker daemon; skips otherwise.
 * Needs the OT image locally / pullable (default: `latest`, which carries a
 * full toolkit incl. python3; override with FOUNDRY_SANDBOX_IMAGE).
 * Docker Desktop kernels lack ipset → OT's DNS-whitelist firewall can't run;
 * run with FOUNDRY_SANDBOX_EGRESS=open there (the egress credential proxy
 * still guards all LLM traffic). On a Linux homelab, allowlist is the default.
 */

const INTEGRATION = process.env.FOUNDRY_INTEGRATION === "1";
const EGRESS_OPEN = process.env.FOUNDRY_SANDBOX_EGRESS === "open";
if (INTEGRATION) {
  // The slim image may lack python3; the driver #1 default for tests with the
  // acceptance scenario is the full `latest` toolkit image unless overridden.
  process.env.FOUNDRY_SANDBOX_IMAGE = process.env.FOUNDRY_SANDBOX_IMAGE ?? "ghcr.io/open-webui/open-terminal:latest";
}

const d = INTEGRATION ? describe : describe.skip;

// helpers.ts tears the server down after EVERY test, so each test boots its
// own server + container (OT container creation is ~5-20 s on first exec).

d("Open Terminal sandbox (real container)", () => {
  const boot = async (): Promise<{ ctx: TestCtx; sock: ReturnType<FoundryClient["socket"]> }> => {
    const c = await startServer({
      sandboxDriver: "auto",
      sandboxEgress: EGRESS_OPEN ? "open" : "allowlist",
    });
    const client = new FoundryClient({ baseUrl: c.server.baseUrl, token: c.server.token });
    const sock = client.socket();
    await sock.connect();
    return { ctx: c, sock };
  };

  const wait = async (cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return;
      await delay(50);
    }
    throw new Error(`timeout waiting for ${what}`);
  };

  it("agent run: create hello.py in the sandbox and run it (REAL python)", async () => {
    const { ctx: c, sock } = await boot();
    const chat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };

    const send = (await sock.req("chat.send", {
      chatId: chat.id,
      content: "create hello.py in the sandbox and run it",
      agent: { enabled: true },
    }, "ot-accept")) as { runId: string };

    await wait(async () => {
      const run = (await sock.req("run.get", { runId: send.runId })) as { status: string };
      return ["done", "failed", "cancelled"].includes(run.status);
    }, "agent run terminal with real OT", 30_000);

    const run = (await sock.req("run.get", { runId: send.runId })) as { status: string; summary?: string };
    expect(run.status).toBe("done");

    // The shell step ran REAL python in the container.
    const evs = (await sock.req("run.events", { runId: send.runId })) as { seq: number; type: string; payload: unknown }[];
    const results = evs.filter((e) => e.type === "tool_result").map((e) => e.payload as { id: string; ok: boolean; content: string });
    const shell = results[1];
    expect(shell?.ok).toBe(true);
    expect(shell?.content).toContain("hello from the sandbox");

    // Workspace file landed on the HOST workspace dir (bind mount) too.
    const uid = c.server.rt.auth.verifyToken(c.server.token)?.userId;
    if (uid === undefined) throw new Error("no uid");
    const wdir = c.server.rt.sandbox.ensureWorkspace(uid).dir;
    expect(readFileSync(`${wdir.replace(/\\/g, "/")}/hello.py`, "utf8")).toContain("hello from the sandbox");
    sock.close();
  }, 90_000);

  it("exec/files/pty roundtrip against the OT REST API", async () => {
    const { sock } = await boot();

    // files roundtrip
    await sock.req("files.write", { path: "ot-check.txt", content: "real ot\n" }, "ot-fw-1");
    const read = (await sock.req("files.read", { path: "ot-check.txt" })) as { content: string };
    expect(read.content).toBe("real ot\n");

    const ls = (await sock.req("files.list", { path: "." })) as { path: string; isDir: boolean }[];
    expect(ls.some((e) => e.path === "ot-check.txt" && !e.isDir)).toBe(true);

    // exec through the driver (agent path) — cat via shell tool is agent-only;
    // use the PTY: term.open + input "ls"
    const term = (await sock.req("term.open", {}, "ot-term-1")) as { termId: string };
    const seen: { event: string; payload: Record<string, unknown> }[] = [];
    sock.on((event, _channel, _seq, payload) => seen.push({ event, payload: payload as Record<string, unknown> }));
    await sock.req("term.input", { termId: term.termId, data: "ls ot-check.txt\n" }, "ot-term-in-1");
    await wait(() => {
      const data = seen.filter((e) => e.event === "term.data").map((e) => {
        const p = e.payload as { data?: string; b64?: boolean };
        if (typeof p.data !== "string") return "";
        return p.b64 === false ? p.data : Buffer.from(p.data, "base64").toString("utf8");
      }).join("");
      return data.includes("ot-check.txt");
    }, "pty ls output");
    sock.close();
  }, 90_000);

  it("egress: gateway proxy reachable from container; OT firewall denies the rest when installed", async () => {
    // allowlist mode: env OPEN_TERMINAL_ALLOWED_DOMAINS=host.docker.internal →
    // OT's iptables firewall must deny external egress but pass the gateway.
    // open mode (Docker Desktop kernels lack ipset): only the proxy-path check.
    const { ctx: c } = await boot();
    const uid = c.server.rt.auth.verifyToken(c.server.token)?.userId;
    if (uid === undefined) throw new Error("no uid");
    const env = await c.server.rt.sandbox.ensureEnv(uid);
    // Deny: direct internet egress (allowlist mode only).
    const denied = await env.driver.execShell(env.envId, "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' https://example.com || echo BLOCKED", { timeoutMs: 15_000 });
    if (EGRESS_OPEN) {
      console.log("egress=open (no OT firewall on this kernel) — external egress result:", denied.stdout.trim() || denied.stderr.trim() || "<no output>");
    } else {
      expect(denied.stdout.includes("BLOCKED")).toBe(true);
    }
    // Allow: the gateway proxy path (host.docker.internal → core :8787).
    const port = new URL(c.server.baseUrl).port;
    const allowed = await env.driver.execShell(env.envId, `curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://host.docker.internal:${port}/healthz`, { timeoutMs: 15_000 });
    expect(allowed.stdout.trim()).toBe("200");
  }, 90_000);

  it("env creation fails fast when the container dies during startup (no 120s zombie)", async () => {
    // A container that exits the moment it starts must abort the OT-ready
    // wait in ~1s — with a distinguishing 502 — not burn the full 120s
    // window polling a dead endpoint (run-liveness.spec.ts locks the run
    // level; this locks the driver level).
    const image = process.env.FOUNDRY_SANDBOX_IMAGE ?? "ghcr.io/open-webui/open-terminal:latest";
    const launcher = new DockerLauncher({ sandboxImage: image, sandboxRuntime: "runc", sandboxOtHost: "127.0.0.1", sandboxEgress: EGRESS_OPEN ? "open" : "auto" });
    await launcher.pullIfMissing(image);
    const container = await launcher.docker.createContainer({ Image: image, Cmd: ["sh", "-c", "exit 1"] });
    const ot = new OtClient("http://127.0.0.1:1", "probe");
    const started = Date.now();
    await expect(launcher.awaitOtReady(container, ot, image)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("exited during startup"),
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    // awaitOtReady removed the dead container
    await wait(async () => {
      return launcher.docker.getImage(container.id).inspect().then(() => false, () => true);
    }, "dead container removed", 5000);
  }, 60_000);

  it("egress auto: allowlist when the kernel has ipset; open fallback (with the log tail in the error) when it doesn't", async () => {
    const c = await startServer({ sandboxDriver: "auto", sandboxEgress: "auto" });
    const uid = c.server.rt.auth.verifyToken(c.server.token)?.userId;
    if (uid === undefined) throw new Error("no uid");
    const env = await c.server.rt.sandbox.ensureEnv(uid);
    const containerRef = env.containerRef ?? "";
    expect(containerRef.length).toBeGreaterThan(0);
    // what the launch actually shipped: with a working firewall the var
    // rides; where it can't install (Docker Desktop), the fallback relaunched
    // WITHOUT it — either outcome = a READY env + reachable OT.
    const info = await env.driver.execShell(env.envId, "env | grep OPEN_TERMINAL_ALLOWED_DOMAINS || echo UNSET", { timeoutMs: 10_000 });
    const envState = info.stdout.trim();
    console.log(`egress=auto launch result: ${envState.includes("OPEN_TERMINAL_ALLOWED_DOMAINS") ? "allowlist installed" : "fallback to open"}`);
    // and the OT server is genuinely reachable through whatever mode won
    const probe = await env.driver.execShell(env.envId, "echo sandbox-up", { timeoutMs: 10_000 });
    expect(probe.stdout.trim()).toBe("sandbox-up");
  }, 90_000);
});