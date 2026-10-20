# PROTOCOL v0 — the contract

This document is the product. All three first-party clients (Android,
Windows, web) and the core implement THIS spec. Types live in
`packages/protocol` as TypeBox schemas; `PROTOCOL_VERSION = 0`. Changes to
this file require bumping the version and noting the migration in the changelog
section at the bottom.

## 1. WebSocket plane (private, first-party clients)

Default URL: `ws://127.0.0.1:8787/ws` (Tailscale address in remote use).

### 1.1 Frames (JSON text)

```ts
// request
{ type: "req",   id: string, method: string, params: unknown, idem?: string }
// response
{ type: "res",   id: string, ok: boolean, payload?: unknown, error?: ProtocolError }
// server push
{ type: "event", event: string, channel: string, seq: number, payload: unknown }

type ProtocolError = { code: "bad_request" | "unauthorized" | "not_found" |
  "denied" | "gate_timeout" | "provider_error" | "capacity" | "internal",
  message: string, retryable?: boolean }
```

- `id` is client-generated (uuid); responses correlate by `id`.
- `idem` (idempotency key) is REQUIRED for side-effecting methods
  (`chat.send`, `run.cancel`, `run.approve`, `term.*`, `files.write`,
  `files.mkdir`, `files.rm`). Server keeps a short-lived dedupe cache (10 min).
- `channel` on events is one of `chat:{id}`, `run:{id}`, `term:{id}`, `sys`.

### 1.2 Handshake

First frame MUST be `connect`; anything else → hard close.

```json
// → req connect
{ "type": "req", "id": "c1", "method": "connect", "params": {
  "protocol": 0,
  "auth": { "token": "fnd_s3..." },
  "client": { "kind": "android|windows|web|cli", "version": "0.1.0" },
  "resume": [ { "channel": "run:abc", "lastSeq": 42 } ] } }

// ← res
{ "type": "res", "id": "c1", "ok": true, "payload": {
  "sessionId": "s_...", "protocol": 0,
  "features": { "methods": ["chat.send", "..."], "events": ["chat.delta", "..."] },
  "snapshot": { "activeRuns": ["run:abc"], "unread": 2 } } }
```

- Auth token: opaque session token (issued by `auth.login` or a long-lived
  client token created in the admin UI). Stored hashed server-side.
- `resume[]`: server replays buffered events per channel from `lastSeq+1`
  (ring buffer, 500 events/channel). If the gap exceeds the buffer, server
  sends `event:"sys.resync"` on that channel and the client must refetch.

### 1.3 Methods (v0)

| Method | Params → Result | Notes |
|---|---|---|
| `sys.health` | `{}` → `{ ok, version, uptimeS }` | |
| `sys.models` | `{}` → `Model[]` | the catalog |
| `chat.list` | `{}` → `ChatSummary[]` | |
| `chat.create` | `{ title?, model? }` → `Chat` | |
| `chat.history` | `{ chatId, before?, limit? }` → `Message[]` | canonical OpenAI messages |
| `chat.send` | `{ chatId, content, attachments?, model?, agent?: { enabled, toolPolicy?: { tool: "ask"\|"always"\|"session"\|"deny" } } }` → `{ runId }` | start of everything; agent:true = autonomous run; runs begin via chat.send only (no run.start in v0) |
| `run.get` | `{ runId }` → `Run` (+ `gates?: Gate[]`) | status, budgets, summary; while open gates exist the result carries them under `gates` (ride-along so a reconnecting client can find what to approve) |
| `run.events` | `{ runId, since? }` → `RunEvent[]` | replay for timeline UI (includes every LLM/tool step + raw provider traffic, keys redacted) |
| `run.cancel` | `{ runId }` → `{}` | |
| `run.approve` | `{ runId, gateId, approve, scope?: "once"\|"session"\|"always" }` → `Gate` | resolves a gate; returns its full wire row (with `state`, `resolvedBy`, `resolvedAt`). Unknown gate → `not_found`; already-resolved → `bad_request`. Timeout auto-deny recorded as `state:"timeout"` |
| `term.open` | `{ envId? }` → `{ termId, envId, replay: string }` | replay = scrollback |
| `term.input` | `{ termId, data, b64? }` → `{}` | |
| `term.resize` | `{ termId, cols, rows }` → `{}` | |
| `term.close` | `{ termId }` → `{}` | |
| `files.list` | `{ envId?, path }` → `FileEntry[]` | workspace-relative paths |
| `files.read` | `{ envId?, path }` → `{ content, b64? }` | |
| `files.write` | `{ envId?, path, content }` → `{}` | |
| `files.mkdir` / `files.rm` / `files.stat` | obvious | |
| `admin.keys.*` | create/list/revoke API keys | admin only |
| `admin.providers.*` | upsert/list providers + vault keys | keys accepted here ONLY |
| — (`admin.schedules.*` moved to REST, §2.1) | | schedules/hooks are admin-REST only |
| `auth.login` | `{ username, password }` → `{ sessionToken, expiresAt }` | human login (ADR-014) |
| `exec.register` | `{ name, version, dockerAvailable, workspaceRoot? }` → `{ replaced? }` | executor plane (§1.3a); no idem |
| `exec.status` | `{}` → `ExecutorInfo { online, name?, version?, dockerAvailable?, workspaceRoot?, reason? }` | executor presence probe |
| `exec.pty.data` | `{ ptyId, data(b64) }` → `{}` | executor PTY pump → `term.data`; no idem |
| `exec.pty.exit` | `{ ptyId, code }` → `{}` | executor PTY exit → `term.exit` |

(P5 hardening) `chat.send` is rate-limited per user (`capacity` error) and
quota-limited per user's concurrent runs; `run.*`, and the term/files planes
with an explicit (or implicit) env, resolve through per-user ownership —
another user's run/env/chat answers the SAME `not_found` as an unknown one.

### §1.3a Executor plane (server→client requests, ADR-015)

After `connect`, a client calls `exec.register` to become the user's local
executor (desktop runner; latest wins — a previous executor's pending calls
reject and its live PTYs `term.exit`). On such connections the **server sends
`req` frames** and the executor answers a standard `res` frame with the same
id; every other connection still gets `frame must be { type:'req', … }` for
non-req frames. These calls carry no idempotency keys: fresh request ids per
attempt, caller-side timeouts (504 SandboxError shape), no auto-retry (a re-run
could double-execute; read-only calls may retry with fresh ids).

| Server→client call | Params → Result | Notes |
|---|---|---|
| `exec.env.create` | `{ envId, chatId?, caps, image? }` → `{ containerRef?, workspaceDir }` | envId/row id are core-minted; runner hosts the dir |
| `exec.env.destroy` / `exec.env.status` | `{ envId }` → `{}` / `{ status: "ready"\|"dead" }` | status never throws offline; the driver reports "dead" |
| `exec.exec` | `{ envId, command, cwd?, env?, timeoutMs? }` → `{ exitCode, stdout, stderr, timedOut }` | mirrors execShell |
| `exec.exec.cancel` | `{ ref: <reqId> }` → `{}` | run.cancel aborts an in-flight exec (runner kills OT exec) |
| `exec.openPty` | `{ envId, cwd?, cols?, rows? }` → `{ ptyId }` | PTY data flows back via `exec.pty.data` |
| `exec.pty.write` / `resize` / `close` | `{ ptyId, … }` → `{}` | |
| `exec.files.list` / `read` / `write` / `mkdir` / `rm` / `stat` | like §1.3 files.* — read returns `{ b64, isText }`; write chunks >768 KB via `append: true` | binary-safe always |
| `exec.tar.start` / `chunk` / `free` | `{ envId, excludes? }` → `{ tarId, size, chunkSize }` / `{ index }` → `{ index, b64 }` / `{ tarId } → {}` | workspace pull for push-to-cloud; symlink-free POSIX tar |

Side-effecting methods (chat.send, run.cancel, run.approve, term.open/input/
resize/close, files.write, files.mkdir, files.rm) carry `idem` **on the frame
itself** (§1.1), never inside params — the hub's dedupe middleware reads one
uniform location.

### 1.4 Events (v0)

| Event | Channel | Payload |
|---|---|---|
| `chat.delta` | `chat:{id}` | `{ runId, delta }` |
| `chat.final` | `chat:{id}` | `{ message }` (canonical OpenAI message) |
| `run.status` | `run:{id}` | `{ runId, status, error?, resumed? }` (`resumed:true` after a boot-restart resume) |
| `run.delta` | `run:{id}` | `{ text? , reasoning? }` (reserved; the P2 loop streams summaries via chat.final) |
| `run.tool_call` | `run:{id}` | `{ call: { id, name, args } }` |
| `run.tool_result` | `run:{id}` | `{ id, ok, content }` (content = tool output text; ok=false on failure/denial) |
| `run.gate_request` | `run:{id}` | `{ gateId, runId, tool, args, policy, createdAt }` (flat, no `gate:` wrapper) |
| `run.gate_resolved` | `run:{id}` | `{ gateId, approved, scope, state }` (`state` = approved/denied/timeout; a client resolution also records the full row as a run_event) |
| `run.usage` | `run:{id}` | `{ promptTokens, completionTokens, costEst, latencyMs }` |
| `term.data` | `term:{id}` | `{ data, b64? }` |
| `term.exit` | `term:{id}` | `{ code }` (code null when closed via `term.close`) |
| `notify.push` | `notify` | `{ title, body, runId? }` |
| `sys.resync` | any | client must refetch channel state |
| `executor.status` | `sys` | `ExecutorInfo { online, name?, version?, dockerAvailable?, workspaceRoot?, reason? }` — desktop executor came/ went (ADR-015) |

### 1.5 Approval gates (P3)

Per-tool policy `ask | always | session | deny`, resolved when an agent run
wants to execute a tool call:

1. The run's `chat.send` `agent.toolPolicy` map (exact tool name, then `"*"`;
   junk entries fall back to the default) — `deny` and `always` are absolute.
2. `"always"` approval cache (settings `gate.always:<userId>:<tool>`, granted
   by a client approving with `scope:"always"`).
3. `"session"` cache — scoped to the CONVERSATION (`chatId:tool` in memory,
   not the WS session), granted by `scope:"session"`.
4. Default `always` (fail open for benign tools; a cache or absence never
   INTRODUCES a gate).

When the effective policy is `ask`: the row lands in the `gates` table (the
truth), `run.gate_request` fires on the run channel + ntfy `gateOpen`, the run
moves `waiting_approval`, and the `run:*` loop parks. A `run.approve` wakes it
— approve proceeds with that tool call; deny/timeout produces a tool result
like `rejected: denied by user` / `auto-denied: approval timed out` and the run
completes gracefully. Timeout is absolute from gate creation (default 15 min,
`FOUNDRY_GATE_TIMEOUT_MS`); the timeout itself closes the gate row as
`state:"timeout"` and emits `run.gate_resolved`. Boot with a parked run: the
open gate row re-arms (no re-ask, timeout rescaled to already-waited time).

## 2. REST plane (OpenAI-compatible)

Base: `http://host:8787/v1` — auth `Authorization: Bearer <api key>`.

- `POST /v1/chat/completions` — full OpenAI Chat Completions semantics:
  `stream` (SSE chunks incl. `tool_calls` deltas and final `[DONE]`),
  `stream_options.include_usage`, `tools`, `tool_choice`, `temperature`,
  `max_tokens`, `stop`. Non-stream returns a complete OpenAI response object
  with `usage`. Unknown fields are passed through, never rejected.
- `GET /v1/models` — `{ object: "list", data: [{ id, object: "model", ... }] }`.
  Model ids are `<provider>/<model>` (e.g. `ollama/llama3.1:8b`,
  `openrouter/anthropic/claude-sonnet-4.5`); bare `model` alias maps to default.
- `GET /healthz`, `GET /readyz`.
- `POST /hook/:hookId` (P3, webhooks) — public trigger plane: `Authorization`
  header NOT required; instead the request must carry `X-Foundry-Signature:
  sha256=<hex>` = HMAC-SHA256 of the RAW request body keyed by the hook's
  signing secret (`fndwhsec_…`, shown exactly once at creation). Unknown hook
  → 404; bad/missing signature → 401; OK → `{ ok: true, runId,
  conversationId }` and an agent run (`trigger:"webhook"`) processes the
  prompt. Body is JSON `{ content, title?, model? }` (400 otherwise), capped
  by the framework's 1 MiB body limit.

### 2.0a Egress plane for sandboxes (P2, ADR-005) — `/v1/egress/*`

Same Fastify app, separate auth: sandboxes authenticate with scoped per-env
Bearer tokens (`esc_<48 hex>`), which they receive ONLY as container env vars
(`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` = the esc token; `OPENAI_BASE_URL`/
`ANTHROPIC_BASE_URL` = the egress base URL). The egress plane speaks full
OpenAI chat-completions (stream + non-stream) and:

- **swaps the esc token for the real provider key** from the vault and routes
  through the normal provider layer — real keys never enter sandbox env;
- **meters usage** and stores raw provider traffic (redacted) as run_events;
- unlinked calls get a fresh run with `trigger:"sandbox"`; a live agent run
  can be attributed by sending its `X-Foundry-Run-Id` header — linked runs are
  NEVER status-bumped or appended to by their sandbox's own LLM sub-calls;
- `GET /v1/egress/models` lists enabled models only.
- (P5) the completions route is metered per env (one bucket per `esc` env;
  `FOUNDRY_RATE_API_PER_MIN`) — 429 in the OpenAI envelope; the models route
  stays unmetered. A sandbox can't hammer provider calls at unlimited rate.

Non-LLM egress is controlled by the OT egress firewall (`allowlist` mode;
`FOUNDRY_SANDBOX_EGRESS=open` on kernels without ipset — Docker Desktop).

Acceptance bar: Open WebUI and Cherry Studio can both use this endpoint as a
custom OpenAI-compatible provider with streaming + tool calling.

### 2.1 Admin REST (self-hosted operator plane)

Same port, same Bearer auth (the root admin key auto-minted at first boot is
written to `$FOUNDRY_DATA_DIR/admin_key.txt`; the file holds the only plaintext
copy, the DB stores hashes). OpenAI error envelope `{ error: { code, message } }`.

- `POST /v1/admin/providers` — upsert. With `id`: create (fresh id, 201) or
  patch (200) — operator config like `{"id":"ollama",...}` is idempotent;
  without `id`: create with a generated id. Body: `{ id?, kind:
  "openai_compat"|"anthropic"|"dummy", baseUrl?, apiKey?, models?: [{ id,
  name?, context?, caps?, priceIn?, priceOut? }] }`. Model ids become
  `<provider>/<model>` unless already prefixed. `apiKey` is accepted here
  ONCE (guardrail #2), vaulted, never echoed — responses and list carry
  `hasKey: boolean` only.
- `GET /v1/admin/providers` → `{ providers: [{ id, kind, baseUrl, enabled,
  hasKey }] }`.
- `DELETE /v1/admin/providers/:id` → `{ ok: true }` (404 unknown).
- `POST /v1/admin/keys` `{ name? }` → `{ id, name, key }` (plaintext exactly
  once); `GET /v1/admin/keys` → `{ keys: [{ id, name }] }`;
  `DELETE /v1/admin/keys/:id` → revoked keys stop verifying immediately.
- `POST /v1/auth/login` `{ username, password }` → `{ sessionToken, expiresAt }`
  — a 30-day session token for WS/REST (same shape as the WS `auth.login`).
  The OpenAI-compat `Bearer <api key>` plane is separate (above) and is not a
  login method.
- `POST /v1/auth/password` `{ currentPassword, newPassword(8–128) }` → `{ ok: true }`
  — self-service change for the authenticated user (401 on wrong current
  password; not required when the user has no password yet, i.e. a
  pre-ADR-006 row the boot could not backfill).
- `GET /v1/admin/mcp/servers` → `{ status: [{ name, connected, tools, error? }] }`;
  `PUT /v1/admin/mcp/servers` with a full MCP server list (settings-driven,
  ADR-006) reloads the MCP manager — tools join the agent registry
  namespaced `mcp__<server>__<tool>`.
- (P3) Schedules: `GET /v1/admin/schedules` → `{ schedules: Schedule[] }`;
  `GET /v1/admin/schedules/:id` → `Schedule` (404 unknown); `POST
  /v1/admin/schedules` `{ name, kind: "cron"|"every", spec, prompt, model?,
  targetChatId?, enabled? }` → 201 `Schedule` (400 on an invalid spec —
  validated by computing the next run up front); `PATCH
  /v1/admin/schedules/:id` (any field subset + `reschedule?: true`) →
  `Schedule` (spec changes and re-enabling always recompute `nextRunAt`);
  `DELETE /v1/admin/schedules/:id` → `{ ok }` (404 unknown).
- (P3) Hooks: `GET /v1/admin/hooks` → `{ hooks: [{ id, name, target: "chat",
  model?, createdAt }] }` (the secret is never listed); `POST
  /v1/admin/hooks` `{ name, model? }` → 201 `{ hook, secret, url }` — the
  vault-encrypted signing secret in PLAINTEXT exactly once (guardrail #2
  pattern); `DELETE /v1/admin/hooks/:id` → `{ ok }` (404 unknown). Then
  trigger it with `POST /hook/:id` (§2).
- `GET /term` — xterm.js terminal test page (dev convenience; P4 replaces it
  with the web client). Holds no special auth — the page authenticates itself
  over WS `connect`.
- (P5) `GET /v1/admin/audit` → `{ events: [{ id, at, userId, action, target,
  outcome, meta }] }` — the append-only audit log (ADR-017), newest first;
  `?limit=` caps the page (default 100).
- (P5) `POST /v1/admin/backup` → `BackupResult` — an online snapshot +
  incremental blob copy written under `$FOUNDRY_DATA_DIR/backups/<ts>/`
  (ADR-017); 409 `a backup is already running` while a run is mid-flight.
- (P5) `GET /v1/admin/backups` → `{ backups: [{ dir, bytes }] }` — newest
  first, the same listing the rotation prunes against.
- (P5) Rate limits: `POST /v1/chat/completions` is metered per identity
  (`FOUNDRY_RATE_API_PER_MIN`) and answers 429 in the OpenAI envelope
  (`{ error: { message: "rate limit exceeded", type: "api_error" } }`)
  without doing provider work; the metered routes are the completion
  endpoints only.

## 3. Core shapes (TypeBox, normative — implement exactly)

```ts
RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" |
            "cancelled" | "timeout"

Run = { id, conversationId?, trigger: "chat"|"schedule"|"webhook"|"manual"|"sandbox",
        status: RunStatus, model, budgets: { maxSteps, maxTokens, maxCostUsd,
        maxWallMs }, createdAt, startedAt?, endedAt?, summary?, error? }

Message = OpenAI ChatCompletionMessage (canonical):
  { role: "system"|"user"|"assistant"|"tool", content: string | parts[],
    tool_calls?: [{ id, type: "function", function: { name, arguments } }],
    tool_call_id?, name? }

Model = { id, provider, name, caps: { vision, tools, reasoning, json },
          context, priceInPerMtok?, priceOutPerMtok?, enabled }

Gate = { gateId, runId, tool, args, policy: "ask"|"always"|"session"|"deny",
         state: "open"|"approved"|"denied"|"timeout", resolvedBy?, createdAt,
         resolvedAt? }                           // gates tables IS the truth

FileEntry = { path, size, mtime, isDir }
```

## 4. Terminal wire

- `term.data` payloads are terminal bytes as text (or base64 when `b64:true`).
- Server-side scrollback ring buffer: 2000 lines per term; replayed on
  `term.open` and reconnect. One live session per env — a second `term.open`
  rejoins the SAME termId.
- Test page: `GET /term` (xterm.js via CDN; API key stored client-side in
  localStorage). Used for P2 acceptance; P4's web client supersedes it.
- Envs idle > `FOUNDRY_ENV_TTL` (default 2h) may be reclaimed; workspace
  files always persist (host volume), containers are disposable.

## 5. Versioning & compatibility

- `connect.params.protocol` must equal `PROTOCOL_VERSION` or the server
  replies `res { ok:false, error:{ code:"bad_request" } }` with supported
  versions in `error.message`.
- Additive changes only within a version (new optional fields, new methods).

## Changelog

- v0 (2026-10-07): initial spec.
- v0 (2026-10-07, P1): clarified two points the implementations settled —
  (a) `idem` rides on the WS FRAME (§1.1), uniform for every side-effecting
  method, never inside params; (b) connect with a mismatched `protocol`
  returns `bad_request` whose `error.message` lists supported versions (the
  schema accepts any non-negative integer so this check, not schema
  validation, produces the negotiation hint). Added §2.1 admin REST.
- v0 (2026-10-07, P2, additive): agent runtime + sandbox + terminal.
  (a) `run.tool_result` payload settled as `{ id, ok, content }` (was
  `{ callId, result, ok }` — content carries the tool output text the
  timeline needs); (b) `run.status` gained optional `resumed` flag;
  (c) `term.exit.code` is null on explicit `term.close` (was int-only);
  (d) `Run.trigger` gained `"sandbox"` (egress-plane sub-calls);
  (e) §2.0a egress plane for sandboxes; (f) admin REST gained MCP server
  endpoints; (g) idempotency list aligned to the implemented
  IDEMPOTENT_METHODS (term.open/input/resize/close and files.mkdir/rm are
  side-effecting; there is no `run.start` — runs start via `chat.send`).
- v0 (2026-10-07, P3, additive): autonomy. (a) `run.gate_request` payload is
  FLAT `{ gateId, runId, tool, args, policy, createdAt }` (was a nested
  `gate:` wrapper); (b) `run.gate_resolved` gained `state` and fires for
  timeout auto-denies too; (c) `run.approve` returns the resolved Gate (was
  `{}`) and validates scope; (d) `run.get` carries `gates: Gate[]` while open
  gates exist; (e) §1.5 added — gate policy precedence + session scope means
  the CONVERSATION, timeout auto-deny closes the gate row; (f) §2 hook
  trigger plane: HMAC over the RAW body against a vault-encrypted `fndwhsec_`
  secret shown once (`POST /v1/admin/hooks`), no bearer auth on `/hook/:id`;
  (g) schedules + hooks admin are REST-only (§2.1) — the WS
  `admin.schedules.*` placeholder was dropped; (h) memory: `memory` agent
  tool (store/search/delete) + top-k injection into the agent system prompt
  (embeddings via a configured embedding-capable provider, deterministic
  fallback); (i) `notify.push` fires for run done/failed, gate open, and
  schedule/webhook fires; (j) `snapshot.activeRuns` includes
  `waiting_approval` runs.- v0 (2026-10-13, P4, additive): first client + delivery. (a) `packages/sdk-ts`
  complete vs this doc: typed WS helper per §1.3 method (idempotency key as a
  second argument on side-effecting methods), REST client for §2/§2.1,
  auto-reconnect on unexpected close via cumulative cursors (auth failure is
  permanent for that socket), SDK error surface unified as `FoundryError`
  (`code` = the OpenAI envelope `type`); (b) the web app connects with
  `client.kind: "web"` and is served by core same-origin (no CORS): GET /
  returns the SPA shell, unmatched non-API GETs fall back to it
  (`FOUNDRY_WEB_DIR` or the repo build dir), while unknown `/v1|/hook` paths
  still answer with the OpenAI error envelope; (c) `files.mkdir`/`files.rm`
  accept their full param shapes (`recursive`) — earlier SDK helpers narrowed
  them; (d) no wire changes — P4 is additive consumers only.

- v0 (2026-10-13, local-execution plane, additive): desktop executor bridge +
  chat env binding (ADR-015). (a) `CLIENT_KINDS` gains `"executor"` (the
  desktop runner); (b) new client→server methods `exec.register` /
  `exec.status` / `exec.pty.data` / `exec.pty.exit` — none of them idem-
  required; (c) §1.3a server→client executor plane exists: connections
  registered as executors may receive `req` frames and answer `res` with the
  same id (every other connection still rejects non-req inbound frames);
  (d) new event `executor.status` on `sys`; (e) `chat.send {agent}` gains
  `location?: "local" | "cloud"` and `chat.list`/`ChatSummary` gains additive
  `location?` / `envId?` — a chat binds where its tool calls execute and runs
  persist `runs.envId`; (f) `POST /v1/chats/:chatId/push` (L3) migrates a
  local chat to a backend env: workspace tar pulled over the bridge, restored
  into a per-chat cloud workspace, then an agent run (trigger "push")
  reconstructs the environment from the chat's install history; the binding
  flips to cloud on completion (`sys.resync` on `chat:{id}`).
- v0 (2026-10-20, P5, additive): hardening. (a) `chat.send` can answer
  `capacity` (`chat rate limit exceeded` after FOUNDRY_RATE_CHAT_PER_MIN /
  `concurrent run limit reached` after FOUNDRY_MAX_CONCURRENT_RUNS) BEFORE
  any persistence — a denied send leaves no user message or run row; (b)
  run.get/events/cancel/approve and the term/files planes reject another
  user's run with the SAME 404 as an unknown one (multi-user audit; explicit
  `envId` in term.open/files.* must belong to the caller); (c) §2.1 gained
  the audit/backup admin routes + completions rate limit (429 envelope);
  (d) `POST /v1/chats/:chatId/push` refuses foreign chats with the same 404.
- v0 (2026-10-20, close-out, additive): run liveness + egress metering. (a)
  OT env creation fails FAST when the container dies during startup (502
  "exited during startup <exit code>" — the driver probes container liveness
  alongside OT readiness instead of waiting out the 120s window; the agent
  run fails through the normal path with a timeline `error` event); (b)
  `/v1/egress/chat/completions` is metered per env (429 envelope, §2.0a);
  (c) sdk-ts gained `adminListAudit` / `adminRunBackup` / `adminListBackups`
  and the web settings gained a System tab (audit log + backup trigger/list).
