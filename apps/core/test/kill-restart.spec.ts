import { beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { FoundryClient } from "@foundry/sdk-ts";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/open.js";
import { Vault } from "../src/vault/vault.js";
import { bootstrapServices, buildRuntime } from "../src/runtime.js";
import { MASTER_KEY, startServer, type TestCtx } from "./helpers.js";

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await startServer();
});

/** Resolve on a chat:{chatId} event, or throw after 8s. */
function waitForEvent(
  sock: { on(h: (event: string, channel: string) => void): () => void },
  chatId: string,
  event: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let hit = false;
    const timer = setTimeout(() => {
      if (!hit) {
        un();
        reject(new Error(`timeout waiting for ${event} on chat:${chatId}`));
      }
    }, 8000);
    const un = sock.on((ev, channel) => {
      if (ev === event && channel === `chat:${chatId}`) {
        hit = true;
        clearTimeout(timer);
        un();
        resolve();
      }
    });
  });
}

/**
 * Acceptance (P1): "kill core mid-stream → restart → history intact".
 *
 * Simulated crash: the DB is closed hard (no graceful teardown) while a slow
 * run is still streaming — the SIGKILL equivalent. Everything persisted
 * BEFORE the crash survives untouched; the in-flight run is simply abandoned
 * (P2's event-log replay finishes that story). The restarted server is fully
 * functional on the SAME database and the SAME token.
 */
describe("crash durability", () => {
  it("history survives a hard kill mid-run and the server stays functional", async () => {
    const client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
    const sock = client.socket();
    await sock.connect();

    // Turn 1: completes fully before the "crash".
    const chat1 = (await sock.req("chat.create", { title: "before crash", model: "dummy/scripted" })) as { id: string };
    const finalP1 = waitForEvent(sock, chat1.id, "chat.final"); // subscribe BEFORE send
    const send1 = (await sock.req("chat.send", { chatId: chat1.id, content: "survive me" }, "idem-1")) as { runId: string };
    await finalP1;

    // Turn 2: the slow model is mid-stream when we kill the process.
    const chat2 = (await sock.req("chat.create", { title: "during crash", model: "dummy/scripted-slow" })) as { id: string };
    await sock.req("chat.send", { chatId: chat2.id, content: "lost mid-flight" }, "idem-2");
    await delay(300); // a few chunks in (120ms each) — genuinely mid-stream

    // --- crash: hard DB close, no graceful shutdown ---
    ctx.server.rt.db.sqlite.close();
    sock.close();
    try {
      await ctx.server.rt.app.close();
    } catch {
      // handles may already be down
    }

    // --- restart: same db file, fresh runtime, ephemeral port ---
    const config = { ...loadConfig(), port: 0, host: "127.0.0.1", dataDir: ctx.server.dataDir, dbPath: ctx.server.dataDir + "/foundry.db", logLevel: "warn" };
    process.env.FOUNDRY_MASTER_KEY = MASTER_KEY;
    const vault = Vault.fromEnv(process.env);
    const db2 = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
    const boot2 = await bootstrapServices(db2, vault, config, { warn: () => {} });
    const rt2 = await buildRuntime({ config, version: "0.0.0-test", db: db2, vault });
    await rt2.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = rt2.app.server.address();
    const port2 = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      // bootstrap is idempotent: NO new root key minted on restart
      expect(boot2.rootKey).toBeUndefined();

      const client2 = new FoundryClient({ baseUrl: `http://127.0.0.1:${port2}`, token: ctx.server.token });
      const sock2 = client2.socket();
      await sock2.connect();

      // The completed turn is intact, on the ORIGINAL token and conversation.
      const list = (await sock2.req("chat.list", {})) as { id: string }[];
      expect(list.map((c) => c.id).sort()).toEqual([chat1.id, chat2.id].sort());
      const hist1 = (await sock2.req("chat.history", { chatId: chat1.id })) as { role: string; content: string }[];
      expect(hist1.map((h) => h.role)).toEqual(["user", "assistant"]);
      expect(hist1[1]?.content).toBe('You said: "survive me"');

      // Turn 1's raw provider events (guardrail #4) + usage ledger survived.
      const evs1 = (await sock2.req("run.events", { runId: send1.runId })) as { type: string }[];
      expect(evs1.map((e) => e.type)).toContain("raw_provider_request");
      expect(evs1.map((e) => e.type)).toContain("raw_provider_response");
      expect(evs1.map((e) => e.type)).toContain("usage");
      const usageRows = db2.sqlite.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number };
      expect(usageRows.n).toBe(1); // turn 2 never metered (killed mid-stream)

      // Turn 2's user turn persisted; no assistant yet (killed mid-stream).
      const hist2 = (await sock2.req("chat.history", { chatId: chat2.id })) as { role: string }[];
      expect(hist2.map((h) => h.role)).toEqual(["user"]);

      // Fully functional after restart: new chat rounds trip end to end.
      const chat3 = (await sock2.req("chat.create", { title: "after crash", model: "dummy/scripted" })) as { id: string };
      const finalP3 = waitForEvent(sock2, chat3.id, "chat.final");
      await sock2.req("chat.send", { chatId: chat3.id, content: "post crash" }, "idem-3");
      await finalP3;
      const hist3 = (await sock2.req("chat.history", { chatId: chat3.id })) as { role: string; content: string }[];
      expect(hist3[1]?.content).toBe('You said: "post crash"');

      sock2.close();
    } finally {
      try {
        await rt2.app.close();
      } catch {
        // already down
      }
      try {
        db2.sqlite.close();
      } catch {
        // already closed
      }
    }
  }, 30_000);
});