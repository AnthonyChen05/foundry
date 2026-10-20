# Build order — phases, tasks, acceptance criteria

Work strictly in phase order. A phase is DONE only when every acceptance
criterion passes. `pnpm smoke` must stay green after every change.

## P0 — Scaffold & foundation

Tasks:
1. pnpm workspace: `packages/protocol`, `packages/sdk-ts` (empty), `apps/core`.
   Root tsconfig (strict, ESM), vitest setup, drizzle config.
2. `packages/protocol`: TypeBox schemas for every shape in `docs/protocol.md`
   §3 + frame types + `PROTOCOL_VERSION = 0`. Export compiled JSON Schema.
3. `apps/core`: Fastify bootstrap (HTTP+WS one port 8787), pino logger,
   config loader (`FOUNDRY_*`), `/healthz`, `/readyz`.
4. Drizzle schema for ALL tables in `docs/data-model.md` + first migration.
5. Vault module: AES-256-GCM roundtrip, master key from env, error if missing.

Acceptance:
- `pnpm test` green; vault roundtrip test passes.
- `curl 127.0.0.1:8787/healthz` → ok; DB file created with all tables.
- `packages/protocol` exports types + JSON Schema; core imports from it only.

## P1 — Gateway MVP (OpenAI-compatible + WS chat)

Tasks:
1. Provider adapters: `dummy` (scripted streaming, tools, deterministic), 
   `openai_compat` (stream/non-stream, tool_calls, usage, pass-through),
   `anthropic` shim (translate both directions: system, tools, streaming,
   thinking → reasoning; store raw responses as run_events).
2. REST: `POST /v1/chat/completions` (SSE + JSON), `GET /v1/models` from
   catalog. Provider CRUD + key vault via admin REST (keys accepted once).
3. WS: `connect` handshake + resume/replay buffer; `chat.*` methods;
   `chat.delta`/`chat.final` events; conversations + messages persisted.
4. `packages/sdk-ts`: thin WS client (connect, send, event subscription) +
   REST helpers. Used by smoke test.
5. Usage ledger rows per provider request.

Acceptance:
- `curl -N` streaming completion from dummy AND a real openai_compat endpoint
  (Ollama if available) with correct SSE chunks + `[DONE]` + usage.
- Open WebUI added as custom OpenAI-compatible provider → streaming chat works
  (manual check, note in PR).
- WS client: send → receive deltas → final persisted; reconnect replays
  buffered events from `lastSeq`.
- Kill core mid-stream → restart → history intact.

## P2 — Agent runtime + sandbox + terminal

Tasks:
1. `SandboxDriver` interface; `OpenTerminalDriver` (wrapper over OT REST:
   exec, files, PTY sessions) + `DockerDriver` (dockerode; used to LAUNCH the
   OT containers: non-root, caps, no socket, egress firewall on).
2. Egress proxy: gateway route that accepts scoped per-env tokens, swaps real
   provider keys, meters usage; env var injection `OPENAI_BASE_URL`-style
   pointing at the proxy.
3. Agent runtime: canonical loop (OpenAI tools format) with budgets; tools
   `shell`, `fs.*`, `fetch`, `done`; every step → `run_events`; runs resume
   from event log on boot.
4. WS `run.*` methods + events; timeline replay.
5. WS `term.*` + PTY plumbing; minimal test page at `/term` (xterm.js via CDN
   is fine for the test page only).
6. MCP client: settings-driven servers (stdio first), tools namespaced into
   registry.

Acceptance:
- Agent run: "create hello.py in the sandbox and run it" completes; events
  replayable; snapshot taken at run end.
- `run.gate_request` NOT yet required (P3) — shell runs under policy `always`
  by default in P2.
- PTY works from the `/term` test page; resize works; reconnect replays
  scrollback.
- Kill core mid-run → restart → run resumes and completes.
- MCP tool (any local stdio server) callable by the agent.

## P3 — Autonomy

Tasks:
1. Approval gates: policy resolution (`ask`/`always`/`session`/`deny` per
   tool), `run.gate_request`/`run.gate_resolved`, timeout auto-deny (15 min),
   session-scoped approvals cached per session.
2. Schedules: cron parser + `next_run_at`; 30 s tick; missed ticks coalesced;
   runs triggered with stored prompt.
3. Webhooks: `POST /hook/:id` + HMAC verify → run.
4. Memory: embeddings via configured provider (prefer local Ollama),
   sqlite-vec index, top-k injection, `memories` CRUD ops as agent tool.
5. ntfy push: run done / gate open / run failed.

Acceptance:
- Gated destructive tool call parks run; client approves → resumes; deny →
  run handles rejection gracefully; timeout → auto-deny recorded.
- A schedule fires and produces a run with ntfy push.
- Memory written in chat A is recalled in chat B (test asserts injection).
- Webhook with valid HMAC triggers a run; bad HMAC → 401.

## P4 — Clients

Tasks:
1. `sdk-ts` complete vs `docs/protocol.md` (WS + REST + types + reconnect).
2. Web app (SvelteKit, served by core or sidecar): chat, run timeline with
   approve/deny buttons, terminal (xterm.js), file browser, settings
   (providers/models/keys/schedules).
3. Windows app: Tauri shell reusing the web app UI.
4. Android app: Kotlin + Compose; WS chat + run timeline + approvals +
   ntfy push handling.

Acceptance: all three frontends chat live, watch a gated run, resolve the
gate, and open a terminal session.

## P5 — Hardening

Tasks:
1. Multi-user audit: every run/env/chat resolution filters by owner —
   `run.get`/`events`/`cancel`/`approve` assert ownership, term/files reject
   foreign (or unknown) `envId` 404, chat pushes verify the chat before
   pulling (all 404s indistinguishable).
2. Limits: per-user token bucket on `chat.send` + per-identity bucket on the
   completions REST plane (429 envelope); per-user concurrent-run quota
   (stateless count of in-flight rows); both deny BEFORE persistence.
3. Audit log: append-only `audit` table (migration 0008), fire-and-forget
   recording with run_events redaction discipline, `GET /v1/admin/audit`.
   Instrumented: auth.login ok/denied, auth.password, gate.resolve,
   executor.register, all admin mutations, chat.push/denied sends, admin.backup.
4. Backup job: online sqlite `.backup()` snapshot + incremental
   content-addressed blob copy, keep 7, dir-stamped (ms precision);
   `FOUNDRY_BACKUP_MIN` periodic (boot-time first run) + `POST
   /v1/admin/backup` + `GET /v1/admin/backups` (409 while busy).
5. Opt-in gVisor: `FOUNDRY_SANDBOX_RUNTIME` / runner `--runtime` →
   `DockerLauncher.runtimeField` → `HostConfig.Runtime` on every container
   each process launches (byte-shape unchanged when unset).
6. Load test: 10 concurrent SSE completions streams (unit-level, dummy).

Acceptance:
- All P5 specs green: limits.spec.ts (buckets/quotas), backup.spec.ts
  (snapshot validity, incremental skip, rotation, re-entry, FOUNDRY_BACKUP_MIN=0),
  hardening.spec.ts (rate/quota deny before persistence, REST 429, audits,
  foreign access → 404, runtime field, config knobs), load.spec.ts
  (10 concurrent streams complete intact, faster than serial).
- `pnpm test` + `pnpm lint` + typechecks green; `pnpm smoke` stays green;
  existing suite unaffected by the new ownership asserts.
- ADR-016/017/018 recorded; protocol/data-model/architecture updated
  (audit table, admin routes, capacity semantics).

---

## First sprint checklist (do this first, in order)

- [ ] `pnpm init` workspace + tsconfig strict + vitest + eslint+prettier
- [ ] `packages/protocol`: all §3 shapes + frames + `PROTOCOL_VERSION=0`
- [ ] `apps/core` Fastify: `/healthz`, `/readyz`, config, pino
- [ ] Drizzle: full schema + migration 0001
- [ ] Vault module + roundtrip test
- [ ] Dummy provider (scripted SSE stream + one scripted tool call)
- [ ] `POST /v1/chat/completions` (non-stream + stream) against dummy
- [ ] `GET /v1/models` from DB catalog
- [ ] WS `connect` handshake + `chat.send`/deltas/final against dummy
- [ ] `pnpm smoke` script tying it together
- [ ] README quickstart section
- [ ] All P0 acceptance criteria green

Definition of done (per PR): tests pass, `pnpm smoke` green, no `any`, raw
provider responses stored, docs updated if the contract changed.