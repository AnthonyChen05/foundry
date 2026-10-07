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