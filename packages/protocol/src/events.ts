import { type Static, Type } from "@sinclair/typebox";
import { GateSchema, MessageSchema, RunStatusSchema } from "./shapes.js";

/**
 * Event payloads from protocol.md §1.4, keyed by event name.
 * This registry is the source for the `features.events` list and for JSON
 * Schema export (client codegen + server-side validation).
 */

export const EVENT_NAMES = [
  "chat.delta",
  "chat.final",
  "run.status",
  "run.delta",
  "run.tool_call",
  "run.tool_result",
  "run.gate_request",
  "run.gate_resolved",
  "run.usage",
  "term.data",
  "term.exit",
  "notify.push",
  "sys.resync",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const GATE_SCOPES = ["once", "session", "always"] as const;

export type GateScopeValue = (typeof GATE_SCOPES)[number];

export const GateScopeSchema = Type.Union(
  GATE_SCOPES.map((s) => Type.Literal(s)),
  { description: "Scope of an approval: this call, this session, or forever." },
);

export type GateScope = Static<typeof GateScopeSchema>;

export const ChatDeltaPayloadSchema = Type.Object(
  { runId: Type.String(), delta: Type.String() },
  { $id: "ChatDeltaPayload" },
);

export type ChatDeltaPayload = Static<typeof ChatDeltaPayloadSchema>;

export const ChatFinalPayloadSchema = Type.Object(
  { message: MessageSchema },
  { $id: "ChatFinalPayload" },
);

export type ChatFinalPayload = Static<typeof ChatFinalPayloadSchema>;

export const RunStatusPayloadSchema = Type.Object(
  {
    runId: Type.String(),
    status: RunStatusSchema,
    error: Type.Optional(Type.String()),
  },
  { $id: "RunStatusPayload" },
);

export type RunStatusPayload = Static<typeof RunStatusPayloadSchema>;

export const RunDeltaPayloadSchema = Type.Object(
  {
    text: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.String()),
  },
  { $id: "RunDeltaPayload" },
);

export type RunDeltaPayload = Static<typeof RunDeltaPayloadSchema>;

export const ToolCallRefSchema = Type.Object(
  { id: Type.String(), name: Type.String(), args: Type.Unknown() },
  { $id: "ToolCallRef" },
);

export type ToolCallRef = Static<typeof ToolCallRefSchema>;

export const RunToolCallPayloadSchema = Type.Object(
  { call: ToolCallRefSchema },
  { $id: "RunToolCallPayload" },
);

export type RunToolCallPayload = Static<typeof RunToolCallPayloadSchema>;

export const RunToolResultPayloadSchema = Type.Object(
  { callId: Type.String(), result: Type.Unknown(), ok: Type.Boolean() },
  { $id: "RunToolResultPayload" },
);

export type RunToolResultPayload = Static<typeof RunToolResultPayloadSchema>;

// `run.gate_request` reuses the §3 Gate shape.
export const GateRequestPayloadSchema = GateSchema;

export const GateResolvedPayloadSchema = Type.Object(
  { gateId: Type.String(), approved: Type.Boolean(), scope: GateScopeSchema },
  { $id: "GateResolvedPayload" },
);

export type GateResolvedPayload = Static<typeof GateResolvedPayloadSchema>;

export const RunUsagePayloadSchema = Type.Object(
  {
    promptTokens: Type.Integer({ minimum: 0 }),
    completionTokens: Type.Integer({ minimum: 0 }),
    costEst: Type.Number({ minimum: 0 }),
    latencyMs: Type.Integer({ minimum: 0 }),
  },
  { $id: "RunUsagePayload" },
);

export type RunUsagePayload = Static<typeof RunUsagePayloadSchema>;

export const TermDataPayloadSchema = Type.Object(
  {
    data: Type.String({ description: "Terminal bytes as text, or base64 when b64." }),
    b64: Type.Optional(Type.Boolean()),
  },
  { $id: "TermDataPayload" },
);

export type TermDataPayload = Static<typeof TermDataPayloadSchema>;

export const TermExitPayloadSchema = Type.Object(
  { code: Type.Integer({ minimum: 0 }) },
  { $id: "TermExitPayload" },
);

export type TermExitPayload = Static<typeof TermExitPayloadSchema>;

export const NotifyPushPayloadSchema = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
    runId: Type.Optional(Type.String()),
  },
  { $id: "NotifyPushPayload" },
);

export type NotifyPushPayload = Static<typeof NotifyPushPayloadSchema>;

export const SysResyncPayloadSchema = Type.Object(
  {
    reason: Type.Optional(
      Type.String({ description: 'Machine-readable reason, e.g. "gap_exceeds_buffer".' }),
    ),
  },
  { $id: "SysResyncPayload" },
);

export type SysResyncPayload = Static<typeof SysResyncPayloadSchema>;