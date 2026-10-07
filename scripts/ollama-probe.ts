/**
 * `pnpm probe:ollama` [OLLAMA_URL env, default http://127.0.0.1:11434]
 *
 * P1 acceptance: the gateway streams through a REAL openai_compat provider
 * (not the dummy). Boots core on a temp dir, registers Ollama via admin REST,
 * then proves: catalog serving, SSE streaming with INCREMENTAL chunks
 * (curl -N semantics), [DONE], usage, and a non-stream completion.
 *
 * Exits 0 with a notice when nothing listens at OLLAMA_URL (e.g. CI), so this
 * is safe to run anywhere; locally it doubles as an operator smoke.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

// Env must exist before core loads. Dynamic import = no hoisting.
process.env.FOUNDRY_MASTER_KEY = process.env.FOUNDRY_MASTER_KEY ?? "probe-master-key-not-a-secret";
process.env.FOUNDRY_LOG_LEVEL = "warn";
process.env.FOUNDRY_DATA_DIR = mkdtempSync(join(tmpdir(), "foundry-probe-"));
const dataDir = process.env.FOUNDRY_DATA_DIR;

const { loadConfig } = await import("@foundry/core/config");
const { openDatabase } = await import("@foundry/core/db");
const { Vault } = await import("@foundry/core/vault");
const { bootstrapServices, buildRuntime } = await import("@foundry/core/runtime");
const { FoundryClient } = await import("@foundry/sdk-ts");

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`probe assertion failed: ${msg}`);
}

let db: Awaited<ReturnType<typeof openDatabase>> | undefined;

async function main(): Promise<void> {
  // Reachability + Ollama's own model list (also proves ITS OpenAI plane up).
  let upstreamModels: { id: string }[] = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/v1/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    upstreamModels = ((await res.json()) as { data: { id: string }[] }).data;
  } catch {
    console.log(`probe: no Ollama at ${OLLAMA_URL} — skipping (acceptance allows this)`);
    return;
  }
  // Deterministic probe target: prefer a non-thinking classic model — "gemma4
  // e2b" variants stream thinking blocks and their visible output varies with
  // tiny token budgets (flaky asserts), "gemma3" and lfm2.5 do not.
  const preferred =
    upstreamModels.find((m) => m.id === "gemma3:4b") ??
    upstreamModels.find((m) => !m.id.startsWith("gemma4")) ??
    upstreamModels[0];
  const pick = preferred?.id;
  if (pick === undefined) {
    console.log("probe: Ollama reachable but no models pulled — skipping");
    return;
  }
  console.log(`probe: Ollama at ${OLLAMA_URL} has ${upstreamModels.length} models; using ${pick}`);

  const config = { ...loadConfig(), port: 0 };
  const vault = Vault.fromEnv();
  db = openDatabase(config.dbPath, { log: () => {}, logWarn: () => {} });
  const boot = await bootstrapServices(db, vault, config, { warn: () => {} });
  const runtime = await buildRuntime({ config, version: "0.0.0-probe", db, vault });
  const sockRefs: { close(): void }[] = [];
  try {
    await runtime.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = runtime.app.server.address();
    assert(addr !== null && typeof addr === "object", "server address available");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const client = new FoundryClient({ baseUrl, token: boot.rootKey?.plaintext });

    // Admin REST: register Ollama as an openai_compat provider (no key needed
    // for local Ollama). Catalog ids stay prefixed: `ollama/<name>`.
    const wireId = `ollama/${pick}`;
    const up = await client.adminUpsertProvider({
      id: "ollama",
      kind: "openai_compat",
      baseUrl: OLLAMA_URL,
      models: [{ id: wireId, name: pick, context: 8192, caps: { vision: false, tools: true, reasoning: false, json: false } }],
    });
    assert(up.models.includes(wireId) || up.models.some((m) => m.endsWith(`/${pick}`)), `model registered (${JSON.stringify(up)})`);
    const models = await client.models();
    assert(models.data.some((m) => m.id === wireId), "GET /v1/models serves the Ollama model");
    console.log("probe: admin provider + catalog ok");

    // -- SSE: `curl -N` semantics — chunks arrive across MULTIPLE reads ------
    const started = Date.now();
    const reads: string[] = [];
    const rawRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${boot.rootKey?.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: wireId,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 48,
        messages: [{ role: "user", content: "Say exactly: gateway to ollama works" }],
      }),
    });
    assert(rawRes.ok, `SSE request 200 (got ${rawRes.status})`);
    const reader = rawRes.body?.getReader();
    assert(reader !== undefined, "SSE body readable");
    const decoder = new TextDecoder();
    let sse = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      reads.push(chunkText);
      sse += chunkText;
    }
    assert(reads.length >= 2, `incremental streaming across reads (got ${reads.length})`);
    const flattened = sse.replace(/\r/g, "");
    assert(flattened.includes("data: [DONE]"), "SSE ends with [DONE]");
    assert(flattened.includes('"usage"') && flattened.includes("prompt_tokens"), "usage present (include_usage)");
    const contentMatches = [...flattened.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
    assert(contentMatches.length > 0, `assistant content streamed (${contentMatches.slice(0, 40)}...)`);
    console.log(`probe: SSE stream ${Date.now() - started}ms, ${reads.length} reads, text: "${contentMatches.slice(0, 60)}"`);

    // -- non-stream JSON -----------------------------------------------------
    // (gemma thinking variants may spend tokens on reasoning first — 256)
    const completion = (await client.chat({
      model: wireId,
      max_tokens: 256,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    })) as { choices: { message: { content: string } }[]; usage?: unknown };
    const content = completion.choices[0]?.message.content ?? "";
    assert(content.length > 0, `non-stream completion content (got: ${content.slice(0, 40)})`);
    assert(completion.usage !== undefined, "non-stream usage present");
    console.log(`probe: non-stream completion ok (${content.slice(0, 40)})`);

    // -- WS plane: the same provider through chat.send ------------------------
    const sock = client.socket({ clientKind: "cli" });
    sockRefs.push(sock);
    await sock.connect();
    const chat = (await sock.req("chat.create", { title: "ollama probe", model: wireId })) as { id: string };
    let finalSeen = false;
    sock.on((event) => {
      if (event === "chat.final") finalSeen = true;
    });
    await sock.req("chat.send", { chatId: chat.id, content: "Reply with the single word: pong" }, "probe-ws-1");
    const deadline = Date.now() + 60_000;
    while (!finalSeen && Date.now() < deadline) await delay(250);
    if (!finalSeen) throw new Error("probe timeout waiting for chat.final via WS");
    console.log("probe: WS chat.send → real provider → chat.final ok");
    sock.close();
    console.log("probe: OK — P1 gateway green through a real provider");
  } finally {
    for (let i = sockRefs.length - 1; i >= 0; i--) sockRefs[i]?.close();
    try {
      await runtime?.app.close();
    } catch {
      // already closed
    }
  }
}

main()
  .then(() => teardown(0))
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    teardown(1);
  });

function teardown(code: number): void {
  try {
    // Windows: close sqlite before unlinking the dir.
    db?.sqlite.close();
  } catch {
    // already closed
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best effort — Windows may hold a handle briefly
  }
  process.exit(code);
}