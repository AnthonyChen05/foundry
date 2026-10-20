# LiveNotes Expansion Plan — Cloud AI Backend, Setup Wizard, Mobile Session App

**Repo:** https://github.com/SynesisLab/transcribe-livenotes (`main`, v1.2.0)
**Prepared for:** execution by Claude Code
**Date:** 2026-10-20
**Scope:** (1) cloud API AI backend selectable alongside local Ollama, (2) desktop first-run setup wizard (local vs cloud) with a cloud-setup screen, (3) mobile session-based app: record → live transcribe (local whisper or cloud STT) → live AI notes (cloud AI) → end-of-session full-transcript re-analysis.

---

## 0. How to run this plan with Claude Code

- Execute **phases in order**. Each phase is independently shippable and ends with a commit.
- After each phase: `npm run check`, then `npm run dev`, then walk that phase's **Acceptance** checklist manually before committing.
- Feed Claude Code one phase at a time, e.g.:
  > "Read PLAN.md in the repo root. Implement Phase 1 only. Do not touch anything outside the files listed. When done, run `npm run check` and the Phase 1 acceptance checklist and report results."
- **Conventions to preserve** (they match the existing codebase):
  - ESM only, no TypeScript, Node ≥ 20, built-in `fetch`/`FormData`/`Blob` — **no new runtime dependencies**.
  - React 18 + Vite 5, single `src/App.jsx` with path-based routing (no react-router).
  - Server binds localhost; all AI calls are proxied through the Node server (API keys must **never** reach the browser).
  - `data/` holds all persisted state; never commit it.
  - Comment style: explain *why*, not *what* (match existing `ollama.js` comments).
  - No `TODO`s, no placeholders, no truncated files.

---

## 1. Current architecture (as-is)

```
mic ──AudioWorklet 16 kHz──▶ VAD chunker ──Float32 PCM──▶ Node server
                                                            │
                                            WAV ── POST ──▶ whisper-server.exe (child process)
                                                            │
                            left pane ◀── WebSocket ── transcript (spoken-at timestamps)
                                  │
                                  ├── AI toolbar ────▶ Ollama ──▶ results stream into notes
                                  └── every ~20 s ───▶ Ollama ──▶ auto-notes bullets (own file)
```

| Path | Role |
|---|---|
| `server/index.js` | Express + WebSocket server; spawns whisper-server, queues + merges transcriptions, proxies Ollama, runs auto-notes job, persists everything |
| `server/ollama.js` | **The only AI client today.** Exports `listModels()`, `chatStream({model, messages, onToken, signal, timeoutMs, numCtx, options})`, `sanitizeOllamaOptions()`, `COMMANDS` (summarize / actions / polish / reread prompt builders), `rebuildAutoNotesMessages()`. Hard per-request timeout with abort so a wedged Ollama can't hang features forever |
| `server/whisper.js` | Local STT: spawns `whisper-server.exe`, receives WAV POSTs per VAD utterance, merges backlogged speech into single windows |
| `server/autonotes.js` | Background job distilling transcript → bullets every ~20s; map/merge chunking (`MAP_CHUNK_CHARS`) for long sessions |
| `server/store.js` | Persistence: `data/sessions/<name>/` (transcript, notes, `autonotes.md`) + app config (`config.ollamaOptions` referenced by `ollama.js`) |
| `server/profiles.js` | Named event presets (topic, accents, style guide) folded into prompts as `profileCtx` |
| `server/paths.js`, `server/sea-bootstrap.js`, `server/tray.ps1` | Data paths + Windows single-exe (Node SEA) + tray |
| `scripts/check.mjs` | Pre-flight check: Node, whisper binary, model, Ollama + models, data dir, ports — prints the exact fix command |
| `scripts/setup.mjs` | One-time whisper.cpp binaries + ggml model download |
| `scripts/package-win.mjs` | Builds `LiveNotes.exe` |
| `src/App.jsx`, `src/main.jsx` | React entry; path-based routing: dashboard at `/`, each note at `/<name>` |
| `src/components/`, `src/hooks/`, `src/lib/` | Transcript pane, markdown editor, profiles UI; recorder hook (VAD + resampling via AudioWorklet); helpers |
| `index.html`, `vite.config.js`, `public/` | Vite shell, dev server on 5173, packaged app serves build at `127.0.0.1:3001` |

**Key insight for this work:** every AI feature already funnels through one function — `chatStream()` in `server/ollama.js` — and every prompt is already built as an OpenAI-shaped `messages` array. That makes the cloud-backend swap almost surgical.

---

## 2. Target architecture (to-be)

```
                          ┌────────────────────────────────────────────┐
                          │                Node server                 │
   mic ──VAD chunks──▶    │  ┌──────────┐   ┌──────────────────────┐   │
   (desktop browser       │  │ whisper- │   │  AI provider layer   │   │
    or /mobile PWA)       │  │ server   │   │  ┌────────────────┐  │   │
                          │  │ (local)  │   │  │ ollama (local) │  │   │
   VAD chunks ──────▶     │  └──────────┘   │  │ openai-compat  │  │   │
     │                    │  ┌──────────┐   │  │ anthropic      │  │   │
     └── if stt=cloud ──▶ │  │ cloud    │   │  └────────────────┘  │   │
                          │  │ STT      │   └──────────────────────┘   │
                          │  └──────────┘              │                │
                          │  store.js (config v2,      ▼                │
                          │  sessions, profiles)   WS + REST API       │
                          └────────────────────────────────────────────┘
```

- **AI backend** = `local` (Ollama) or `cloud` (OpenAI-compatible / Anthropic), chosen in setup wizard, switchable in settings.
- **STT backend** = `local` (whisper.cpp, default) or `cloud` (OpenAI-compatible `/audio/transcriptions`).
- **Mobile** = PWA at `/mobile` served by the same server; session-based UI; reuses the exact same WS protocol and recorder hook.
- **Setup wizard** = `/setup` route, runs on first launch (no `setupComplete` flag in config), reuses the `check.mjs` logic server-side.

---

## 3. Decisions & assumptions — confirm before Phase 1

| # | Decision | Rationale |
|---|---|---|
| D1 | **Cloud AI adapter v1 = OpenAI-compatible Chat Completions** (covers OpenAI, Groq, OpenRouter, DeepSeek, Together, Fireworks, LM Studio, custom base URLs). **Anthropic native adapter v1.1** (different SSE shape, `x-api-key` header). | One adapter covers ~90% of providers; existing prompts are already OpenAI-shaped `messages` arrays. |
| D2 | **Cloud STT = OpenAI-compatible `/v1/audio/transcriptions`** (OpenAI `whisper-1`/`gpt-4o-transcribe`, Groq `whisper-large-v3-turbo`). Per-VAD-utterance POSTs, same as the current WAV flow — spoken-at timestamps keep coming from the VAD chunker, so no cloud-side timestamps needed. | Mirrors existing queue/merge logic exactly; zero protocol changes. |
| D3 | **Mobile = mobile web / PWA served by the existing Node server** (reachable over LAN, Tailscale, etc.). A browser **cannot** run whisper.cpp on-device — true on-device whisper requires a native app (React Native + whisper.cpp bindings), which is Phase 6 (stretch), explicitly out of v1 scope. | Reuses ~100% of the stack; "local whisper" = whisper on the host machine the server runs on. |
| D4 | **API keys live in `data/config.json` only** (gitignored), proxied server-side, redacted in every GET response (`hasApiKey: true` + masked tail at most). | Keeps the zero-secrets-in-repo, zero-telemetry ethos; keys never cross the WebSocket. |
| D5 | **Local mode must keep working fully offline, unchanged.** When any cloud backend is active, the UI shows a visible "☁ Cloud" privacy chip (audio/text leaves the machine). | The project's core promise is local-first; cloud is opt-in and loudly labeled. |
| D6 | **Mobile AI notes = cloud API only** (per product spec). If the server is configured local-only, the mobile onboarding warns and offers to switch the server's AI backend to cloud. | Matches stated requirement. |
| D7 | **LAN access is opt-in.** The server currently serves `127.0.0.1` only; a phone can't reach that. Add a `network.bindLan` toggle (default `false`) + LAN URL + QR code display in mobile onboarding. | Security default stays tight; mobile still works with one toggle. |

---

## 4. Config schema (v2) — `data/config.json`

```json
{
  "setupComplete": true,
  "network": { "bindLan": false, "port": 3001 },
  "ai": {
    "backend": "local",
    "local":  { "url": "http://127.0.0.1:11434", "model": "qwen2.5:3b" },
    "cloud":  { "api": "openai", "baseUrl": "https://api.openai.com/v1",
                "apiKey": "sk-…", "model": "gpt-4o-mini" },
    "ollamaOptions": { "temperature": 0.7 }
  },
  "stt": {
    "backend": "local",
    "cloud": { "baseUrl": "https://api.openai.com/v1", "apiKey": null,
               "model": "gpt-4o-transcribe", "language": null }
  }
}
```

Migration rules (in `server/store.js`):
- Missing `ai`/`stt`/`setupComplete` → fill defaults (`backend: "local"`, `setupComplete: false` for fresh installs).
- **Back-compat:** if the existing config has `ollamaOptions` or an `OLLAMA_URL` env was in use, carry them into `ai.local` / `ai.ollamaOptions`; keep env `OLLAMA_URL` as fallback for `ai.local.url`.
- `stt.cloud.apiKey === null` → fall back to `ai.cloud.apiKey` (one key, two uses) if both backends point at the same `baseUrl`; otherwise STT cloud requires its own key.
- Every write goes through `store.js` sanitize: `apiKey` values are only ever written, never echoed.

---

## 5. New server API surface

| Method & path | Purpose |
|---|---|
| `GET /api/system/check` | JSON result of the pre-flight check. **Refactor:** move the core of `scripts/check.mjs` into `server/systemCheck.js`; the script becomes a thin CLI wrapper over it (output format preserved). |
| `GET /api/setup` | `{ setupComplete, checks }` — wizard bootstrapping + App.jsx first-run gate. |
| `POST /api/setup/complete` | Sets `setupComplete: true`. |
| `GET /api/ai/status` | `{ backend, model, ready, local: {url, reachable, models[]}, cloud: {baseUrl, hasApiKey, maskedKey, model} }` — keys redacted. |
| `PUT /api/ai/config` | Writes `config.ai` (sanitized; whitelist fields; keys write-only). |
| `POST /api/ai/test` | Sends a tiny prompt through the active (or a specified) backend; returns `{ ok, latencyMs, error }`. Used by wizard "Test connection" and settings. |
| `GET /api/ai/models` | local → Ollama `/api/tags`; cloud → `{baseUrl}/models` (OpenAI-compat) or static curated list (Anthropic). |
| `PUT /api/stt/config`, `POST /api/stt/test` | Same pattern for the STT backend; test = transcribe a 1s silent WAV. |
| `POST /api/stt/cloud` | Internal endpoint used by the transcription queue when `stt.backend === "cloud"`: multipart WAV in → `{ text }` out. |
| `POST /api/sessions/:name/reanalyze` | Full-transcript re-analysis (mobile "end of session" button; also useful on desktop). Streams via WebSocket events; persists result (see §6 Phase 4). |
| `POST /api/network/lan` | Toggle `network.bindLan` (requires server restart; response includes the LAN URL to display + QR payload). |

**WebSocket additions** (same WS, new server→client event types, additive only):
```json
{ "type": "ai", "scope": "autonotes", "event": "start|token|done|error", ... }
{ "type": "ai", "scope": "reanalyze", "event": "start|token|done|error", "session": "<name>" }
{ "type": "stt", "event": "engine", "backend": "local|cloud" }
```

---

## 6. Phases

### Phase 0 — Recon & safety net (~half day)

**Goal:** zero behavior change; establish the map Claude Code needs and a manual QA baseline.

1. Read `server/index.js` end-to-end; document the WS message protocol and the transcription queue/merge flow in `docs/protocol.md`.
2. Read `server/store.js`; document the exact current config shape and write path.
3. Baseline manual test script (`docs/qa-baseline.md`): record 30s → transcript appears; toolbar summarize streams; auto-notes bullets appear ~20s; reboot app → data persists.

**Acceptance:** docs exist; `npm run check` and the app behave identically to `main`.

---

### Phase 1 — AI provider abstraction (cloud chat backend)

**Goal:** `chatStream()` becomes backend-agnostic. Toolbar, auto-notes, and rebuilds work identically on local Ollama or cloud API. **No UI redesign yet** — a minimal backend switcher in the existing settings menu.

**Files:**

- `server/ai/index.js` *(new)* — `getProvider(config)` returns an object implementing:
  ```js
  { listModels(): Promise<string[]>,
    chatStream({ model, messages, onToken, signal, timeoutMs, options }): Promise<string> }
  ```
  Signature **identical** to today's `chatStream`, so callers (`autonotes.js`, `index.js` toolbar handlers) change imports only.
- `server/ai/ollama.js` — move `server/ollama.js` here. Behavior unchanged. `OLLAMA_URL` now comes from `config.ai.local.url` (env fallback preserved). `numCtx`/`num_thread` handling stays (Ollama-specific; other providers ignore).
- `server/ai/openai.js` *(new)* — OpenAI-compatible SSE (`data: {…}` lines, `[DONE]` sentinel). Port the exact timeout/abort semantics from `ollama.js` (hard timeout → abort → error propagates → caller's busy state clears). Option mapping whitelist: `temperature`, `top_p`, `max_tokens` ← `num_predict`, `seed`; ignore `num_ctx`, `top_k`, `repeat_penalty`, `num_thread`. Handle `: comment` keep-alive lines (OpenRouter) and non-SSE JSON error bodies.
- `server/ai/anthropic.js` *(new, v1.1 — can land in the same phase if time allows)* — Messages API: pull `system` out of `messages[0]`, map roles, stream `content_block_delta` events, `x-api-key` + `anthropic-version` headers, `max_tokens` required (default 4096).
- `server/ai/prompts.js` *(new)* — move `COMMANDS`, `rebuildAutoNotesMessages()`, `SYSTEM`, `transcriptTail()` verbatim. Provider-agnostic; prompt text unchanged.
- `server/autonotes.js`, `server/index.js` — swap imports to `server/ai` + `server/ai/prompts.js`. Auto-notes' `numCtx` fallback (8192) becomes provider-agnostic: pass through as a hint; `openai.js`/`anthropic.js` ignore it.
- `server/store.js` — config v2 schema + migration + redaction helpers (`redactConfig()` for GET responses).
- New endpoints from §5: `GET /api/ai/status`, `PUT /api/ai/config`, `POST /api/ai/test`, `GET /api/ai/models`.
- `src/` — settings menu: "AI backend: Local Ollama / Cloud API" + cloud fields (provider preset, base URL, API key, model dropdown, **Test connection**). Model dropdown populated from `/api/ai/models`.

**Provider presets** (constants in `server/ai/index.js`, mirrored in the UI):
`openai → https://api.openai.com/v1`, `anthropic → https://api.anthropic.com/v1`, `openrouter → https://openrouter.ai/api/v1`, `groq → https://api.groq.com/openai/v1`, `deepseek → https://api.deepseek.com/v1`, `custom → user-entered base URL`.

**Acceptance:**
- [ ] Switch backend mid-session **without restart**; next toolbar command + auto-notes tick use the new backend.
- [ ] Both backends stream token-by-token into notes and the auto-notes panel.
- [ ] Bad/expired key: readable error surfaces, busy state clears (same UX as the Ollama-wedge timeout path).
- [ ] `GET /api/ai/status` never returns a raw key; `data/config.json` holds it; no key in logs.
- [ ] Airplane-mode test: local backend fully functional offline.
- [ ] Auto-notes map/merge path works on cloud for a >20-min transcript.

---

### Phase 2 — Desktop first-run setup wizard (local vs cloud)

**Goal:** on first launch the app walks the user through choosing **Local (Ollama)** or **Cloud (API)**, with a dedicated cloud-setup screen; afterwards it's changeable in Settings.

**Files:**

- `server/systemCheck.js` *(new)* — extracted core of `scripts/check.mjs` returning structured JSON per check (`{ name, ok, fix }`). `scripts/check.mjs` becomes a CLI wrapper (human-readable output preserved byte-for-byte where practical).
- Endpoints: `GET /api/system/check`, `GET /api/setup`, `POST /api/setup/complete`.
- `src/components/SetupWizard.jsx` *(new)* + wizard styles; `src/App.jsx` — route `/setup`; **gate:** if `GET /api/setup` reports `setupComplete === false`, every route redirects to `/setup` (escape hatch: "Use defaults & skip" sets backend `local`, marks complete).
- `src/components/SettingsPanel.jsx` — add "Re-run setup" and "Change AI backend" entries (preserves all data).

**Wizard steps:**

1. **Welcome** — what this app does, privacy one-liner ("Local mode: nothing leaves this machine. Cloud mode: audio/text goes to the provider you choose.").
2. **Choose backend** — two big cards: **🖥 Local (Ollama)** / **☁ Cloud (API key)**.
3a. **Local setup** — live checks from `/api/system/check` (Ollama reachable? models installed?), model dropdown from `/api/ai/models` with refresh, and the exact `ollama pull <model>` command displayed when nothing suitable is installed (reuse check.mjs's recommended-model logic).
3b. **Cloud setup** — provider preset dropdown (§Phase 1 list), base URL (editable for custom), API key (password field, stored server-side), model dropdown fetched from `/api/ai/models`, **Test connection** button → `POST /api/ai/test` shows latency + ok/error inline.
4. **Transcription** — "Local whisper (default, offline)" vs "Cloud STT" (optional here; full feature lands Phase 3; if cloud chosen now, wizard writes `stt.backend='cloud'` and Phase 3 makes it real — or hide this step until Phase 3 ships, decided at implementation time).
5. **Done** — summary card, "Start using Live Notes" → `POST /api/setup/complete` → redirect to `/`.

**Back-compat rule:** existing installs with a config but no `setupComplete` → treated as complete (no forced wizard), but Settings shows a one-time "Set up backends?" nudge.

**Acceptance:**
- [ ] Fresh `data/` → wizard is unavoidable and completable in both branches; config written correctly; app lands on the dashboard.
- [ ] Cloud branch: wrong key → inline error; right key → latency shown; model list populates.
- [ ] Local branch: with Ollama stopped → check fails with the exact fix command displayed.
- [ ] Packaged exe flow unaffected: first run of a new build opens the wizard in the auto-opened browser.
- [ ] Existing-config upgrade: no forced wizard, everything still works.

---

### Phase 3 — Cloud STT (transcription backend option)

**Goal:** transcription can run on local whisper.cpp **or** a cloud speech API, per `config.stt.backend`. Local remains default and offline-capable.

**Files:**

- `server/stt/cloud.js` *(new)* — `transcribeWav(wavBuffer, { baseUrl, apiKey, model, language })` using global `FormData`/`Blob` (Node ≥ 20) against `/audio/transcriptions` (`response_format: "json"` or `"text"`). Per-utterance latency expected ~0.5–2s — acceptable because VAD already batches utterances.
- `server/index.js` — in the transcription queue: if `stt.backend === 'cloud'`, route VAD utterance WAVs to the cloud adapter instead of POSTing to `whisper-server.exe`; keep the **exact same merge/timestamp pipeline** downstream. On cloud error (network, quota): emit `{"type":"stt","event":"engine","backend":"local"}`-style warning and **fall back to local whisper for that utterance** if available; surface a persistent badge if fallback is active.
- Endpoints: `PUT /api/stt/config`, `POST /api/stt/test`.
- `src/` — settings toggle + transcript-pane engine chip ("🔒 whisper.cpp" / "☁ cloud STT"); wizard step 4 becomes live if deferred in Phase 2.

**Acceptance:**
- [ ] Live 10-utterance session on cloud STT: correct spoken-at timestamps, backlogged merge still works, no duplicate/garbled ordering.
- [ ] Kill network mid-session → utterances fall back to local whisper (or queue with visible warning); no crash.
- [ ] Local mode untouched: whisper-server child process behavior identical when `stt.backend === 'local'`.

---

### Phase 4 — Mobile session app (PWA at `/mobile`)

**Goal:** a phone-friendly, **session-based** experience: record → live transcribe (local whisper on the host or cloud STT) → live AI notes (cloud AI) → end session → **one-tap full-transcript re-analysis by AI**. No dashboard, no markdown editor, no profiles UI, no AI toolbar — just the session flow.

**Storage decision:** mobile sessions persist into the **same** `data/sessions/<name>/` tree as desktop notes (auto-named `Mobile 2026-10-20 14:32` or user-entered), so a session started on the phone can be opened later on the desktop and vice versa.

**Files:**

- `src/App.jsx` — routes `/mobile` and `/mobile/list`; dashboard `/` untouched (desktop remains default).
- `src/components/mobile/MobileSession.jsx` *(new)* — the session screen, three states:
  - **idle:** big record button, session name input (optional), link to recent sessions, active-backend chips.
  - **recording:** live transcript stream (reuse existing WS + recorder hook), auto-notes panel streaming (cloud AI), **Stop** button. Reuse the existing recorder hook as-is; add mobile-specific handling:
    - `getUserMedia` must be triggered from a user gesture (iOS requirement).
    - Screen Wake Lock API while recording; on lock loss (iOS backgrounding), show "recording paused — return to the app" state. Document iOS limits (Safari suspends mic capture when backgrounded/locked; Android Chrome survives screen-off with wake lock).
    - Handle `visibilitychange` → warn before accidental backgrounding mid-session.
  - **ended:** tabs — Transcript (full, timestamped) / Notes (`autonotes.md` content) / **Re-analyze** section.
- `src/components/mobile/MobileSessionList.jsx` *(new)* — read-only recent sessions; open → transcript + notes + re-run re-analysis.
- **Re-analyze:** button → `POST /api/sessions/:name/reanalyze` → server reads the full transcript, chunks if > `MAP_CHUNK_CHARS` (reuse `autonotes.js` map/merge helpers and the `rebuildAutoNotesMessages` prompt family with a "comprehensive re-analysis" variant: key points, decisions, action items, open questions, speaker-attributed highlights where possible), **streams** result over WS `{"type":"ai","scope":"reanalyze"}` into a dedicated view, then persists to `data/sessions/<name>/analysis.md` (never clobbers `autonotes.md` or the desktop notes doc). Re-running creates `analysis-<n>.md` and keeps the latest as the shown one.
- `src/components/mobile/MobileOnboarding.jsx` *(new)* — first-visit overlay: pick STT backend (local whisper on server / cloud STT), confirm AI backend is cloud (per D6; warn + one-tap switch if server is local-only), and LAN setup if not yet enabled.
- **LAN access (D7):** `server/index.js` binds `127.0.0.1` by default; when `config.network.bindLan === true`, bind `0.0.0.0` and log the LAN URL(s). Mobile onboarding shows the LAN URL **+ QR code** (generate server-side as SVG — tiny hand-rolled QR encoder or a vendored single-file implementation; no new runtime dep if avoidable, otherwise document the exception). Security note rendered in UI: "Anyone on this network can reach this server."
- **PWA assets:** `public/manifest.webmanifest` (name, theme color, standalone display, apple-touch icon), minimal service worker caching only the app shell, `100dvh` layout, `viewport-fit=cover` + safe-area insets, mobile styles in `src/styles.mobile.css`.
- `server/index.js` — WS protocol: mobile reuses the existing transcript stream and `ai` events verbatim; session create/rename endpoints as needed (likely already exist for the dashboard — reuse, don't fork).

**Acceptance:**
- [ ] iPhone Safari (16+) and Android Chrome: full session ≥ 10 min — live transcript keeps up, auto-notes stream, no audio dropouts while screen on.
- [ ] End session → Re-analyze streams in, persists to `analysis.md`, survives app restart, and the desktop dashboard shows the same session with the analysis.
- [ ] Cloud STT path on mobile works end-to-end; local-whisper-on-host path works over LAN.
- [ ] Desktop UX completely unchanged (dashboard at `/`, existing notes unaffected).
- [ ] Lighthouse PWA installability passes on Android (installable, offline shell loads).

---

### Phase 5 — Packaging, docs, polish (ship it)

1. `scripts/package-win.mjs` / SEA build: confirm the new `server/ai/*`, `server/stt/*`, `server/systemCheck.js` and built `dist/` (wizard, mobile) are bundled; test the exe end-to-end with a fresh data dir (wizard → local → cloud → mobile over LAN).
2. README.md + README.zh-TW.md + SETUP.md (+ zh-TW): new **"Backends"** section (local vs cloud, provider presets, key storage + security), **"Mobile"** section (LAN/Tailscale, QR, iOS backgrounding caveats), updated architecture diagram.
3. Privacy chips everywhere a backend is visible: header chip `🔒 Local only` / `☁ Cloud — audio & text leave this machine` (per D5).
4. Error UX pass: every cloud failure path has a human-readable message + retry (mirror the existing Ollama timeout pattern).
5. Bump version to **1.3.0**; update `package.json` description ("local *or* cloud AI").

---

### Phase 6 — Stretch: native mobile with on-device whisper (out of v1 scope)

Only if "local whisper" must mean **on the phone itself** (D3): React Native (or Expo + config plugin) with whisper.cpp bindings (e.g. `whisper.rn`-style library), reusing the same server API for cloud AI and session sync. Estimate: 2–4 weeks standalone; separate repo/app; app-store signing overhead. The PWA from Phase 4 remains the canonical mobile experience; native adds offline-on-phone transcription.

---

## 7. Testing matrix

| | STT local | STT cloud | AI local | AI cloud |
|---|---|---|---|---|
| Desktop wizard | ✅ | ✅ | ✅ | ✅ |
| Desktop session | ✅ | ✅ | ✅ | ✅ |
| Mobile (LAN) | ✅ | ✅ | ⚠️ warn-only (D6) | ✅ |

**Error injection cases:** bad API key · expired/revoked key · network drop mid-stream · provider 429 rate-limit (per-utterance STT bursts) · transcript exceeding cloud context (map/merge path) · Ollama wedged (existing timeout path) · server restart mid-session (mobile reconnect + resume) · `bindLan` on/off transitions.

**Security checks:** `GET /api/ai/status` & config redaction · keys absent from logs, WS frames, and client bundle · `bindLan` default off · wizard escape hatch doesn't write keys anywhere else.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| iOS suspends mic capture when backgrounded/locked | Wake Lock + explicit "keep screen on" guidance + documented limitation (Phase 4); native app is the real fix (Phase 6) |
| Cloud context windows differ from Ollama `num_ctx` assumptions in auto-notes/map-merge | Provider-agnostic context hint; chunk sizes keyed off `MAP_CHUNK_CHARS` stay valid; cap prompt size before send |
| Per-utterance cloud STT bursts hit rate limits | Reuse the whisper merge/backlog windowing (batch N utterances per request); exponential backoff + local fallback |
| SSE parsing edge cases across providers | Dedicated adapters with tests against OpenAI, OpenRouter (comment lines), Anthropic event shapes |
| Key leakage via LAN exposure | Keys never leave the server (all AI calls proxied); `bindLan` off by default; QR screen warns explicitly |
| SEA/Windows packaging surprises | Phase 5 explicit exe test matrix; no new native/runtime deps (D-conventions) |
| Mobile session naming collisions with desktop notes | Namespace auto-names as `Mobile <timestamp>`; same store, same uniqueness rules as dashboard |

---

## 9. Out of scope (v1)

- Speaker diarization, on-device native whisper (Phase 6), multi-user auth on LAN, E2E encryption, provider-side prompt caching optimizations, and any telemetry (still zero).

---

## 10. Suggested commit slicing

1. `refactor(server): extract AI provider layer (ollama unchanged)` — Phase 1 part A
2. `feat(server): OpenAI-compatible + Anthropic cloud AI backends` — Phase 1 part B
3. `feat(ui): backend switcher in settings` — Phase 1 part C
4. `refactor(check): shared systemCheck module + /api/system/check` — Phase 2 part A
5. `feat(ui): first-run setup wizard (/setup)` — Phase 2 part B
6. `feat(server): cloud STT backend with local fallback` — Phase 3
7. `feat(mobile): session-based mobile app at /mobile` — Phase 4 part A
8. `feat(mobile): re-analysis, onboarding, PWA shell, LAN toggle + QR` — Phase 4 part B
9. `docs+chore: backends/mobile docs, privacy chips, v1.3.0` — Phase 5

---

## 11. References

- Repo: https://github.com/SynesisLab/transcribe-livenotes
- Server tree: https://github.com/SynesisLab/transcribe-livenotes/tree/main/server
- Src tree: https://github.com/SynesisLab/transcribe-livenotes/tree/main/src
- `ollama.js` (the integration point): https://github.com/SynesisLab/transcribe-livenotes/blob/main/server/ollama.js
- `package.json`: https://github.com/SynesisLab/transcribe-livenotes/blob/main/package.json
- OpenAI streaming (SSE) reference: https://platform.openai.com/docs/api-reference/chat/streaming
- Anthropic Messages streaming reference: https://docs.anthropic.com/en/api/messages-streaming
- OpenAI audio transcriptions: https://platform.openai.com/docs/api-reference/audio/createTranscription
- Screen Wake Lock: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API