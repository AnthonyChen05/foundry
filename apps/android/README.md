# Foundry Android (P4 #4)

Kotlin + Compose client for the Foundry core. Thin view over the
server-authoritative backend (CLAUDE.md): commands go out over the WS plane,
state mirrors what events + refetches say, `sys.resync` triggers a refetch —
no client-owned truth. Port of `apps/web`'s `foundry.svelte.ts` store to a
`StateFlow`.

## Layout

- `core/` — wire layer: frames (`req`/`res`/`event`), protocol error,
  typed §3 shapes (ChatSummary, Message, Run, Gate, FileEntry, …) parsed
  with `ignoreUnknownKeys` so additive protocol changes never break the app.
- `data/FoundrySocket.kt` — OkHttp WS client, a port of sdk-ts `socket.ts`:
  connect handshake with per-channel resume cursors, exponential-backoff
  reconnect (cap 15s), 60s req timeouts (retryable capacity-shaped errors),
  permanent-fail on auth handshake rejection, `sys.resync` routing.
- `data/FoundryRest.kt` — the REST bits the WS can't do: `POST
  /v1/auth/login` (ADR-014), `POST /v1/auth/password`, `POST
  /v1/chats/:chatId/push` (ADR-015).
- `data/AppStore.kt` — the store: chats/messages/drafts/runs/gates/timeline
  + term sessions + executor presence; command methods (send/cancel/
  approve/createChat/push-to-cloud) with idempotency keys.
- `notify/` — system notifications for `notify.push` + a streaming ntfy
  subscription (`GET {topic}/json`); when the process is dead, delivery
  falls back to the ntfy Android app subscribed to the same topic (ADR-009).
- `ui/` — single-activity Compose: login, chats, chat (drafts + gate cards +
  local/cloud binding chip + push-to-cloud), run timeline, terminal (PTY via
  `term.*`), files, settings (executor, models, password, ntfy, logout).

## What this client is NOT

Never an executor. `clientKind` is `"android"`; the executor plane
(`exec.register`, server→client `exec.*` requests) is desktop-runner-only
(ADR-015) — this app replies `internal` if the server ever sent one. Provider
keys never appear here: the app authenticates as the user (password → 30-day
session token), and sandbox egress keys live server-side only.

## Build / install

Requires JDK 17+ and an Android SDK (see `local.properties` / `ANDROID_HOME`).

```sh
cd apps/android
./gradlew :app:assembleDebug            # → app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug             # to a connected device/emulator
./gradlew :app:testDebugUnitTest        # JVM unit tests (frame parsing)
```

Versions are pinned to what this dev machine already caches: AGP 9.2.1,
Kotlin 2.4 (AGP 9 built-in Kotlin), Gradle 9.4.1, Compose 1.7.6, Material3
1.3.1, OkHttp 4.12.

## Status / v1 scope

- P4 acceptance: chat live (streaming drafts), watch a gated run, approve/deny
  with once/session/always scopes, open a terminal session — all present.
- v1 terminal is a monospace scrollback renderer (no ANSI styling); resize is
  80×24 via `term.open` defaults.
- Files: browse/read/mkdir/rm (no file upload yet).
- No FCM (non-goal; pushes are ntfy, self-hosted).
- `usesCleartextTraffic="true"` is required: the self-hosted core speaks plain
  http on the LAN/tailnet (no TLS endpoint exists), so the app opts into
  cleartext globally — the same trade Open WebUI-style clients make on homelab
  hosts.