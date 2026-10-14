# Decisions (ADRs)

Status key: accepted (date). Supersede by appending, never editing history.

## ADR-001 — TypeScript + Node monolith
Accepted 2026-10-07. One language across core, webapp, SDKs; first-class MCP
TS SDK; dockerode + node-pty mature; Fastify for HTTP+WS. Consequences:
single process to reason about; split later only under measured pain.

## ADR-002 — OpenAI Chat Completions is the canonical wire format, both directions
Accepted 2026-10-07. Inbound REST is OpenAI-compatible so ANY OpenAI-compatible
client (Open WebUI, Cherry Studio, OpenClaw, curl) works day one. Internal
messages/tools use OpenAI shapes; Anthropic is translated at the adapter edge
(system, tools, streaming, thinking→reasoning). Never invent a new format.
Consequence: some Anthropic features are lossy in v0 (document in adapter).

## ADR-003 — Runs are resumable, append-only event logs
Accepted 2026-10-07. Every run persists an ordered event stream
(LLM deltas, tool calls/results, gate requests/resolutions, raw provider
traffic, status transitions). `runs.status` is materialized from events.
Consequences: crash recovery = replay; approval gates = park + resume;
audit + client timeline UI come free. Cost: discipline in event design.

## ADR-004 — Sandbox = swappable driver interface; Open Terminal is driver #1
Accepted 2026-10-07. `create/exec/openPty/files/snapshot/destroy` interface.
Driver #1 wraps `ghcr.io/open-webui/open-terminal` (MIT: REST exec, file API,
PTY sessions, egress firewall). Driver #2 raw Docker (dockerode) for tests and
container lifecycle. Firecracker later behind the same interface (do NOT build
in v0). Consequence: isolation improves over time without runtime rewrites.

Implementation notes (P2, 2026-10-07):
- OT's image runs as `user` (uid 1000) and escalates via passwordless sudo in
  its entrypoint (firewall bootstrap, chown of bind-mounted home). Containers
  therefore get `CapAdd: [SETUID, SETGID, NET_ADMIN]` with everything else
  dropped — OT itself drops NET_ADMIN after setup (capsh). This is OT's own
  privilege model, not a weakening of guardrail #3 (no docker socket, caps,
  no host exec path).
- OT's egress firewall needs kernel `ipset`, which Docker Desktop's VM lacks
  (`iptables: Can't open socket to ipset` — OT then refuses to start). Driver
  accepts `FOUNDRY_SANDBOX_EGRESS=open` to skip the allowlist on such hosts;
  the egress credential proxy (ADR-005) still mediates all LLM traffic there.
  On Linux homelab hosts the default `allowlist` mode is active.
- Image default is `open-terminal:slim`; integration tests use `latest`
  (slim lacks python3).
- Node 24+/25 deliver WS binary frames as `Blob` (Node 22: ArrayBuffer) — the
  OT terminal attach handles both.

## ADR-005 — Sandboxes never hold real keys (egress credential proxy)
Accepted 2026-10-07. Containers get scoped, short-lived per-env tokens; their
LLM egress goes through the gateway proxy, which swaps real keys and meters
usage (pattern proven by acumenix/sbx). Non-LLM egress: OT egress firewall,
default deny, per-env allowlist. Consequence: audit chokepoint + leak
containment; slight latency, acceptable.

## ADR-006 — Agent runtime is an MCP client
Accepted 2026-10-07. stdio + streamable HTTP via `@modelcontextprotocol/sdk`;
namespaced tools `mcp__<server>__<tool>`. Consequence: existing MCP servers
(Scarlet MCP, searxng, github) become agent tools with zero glue.

## ADR-007 — SQLite (WAL) + content-addressed blobs + sqlite-vec
Accepted 2026-10-07. Zero-ops, local-first, single backup target. Postgres is
an explicit non-goal until multi-user ships. Consequence: single-writer
discipline; use WAL + busy_timeout; drizzle migrations additive only.

## ADR-008 — Single user now, multi-user-ready schema
Accepted 2026-10-07. One admin user; `user_id` on every domain table; auth
designed so a second account is data, not a migration. No roles/quotas in v0.

## ADR-009 — ntfy for push, Tailscale for remote access
Accepted 2026-10-07. Zero-cloud delivery to Android; remote clients connect
over tailnet. Never expose 8787 publicly in v0.

## ADR-010 — Trust model: trusted gateway, untrusted execution
Accepted 2026-10-07. The gateway holds keys, policy, history. Sandbox
containers: non-root, cpu/mem/pids caps, no docker socket, egress only via
gateway proxy, disposable with persistent workspace volume. Agent output is
data, never a host command. WS handshake mandatory; idempotency keys on
side effects; raw provider traffic stored redacted. This ADR is the summary
of the hard guardrails in CLAUDE.md — if code violates it, code is wrong.

## ADR-011 — Approval gates fail OPEN by default; caches can only answer, never introduce
Accepted 2026-10-07. Tool policy per run (`chat.send` `agent.toolPolicy`,
tool then `"*"`), plus two approval caches: `session` scope = the CONVERSATION
(in-memory `chatId:tool`), `always` scope = durable settings
(`gate.always:<userId>:<tool>`). Resolution precedence: explicit `deny`/`always`
absolute → always-cache → session-cache → default `always` (P2 compatibility:
nothing gated unless the run asks). Why: a cache alone must never gate a call
(fail safe for benign tools), but explicit `ask`/`session` intent is honored
— the cache answers the ask. Gates table rows are the truth (a WS session
dies, the run still parks on its row); timeout is absolute from gate creation
and CLOSES the row as `state:"timeout"` — a parked run never leaks past boot
restarts (re-arm respects time already waited). Consequence: `run.get`
carries open gates; deny/timeout become tool results (`rejected: …`) so the
model reacts gracefully.

## ADR-012 — Webhook secrets are vaulted verifiers-in-reverse: encrypted, shown once, HMAC over the raw body
Accepted 2026-10-07. Unlike API keys (hash verifiers), webhook verification
needs the SECRET itself, so it is AES-256-GCM encrypted in the vault and
shown in plaintext exactly once at creation (`POST /v1/admin/hooks` →
`{ hook, secret, url }`); GET lists never echo it. `POST /hook/:hookId` skips
bearer auth (public trigger plane) and instead requires `X-Foundry-Signature:
sha256=<hex>` = HMAC-SHA256 of the RAW bytes (preParsing tee — the JSON parse
must not see a different body than the signature), compared with
`timingSafeEqual`. Unknown → 404, bad sig → 401. Fire = fresh conversation +
agent run (`trigger:"webhook"`), ntfy push, return `{ ok, runId,
conversationId }` immediately (run is fire-and-forget).

## ADR-013 — Scheduler bookkeeping first: fire = advance next_run_at from NOW, then run
Accepted 2026-10-07. A 30 s tick (`FOUNDRY_TICK_MS`) selects rows with
`next_run_at <= now` sorted oldest-due first; firing recomputes `next_run_at`
FROM NOW (not from the missed slot) and writes it BEFORE creating the run —
so a crash mid-fire coalesces missed ticks into one catch-up run and a
now-unparseable spec disables the row without ever firing. Run creation is
fire-and-forget; a failure only logs (the occurrence was already consumed).
Cron is local-time, 5-field, POSIX semantics including the DOM/DOW
both-restricted OR rule and `dow 7 == 0`.
