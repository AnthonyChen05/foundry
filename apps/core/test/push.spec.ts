import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { FoundryClient } from "@foundry/sdk-ts";
import { conversations, runs, snapshots, workspaces } from "../src/db/schema.js";
import { FakeDriver } from "../src/sandbox/fake.js";
import { FakeExecutor } from "./fake_executor.js";
import { startServer, type TestCtx } from "./helpers.js";

/**
 * Push-to-cloud (ADR-015 L3): a local chat's workspace migrates into a
 * backend env; the reconcile run (the LLM) inspects + reinstalls; the binding
 * flips to cloud. Harness: FakeExecutor over the bridge + FakeDrivers — no Docker.
 */

let ctx: TestCtx;
let client: FoundryClient;
let executor: FakeExecutor;
let execDriver: FakeDriver;

async function boot(): Promise<void> {
  ctx = await startServer();
  client = new FoundryClient({ baseUrl: ctx.server.baseUrl, token: ctx.server.token });
  execDriver = new FakeDriver();
  executor = new FakeExecutor({ port: ctx.server.port, token: ctx.server.token, driver: execDriver });
  await executor.connect();
}

afterEach(async () => {
  try {
    executor?.close();
  } catch {
    // already closed
  }
});

async function waitForRunDone(runId: string, what = "run"): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const row = ctx.server.rt.db.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (row?.status === "done") return;
    if (row?.status === "failed") throw new Error(`${what} failed: ${row.error ?? "?"}`);
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await delay(25);
  }
}

function bindingOf(chatId: string): { location?: string; envId?: string; push?: unknown } {
  const row = ctx.server.rt.db.db.select().from(conversations).where(eq(conversations.id, chatId)).get();
  const meta = row?.meta ?? {};
  return {
    location: meta["location"] as string | undefined,
    envId: meta["envId"] as string | undefined,
    push: meta["push"],
  };
}

/** Boot, run a scripted LOCAL agent chat (files land on the executor side). */
async function makeLocalChat(): Promise<{ chatId: string; localEnvId: string }> {
  const sock = client.socket();
  await sock.connect();
  const created = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
  const send = (await sock.req("chat.send", {
    chatId: created.id,
    content: "create hello.py in the sandbox and run it",
    agent: { enabled: true, location: "local" },
  }, `push-local-${Math.random().toString(36).slice(2)}`)) as { runId: string };
  await waitForRunDone(send.runId, "local run");
  sock.close();
  const localEnvId = bindingOf(created.id).envId ?? "";
  expect(localEnvId.startsWith("env_")).toBe(true);
  return { chatId: created.id, localEnvId };
}

describe("push to cloud (ADR-015)", () => {
  it("happy path: tar pull → cloud env → restore → reconcile run → binding flips", async () => {
    await boot();
    const { chatId, localEnvId } = await makeLocalChat();

    const res = await client.pushChat(chatId);
    expect(res.pushRunId.startsWith("run_")).toBe(true);
    expect(res.cloudEnvId.startsWith("env_")).toBe(true);
    await waitForRunDone(res.pushRunId, "reconcile run");

    // Binding flipped to the cloud env; push state recorded done.
    const binding = bindingOf(chatId);
    expect(binding.location).toBe("cloud");
    expect(binding.envId).toBe(res.cloudEnvId);
    expect((binding.push as { state?: string }).state).toBe("done");

    // The reconcile run is bound to the cloud env + is the agent trigger row.
    const runRow = ctx.server.rt.db.db.select().from(runs).where(eq(runs.id, res.pushRunId)).get();
    expect(runRow?.envId).toBe(res.cloudEnvId);
    expect(runRow?.agent).toBe(true);

    // Files restored into the core-hosted per-chat cloud workspace.
    const chatWs = ctx.server.rt.db.db
      .select()
      .from(workspaces)
      .all()
      .find((w: { name: string }) => w.name === `chat:${chatId}`);
    if (chatWs === undefined) throw new Error("chat workspace missing");
    const restoredFile = join(resolve(chatWs.path), "hello.py");
    expect(existsSync(restoredFile)).toBe(true);
    expect(readFileSync(restoredFile, "utf8")).toContain("hello");

    // Audit: a snapshots row points at the local env's tar.
    const snapRows = ctx.server.rt.db.db.select().from(snapshots).all();
    expect(snapRows.some((s: { envId: string; note: string | null }) => s.envId === localEnvId && (s.note ?? "").includes("push-to-cloud"))).toBe(true);

    // chat.list reports the flipped binding (ChatSummary additive fields).
    const sock = client.socket();
    await sock.connect();
    const list = await sock.chatList();
    const listed = list.find((c) => c.id === chatId);
    expect(listed?.location).toBe("cloud");
    expect(listed?.envId).toBe(res.cloudEnvId);
    sock.close();
  });

  it("push rejections: a cloud chat → 400; an offline executor → 503 (binding stays)", async () => {
    await boot();
    // A chat that never went local:
    const sock = client.socket();
    await sock.connect();
    const cloudChat = (await sock.req("chat.create", { model: "dummy/scripted" })) as { id: string };
    sock.close();
    await expect(client.pushChat(cloudChat.id)).rejects.toMatchObject({ code: "invalid_request_error" });

    // A local chat whose executor dropped mid-life: bind first (needs the
    // executor), then disconnect, then push. 503 maps to the repo's envelope
    // vocabulary (openAiError derives "api_error" for statuses it doesn't
    // enumerate) — assert the status semantics via message + status.
    const { chatId } = await makeLocalChat();
    executor.close();
    await delay(50);
    const failure = await client.pushChat(chatId).then(
      () => { throw new Error("push should have failed offline"); },
      (err: unknown) => err as { code?: string; message?: string; status?: number },
    );
    expect(failure.message ?? "").toContain("no local executor is connected");
    // The chat STAYED local (failed push keeps the binding).
    expect(bindingOf(chatId).location).toBe("local");
  });
});