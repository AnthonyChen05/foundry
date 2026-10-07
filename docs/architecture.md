# Architecture (v0)

Diagram: `assets/architecture.svg`.

## 1. Planes (inbound)

Two independent inbound planes on one port (8787):

1. **Private WS plane** — for first-party clients (Android, Windows, web).
   Typed JSON frames over WebSocket (`req`/`res`/`event`, see
   `docs/protocol.md`). Carries chat streaming, agent run events, approval
   gates, PTY terminal streams, file ops, notifications.
2. **OpenAI-compatible REST plane** — `/v1/chat/completions`, `/v1/models`.
   Any third-party OpenAI-compatible client (Open WebUI, Cherry Studio,
   OpenClaw, curl, scripts) can point here and treat Foundry as a provider.
   Streaming via SSE. This makes the backend useful on day one, before any
   first-party client exists.

## 2. Components

### Gateway & WS hub
- Connection handshake (`connect`), auth (API keys for REST; session tokens
  for WS), per-channel event routing with seq tracking and replay buffer.
- Idempotency keys on side-effecting methods (`chat.send`, `run.*`).
- Push notifications via ntfy (self-hosted) — run finished, gate needs approval.
- Serves the OpenAI-compatible REST plane through the provider layer.

### Provider layer (the switchboard)
- **Canonical internal format: OpenAI Chat Completions** (messages, tools,
  tool_calls, usage). Nothing else crosses component boundaries.
- Adapters: (a) `openai-compat` — covers Ollama, LM Studio, vLLM, OpenRouter,
  Groq, OpenAI; (b) `anthropic` — full translation shim both directions
  (system prompt, tool use, streaming, thinking blocks → reasoning); (c)
  `dummy` — scripted provider for tests.
- Model catalog in DB: id, provider, capabilities (vision/tools/reasoning/json),
  context window, prices. `GET /v1/models` serves it.
- Routing by model id prefix (`ollama/llama3.1:8b`,
  `openrouter/anthropic/claude-sonnet-4.5`). Optional failover chains.
- Key vault: AES-256-GCM blobs; master key `FOUNDRY_MASTER_KEY`.
- Usage ledger per request: tokens in/out, cost estimate, latency.

### Agent runtime (the brain)
- Canonical loop: `plan → act (tools) → observe → repeat` with budgets:
  max steps, max tokens, cost cap, wall-clock cap. Stop/yield states explicit.
- **Runs are resumable, append-only event logs** (`runs` + `run_events`).
  Everything the run does is an event: LLM deltas, tool calls/results, gate
  requests/resolutions, status transitions. Crash → replay. This powers
  autonomy, audit, crash recovery, and the client timeline UI.
- Approval gates: per-tool policy `ask | always | session | deny`. A gated
  tool call parks the run in `waiting_approval`; the client resolves it over
  WS (`run.approve`); timeout (default 15 min) auto-denies.
- Triggers: chat message, schedule (cron), webhook (HMAC), manual.
- Long-term memory: `memories` table + sqlite-vec index; embeddings via the
  configured embedding provider (local Ollama preferred); top-k injected into
  system prompt.
- Sub-agents (P3+): spawn child runs; results bubble up as tool results.
- **MCP client** (stdio + streamable HTTP): configured servers' tools join the
  tool registry namespaced `mcp__<server>__<tool>`. Existing MCP servers
  (Scarlet MCP, searxng, github, …) plug in with zero glue code.

### Sandbox / VM layer (the hands)
Driver interface (TS sketch — normative):

```ts
interface SandboxDriver {
  create(opts: { image?: string; caps?: Caps; env?: Record<string, string>;
                 workspaceId?: string }): Promise<Env>;
  exec(env: EnvId, cmd: string[], opts?: { cwd?: string; timeoutMs?: number;
                 onStdout?: (s: string) => void; onStderr?: (s: string) => void }):
    Promise<ExecResult>;            // { exitCode, stdout, stderr, timedOut }
  openPty(env: EnvId, opts?: { cwd?: string; cols?: number; rows?: number }):
    Promise<PtyHandle>;             // { stream, resize(cols, rows), close() }
  files: FileApi;                   // list/read/readStream/write/mkdir/rm/stat
  snapshot(env: EnvId, note?: string): Promise<BlobId>;
  destroy(env: EnvId): Promise<void>;
}
```

- **Driver #1: Open Terminal container** (`ghcr.io/open-webui/open-terminal`,
  MIT). Gives: REST exec API, file management API, **PTY-backed interactive
  terminal sessions**, egress firewall, image variants (`latest` ~4GB w/ full
  toolkit; `slim` ~430MB). The driver wraps its HTTP API per the interface
  above. Long-lived envs = one OT container per workspace; ephemeral execs
  allowed inside it.
- **Driver #2: raw Docker** via dockerode — for integration tests and as the
  control path for creating/managing the OT containers themselves.
- **Later:** Firecracker microVM driver (interface only in v0 — do not build).
- Filesystem model: per-workspace directory on host, bind-mounted into the
  container (OT: `/home/user`). Snapshots: tar+zstd of the workspace → blob
  store at run end and on demand; keep last N (default 20).
- **Egress rule:** containers hold no provider keys. Their HTTP egress goes
  through the gateway's egress proxy with a scoped per-env token; the proxy
  swaps in real keys and meters usage (the "sbx pattern"). Non-LLM egress is
  controlled by the OT egress firewall (default deny, allowlist per env).

### Persistence
- SQLite (WAL) via Drizzle + better-sqlite3: conversations, messages,
  runs, run_events, gates, schedules, memories, vault, models, providers,
  usage, settings, workspaces, envs, blobs. See `docs/data-model.md`.
- Blob store: content-addressed (sha256) files under `$FOUNDRY_DATA_DIR/blobs/`.
- Vector: sqlite-vec virtual table for memory embeddings.

## 3. Key data flows

**(a) Plain chat (no agent):** client → `chat.send` (WS) or `POST
/v1/chat/completions` → provider layer routes → adapter streams → deltas
relayed (WS events / SSE chunks) → final message + usage persisted.

**(b) Agent run with approval gate:** `chat.send {agent: true}` → run created
(`queued`) → loop streams deltas → tool call `shell("rm -rf build")` matches
gate policy `ask` → run → `waiting_approval`, `run.gate_request` event →
phone push via ntfy → client sends `run.approve` → run resumes → tool result
event → loop continues → `done` + summary + workspace snapshot.

**(c) Terminal session:** client `term.open` → driver `openPty` on the env's
container → `term.data` events stream both ways; server keeps a 2000-line
scrollback ring buffer for reconnect replay; resize propagates.

**(d) Scheduled run:** scheduler tick (30 s) → due schedule → new run with
stored prompt → same loop → ntfy push with summary.

## 4. Deployment topology

- **Homelab Linux box:** Foundry core (one process, port 8787, behind
  Tailscale), ntfy, Docker daemon (sandbox containers).
- **Jetson Orin Nano:** Ollama only — a pure model endpoint on the LAN
  (`http://<jetson>:11434`). Never co-locate sandbox containers with it.
- **Remote access:** Tailscale (preferred) or SSH tunnel; never expose 8787
  to the public internet in v0.
- All state under `$FOUNDRY_DATA_DIR/` (db, blobs, workspaces) → single
  rsync/borg target for backups.

## 5. Trust model (summary)

Trusted gateway, untrusted execution. The gateway holds keys, history, and
policy; sandbox containers are disposable, capped, non-root, keyless, and
egress-controlled. Agent output is data, never host commands. Full ADR at
`docs/decisions.md` §ADR-010.