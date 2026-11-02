# Claude Android app → Foundry/Ollama-family feature map (capture-driven)

Captured live off Anthony's Pixel via `adb` (USB) 2026-11-02 — screenshots in this folder.
Reference = the Claude app's UI patterns; target-mapping = what **Open WebUI**-equivalent
capabilities exist in Foundry (the core's models/profiles, agent runtime, MCP, schedules,
memory, files, egress). The result drives the Android+Windows clients' redesign.

| # | Screen | What it shows |
|---|--------|---------------|
| cap0 | Home | starburst + "Good afternoon, <user>", plan-chip, bottom floating composer ("Chat with…", +, model chip, mic, voice-mode button) |
| cap1 | Drawer | wordmark, top-level: Chats / Projects / Code / Artifacts, "Recents" list, avatar + "New chat" pill at bottom |
| cap2 | Chat thread | serif response w/ inline chips, per-message actions (copy/share/read-aloud/up/down/retry), "Reply to…" composer w/ model chip + mic + voice |
| cap3 | Model sheet | bottom-sheet: model name + plan-badge + one-line description per row ("For your toughest challenges"…), **Effort** (Recommended/Low), **More models** |
| cap4 | Attach/tools sheet ("Add to chat") | Camera/Photos/Files cards, **Add to project**, **Web search toggle**, **Connectors** (= MCP), **Memory toggle** ("Can't be changed for this chat") |
| cap6 | (home, re-shot) | — |
| cap7 | Settings | account + plan-badge, upgrade card, Profile/Billing/**Capabilities (N enabled)**/**Connectors**/**Permissions (N enabled)**, Color mode, Font style, **Voice**, Haptic feedback |

## The feature map → Foundry equivalents

| Claude app | Open WebUI equivalent | Foundry today | Action |
|---|---|---|---|
| Recents list w/ plain titles | Chats list | ✅ `chat.list` both clients | restyle |
| "New chat" pill (drawer + composer) | New chat button | ✅ | restyle as the pill |
| Home = composer-first (no list!) | OWUI home = a blank-new-chat | ⚠ Android = list-first | redesign: home = greeting + big composer |
| Model chip in the composer (bottom, always visible) | model selector in the message bar | ✅ (picker) | restyle: chip-in-composer + a bottom-sheet |
| Model sheet: NAME + DESCRIPTION + plan-badge | OWUI model selector shows desc/tags | ⚠ Foundry `sys.models` has name/caps/avatar — NO description | add `description` + default-effort to Model (wire) + render |
| **Effort** (Recommended/Low) per send | OWUI: per-model params | ❌ no reasoning-effort knob | map to profile params (`reasoning_effort`) — pass as a chat.send arg |
| **Web search toggle** per chat | OWUI: web-search button per message | ❌ (Foundry has no web tool) | provider-level web tool later; UI = a toggle chip that maps to a tool enable |
| **Connectors** (= MCP servers) per chat | OWUI: Tools toggle | ⚠ Foundry = MCP server-side (admin-level), tools always-on per agent | per-chat tool toggles: map MCP servers/tools → the chip; policy = existing toolPolicy |
| **Memory toggle** ("can't be changed for this chat") | OWUI: memory per-chat | ✅ core-side memory; not per-chat surfaced | a per-chat memory toggle = Foundry-side (profile system-prompt injection) — UI: the same toggle |
| **Projects** (= curated chats + files + system prompt) | OWUI: Workspaces/KB | ⚠ Foundry = chats + workspaces(envs) + profiles; no project-grouping | a "Projects" = a chat-folder + a profile + a default workspace binding — server: `project_id` on chats |
| **Artifacts** (the = file/canvas viewer) | OWUI: Code-artifacts/canvas | ⚠ run.tool_result text = plain | an "Artifacts" viewer = the run-events' file outputs rendered (a canvas view) |
| Attach: Camera/Photos/Files | OWUI: file/image upload | ❌ v1 = no uploads (chat.send has attachments? param) | images→vision content-parts; files→a workspace push |
| Voice (mic + voice-mode + Voice settings) | OWUI: voice (STT/TTS) | ❌ (non-goal for v1) | skip |
| Per-message: copy/share/read-aloud/up/down/**retry** | OWUI: similar row actions | ⚠ copy ✅; retry = re-run from a message (not in protocol!) | read-aloud = TTS-skip; retry = the protocol-side (a chat.send w/ history-trim) or a server-side "regenerate" |
| Settings: Capabilities (N enabled) | OWUI: toggles | ⚠ = the tool-policy/executor | rename the Windows "Tool policy" + the executor to a "Capabilities" card |
| Permissions (N enabled) | — | ⚠ = the gates | a "Permissions" card = the gate-policies view |
| Color mode (System) | — | ⚠ Windows = dark-only; Android = system | a Color mode = Setting (light/dark/system) both clients |
| Font style | — | ❌ | skip (the serif look = cosmetic; maybe a font-scale) |
| The plan-badge + Upgrade | (owui n/a) | — | skip |

## The immediate redesign batch (cheap, from the captures)
1. The Android home = the Claude-shape: a greeting (= the time-based), a starburst, the bottom floating composer w/ the model-chip + a "+"-tools button + the send; the drawer keeps the Recents.
2. The model picker = a bottom-sheet w/ name/desc/badge rows (needs a wire `description`).
3. The tools button next to the composer = a sheet: the web-search/memory/connectors toggles = the per-chat agent knobs (map: web-search = TODO; memory = the profile-prompt; connectors = the MCP/tool toggles = the toolPolicy map!).
4. The per-message action row: copy/retry-first (retry = a re-send = the SAME chat.send minus the last turn = a server-need: a `chat.retry` in the protocol or a client-side re-send).
5. The Windows client = the same shapes restyled (the chip-in-composer + the tools-sheet + the capabilities/permissions cards).

Open (the biggest server-side gaps): "Projects" (chat-folders + a bound profile/workspace) and "Artifacts" (a rendered canvas for the run/tool outputs). Both = core-side surface first, then the clients.