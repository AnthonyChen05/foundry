import { type Static, Type } from "@sinclair/typebox";

/**
 * Chat-plane method params/results (protocol.md §1.3 rows that P1 ships:
 * `sys.health`, `sys.models`, `chat.*`, `auth.login`). Run/term/files/admin
 * shapes land with their phases (P2) — additive within v0.
 */

export const ChatSummarySchema = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    model: Type.Optional(Type.String()),
    /** Where execution is bound (ADR-015 desktop executor plane). Additive v0. */
    location: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("cloud")])),
    /** The chat's currently-bound env (local chats bind their desktop env). */
    envId: Type.Optional(Type.String()),
    createdAt: Type.String({ description: "ISO 8601." }),
    updatedAt: Type.String({ description: "ISO 8601." }),
  },
  { $id: "ChatSummary" },
);

export type ChatSummary = Static<typeof ChatSummarySchema>;

export const ChatCreateParamsSchema = Type.Object({
  title: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

export type ChatCreateParams = Static<typeof ChatCreateParamsSchema>;

export const ChatSendParamsSchema = Type.Object({
  chatId: Type.String(),
  content: Type.String(),
  attachments: Type.Optional(Type.Unknown()),
  model: Type.Optional(Type.String()),
  /** agent:true = autonomous run (P2+); toolPolicy gates tools later. */
  agent: Type.Optional(
    Type.Object({
      enabled: Type.Boolean(),
      toolPolicy: Type.Optional(Type.Unknown()),
      location: Type.Optional(
        Type.Union([Type.Literal("local"), Type.Literal("cloud")], {
          description: "Where tool calls execute (ADR-015): 'local' = the client's desktop executor, absent/cloud = the backend sandbox.",
        }),
      ),
    }),
  ),
  // NOTE: `idem` rides on the frame itself (protocol.md §1.1), not in params —
  // the hub's dedupe middleware reads frame-level idem for every side-effecting
  // method uniformly.
});

export type ChatSendParams = Static<typeof ChatSendParamsSchema>;

export const ChatHistoryParamsSchema = Type.Object({
  chatId: Type.String(),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

export type ChatHistoryParams = Static<typeof ChatHistoryParamsSchema>;

export const AuthLoginParamsSchema = Type.Object({
  username: Type.String({ description: "Login username (self-hosted default: admin)." }),
  password: Type.String({ description: "Login password (plaintext on the wire over localhost/Tailscale; hashed at rest with scrypt)." }),
});

export type AuthLoginParams = Static<typeof AuthLoginParamsSchema>;

export const AuthLoginResultSchema = Type.Object(
  {
    sessionToken: Type.String({ description: "Opaque; pass in connect.params.auth.token." }),
    expiresAt: Type.String({ description: "ISO 8601." }),
  },
  { $id: "AuthLoginResult" },
);

export type AuthLoginResult = Static<typeof AuthLoginResultSchema>;

export const ChatSendResultSchema = Type.Object(
  {
    runId: Type.String(),
    conversationId: Type.Optional(Type.String()),
  },
  { $id: "ChatSendResult" },
);

export type ChatSendResult = Static<typeof ChatSendResultSchema>;