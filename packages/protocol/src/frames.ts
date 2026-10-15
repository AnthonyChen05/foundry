import { type Static, Type } from "@sinclair/typebox";
import { ProtocolErrorSchema } from "./errors.js";

/** Frame `type` discriminators (§1.1). */
export const FRAME_REQ = "req";
export const FRAME_RES = "res";
export const FRAME_EVENT = "event";

/** Event channel forms from protocol.md — `chat:{id}`, `run:{id}`, `term:{id}`, `sys`, `notify`. */
export type Channel =
  | `chat:${string}`
  | `run:${string}`
  | `term:${string}`
  | "sys"
  | "notify";

/**
 * Channels are opaque strings on the wire; this schema carries the documented
 * forms as a pattern for codegen while staying permissive for validation.
 */
export const ChannelSchema = Type.String({
  description: 'One of "chat:{id}", "run:{id}", "term:{id}", "sys", "notify".',
});

/** Client → server request. `idem` is required for side-effecting methods (§1.1). */
export const ReqFrameSchema = Type.Object({
  type: Type.Literal(FRAME_REQ),
  id: Type.String({ description: "Client-generated correlation id (uuid)." }),
  method: Type.String(),
  params: Type.Unknown(),
  idem: Type.Optional(Type.String({ description: "Idempotency key." })),
});

/** Server → client response correlated by `id`. */
export const ResFrameSchema = Type.Object({
  type: Type.Literal(FRAME_RES),
  id: Type.String(),
  ok: Type.Boolean(),
  payload: Type.Optional(Type.Unknown()),
  error: Type.Optional(ProtocolErrorSchema),
});

/** Server push. `seq` is per-channel monotonic; replay uses seq gaps (§1.2). */
export const EventFrameSchema = Type.Object({
  type: Type.Literal(FRAME_EVENT),
  event: Type.String(),
  channel: ChannelSchema,
  seq: Type.Integer({ minimum: 0 }),
  payload: Type.Optional(Type.Unknown()),
});

export type ReqFrame = Static<typeof ReqFrameSchema>;
export type ResFrame = Static<typeof ResFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;

/**
 * Any inbound client frame: `req` (normally) or `res` — a connection that has
 * registered as the user's executor (ADR-015, "exec.register") may also answer
 * `res` to the server→client requests it receives (executor plane). Everything
 * else inbound is closed.
 */
export const InboundFrameSchema = Type.Union([ReqFrameSchema], {
  description: "Frames a client may send: 'req' (all clients) or 'res' (replies to server→client requests on executor connections).",
});