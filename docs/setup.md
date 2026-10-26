# Setup guide

From nothing to a running Foundry: the backend (core) plus its sandbox
sidecars, with Docker Compose. Also covers the host-run path (Windows/macOS
or when you want the desktop's local sandbox), first login, wiring provider
+ clients, and troubleshooting.

Everything runs on ONE machine you control: no cloud, no accounts. Remote
access = Tailscale (or plain LAN).

## Choose your path

| Path | Use it when | Section |
|---|---|---|
| **Docker Compose (Linux)** | deploy on a homelab/VPS/Linux box — the cleanest full install | §1 |
| **Run core on the host** | your daily machine (Windows/macOS), or you use the desktop's local-sandbox feature | §2 |

The desktop/local-sandbox feature (ADR-015) needs core to run on a checkout
machine with Docker — it is a HOST story, not a compose one; that is §2.

## 0. Prerequisites (both paths)

- Node 22 LTS + pnpm ≥ 10 (host path only — the image has its own Node)
- Docker Engine 27+ (any daemon: core launches sandbox containers through the
  local socket)
- ~3 GB (image + the OT sandbox image ~600 MB + your data)

```sh
git clone https://github.com/AnthonyChen05/foundry.git
cd foundry
```

## 1. Docker Compose (Linux)

### 1.1 How the compose topology is wired (read before up)

Compose runs core in a container, but the SANDBOX containers its agent tools
launch are SIBLINGS on the same daemon. Three consequences:

1. **Same-path data dir.** A sandbox's workspace bind source is core's own
   `FOUNDRY_DATA_DIR` path, and the daemon resolves bind sources host-side —
   so the host dir and the in-container dir must be the same absolute path.
   This guide standardizes on `/srv/foundry`:

   ```sh
   sudo mkdir -p /srv/foundry && sudo chown $(id -u):$(id -g) /srv/foundry
   ```

2. **Sandbox reachability.** Each sandbox publishes its Open Terminal port to
   the HOST's loopback; a containerized core reaches it via the host gateway,
   which the compose file sets for you (`FOUNDRY_SANDBOX_OT_HOST=
   host.docker.internal`). On the host path (§2) this stays the default
   `127.0.0.1` — leave it unset there.
3. **Bind ALL interfaces.** A containerized core must bind
   `FOUNDRY_HOST=0.0.0.0` or the published port answers nothing while the
   in-container healthcheck still passes (compose sets this).

### 1.2 Configure

```sh
cp .env.example .env
```

Edit `.env`:

```sh
# REQUIRED. AES-256-GCM vault master: encrypts provider keys at rest.
# Losing/rotating it unrecoverably loses the stored keys (only your re-entry
# of provider keys — nothing else in your data is lost).
FOUNDRY_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")

# First-boot owner password (username defaults to "admin"). Ignored once
# credentials exist; if you leave it empty, boot generates a password and
# writes it to <data>/admin_credentials.txt — the only copy.
FOUNDRY_ADMIN_PASSWORD=your-owner-password

# ntfy push (optional — or use the bundled compose profile, §1.4)
# FOUNDRY_NTFY_URL=http://ntfy:80
# FOUNDRY_NTFY_TOPIC=foundry
```

The compose file sets `FOUNDRY_DATA_DIR=/srv/foundry` itself.

### 1.3 Up

```sh
docker compose up -d          # builds the image once (pnpm install + build)
docker compose logs -f core   # boot log ends at "listening"
curl http://127.0.0.1:8787/healthz    # {"ok":true,...}
```

Open `http://<host>:8787/` — sign in with `admin` + your `FOUNDRY_ADMIN_PASSWORD`
(or read `admin_credentials.txt` under the data dir). The web client is served
same-origin by the same port.

Verify the sandbox end-to-end from the web client: new chat → toggle
**Agent** → send *"create hello.py in the sandbox and run it"*. The run's tool
events stream in the inspector's timeline and `hello.py` lands in the Files
tab. (A first run pays a one-time pull of the sandbox image.)

### 1.4 Optional: bundled ntfy

```sh
# compose adds an ntfy service (cache volume, bound to 127.0.0.1:2587)
docker compose --profile push up -d
```

With the profile up, set in `.env`:
`FOUNDRY_NTFY_URL=http://ntfy:80`, any `FOUNDRY_NTFY_TOPIC=foundry`, then
`docker compose up -d core` to apply. Subscribe your phone's ntfy app to
`http://<host>:2587/<topic>` over Tailscale. Run done/failed + gate-open
events push immediately.

### 1.5 Trust model of this deployment (read once)

- The **core container** is the trusted gateway. It needs two privileges:
  port 8787 and the Docker socket (it launches/controls the sandbox
  sidecars). Nothing else mounts the socket.
- **Sandbox containers** (one per user/chat workspace) are untrusted: no
  docker socket, non-root, CPU/mem/pids caps, egress only through the
  gateway's credential proxy — they hold a short-lived `esc_` token, never a
  real provider key. In `allowlist` mode their container firewall passes only
  the gateway path.
- Agent tool calls NEVER run in the core container (guardrail #1).

### 1.6 What a verified install looks like

The compose path in this guide was verified end-to-end by building the image
and driving the real topology: core healthy + web client served same-origin,
password login, a streamed chat, and an agent run through a sandbox
sibling — `fs_create hello.py (32 bytes)` + `python3 hello.py` →
`hello from the sandbox` through the run timeline, and the file readable
via Files. Sandboxes reached their OT port through the host gateway;
exec output capture stays on container tmpfs (`XDG_STATE_HOME=/tmp/ot-state`,
set by core per sandbox).

## 2. Run the core on the host (Windows/macOS/Linux, developer mode)

This is the path this repo's owner uses daily, and the only one that unlocks
the **desktop local sandbox** (ADR-015): your desktop app + a `@foundry/runner`
process host envs on the same machine while core keeps owning state.

```sh
pnpm install
cp .env.example .env    # set FOUNDRY_MASTER_KEY (+ FOUNDRY_ADMIN_PASSWORD)
pnpm build              # core + sdk + the SAME-ORIGIN web build
pnpm dev                # http://127.0.0.1:8787 (auto-serves the web build)
```

- Docker Desktop kernels often lack `ipset` (the allowlist firewall) — set
  `FOUNDRY_SANDBOX_EGRESS=open` in `.env` there (the credential proxy still
  guards ALL LLM traffic). Linux: leave the default `allowlist`.
- Windows desktop app: `apps/desktop` (Tauri) — run its release build or
  `foundry-desktop`; first run asks for the server URL (default
  `http://127.0.0.1:8787`).
- Android: install the release APK (repo Releases tab), set the server URL on
  its login screen, sign in.
- Local sandbox (desktop app): Settings → enable the local executor; core
  spawns+supervises `@foundry/runner` (node + Docker Desktop on PATH).

## 3. Wire a provider + any OpenAI client

The dummy provider is seeded at first boot (models `dummy/scripted` — a
deterministic test model). For a REAL provider:

```sh
# Ollama example (host-local): admin UI → Providers → add
curl -s -X POST http://127.0.0.1:8787/v1/admin/providers \
  -H "authorization: Bearer $(cat /srv/foundry/admin_key.txt)" \
  -H 'content-type: application/json' -d '{
    "kind": "openai_compat",
    "baseUrl": "http://host.docker.internal:11434",
    "apiKey": "ollama"
  }'
# Omitting `models` auto-pulls them from the provider's OpenAI-compatible
# /models endpoint (Ollama/LM Studio/vLLM/OpenRouter); for anthropic providers
# models are entered by hand. Discovered models default to tool-capable.
# quick real-provider check:  pnpm probe:ollama
```

Any OpenAI-compatible client then works against `http://<host>:8787/v1` (API
key from the admin UI → API keys): Open WebUI, Cherry Studio, LM Studio,
`curl`. Keys are vaulted AES-256-GCM and never re-shown.

## 4. Operating

- **Backups** (`GET/POST /v1/admin/backup(s)` + Settings → System): the job
  runs daily at boot+interval (`FOUNDRY_BACKUP_MIN`) into
  `<data>/backups/<ts>/` — an online SQLite snapshot + incremental blob copy,
  keep 7. To RESTORE: stop core, replace `<data>/foundry.db` with the
  snapshot file, copy `blobs/` from the backup, start.
- **Audit log**: append-only, newest first, at `GET /v1/admin/audit` (and the
  System tab) — auth tries, gate resolutions, admin mutations, pushes,
  backups.
- **Limits**: `FOUNDRY_RATE_CHAT_PER_MIN` (60), `FOUNDRY_RATE_API_PER_MIN`
  (600), `FOUNDRY_MAX_CONCURRENT_RUNS` (8) — denials are `capacity` (WS) /
  429 (REST) and audited.
- **gVisor** (optional hardening): install `runsc` in the daemon and set
  `FOUNDRY_SANDBOX_RUNTIME=runsc` (compose: add it to `environment`; the
  desktop runner takes `--runtime the same way).
- **Logs**: `docker compose logs -f core` (json pino; log level
  `FOUNDRY_LOG_LEVEL`).

## 5. Troubleshooting

| Symptom | Cause + fix |
|---|---|
| `healthz` ok; agent run hangs/`failed: open-terminal container exited during startup` | the OT container died at boot — `docker logs <container>`; on Docker Desktop the allowlist firewall fails (`Can't open socket to ipset`) → `FOUNDRY_SANDBOX_EGRESS=open` |
| `failed: open-terminal container did not become ready` (compose; the sandbox container is Up) | a containerized core can't reach the sandbox's mapped port as 127.0.0.1 — set `FOUNDRY_SANDBOX_OT_HOST=host.docker.internal` (the compose file does) |
| published port answers nothing (curl empty reply) but the container is `healthy` | the containerized core bound `FOUNDRY_HOST=127.0.0.1` — in-container loopback only; set `FOUNDRY_HOST=0.0.0.0` (the compose file does) |
| sandbox container `failed to create: bind source not found` | compose path trap (§1.1): the data dir must exist at the SAME host path as in-container (`/srv/foundry` both) |
| `404` on run/chat/env ids in logs | normal multi-user assert: unknown and foreign ids are indistinguishable (P5). For YOUR own run: check the WS session's user |
| Ollama unreachable in compose | the core container needs the host gateway mapping (`extra_hosts host.docker.internal:host-gateway` — compose already has it) or use the compose service name if Ollama itself is composed |
| `Invalid master key` / vault decrypt fails at boot | `FOUNDRY_MASTER_KEY` changed under an existing data dir — keys at rest need the ORIGINAL value |
| ntfy not pushing | both URL+TOPIC set? phone subscribed to `http://<host>:2587/<topic>`? (bind is loopback — reach it over Tailscale/LAN) |
| port 8787 in use | set `FOUNDRY_PORT` in `.env` AND the compose ports mapping |
| forgot the admin password | delete `<data>/admin_credentials.txt`? — no: credentials persist by design. Boot re-backfills ONLY if the rows are missing — set `FOUNDRY_ADMIN_PASSWORD` and run once against a data dir WITHOUT credentials rows (fresh), or self-service change in the UI (Settings → Account) |

## 6. What's where

```
/srv/foundry/                    # $FOUNDRY_DATA_DIR (the compose data dir)
├── foundry.db (+ -wal/-shm)     # ALL tables (SQLite, WAL)
├── blobs/                       # content-addressed (sha256) — snapshots, files, push tars
├── workspaces/<ws-name>/        # the agent sandbox's bind-mounted workspace
├── backups/<ts>/                # online snapshot + blobs + manifest.json (keep 7)
├── admin_key.txt                # ONLY at first boot (root API key plaintext; store it)
└── admin_credentials.txt        # ONLY at first boot if FOUNDRY_ADMIN_PASSWORD unset
```