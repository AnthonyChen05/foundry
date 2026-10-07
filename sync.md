# Sync model — server-authoritative, multi-frontend

**Product framing:** an Open-WebUI-like backend, but built for agentic tasks
and three synced frontends (web app, Android, desktop). Open WebUI proves the
"one server, thin web client" model; Foundry generalizes it: the backend is
the **sync engine**, and every first-party client is a thin view + command
sender. No client is the source of truth for anything except its own UI state
(drafts, scroll positions, cached media).

## What syncs

| Collection | Truth lives | Sync mechanism |
|---|---|---|
| Conversations + messages | server | `chat.*` events on `chat:{id}`; history refetch |
| Runs + run timeline + gates | server | `run.*` events on `run:{id}`; `run.events` replay |
| Schedules, memories, settings | server | refetch on `sys.resync` / version bump |
| Models / providers (admin) | server (DB) | refetch on change event |
| Terminal scrollback | server (ring buffer) | `term.open` replay + live `term.data` |
| Workspace files | server volume | `files.*` + blob download |
| Attachments / media | server blob store | `POST /v1/blobs` up, `GET /v1/blobs/:id` down |
| Client-local only | device | UI prefs, drafts, offline queue, media cache |

## Mechanisms

1. **Channel + seq.** Every event carries a per-channel monotonic `seq`.
   Clients track `lastSeq` per channel; `connect.params.resume[]` replays
   gaps from the server ring buffer (500 events/channel).
2. **Subscription routing.** After `connect`, clients `sys.watch` the channels
   they care about (`chat:*`, `run:*`, `notify`, ...). The server routes ONLY
   watched channels — battery-friendly for Android.
3. **Bootstrap (new device).** `connect` → `chat.list` (incl. unread counts)
   → `chat.history` for opened chats → `run.events` when opening a run view
   → live events thereafter. A fresh install is fully caught up in seconds.
4. **Live-run continuity.** Run channels are global, not per-device: start a
   run on desktop, the phone shows the same timeline live; a gate opened
   while you're away can be approved from the phone; both devices receive
   `run.gate_resolved`.
5. **Offline (mobile-first).** Side-effecting commands carry idempotency
   keys, so clients may queue them offline and replay safely on reconnect
   (server dedupes within a 10-min window). ntfy push re-notifies.
6. **Unread.** Computed server-side; returned in `chat.list`;
   `chat.read { chatId, uptoMsgId }` clears it; broadcast to other sessions
   of the same user.
7. **Conflicts.** Single user, server-ordered appends: no CRDTs, ever, at
   this scale. Edits (title, settings) are last-write-wins with a
   `updatedAt` guard.
8. **Overrun.** If a client's `lastSeq` gap exceeds the ring buffer, the
   server sends `sys.resync` on that channel and the client refetches. Sync
   correctness must not depend on buffer size.

## Sync matrix (what each client MUST implement)

| Capability | Web | Desktop (Tauri) | Android |
|---|---|---|---|
| Chat + streaming + history | ✅ | ✅ | ✅ |
| Run timeline + approvals | ✅ | ✅ | ✅ |
| ntfy push handling | — | ✅ | ✅ |
| Offline command queue | — | — | ✅ |
| Terminal (PTY) | ✅ | ✅ | optional (v1: no) |
| Files browser | ✅ | ✅ | read-only v1 |
| Admin (providers/keys/schedules) | ✅ | ✅ | — |

## Acceptance criteria (testable, wired into build-order.md)

- Type on desktop → the same conversation updates live on web + Android.
- Start an agent run on web; gate opens; push arrives on the phone; approve
  from the phone; the desktop timeline shows the full run incl. resolution —
  live.
- Phone in airplane mode: `chat.send` queued; reconnect → delivered exactly
  once (idem key dedupe verified by test).
- Fresh device bootstrap: full history + unread state within seconds, no
  manual sync action.
- Forced `sys.resync` (buffer overrun in test) → client refetches and
  converges.