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
  (`chat.send`, `run.start`, `run.approve`, `term.*` writes, `files.write`).
  Server keeps a short-lived dedupe cache (10 min).
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
| `chat.send` | `{ chatId, content, attachments?, model?, agent?: { enabled, toolPolicy? } }` → `{ runId }` | start of everything; agent:true = autonomous run |
| `run.get` | `{ runId }` → `Run` | status, budgets, summary |
| `run.events` | `{ runId, since? }` → `RunEvent[]` | replay for timeline UI |
| `run.cancel` | `{ runId }` → `{}` | |
| `run.approve` | `{ runId, gateId, approve, scope?: "once"\|"session"\|"always" }` → `{}` | resolves a gate |
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
| `admin.schedules.*` | CRUD schedules | |
| `auth.login` | `{ apiKey }` → `{ sessionToken, expiresAt }` | REST-issued too |

Side-effecting methods (chat.send, run.start, run.approve, term.input/close,
files.write, run.cancel) carry `idem` **on the frame itself** (§1.1), never
inside params — the hub's dedupe middleware reads one uniform location.

### 1.4 Events (v0)

| Event | Channel | Payload |
|---|---|---|
| `chat.delta` | `chat:{id}` | `{ runId, delta }` |
| `chat.final` | `chat:{id}` | `{ message }` (canonical OpenAI message) |
| `run.status` | `run:{id}` | `{ runId, status, error? }` |
| `run.delta` | `run:{id}` | `{ text? , reasoning? }` |
| `run.tool_call` | `run:{id}` | `{ call: { id, name, args } }` |
| `run.tool_result` | `run:{id}` | `{ callId, result, ok }` |
| `run.gate_request` | `run:{id}` | `{ gate: { gateId, tool, args, policy, createdAt } }` |
| `run.gate_resolved` | `run:{id}` | `{ gateId, approved, scope }` |
| `run.usage` | `run:{id}` | `{ promptTokens, completionTokens, costEst, latencyMs }` |
| `term.data` | `term:{id}` | `{ data, b64? }` |
| `term.exit` | `term:{id}` | `{ code }` |
| `notify.push` | `notify` | `{ title, body, runId? }` |
| `sys.resync` | any | client must refetch channel state |

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
- (P3) `POST /hook/:hookId` — HMAC-SHA256 signature header `X-Foundry-Signature`.

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
- `POST /v1/auth/login` `{ apiKey }` → `{ sessionToken, expiresAt }` — a
  short-lived session token for WS/REST (same shape as the WS `auth.login`).

## 3. Core shapes (TypeBox, normative — implement exactly)

```ts
RunStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" |
            "cancelled" | "timeout"

Run = { id, conversationId?, trigger: "chat"|"schedule"|"webhook"|"manual",
        status: RunStatus, model, budgets: { maxSteps, maxTokens, maxCostUsd,
        maxWallMs }, createdAt, startedAt?, endedAt?, summary?, error? }

Message = OpenAI ChatCompletionMessage (canonical):
  { role: "system"|"user"|"assistant"|"tool", content: string | parts[],
    tool_calls?: [{ id, type: "function", function: { name, arguments } }],
    tool_call_id?, name? }

Model = { id, provider, name, caps: { vision, tools, reasoning, json },
          context, priceInPerMtok?, priceOutPerMtok?, enabled }

Gate = { gateId, runId, tool, args, policy: "ask"|"always"|"session"|"deny",
         createdAt }

FileEntry = { path, size, mtime, isDir }
```

## 4. Terminal wire

- `term.data` payloads are terminal bytes as text (or base64 when `b64:true`).
- Server-side scrollback ring buffer: 2000 lines per term; replayed on
  `term.open` and reconnect.
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