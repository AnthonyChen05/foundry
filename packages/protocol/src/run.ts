import { type Static, Type } from "@sinclair/typebox";
import { GateScopeSchema } from "./events.js";

/**
 * Run-plane method params/results (protocol.md §1.3): `run.get`, `run.events`,
 * `run.cancel`, `run.approve` — the timeline contract for P2's agent runtime:
 * `run.get` returns the Run shape, `run.events` replays the append-only event
 * log (data-model.md — run_events is the source of truth for reconstruction),
 * `run.cancel` aborts an in-flight run, `run.approve` resolves a gate (its
 * full gate machinery lands in P3; the method exists on the wire in v0).
 */

/** run_events type values (data-model.md). Wire surface of `run.events`. */
export const RUN_EVENT_TYPES = [
  "status",
  "delta",
  "tool_call",
  "tool_result",
  "gate_request",
  "gate_resolved",
  "usage",
  "error",
  "raw_provider_request",
  "raw_provider_response",
] as const;

export type RunEventTypeValue = (typeof RUN_EVENT_TYPES)[number];

export const RunEventTypeSchema = Type.Union(
  RUN_EVENT_TYPES.map((t) => Type.Literal(t)),
  { description: "Append-only run event type.", $id: "RunEventType" },
);

export type RunEventItem = Static<typeof RunEventItemSchema>;

export const RunEventItemSchema = Type.Object(
  {
    seq: Type.Integer({ minimum: 0 }),
    type: RunEventTypeSchema,
    payload: Type.Unknown(),
    createdAt: Type.String({ description: "ISO 8601." }),
  },
  { $id: "RunEventItem" },
);

export const RunGetParamsSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
});

export type RunGetParams = Static<typeof RunGetParamsSchema>;

export const RunEventsParamsSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  /** Replay everything after this run_events seq (timeline catch-up). */
  since: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type RunEventsParams = Static<typeof RunEventsParamsSchema>;

export const RunCancelParamsSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
});

export type RunCancelParams = Static<typeof RunCancelParamsSchema>;

export const RunApproveParamsSchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  gateId: Type.String({ minLength: 1 }),
  approve: Type.Boolean(),
  scope: Type.Optional(GateScopeSchema),
});

export type RunApproveParams = Static<typeof RunApproveParamsSchema>;