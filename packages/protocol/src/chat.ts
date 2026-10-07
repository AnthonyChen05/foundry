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
  apiKey: Type.String(),
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