# Foundry

Self-hosted LLM backend: an OpenAI-compatible API gateway + provider
switchboard + autonomous agent runtime + sandboxed Linux "VM" with a
terminal, a filesystem, and snapshots — in one Node process, with zero cloud
services.

<p align="center">
  <img src="docs/screenshots/01-chat.png" width="820" alt="Chat — live streaming reply, conversation list, and the run inspector (Run / Term / Files) on the right"/>
</p>

## Why

One backend, three first-party clients (Android, Windows, web) plus **any**
OpenAI-compatible tool (Open WebUI, Cherry Studio, LM Studio, curl). Your
remote access is Tailscale; your provider runs local (Ollama, LM Studio,
vLLM) or hosted (OpenRouter, Groq, OpenAI, Anthropic via an adapter shim);
your keys live in the gateway's AES-256-GCM vault; your push notifications
come from self-hosted ntfy. Nothing phones home.

Trust model in one line: **trusted gateway, untrusted execution.** Agent tool
calls never run on the host — they run inside disposable, resource-capped
Open Terminal containers that never hold a real provider key (they carry a
short-lived scoped token and egress through the gateway's proxy), can't see
the docker socket, and drop to a non-root user.

## Features

- **Gateway** — `POST /v1/chat/completions` (SSE + non-stream), `GET
  /v1/models`, and a private WebSocket plane (connect handshake, per-channel
  sequence numbers, ring-buffer replay on reconnect) — all on port 8787.
  Providers: Ollama, LM Studio, vLLM, OpenRouter, Groq, OpenAI, Anthropic
  (shimmed), plus a deterministic dummy for tests.
- **Agent runtime** — a resumable tool loop (`shell`, `fs.*`, `fetch`,
  `done`, plus MCP tools from settings-driven servers). Every step journals
  to an append-only run event log, so a kill mid-run resumes on the next
  boot. Long-term memory (sqlite-vec) persists and is recalled into later
  chats.
- **Approval gates** — gate any tool per chat (`ask` / `always` / `session`
  / `deny`); gated calls park the run, ping ntfy, and wait for
  `run.approve` from any client (with scope: once / this session / always).
  Timeout auto-denies.
- **Sandbox** — a PTY terminal with binary-safe streaming + scrollback
  replay, full file read/write/list/mkdir/rm, and workspace snapshots
  (tar.gz of the whole workspace at run end, keep 20).
- **Autonomy** — cron schedules and HMAC webhooks trigger runs; run
  done/failed/gate-open events push to your phone (ntfy).
- **Desktop/local mode + push-to-cloud** — per chat, run the agent in the
  backend's sandbox or in a container on YOUR desktop (the runner process +
  the executor bridge). Push a local chat to the cloud: the workspace tars
  over, and a reconcile run reinstalls the dependencies you had installed.
- **Hardening** — per-user ownership on every run/env/chat access (foreign
  ids 404 like unknown ones), per-user rate limits + concurrent-run quota
  (denied before anything persists), per-identity metering on the
  completions + egress planes, an append-only audit log, a daily backup job
  (online SQLite snapshot + incremental blob copy, keep 7), password auth
  (scrypt), and an opt-in gVisor runtime.

## What it looks like

Web client (served same-origin by core):

<p align="center">
  <img src="docs/screenshots/01-chat.png" width="820" alt="Chat — live streaming reply, conversation list, and the run inspector (Run / Term / Files) on the right"/>
</p>
<p align="center">
  <img src="docs/screenshots/02-gate.png" width="820" alt="Run timeline — a sandboxed shell call is parked on an approval gate; scope + Approve/Deny; live tool events stream below"/>
</p>
<p align="center">
  <img src="docs/screenshots/04-term.png" width="820" alt="Inspector terminal tab — a live PTY into the sandboxed Open Terminal container (prompt, ls output, echo roundtrip)"/>
</p>

The Android client (Kotlin + Compose) is a thin view over the same WS plane:
streaming chats, the run timeline with gate approve/deny, a PTY terminal, a
file browser, ntfy push handling — fold-aware: two-pane list/detail on
unfolded foldables, split at the hinge.

## Quickstart

> Full deployment guide — including the **Docker Compose** path for Linux —
> lives in [`docs/setup.md`](docs/setup.md).

```sh
pnpm install
cp .env.example .env               # set FOUNDRY_MASTER_KEY (required)
pnpm build                         # core, sdk, and the web SPA
pnpm dev                           # http://127.0.0.1:8787 (web UI at /)
```

First boot creates the owner account. Sign in with the username (default
`admin`) and the password you set in `FOUNDRY_ADMIN_PASSWORD` — or read the
generated one from `data/admin_credentials.txt`. API keys (for
OpenAI-compatible clients) are minted in the admin UI once and never shown
again.

Use it from any OpenAI-compatible client:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"dummy/scripted","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

Register a real provider (idempotent; repeat calls patch):

```sh
curl http://127.0.0.1:8787/v1/admin/providers -X POST \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"id":"ollama","kind":"openai_compat","baseUrl":"http://127.0.0.1:11434",
       "models":[{"id":"ollama/gemma3:4b","name":"Gemma 3 4B","caps":{"tools":true}}]}'
pnpm probe:ollama                  # automated real-provider check
```

## The clients

| Client | Where | What it is |
|---|---|---|
| Web | served by core at `/` (same origin) | SvelteKit 2 + Svelte 5 SPA: chat, run timeline, terminal (xterm.js), files, settings |
| Windows | [`apps/desktop`](apps/desktop) (Tauri) | a thin native shell that loads the core's origin; supervises the local-sandbox runner |
| Android | [`apps/android`](apps/android) (Kotlin + Compose) | thin view over the same WS plane; fold-aware two-pane; ntfy push; sideload the APK from Releases |
| Any OpenAI client | `/v1/*` | API-key Bearer; SSE streaming; tool calling |

`packages/sdk-ts` is the typed WS+REST SDK every frontend is built on.

## How it's built

TS/Node monolith (Node 22 LTS, TypeScript 5 strict, pnpm workspaces;
Fastify 5 + `@fastify/websocket` on one port). SQLite (WAL) via Drizzle;
`sqlite-vec` for memory vectors; TypeBox schemas are the single wire-format
source of truth (`packages/protocol` → JSON Schema). Sandboxes are swappable
drivers: #1 Open Terminal containers (MIT), #2 raw Docker (tests/fallback),
with a Firecracker driver interface reserved.

- [`docs/architecture.md`](docs/architecture.md) — components, planes, data
  flows, deployment topology
- [`docs/protocol.md`](docs/protocol.md) — the wire contract (WS methods +
  events, REST surface, core shapes)
- [`docs/setup.md`](docs/setup.md) — operator setup guide (Docker Compose +
  host paths, operating + troubleshooting)
- [`docs/decisions.md`](docs/decisions.md) — the ADRs (why each mechanism
  looks the way it does)
- [`docs/data-model.md`](docs/data-model.md) — SQLite schema
- [`docs/build-order.md`](docs/build-order.md) — the phase plan the repo was
  built in (P0 foundation → P5 hardening), with acceptance criteria

## Develop

```sh
pnpm test                          # unit tests (no Docker needed)
FOUNDRY_INTEGRATION=1 pnpm test    # with Docker: real sandbox containers
pnpm lint && pnpm typecheck
pnpm smoke                         # end-to-end: REST SSE + WS + SPA + gated run
```

Notable env knobs (all optional beyond `FOUNDRY_MASTER_KEY`): see
[`.env.example`](.env.example) — rate limits, concurrent-run quota, backup
cadence, sandbox image/OCI runtime/egress mode, ntfy, admin bootstrap.

## License

[MIT](LICENSE).