/**
 * Drizzle schema for ALL tables in docs/data-model.md.
 *
 * Conventions (data-model.md):
 *  - ids: text ULIDs. user_id on every domain table (multi-user-ready, ADR-008).
 *  - timestamps: unix epoch MILLISECONDS as INTEGER (wire uses ISO 8601 strings
 *    per protocol.md §3; conversion happens at the repo boundary).
 *  - JSON columns hold canonical OpenAI shapes or tagged unions; typed via
 *    @foundry/protocol (core imports from protocol only — never redefines).
 *  - migrations are additive only.
 */
import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Message, ModelCaps, RunBudgets, RunStatusValue, TriggerValue } from "@foundry/protocol";

// ---------------------------------------------------------------------------
// users / auth
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Login username (user-facing auth, ADR-006). Null on pre-password rows until boot backfills. */
    username: text("username"),
    /** scrypt params+salt+hash, "scrypt:N:r:p:salt:hash" — never a password. */
    passwordHash: text("password_hash"),
    createdAt: integer("created_at").notNull(),
  },
  // SQLite treats NULLs as distinct in unique indexes: legacy rows without a
  // username coexist, and the single real username is globally unique.
  (t) => [uniqueIndex("users_username_idx").on(t.username)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** sha256 of the full key; the plaintext is shown once at creation. */
    keyHash: text("key_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);

/**
 * WS session tokens issued by `auth.login` (protocol.md §1.2/§1.3). Token is
 * `s_`-prefixed, stored hashed (sha256); verified on every `connect`.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    model: text("model"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.updatedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    runId: text("run_id"),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    /** Canonical OpenAI ChatCompletionMessage (ADR-002). */
    content: text("content", { mode: "json" }).$type<Message>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("messages_conv_seq_idx").on(t.conversationId, t.seq)],
);

// ---------------------------------------------------------------------------
// providers / models
// ---------------------------------------------------------------------------

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  /** 'openai_compat' | 'anthropic' | 'dummy' */
  kind: text("kind").notNull(),
  baseUrl: text("base_url"),
  vaultKeyId: text("vault_key_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const models = sqliteTable(
  "models",
  {
    /** '<provider>/<model>' form, e.g. 'ollama/llama3.1:8b'. */
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id),
    name: text("name").notNull(),
    context: integer("context").notNull(),
    caps: text("caps", { mode: "json" }).$type<ModelCaps>().notNull(),
    priceIn: real("price_in"),
    priceOut: real("price_out"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("models_provider_idx").on(t.providerId)],
);

/**
 * Model profiles (operator ask 2026-10-26: "personality of the LLM we're
 * talking to", Open WebUI's model pages): a DERIVED model — a base catalog
 * model plus a custom name/avatar, a system prompt, and default advanced
 * parameters. Selecting the profile's id everywhere (sys.models, chat.*,
 * /v1/models + completions) resolves to the wrapped base with the prompt
 * prepended and the params merged UNDER the caller's explicit values.
 */
export const modelProfiles = sqliteTable(
  "model_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** The wrapped catalog model id ('<provider>/<model>'). */
    baseModelId: text("base_model_id").notNull(),
    name: text("name").notNull(),
    /** A display glyph for the profile (emoji); optional. */
    avatar: text("avatar"),
    systemPrompt: text("system_prompt"),
    /** Advanced defaults: temperature/topP/maxTokens/presence/frequency/seed/stop. */
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("model_profiles_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// vault (AES-256-GCM ciphertext triples; master key = FOUNDRY_MASTER_KEY)
// ---------------------------------------------------------------------------

export const vaultCiphertexts = sqliteTable("vault", {
  id: text("id").primaryKey(),
  ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
  iv: blob("iv", { mode: "buffer" }).notNull(),
  tag: blob("tag", { mode: "buffer" }).notNull(),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// runs / run_events (append-only event log — ADR-003)
// ---------------------------------------------------------------------------

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(() => conversations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** sub-agents later (P3+) */
    parentRunId: text("parent_run_id"),
    trigger: text("trigger").notNull().$type<TriggerValue>(),
    /** RunStatus; materialized from run_events on boot (data-model.md rules). */
    status: text("status").notNull().$type<RunStatusValue>(),
    model: text("model").notNull(),
    budgets: text("budgets", { mode: "json" }).$type<RunBudgets>().notNull(),
    /** True when the run is an autonomous agent loop (P2) — boot-time resume
     *  reconstructs these from run_events; plain chat runs don't resume. */
    agent: integer("agent", { mode: "boolean" }).notNull().default(false),
    /** The env the run's tool calls executed in (ADR-015 chat binding; no FK —
     *  envs are mortal and must not block anything on delete). */
    envId: text("env_id"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    summary: text("summary"),
    error: text("error"),
  },
  (t) => [index("runs_status_idx").on(t.status), index("runs_created_idx").on(t.createdAt)],
);

/** type: 'status'|'delta'|'tool_call'|'tool_result'|'gate_request'|'gate_resolved'|'usage'|'error'|'raw_provider_request'|'raw_provider_response' */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>(),
    createdAt: integer("created_at").notNull(),
  },
  // Append-only: NEVER update or delete rows (ADR-003).
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)],
);

export const gates = sqliteTable(
  "gates",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    tool: text("tool").notNull(),
    args: text("args", { mode: "json" }).$type<unknown>(),
    /** tool_call id this gate parks (null for pre-P3 rows); resume reconcile keyed on it */
    callId: text("call_id"),
    /** 'ask' | 'always' | 'session' | 'deny' */
    policy: text("policy").notNull(),
    /** 'open' | 'approved' | 'denied' | 'timeout' */
    state: text("state").notNull(),
    resolvedBy: text("resolved_by"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [index("gates_run_idx").on(t.runId, t.state)],
);

// ---------------------------------------------------------------------------
// schedules / memories (P3 features, schema now so migrations stay additive)
// ---------------------------------------------------------------------------

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** 'cron' | 'every' */
    kind: text("kind").notNull(),
    /** cron spec '0 9 * * 1-5' for kind=cron; seconds for kind=every */
    spec: text("spec").notNull(),
    prompt: text("prompt").notNull(),
    /** explicit model override (wire form like "dummy/scripted"); null → default model at fire time */
    model: text("model"),
    targetChatId: text("target_chat_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunId: text("last_run_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("schedules_due_idx").on(t.enabled, t.nextRunAt)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    content: text("content").notNull(),
    sourceRunId: text("source_run_id"),
    importance: real("importance").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("memories_user_idx").on(t.userId)],
);

// memory_vec (sqlite-vec virtual table) is created by db/open.ts after loading
// the extension — vec0 tables cannot be expressed in drizzle-kit. Embedding id
// = memories.id. See data-model.md.

// ---------------------------------------------------------------------------
// blobs / snapshots / workspaces / envs
// ---------------------------------------------------------------------------

export const blobs = sqliteTable("blobs", {
  /** sha256 hex; content at $FOUNDRY_DATA_DIR/blobs/<aa>/<hex> */
  id: text("id").primaryKey(),
  size: integer("size").notNull(),
  mime: text("mime").notNull(),
  path: text("path").notNull(),
  refcount: integer("refcount").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  envId: text("env_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  blobId: text("blob_id")
    .notNull()
    .references(() => blobs.id),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
});

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** $FOUNDRY_DATA_DIR/workspaces/<id> */
    path: text("path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("workspaces_user_idx").on(t.userId)],
);

export const envs = sqliteTable(
  "envs",
  {
    id: text("id").primaryKey(),
    /** 'open_terminal' | 'docker' | 'fake' | 'executor' (ADR-015 delegating driver) */
    driver: text("driver").notNull(),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    image: text("image").notNull(),
    /** 'creating' | 'ready' | 'paused' | 'dead' */
    status: text("status").notNull(),
    caps: text("caps", { mode: "json" }).$type<Record<string, unknown>>(),
    containerRef: text("container_ref"),
    /** sha256 of the env's scoped egress token; never the token itself (ADR-005) */
    egressTokenHash: text("egress_token_hash"),
    /** Executor envs: the desktop-side workspace dir (null for core-hosted envs). */
    workspaceDir: text("workspace_dir"),
    createdAt: integer("created_at").notNull(),
    lastActiveAt: integer("last_active_at"),
  },
  (t) => [index("envs_status_idx").on(t.status)],
);

// ---------------------------------------------------------------------------
// usage / settings / hooks
// ---------------------------------------------------------------------------

export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costEst: real("cost_est").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("usage_created_idx").on(t.createdAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});

export const hooks = sqliteTable(
  "hooks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /**
     * HMAC-SHA256 signing secret, vault-encrypted (row id in the vault table) —
     * verification needs the SECRET itself (unlike api keys/sessions, which are
     * verifiers), so it is encrypted at rest + handed to the operator ONCE.
     */
    secretVaultId: text("secret_vault_id"),
    /** 'schedule' | 'chat' */
    target: text("target").notNull(),
    /** Wire-form model for triggered runs; null → settings default_model. */
    model: text("model"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("hooks_user_idx").on(t.userId)],
);

// P5 audit log (append-only): security-relevant actions across all planes.
// userId may be null for system/boot events; never read by non-admin clients.
export const audit = sqliteTable(
  "audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id"),
    /** unix epoch ms (repo convention). */
    at: integer("at").notNull(),
    /** dotted action: "auth.login", "gate.resolve", "admin.keys.create", … */
    action: text("action").notNull(),
    /** Subject of the action (chat/run/key/hook/provider/… id). */
    target: text("target"),
    /** "ok" | "denied" | "timeout" | "error" */
    outcome: text("outcome").notNull(),
    /** Small structured details; no secrets (same redaction discipline as run_events). */
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (t) => [index("audit_at_idx").on(t.at)],
);

/** All table names — used by tests to assert the DB is complete. */
export const ALL_TABLES = [
  "users",
  "api_keys",
  "sessions",
  "conversations",
  "messages",
  "providers",
  "models",
  "model_profiles",
  "vault",
  "runs",
  "run_events",
  "gates",
  "schedules",
  "memories",
  "memory_vec",
  "blobs",
  "snapshots",
  "workspaces",
  "envs",
  "usage",
  "settings",
  "hooks",
  "audit",
] as const;