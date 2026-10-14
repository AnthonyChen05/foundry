import { type Static, Type } from "@sinclair/typebox";

/**
 * Core shapes from protocol.md §3 (normative — implement exactly).
 * All timestamps on the wire are ISO 8601 strings.
 */

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "done",
  "failed",
  "cancelled",
  "timeout",
] as const;

export type RunStatusValue = (typeof RUN_STATUSES)[number];

export const RunStatusSchema = Type.Union(
  RUN_STATUSES.map((s) => Type.Literal(s)),
  { description: "Run lifecycle status.", $id: "RunStatus" },
);

export type RunStatus = Static<typeof RunStatusSchema>;

export const TRIGGERS = ["chat", "schedule", "webhook", "manual", "sandbox"] as const;

export type TriggerValue = (typeof TRIGGERS)[number];

export const RunTriggerSchema = Type.Union(
  TRIGGERS.map((s) => Type.Literal(s)),
  { description: "What started the run.", $id: "RunTrigger" },
);

export type RunTrigger = Static<typeof RunTriggerSchema>;

export const RunBudgetsSchema = Type.Object(
  {
    maxSteps: Type.Integer({ minimum: 1 }),
    maxTokens: Type.Integer({ minimum: 0 }),
    maxCostUsd: Type.Number({ minimum: 0 }),
    maxWallMs: Type.Integer({ minimum: 0 }),
  },
  { $id: "RunBudgets" },
);

export type RunBudgets = Static<typeof RunBudgetsSchema>;

export const RunSchema = Type.Object(
  {
    id: Type.String(),
    conversationId: Type.Optional(Type.String()),
    trigger: RunTriggerSchema,
    status: RunStatusSchema,
    model: Type.String(),
    budgets: RunBudgetsSchema,
    createdAt: Type.String({ description: "ISO 8601." }),
    startedAt: Type.Optional(Type.String({ description: "ISO 8601." })),
    endedAt: Type.Optional(Type.String({ description: "ISO 8601." })),
    summary: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { $id: "Run" },
);

export type Run = Static<typeof RunSchema>;

// ---------------------------------------------------------------------------
// Message — canonical OpenAI Chat Completions message (ADR-002)
// ---------------------------------------------------------------------------

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

/**
 * OpenAI content parts. Only `text` and `image_url` are typed; unknown part
 * types must pass through unvalidated (canonical format rule: never reject
 * unknown provider fields — protocol.md §2).
 */
export const ContentPartSchema = Type.Object(
  {
    type: Type.String({ description: 'Part type, e.g. "text", "image_url".' }),
    text: Type.Optional(Type.String()),
    image_url: Type.Optional(Type.Object({ url: Type.String() })),
  },
  { description: "OpenAI content part; unknown part types pass through." },
);

export type ContentPart = Static<typeof ContentPartSchema>;

export const ToolCallSchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Literal("function"),
    function: Type.Object({ name: Type.String(), arguments: Type.String() }),
  },
  {
    description: "OpenAI tool_call; `arguments` is a JSON-encoded string.",
    $id: "ToolCall",
  },
);

export type ToolCall = Static<typeof ToolCallSchema>;

export const MessageSchema = Type.Object(
  {
    role: Type.Union(
      MESSAGE_ROLES.map((r) => Type.Literal(r)),
      { description: "Canonical OpenAI message role." },
    ),
    content: Type.Union([Type.String(), Type.Array(ContentPartSchema)], {
      description: "Text content or content-parts array.",
    }),
    tool_calls: Type.Optional(
      Type.Array(ToolCallSchema, {
        description: "Present on assistant messages requesting tool execution.",
      }),
    ),
    tool_call_id: Type.Optional(
      Type.String({ description: "Present on tool-role messages." }),
    ),
    name: Type.Optional(Type.String()),
  },
  {
    description:
      "Canonical OpenAI ChatCompletionMessage (ADR-002). Unknown fields pass through.",
    $id: "Message",
  },
);

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export type Message = Static<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const ModelCapsSchema = Type.Object(
  {
    vision: Type.Boolean(),
    tools: Type.Boolean(),
    reasoning: Type.Boolean(),
    json: Type.Boolean(),
  },
  { $id: "ModelCaps" },
);

export type ModelCaps = Static<typeof ModelCapsSchema>;

export const ModelSchema = Type.Object(
  {
    id: Type.String({
      description: 'Catalog id "<provider>/<model>", e.g. "ollama/llama3.1:8b".',
    }),
    provider: Type.String(),
    name: Type.String(),
    caps: ModelCapsSchema,
    context: Type.Integer({ minimum: 1 }),
    priceInPerMtok: Type.Optional(Type.Number({ minimum: 0 })),
    priceOutPerMtok: Type.Optional(Type.Number({ minimum: 0 })),
    enabled: Type.Boolean(),
  },
  { $id: "Model" },
);

export type Model = Static<typeof ModelSchema>;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export const GATE_POLICIES = ["ask", "always", "session", "deny"] as const;

export type GatePolicy = (typeof GATE_POLICIES)[number];

export const GatePolicySchema = Type.Union(
  GATE_POLICIES.map((p) => Type.Literal(p)),
  { description: "Approval policy for a tool (P3)." },
);

export const GateSchema = Type.Object(
  {
    gateId: Type.String(),
    runId: Type.String(),
    tool: Type.String(),
    args: Type.Unknown(),
    policy: GatePolicySchema,
    createdAt: Type.String({ description: "ISO 8601." }),
  },
  { $id: "Gate" },
);

export type Gate = Static<typeof GateSchema>;

export const GateStateSchema = Type.Union(
  ["open", "approved", "denied", "timeout"].map((s) => Type.Literal(s)),
  { description: "Gate lifecycle: open → approved|denied|timeout." },
);

export type GateState = Static<typeof GateStateSchema>;

// ---------------------------------------------------------------------------
// Schedule / Hook (P3 — REST admin CRUD + webhooks)
// ---------------------------------------------------------------------------

export const ScheduleKindSchema = Type.Union(
  ["cron", "every"].map((k) => Type.Literal(k)),
  { description: "cron = 5-field cron spec; every = interval in seconds." },
);

export type ScheduleKind = (typeof ScheduleKindSchema)["static"];

export const ScheduleSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    kind: ScheduleKindSchema,
    /** "0 9 * * 1-5" for cron; "900" (seconds) for every. */
    spec: Type.String(),
    /** Prompt sent to the agent run on each fire. */
    prompt: Type.String(),
    /** Wire-form model override (e.g. "dummy/scripted"); null → default model. */
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    /** Conversation the run attaches to; null → an auto-created schedule chat. */
    targetChatId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    enabled: Type.Boolean(),
    nextRunAt: Type.String({ description: "ISO 8601; server-computed on create." }),
    lastRunId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdAt: Type.String({ description: "ISO 8601." }),
  },
  { $id: "Schedule" },
);

export type Schedule = Static<typeof ScheduleSchema>;

export const ScheduleCreateParamsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    kind: ScheduleKindSchema,
    spec: Type.String({ minLength: 1, description: "cron spec or seconds (integer ≥ 1) as a string." }),
    prompt: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    targetChatId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type ScheduleCreateParams = Static<typeof ScheduleCreateParamsSchema>;

export const SchedulePatchParamsSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    spec: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    targetChatId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    enabled: Type.Optional(Type.Boolean()),
    /** Recompute nextRunAt from now (used after editing spec or re-enabling). */
    reschedule: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type SchedulePatchParams = Static<typeof SchedulePatchParamsSchema>;

export const HookSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    /** "chat" — the webhook body becomes an agent chat run. */
    target: Type.Literal("chat"),
    /** Wire-form model for triggered runs; null → default model. */
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    createdAt: Type.String({ description: "ISO 8601." }),
  },
  { $id: "Hook" },
);

export type Hook = Static<typeof HookSchema>;

export const HookCreateParamsSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    /** Wire-form model for triggered runs; null → default model. */
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export type HookCreateParams = Static<typeof HookCreateParamsSchema>;

/**
 * Body of POST /hook/:hookId (public, HMAC-signed). `content` is the prompt;
 * optional `title`/`model` override. The signature header covers the RAW body.
 */
export const HookPayloadSchema = Type.Object(
  {
    content: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String()),
    model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export type HookPayload = Static<typeof HookPayloadSchema>;

// ---------------------------------------------------------------------------
// FileEntry
// ---------------------------------------------------------------------------

export const FileEntrySchema = Type.Object(
  {
    path: Type.String({ description: "Workspace-relative path." }),
    size: Type.Integer({ minimum: 0 }),
    mtime: Type.String({ description: "ISO 8601." }),
    isDir: Type.Boolean(),
  },
  { $id: "FileEntry" },
);

export type FileEntry = Static<typeof FileEntrySchema>;