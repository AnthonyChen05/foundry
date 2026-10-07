import { type Static, Type } from "@sinclair/typebox";

/** Error codes from protocol.md §1.1. */
export const PROTOCOL_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "denied",
  "gate_timeout",
  "provider_error",
  "capacity",
  "internal",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export const ProtocolErrorCodeSchema = Type.Union(
  PROTOCOL_ERROR_CODES.map((code) => Type.Literal(code)),
  { description: "Protocol error codes (§1.1)." },
);

/**
 * Error shape carried in `res { ok:false }` frames (§1.1).
 * `retryable` hints clients whether a retry is worthwhile.
 */
export const ProtocolErrorSchema = Type.Object(
  {
    code: ProtocolErrorCodeSchema,
    message: Type.String(),
    retryable: Type.Optional(Type.Boolean()),
  },
  { $id: "ProtocolError" },
);

export type ProtocolError = Static<typeof ProtocolErrorSchema>;