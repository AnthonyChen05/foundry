import { type Static, Type } from "@sinclair/typebox";
import { ChannelSchema } from "./frames.js";
import { PROTOCOL_VERSION } from "./version.js";

/** §1.2 handshake shapes. First frame on every WS connection MUST be `connect`. */

export const CLIENT_KINDS = ["android", "windows", "web", "cli"] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];

export const ClientKindSchema = Type.Union(
  CLIENT_KINDS.map((k) => Type.Literal(k)),
  { description: "Which first-party client is connecting." },
);

export const ResumeEntrySchema = Type.Object(
  {
    channel: ChannelSchema,
    lastSeq: Type.Integer({
      minimum: -1,
      description: "Server replays events with seq > lastSeq (ring buffer 500/channel).",
    }),
  },
  { $id: "ResumeEntry" },
);

export type ResumeEntry = Static<typeof ResumeEntrySchema>;

export const ConnectParamsSchema = Type.Object(
  {
    // Loose on purpose (integer, not Literal): a mismatched legacy version must
    // reach the server's version check so §5's "supported versions" error can
    // be produced — a Literal would fail schema Check first with a generic
    // message and no negotiation hint.
    protocol: Type.Integer({
      minimum: 0,
      description: "Must equal PROTOCOL_VERSION exactly (§5).",
    }),
    auth: Type.Object({ token: Type.String() }),
    client: Type.Object({ kind: ClientKindSchema, version: Type.String() }),
    resume: Type.Optional(
      Type.Array(ResumeEntrySchema, { description: "Per-channel replay cursors from lastSeq+1." }),
    ),
  },
  { $id: "ConnectParams" },
);

export type ConnectParams = Static<typeof ConnectParamsSchema>;

export const ServerFeaturesSchema = Type.Object(
  {
    methods: Type.Array(Type.String(), { description: "Method names this server supports." }),
    events: Type.Array(Type.String(), { description: "Event names this server emits." }),
  },
  { $id: "ServerFeatures" },
);

export type ServerFeatures = Static<typeof ServerFeaturesSchema>;

export const ConnectSnapshotSchema = Type.Object(
  {
    activeRuns: Type.Array(Type.String(), { description: "Channel ids with live runs." }),
    unread: Type.Integer({ minimum: 0 }),
  },
  { $id: "ConnectSnapshot" },
);

export type ConnectSnapshot = Static<typeof ConnectSnapshotSchema>;

export const ConnectResultSchema = Type.Object(
  {
    sessionId: Type.String({ description: 'Opaque session id, "s_"-prefixed.' }),
    protocol: Type.Union([Type.Literal(PROTOCOL_VERSION)]),
    features: ServerFeaturesSchema,
    snapshot: ConnectSnapshotSchema,
  },
  { $id: "ConnectResult" },
);

export type ConnectResult = Static<typeof ConnectResultSchema>;