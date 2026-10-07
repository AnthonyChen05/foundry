# Foundry — handoff spec package

**What this is:** a complete design spec for a self-hosted LLM backend —
API gateway + OpenAI-compatible provider switchboard + autonomous agent
runtime + sandboxed VM/terminal + filesystem — written to be executed by an
autonomous coding agent (Claude Code). Generated 2026-10-07. No code exists
yet; these docs are the source of truth.

**Working codename:** `foundry` (placeholder — rename freely). Owner: Anthony.

## How to use with Claude Code

1. Create the real repo (e.g. `foundry`), copy **everything** in this folder
   to the repo root (so `CLAUDE.md` sits at root — Claude Code auto-loads it).
2. Start Claude Code in the repo and say:
   > Read CLAUDE.md, then docs/build-order.md. Start P0.
3. After each phase, make the agent run the phase's acceptance criteria before
   moving on. `docs/build-order.md` is the TODO list; `docs/protocol.md` is
   the contract all three frontends will code against.

## File map

| File | Purpose |
|---|---|
| `CLAUDE.md` | Agent instructions: mission, pinned stack, guardrails, conventions |
| `docs/architecture.md` | Components, planes, data flows, sandbox drivers, deployment |
| `docs/protocol.md` | **v0 wire protocol** — private WS + OpenAI-compatible REST |
| `docs/data-model.md` | SQLite schema (WAL) + blob store + vector index |
| `docs/build-order.md` | Phases P0–P5, tasks, acceptance criteria, first sprint |
| `docs/decisions.md` | Ten ADRs capturing every locked-in decision |
| `docs/prior-art.md` | OpenClaw, Open Terminal, sbx, LiteLLM, E2B — what to steal |
| `assets/architecture.svg` | System diagram (v0) |

## One-paragraph summary

A single TS/Node monolith exposes two inbound planes: a typed private
WebSocket protocol for the first-party Android/Windows/web clients, and an
OpenAI-compatible REST surface (`/v1/chat/completions`) so existing tools
(Open WebUI, Cherry Studio, OpenClaw, curl) can use it as a "provider" on day
one. Outbound, adapters normalize Ollama/LM Studio/vLLM/OpenRouter/OpenAI plus
an Anthropic⇄OpenAI shim, with a key vault, routing rules, failover and usage
metering. An agent runtime executes tool-using loops inside swappable sandbox
drivers (driver #1: an Open Terminal container; driver #2: raw Docker;
Firecracker later), with approval gates (`ask`/`always`/`session`), cron +
webhook triggers, long-term memory in sqlite-vec, and MCP servers as tools.
Runs are resumable, append-only event logs. Push via ntfy; remote access via
Tailscale; zero cloud.

## The sync principle

The backend is the **sync engine**. All frontends are thin views + command
senders over server-authoritative state; no client owns truth. Consistency
comes free: per-channel `seq` cursors on events, ring-buffer replay on
reconnect, `sys.resync` when a client falls outside the buffer, and refetch
methods (`chat.history`, `run.events`) as the convergence path.

## Quickstart (P1 state)

Status: P1 gateway MVP — provider adapters (`dummy` scripted, `openai_compat`,
`anthropic` shim), OpenAI-compatible REST with SSE streaming, private WS plane
(connect handshake, per-channel seq + replay buffer, chat.*), SQLite persistence,
usage ledger, key vault.

```sh
pnpm install                       # first time
cp .env.example .env               # then set FOUNDRY_MASTER_KEY (required)
pnpm dev                           # boots on 127.0.0.1:8787
curl http://127.0.0.1:8787/healthz # -> {"ok":true,...}
pnpm test                          # unit tests (no Docker needed)
pnpm smoke                         # end-to-end: REST SSE + WS chat + replay
```

Use it as an OpenAI-compatible provider from any client (curl `-N` = no buffer):

```sh
KEY=$(cat data/admin_key.txt)      # auto-minted at FIRST boot only
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"dummy/scripted","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

Register a real provider once (stable id, idempotent — repeat calls patch):

```sh
curl http://127.0.0.1:8787/v1/admin/providers -X POST \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"id":"ollama","kind":"openai_compat","baseUrl":"http://127.0.0.1:11434",
       "models":[{"id":"ollama/gemma3:4b","name":"Gemma 3 4B","caps":{"tools":true}}]}'
# then: model "ollama/gemma3:4b" through the same /v1/chat/completions
pnpm probe:ollama  # automated version of the above against a local Ollama
```

Notes:
- `FOUNDRY_MASTER_KEY` is required; without it core refuses to start (no keys
  at rest without vault). Provider keys are accepted once via admin REST,
  stored AES-256-GCM, never echoed or logged.
- Relative `FOUNDRY_DATA_DIR` (default `./data`) resolves from the process
  cwd — start core from the repo root unless you want `apps/core/data`.
- Node: the stack pins Node 22 LTS; this machine currently runs Node 25.8.1
  (tests + boot verified on it).