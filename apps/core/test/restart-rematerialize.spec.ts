import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { FoundryClient } from "@foundry/sdk-ts";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDatabase } from "../src/db/open.js";
import { Vault } from "../src/vault/vault.js";
import { bootstrapServices, buildRuntime, type FoundryRuntime } from "../src/runtime.js";
import { envs, runs } from "../src/db/schema.js";

/**
 * Restart re-materialization: a core restart empties the driver's in-memory
 * maps — a "ready" env row must be probed and re-created over the same
 * workspace dir (files survive; ADR-003/ADR-015) instead of the run's tool
 * calls failing with "driver has no live container".
 */

const dataDirs: string[] = [];
afterEach(() => {
  for (const d of dataDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function configOf(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    port: 0,
    host: "127.0.0.1",
    dataDir,
    dbPath: join(dataDir, "foundry.db"),
    logLevel: "warn",
    sandboxDriver: "fake",
    backupMin: 0,
    adminPassword: "restart-test-pw",
  };
}

async function boot(dataDir: string): Promise<{ rt: FoundryRuntime; token: string }> {
  process.env.FOUNDRY_MASTER_KEY = process.env.FOUNDRY_MASTER_KEY ?? "test-master-key-not-a-secret";
  const config = configOf(dataDir);
  const vault = Vault.fromEnv();
  const db = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
  await bootstrapServices(db, vault, config, { warn: () => {} });
  const rt = await buildRuntime({ config, version: "restart", db, vault });
  await rt.app.listen({ port: 0, host: "127.0.0.1" });
  const token = readFileSync(join(dataDir, "admin_key.txt"), "utf8").trim();
  return { rt, token };
}

async function stop(rt: FoundryRuntime): Promise<void> {
  await rt.app.close();
  rt.shutdownServices();
  try {
    rt.db.sqlite.close();
  } catch {
    // already closed
  }
}

describe("restart re-materialization", () => {
  it("a ready env row from a previous boot is re-created on the next run; files survive", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "foundry-restart-"));
    dataDirs.push(dataDir);

    // Boot 1: an agent run creates the env + writes a workspace file.
    const a = await boot(dataDir);
    const s1 = new FoundryClient({ baseUrl: `http://127.0.0.1:${(a.rt.app.server?.address() as { port: number }).port}`, token: a.token }).socket();
    await s1.connect();
    const chat = (await s1.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    const r1 = (await s1.req("chat.send", {
      chatId: chat.id,
      // "create hello.py …" is the scripted scenario (writes hello.py).
      content: "create hello.py in the sandbox and run it",
      agent: { enabled: true },
    }, "restart-1")) as { runId: string };
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && a.rt.chat.getRun(r1.runId)?.status !== "done") await delay(50);
    expect(a.rt.chat.getRun(r1.runId)?.status).toBe("done");

    const envRowsBefore = a.rt.db.db.select().from(envs).all();
    expect(envRowsBefore).toHaveLength(1);
    const oldEnvId = envRowsBefore[0]?.id as string;
    expect((envRowsBefore[0]?.status as string)).toBe("ready");

    const list1 = (await s1.req("files.list", { path: "." })) as { path: string }[];
    expect(list1.some((f) => f.path === "hello.py")).toBe(true);
    s1.close();
    await stop(a.rt);

    // Boot 2: fresh process, same data dir — the driver map is empty and the
    // OLD env row still says "ready". A run must probe it, close it, and
    // re-create over the same workspace (file intact).
    const b = await boot(dataDir);
    const port2 = (b.rt.app.server?.address() as { port: number }).port as number;
    const s2 = new FoundryClient({ baseUrl: `http://127.0.0.1:${port2}`, token: a.token }).socket();
    await s2.connect();
    const r2 = (await s2.req("chat.send", { chatId: chat.id, content: "hello again", agent: { enabled: true } }, "restart-2")) as { runId: string };
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2 && b.rt.chat.getRun(r2.runId)?.status !== "done") await delay(50);
    expect(b.rt.chat.getRun(r2.runId)?.status, `run2 error: ${b.rt.chat.getRun(r2.runId)?.error ?? "none"}`).toBe("done");

    const envRowsAfter = b.rt.db.db.select().from(envs).all();
    const oldRow = envRowsAfter.find((e) => e.id === oldEnvId);
    expect(oldRow?.status).toBe("dead");
    const readyNew = envRowsAfter.filter((e) => e.status === "ready");
    expect(readyNew).toHaveLength(1);
    expect(readyNew[0]?.id).not.toBe(oldEnvId);
    // The new run ran against the NEW env, not the dead one.
    const run2Row = b.rt.db.db.select({ envId: runs.envId }).from(runs).where(eq(runs.id, r2.runId)).get();
    expect(run2Row?.envId).toBeDefined();
    expect(run2Row?.envId).not.toBe(oldEnvId);

    // And the workspace file from boot 1 still lists.
    const list2 = (await s2.req("files.list", { path: "." })) as { path: string }[];
    expect(list2.some((f) => f.path === "hello.py")).toBe(true);
    s2.close();
    await stop(b.rt);
  }, 60_000);
});