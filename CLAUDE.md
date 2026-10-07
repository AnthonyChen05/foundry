# CLAUDE.md — Foundry (working codename — rename freely)

> Self-hosted backend for LLM frontends: API gateway + provider switchboard +
> autonomous agent runtime + sandboxed VM/terminal + filesystem.
> This file is the entry point. Read it fully, then read the docs in order.

## Mission

One backend, three first-party frontends (Android app, Windows app, self-hosted
web app) plus **any** OpenAI-compatible client. It routes chat traffic to
OpenAI-compatible providers (Ollama, LM Studio, vLLM, OpenRouter, Groq, OpenAI,
Anthropic via a translation shim), runs autonomous agent loops with tool use,
approval gates, schedules and long-term memory, and gives agents a sandboxed
Linux environment ("VM") with a terminal, a filesystem, and snapshots.

Design slogan (borrowed from OpenClaw): **trusted gateway, untrusted execution.**

Owner: single self-hosted user (Anthony). Schema stays multi-user-ready.

## Stack (pinned — do not swap without user approval)

- Node 22 LTS, TypeScript 5 (strict, ESM), pnpm workspaces
- Fastify 5 + `@fastify/websocket` — HTTP and WS on one port (default 8787)
- `@sinclair/typebox` for ALL wire schemas (single source of truth in
  `packages/protocol`); generates JSON Schema for future client codegen
- Drizzle ORM + better-sqlite3, SQLite in WAL mode; `sqlite-vec` extension for
  memory vectors
- Sandbox: driver interface (see docs/architecture.md §5).
  Driver #1 = **Open Terminal** container (`ghcr.io/open-webui/open-terminal`,
  MIT — REST exec, file API, PTY sessions, egress firewall).
  Driver #2 = raw Docker via `dockerode` (tests + fallback).
- MCP client: `@modelcontextprotocol/sdk` (stdio + streamable HTTP)
- Push: ntfy (self-hosted). Remote access: Tailscale. **No cloud services.**

## Target repo layout

```
foundry/
├── CLAUDE.md, README.md, docs/     # this handoff
├── packages/protocol/              # TypeBox schemas, wire types, PROTOCOL_VERSION
├── packages/sdk-ts/                # thin client SDK (WS + REST) for all frontends
├── apps/core/                      # THE monolith: gateway, providers, agent, sandbox, storage
└── apps/web/                       # (P4) SvelteKit web app
```

**Monolith-first. Do NOT split into microservices.** One Node process plus
sidecar sandbox containers; split only when something measurably hurts.

## Current phase

**P0 → P1.** Follow `docs/build-order.md` exactly; every phase has
acceptance criteria. Never start phase N+1 until N passes. P3 (autonomy) is
off-limits until P2 passes.

## Hard guardrails (security — never violate)

1. Agent tool calls NEVER execute on the host. All exec/files/PTY go through
   the sandbox driver interface, nothing else.
2. Provider API keys live only in the gateway vault (AES-256-GCM; master key
   from `FOUNDRY_MASTER_KEY`). Keys are never logged, never sent to clients,
   and NEVER placed in sandbox env — sandboxes egress through the gateway
   proxy using scoped, short-lived tokens only.
3. Sandbox containers: non-root, resource caps (cpu/mem/pids), no docker
   socket, egress only via the gateway proxy.
4. Every provider request/response is stored raw (keys redacted) to
   `run_events` for debugging.
5. WS: first frame must be `connect` (else hard close); side-effecting
   methods require idempotency keys.

## Conventions

- Strict TS: no `any`, no `!` non-null assertions, no `enum` (use unions), ESM only.
- All wire/message types live in `packages/protocol`; `apps/core` imports, never redefines.
- DB migrations via drizzle-kit; schema evolves additively. Every domain table
  carries `user_id` (multi-user-ready).
- Config via env, `FOUNDRY_*` prefix: `FOUNDRY_PORT=8787`, `FOUNDRY_DATA_DIR`,
  `FOUNDRY_DB_PATH`, `FOUNDRY_MASTER_KEY`, `FOUNDRY_INTEGRATION=1`.
- vitest for tests. Integration tests needing Docker check `FOUNDRY_INTEGRATION`
  and skip otherwise.
- Canonical message/tool format = **OpenAI Chat Completions** everywhere
  internally; Anthropic is translated at the adapter edge (see ADR-002).

## Verify your work

- `pnpm test` — unit
- `FOUNDRY_INTEGRATION=1 pnpm test` — needs Docker; spins an Open Terminal container
- `pnpm dev` → `http://127.0.0.1:8787/healthz` must return ok
- `pnpm smoke` — streams a chat completion from the dummy provider through
  `POST /v1/chat/completions`

## Non-goals for v1

Multi-tenant auth (schema-ready only), Kubernetes, Firecracker driver
(interface only — do not implement), hosted/SaaS mode, RAG pipelines beyond
long-term memory, voice.

## Doc map (read in this order)

1. `README.md` — what this handoff is
2. `docs/architecture.md` — components, data flows, deployment
3. `docs/protocol.md` — WS + REST contract (v0) ← the product
4. `docs/data-model.md` — SQLite schema
5. `docs/decisions.md` — ADRs (the "why")
6. `docs/build-order.md` — phases, tasks, acceptance criteria ← your TODO list
7. `docs/prior-art.md` — what to study/borrow, licenses

If docs conflict with user instruction, user wins — then update the doc.