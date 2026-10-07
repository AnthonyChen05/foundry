/**
 * @foundry/protocol — Foundry wire protocol v0 (docs/protocol.md).
 *
 * Every wire shape, frame and event lives here as TypeBox schemas; TypeBox
 * schemas ARE JSON Schema, so they double as the codegen source for clients
 * (`./schema` exports a registry, `schema/generated/*.json` the emitted files).
 */

export * from "./version.js";
export * from "./errors.js";
export * from "./frames.js";
export * from "./shapes.js";
export * from "./connect.js";
export * from "./events.js";
export * from "./methods.js";
export * from "./registry.js";
export * from "./chat.js";

import { type TSchema } from "@sinclair/typebox";
import {
  AuthLoginParamsSchema,
  AuthLoginResultSchema,
  ChatCreateParamsSchema,
  ChatHistoryParamsSchema,
  ChatSendParamsSchema,
  ChatSendResultSchema,
  ChatSummarySchema,
} from "./chat.js";
import {
  ClientKindSchema,
  ConnectParamsSchema,
  ConnectResultSchema,
  ConnectSnapshotSchema,
  ResumeEntrySchema,
  ServerFeaturesSchema,
} from "./connect.js";
import { ProtocolErrorCodeSchema, ProtocolErrorSchema } from "./errors.js";
import { ChannelSchema, EventFrameSchema, ReqFrameSchema, ResFrameSchema } from "./frames.js";
import {
  ContentPartSchema,
  FileEntrySchema,
  GatePolicySchema,
  GateSchema,
  MessageSchema,
  ModelCapsSchema,
  ModelSchema,
  RunBudgetsSchema,
  RunSchema,
  RunStatusSchema,
  RunTriggerSchema,
  ToolCallSchema,
} from "./shapes.js";
import { EVENT_PAYLOAD_SCHEMA } from "./registry.js";

/**
 * Registry of named schemas. Drives the emitted JSON Schema files
 * (schema/generated/<Name>.json) — the contract for client codegen.
 */
export const PROTOCOL_SCHEMAS: { name: string; schema: TSchema }[] = [
  { name: "ProtocolError", schema: ProtocolErrorSchema },
  { name: "ProtocolErrorCode", schema: ProtocolErrorCodeSchema },
  { name: "ClientKind", schema: ClientKindSchema },
  { name: "Channel", schema: ChannelSchema },
  { name: "ReqFrame", schema: ReqFrameSchema },
  { name: "ResFrame", schema: ResFrameSchema },
  { name: "EventFrame", schema: EventFrameSchema },
  { name: "RunStatus", schema: RunStatusSchema },
  { name: "RunTrigger", schema: RunTriggerSchema },
  { name: "RunBudgets", schema: RunBudgetsSchema },
  { name: "Run", schema: RunSchema },
  { name: "ContentPart", schema: ContentPartSchema },
  { name: "ToolCall", schema: ToolCallSchema },
  { name: "Message", schema: MessageSchema },
  { name: "ModelCaps", schema: ModelCapsSchema },
  { name: "Model", schema: ModelSchema },
  { name: "GatePolicy", schema: GatePolicySchema },
  { name: "Gate", schema: GateSchema },
  { name: "FileEntry", schema: FileEntrySchema },
  { name: "ResumeEntry", schema: ResumeEntrySchema },
  { name: "ConnectParams", schema: ConnectParamsSchema },
  { name: "ServerFeatures", schema: ServerFeaturesSchema },
  { name: "ConnectSnapshot", schema: ConnectSnapshotSchema },
  { name: "ConnectResult", schema: ConnectResultSchema },
  { name: "ChatSummary", schema: ChatSummarySchema },
  { name: "ChatCreateParams", schema: ChatCreateParamsSchema },
  { name: "ChatSendParams", schema: ChatSendParamsSchema },
  { name: "ChatHistoryParams", schema: ChatHistoryParamsSchema },
  { name: "AuthLoginParams", schema: AuthLoginParamsSchema },
  { name: "AuthLoginResult", schema: AuthLoginResultSchema },
  { name: "ChatSendResult", schema: ChatSendResultSchema },
  ...Object.entries(EVENT_PAYLOAD_SCHEMA).map(([name, schema]) => ({
    name: `EventPayload.${name}`,
    schema,
  })),
];