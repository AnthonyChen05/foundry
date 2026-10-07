/**
 * `pnpm smoke` — proves the P1 path end to end in one process:
 *
 *   boot core (temp data dir, ephemeral port)
 *   → GET /v1/models serves the seeded dummy catalog
 *   → POST /v1/chat/completions non-stream + SSE (true streaming, usage, [DONE])
 *   → WS connect → chat.create → chat.send → chat.delta* → chat.final
 *   → server-side persistence + reconnect replay
 *
 * Exits 0 on green, 1 with the first failing assertion.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Env must exist before core loads. Dynamic import = no hoisting.
process.env.FOUNDRY_MASTER_KEY = process.env.FOUNDRY_MASTER_KEY ?? "smoke-master-key-not-a-secret";
process.env.FOUNDRY_LOG_LEVEL = "warn";
process.env.FOUNDRY_DATA_DIR = mkdtempSync(join(tmpdir(), "foundry-smoke-"));
const dataDir = process.env.FOUNDRY_DATA_DIR;

const { loadConfig } = await import("@foundry/core/config");
const { openDatabase } = await import("@foundry/core/db");
const { Vault } = await import("@foundry/core/vault");
const { bootstrapServices, buildRuntime } = await import("@foundry/core/runtime");
const { FoundryClient } = await import("@foundry/sdk-ts");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`smoke assertion failed: ${msg}`);
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await delay(50);
  }
  throw new Error(`smoke timeout waiting for ${what}`);
}

let port = 0;
let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined;
let db: Awaited<ReturnType<typeof openDatabase>> | undefined;
const sockRefs: { close(): void }[] = [];

async function main(): Promise<void> {
  const config = { ...loadConfig(), port: 0 };
  const vault = Vault.fromEnv();
  db = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
  const boot = await bootstrapServices(db, vault, config, { warn: () => {} });
  runtime = await buildRuntime({ config, version: "0.0.0-smoke", db, vault });
  await runtime.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = runtime.app.server.address();
  assert(addr !== null && typeof addr === "object", "server address available");
  port = addr.port;
  const client = new FoundryClient({ baseUrl: `http://127.0.0.1:${port}`, token: boot.rootKey?.plaintext });

  // -- REST: models -----------------------------------------------------------
  const models = await client.models();
  assert(models.data.some((m) => m.id === "dummy/scripted"), "seeded dummy/scripted in GET /v1/models");
  console.log("smoke: models catalog ok");

  // -- REST: non-stream completion ---------------------------------------------
  const completion = (await client.chat({
    model: "dummy/scripted",
    messages: [{ role: "user", content: "hello smoke" }],
  })) as {
    choices: { message: { content: string }; finish_reason: string }[];
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  assert(completion.choices[0]?.message.content === 'You said: "hello smoke"', "dummy echoes input (non-stream)");
  assert(completion.choices[0]?.finish_reason === "stop", "finish_reason stop");
  assert(completion.usage.total_tokens >= 2, "usage present on non-stream");

  // -- REST: SSE stream ----------------------------------------------------------
  const rawRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${boot.rootKey?.plaintext}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "dummy/scripted",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello sse" }],
    }),
  });
  assert(rawRes.ok, "SSE request 200");
  const rawBody = await rawRes.text();
  assert(new RegExp('data: \\{"id":"chatcmpl-dummy').test(rawBody), "SSE carries OpenAI chunk shape");
  assert(rawBody.replace(/\r/g, "").includes("data: [DONE]\n\n"), "SSE ends with [DONE]");
  assert(rawBody.includes('"usage"') && rawBody.includes("prompt_tokens"), "SSE final usage chunk present");
  console.log("smoke: SSE stream + [DONE] + usage ok");

  // True streaming check: chunks arrive incrementally (not one buffered blob).
  const sdkChunks: { choices?: { delta?: { content?: string }; finish_reason?: string | null }[]; usage?: unknown }[] = [];
  for await (const chunk of client.chatStream({
    model: "dummy/scripted",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "incremental" }],
  })) {
    sdkChunks.push(chunk);
  }
  assert(sdkChunks.length >= 3, `multiple SSE chunks (${sdkChunks.length})`);
  assert(sdkChunks[sdkChunks.length - 1]?.usage !== undefined, "last chunk carries usage (include_usage)");

  // -- WS plane -------------------------------------------------------------------
  const sock = client.socket({ clientKind: "cli" });
  sockRefs.push(sock);
  const connectRes = await sock.connect();
  assert(connectRes.protocol === 0, "WS connect: protocol 0");
  assert(connectRes.features.methods.includes("chat.send"), "WS connect: features.methods");
  assert(Array.isArray(connectRes.snapshot.activeRuns), "WS connect: snapshot.activeRuns");

  const chat = (await sock.req("chat.create", { title: "smoke ws", model: "dummy/scripted" })) as { id: string };
  assert(typeof chat.id === "string" && chat.id.startsWith("ch_"), "chat.create returns id");

  const seen: { event: string; channel: string; seq: number; payload: Record<string, unknown> }[] = [];
  sock.on((event, channel, seq, payload) => seen.push({ event, channel, seq, payload: payload as Record<string, unknown> }));

  const sendRes = (await sock.req("chat.send", { chatId: chat.id, content: "ws smoke send" }, `idem-smoke-1`)) as { runId: string };
  assert(typeof sendRes.runId === "string" && sendRes.runId.startsWith("run_"), "chat.send returns runId");

  await waitFor(
    () => seen.some((e) => e.event === "chat.final") && seen.some((e) => e.event === "run.status" && e.payload.status === "done"),
    5000,
    "chat.final + run.status done via WS",
  );
  const deltas = seen.filter((e) => e.event === "chat.delta");
  assert(deltas.length >= 2, `chat.delta events streamed (${deltas.length})`);
  const chatEvents = seen.filter((e) => e.channel === `chat:${chat.id}`);
  assert(chatEvents.every((e, i) => i === 0 || e.seq > (chatEvents[i - 1] as { seq: number }).seq), "chat channel seq monotonic");
  console.log("smoke: WS chat.send → deltas → final ok");

  // persistence: history on a FRESH socket reflects the completed turn
  const sock2 = client.socket();
  sockRefs.push(sock2);
  await sock2.connect();
  const history = (await sock2.req("chat.history", { chatId: chat.id })) as { role: string; content: string }[];
  const roles = history.map((h) => h.role);
  assert(roles.includes("user") && roles.includes("assistant"), "user + assistant persisted");
  const assistant = history[history.length - 1];
  assert(assistant.role === "assistant" && typeof assistant.content === "string" && assistant.content.includes('You said: "ws smoke send"'), "assistant persisted content");
  console.log("smoke: persistence + history ok");

  // reconnect replay: fresh socket, resume from 0 on the chat channel
  // NOTE: subscribe AFTER connect() on purpose — the SDK must not lose the
  // resume burst just because no handler existed while it landed (the common
  // connect-then-subscribe client pattern).
  const sock3 = client.socket();
  sockRefs.push(sock3);
  await sock3.connect([{ channel: `chat:${chat.id}`, lastSeq: 0 }]);
  const replayed: { event: string; seq: number }[] = [];
  sock3.on((event, channel, seq) => {
    if (channel === `chat:${chat.id}`) replayed.push({ event, seq });
  });
  await waitFor(() => replayed.some((r) => r.event === "chat.final"), 3000, "replayed chat.final from lastSeq 0");
  assert(replayed.every((r, i) => i === 0 || r.seq > replayed[i - 1].seq), "replayed seq monotonic");
  console.log("smoke: reconnect replay ok");

  sock.close();
  sock2.close();
  sock3.close();
}

main()
  .then(() => {
    console.log("smoke: OK — P1 gateway green");
    return teardown(0);
  })
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    return teardown(1);
  });

async function teardown(code: number): Promise<void> {
  for (const s of sockRefs) s.close();
  try {
    await runtime?.app.close();
  } catch {
    // already closed
  }
  try {
    // Windows: close sqlite before unlinking the dir.
    db?.sqlite.close();
  } catch {
    // already closed
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  process.exitCode = code;
}