# Prior art — what to study and borrow (checked 2026-10-07)

License note: MIT/Apache-2.0 code may be borrowed WITH attribution (keep our
LICENSE MIT + a NOTICE file when vendoring). Ideas and architecture are free.
When borrowing code, record source + commit in the PR description.

| Project | License | Role in this design |
|---|---|---|
| **open-webui/open-terminal** — github.com/open-webui/open-terminal (docs: openterminal.sh) | MIT | **Sandbox driver #1.** "A computer you can curl": REST exec, file management, PTY-backed interactive terminal sessions, egress firewall, Docker or bare-metal; image variants latest (~4GB full toolkit) / slim (~430MB) / alpine (~230MB); multi-user mode exists but we use single-tenant containers. Study its API surface when writing `OpenTerminalDriver`. |
| **OpenClaw** — github.com/openclaw, docs.openclaw.ai | MIT | **Gateway + autonomy reference.** Single long-lived Gateway; typed WS protocol (req/res/event, first-frame `connect`, JSON-Schema validated, TypeBox → generated client models); device pairing; serialized agent loop per session; GatewayScheduler with durable deadlines + missed-tick coalescing; SQLite WAL; hooks (before_tool_call etc.). Read: docs.openclaw.ai/architecture + "Agent Loop". |
| **sbx (acumenix/sbx)** | Apache-2.0 | **Egress credential proxy + sandbox ops reference.** Per-sandbox tokens instead of real keys; base-URL rewrite LLM gateway (no TLS MITM); per-sandbox resource caps; admission control vs host memory budget; idle auto-pause/resume; snapshot/restore tarballs; live xterm.js terminal over hand-rolled WS PTY. |
| **open-terminal-lite (Mintplex-Labs)** | MIT | Node/Express rewrite of Open Terminal (~400MB Alpine) with **built-in MCP server mode**. Alternate leaner driver if OT's Python image feels heavy. |
| **E2B** | (reference) | Firecracker microVM sandbox design; the target for a future driver tier. Also its SDK ergonomics (create/exec/files) shaped our driver interface. |
| **LiteLLM** | MIT | Provider translation edge cases (streaming tool_calls, usage fields, error normalization) — read before writing the anthropic shim. |
| **OpenHands** | MIT | Event-stream agent architecture; run replay UX patterns. |
| **Hermes (conduit)** | — | Owner's existing reference for approval gates + schedules UX; match its interaction feel. |

Steal list (concrete):
1. OpenClaw's WS frame design + mandatory `connect` handshake + idempotency
   keys → `docs/protocol.md` §1.
2. OpenClaw's scheduler semantics (durable deadlines, missed ticks coalesced,
   catch-up once per wake) → P3 schedules.
3. sbx's egress proxy (token swap + metering, no TLS MITM) → ADR-005.
4. Open Terminal's exec/files/PTY API mapping → `OpenTerminalDriver`.
5. OpenHands' run/event timeline UX → P4 run timeline.

Do NOT copy: OpenClaw's channel plugins (not needed — we have first-party
clients + OpenAI-compat plane), its pairing/crypto complexity (single-user
v0), or any GPL code.