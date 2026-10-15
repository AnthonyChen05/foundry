import { type Static, type TSchema } from "@sinclair/typebox";
import {
  type EventName,
  ChatDeltaPayloadSchema,
  ChatFinalPayloadSchema,
  GateResolvedPayloadSchema,
  GateRequestPayloadSchema,
  NotifyPushPayloadSchema,
  RunDeltaPayloadSchema,
  RunStatusPayloadSchema,
  RunToolCallPayloadSchema,
  RunToolResultPayloadSchema,
  RunUsagePayloadSchema,
  SysResyncPayloadSchema,
  TermDataPayloadSchema,
  TermExitPayloadSchema,
  ExecutorStatusPayloadSchema,
} from "./events.js";

/** Event name → payload schema. Order-stable; drives JSON Schema emission. */
export const EVENT_PAYLOAD_SCHEMA: Record<EventName, TSchema> = {
  "chat.delta": ChatDeltaPayloadSchema,
  "chat.final": ChatFinalPayloadSchema,
  "run.status": RunStatusPayloadSchema,
  "run.delta": RunDeltaPayloadSchema,
  "run.tool_call": RunToolCallPayloadSchema,
  "run.tool_result": RunToolResultPayloadSchema,
  "run.gate_request": GateRequestPayloadSchema,
  "run.gate_resolved": GateResolvedPayloadSchema,
  "run.usage": RunUsagePayloadSchema,
  "term.data": TermDataPayloadSchema,
  "term.exit": TermExitPayloadSchema,
  "notify.push": NotifyPushPayloadSchema,
  "sys.resync": SysResyncPayloadSchema,
  "executor.status": ExecutorStatusPayloadSchema,
};

/** Payload type for a given event name. */
export type EventPayload<E extends EventName> = E extends keyof typeof EVENT_PAYLOAD_SCHEMA
  ? Static<(typeof EVENT_PAYLOAD_SCHEMA)[E]>
  : never;