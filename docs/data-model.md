# Data model (SQLite, WAL)

Single DB at `$FOUNDRY_DATA_DIR/foundry.db`, WAL mode, `foreign_keys=ON`,
managed by drizzle-kit. Every domain table carries `user_id` (single row in
`users` for v0 — multi-user-ready per ADR-008). IDs: text ULIDs. JSON columns
store canonical OpenAI shapes or tagged unions.

```sql
users        (id PK, name, username?, password_hash?, created_at)
             -- username: user-facing login (ADR-014, unique index; NULL on
             -- pre-password rows, backfilled at boot). password: scrypt
             -- "scrypt:N:r:p:salt:hash" (hashToken-style sha256 verifier for
             -- keys/sessions below; passwords get a slow KDF, not a token hash)

api_keys     (id PK, user_id, name, key_hash, created_at, last_used_at, revoked_at)

sessions     (id PK, user_id, token_hash, created_at, expires_at?, revoked_at?)
             -- WS session tokens issued by auth.login; token stored hashed

conversations(id PK, user_id, title, model, created_at, updated_at, meta JSON)
             -- meta {location: "local"|"cloud", envId?}: the chat's execution
             -- binding (ADR-015); exposed additively on ChatSummary
messages     (id PK, conversation_id FK, run_id?, seq INT, role, content JSON,
              created_at)                       -- content = canonical OpenAI message
                                              -- INDEX (conversation_id, seq)

providers    (id PK, kind 'openai_compat'|'anthropic'|'dummy', base_url,
              vault_key_id?, enabled, created_at)
models       (id PK,            -- 'ollama/llama3.1:8b' form
              provider_id FK, name, context INT,
              caps JSON,        -- { vision, tools, reasoning, json }
              price_in FLOAT?, price_out FLOAT?, enabled)

vault        (id PK, ciphertext BLOB, iv BLOB, tag BLOB, created_at)
             -- AES-256-GCM; master key = FOUNDRY_MASTER_KEY (scrypt-derived)

runs         (id PK, conversation_id?, user_id, parent_run_id?,   -- sub-agents later
              trigger 'chat'|'schedule'|'webhook'|'manual',
              status, model, budgets JSON, env_id?,
              -- env_id: the env the run's tool calls execute in (ADR-015; no FK)
              created_at, started_at?, ended_at?, summary?, error?)
             -- INDEX (status), INDEX (created_at)

run_events   (id INTEGER PK AUTOINC, run_id FK, seq INT,
              type,             -- 'status'|'delta'|'tool_call'|'tool_result'|
                                -- 'gate_request'|'gate_resolved'|'usage'|'error'|
                                -- 'raw_provider_request'|'raw_provider_response'
              payload JSON, created_at,
              UNIQUE(run_id, seq))            -- append-only; NEVER update/delete

gates        (id PK, run_id FK, tool, args JSON, call_id?,   -- call_id = the
              -- tool_call id this gate parks (resume reconcile); null for
              -- pre-P3 rows
              policy 'ask'|'always'|'session'|'deny',
              state 'open'|'approved'|'denied'|'timeout',
              resolved_by?, created_at, resolved_at?)

schedules    (id PK, user_id, name, kind 'cron'|'every', spec,   -- '0 9 * * 1-5' | '3600'
              prompt, model?,                    -- null → default model at fire time
              target_chat_id?, enabled,
              next_run_at INT, last_run_id?,     -- next_run_at recomputed FROM NOW
              created_at)                        -- at fire; missed ticks coalesce

memories     (id PK, user_id, content, source_run_id?, importance REAL,
              created_at)                       -- vec index: sqlite-vec virtual table
memory_vec    (embedding_id PK = memories.id, embedding FLOAT[dim])
              -- embedding model: settings 'memory.embedding_model', else first
              -- enabled provider with an embed adapter; no vectors → search
              -- degrades to substring matching

blobs        (id PK,           -- sha256 hex
              size INT, mime, path, refcount INT DEFAULT 0, created_at)
             -- files at $FOUNDRY_DATA_DIR/blobs/<aa>/<sha256>

snapshots    (id PK, env_id, workspace_id, blob_id FK, note?, created_at)
             -- blob = tar.gz of the whole workspace ((gzip, not zstd — zero
             -- native deps; revisit when a zstd driver is available))

workspaces   (id PK, user_id, name, path,        -- $FOUNDRY_DATA_DIR/workspaces/<id>
              created_at)
envs         (id PK, driver 'open_terminal'|'docker'|'fake'|'executor',
              workspace_id?, image, status 'creating'|'ready'|'paused'|'dead',
              caps JSON, container_ref?, egress_token_hash?, workspace_dir?,
              -- workspace_dir: executor envs' desktop-side dir (ADR-015); null for core-hosted envs
              created_at, last_active_at)

usage        (id INTEGER PK AUTOINC, run_id?, provider, model,
              prompt_tokens INT, completion_tokens INT, cost_est REAL,
              latency_ms INT, created_at)       -- INDEX (created_at)

settings     (key PK, value JSON)                -- routing rules, policies, ntfy url, …
hooks        (id PK, user_id, name, secret_vault_id?,  -- HMAC signing secret is
              -- vault-ENCRYPTED (verification needs the secret itself, unlike
              -- key verifiers); operator sees plaintext exactly once at create
              target 'schedule'|'chat', model?, created_at)   -- P3 webhook triggers

audit        (id INTEGER PK AUTOINC, user_id?, at,     -- append-only (P5,
              -- ADR-017); INDEX (at). meta JSON redaction = run_events
              -- (no keys/tokens/secrets); record failures are swallowed
              action, target?, outcome 'ok'|'denied'|'timeout'|'error',
              meta JSON?)
```

Rules:

- `run_events` is the source of truth for run reconstruction. `runs.status` is
  a materialized convenience; on boot, recompute from events.
- Raw provider request/response events store full JSON with `Authorization`
  headers and key fields REDACTED.
- Snapshots at run end: tar+zstd of workspace → `blobs`; keep last 20 per
  workspace (config in `settings`).
- Migrations: additive only. Never rewrite history of existing columns.
- `audit` is append-only (P5, ADR-017): no UPDATE/DELETE paths exist; the
  periodic backup job (same ADR) is its archive.