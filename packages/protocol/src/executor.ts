import { type Static, Type } from "@sinclair/typebox";

/**
 * Executor plane (ADR-015): the desktop's runner registers over a normal WS
 * connection (client→server: exec.register / exec.status / exec.pty.*) and
 * then answers server→client `req` frames (exec.env.* / exec.exec / exec.pty.*
 * / exec.files.* / exec.tar.*) so core's LocalExecutorDriver can delegate
 * SandboxDriver calls to the desktop's LOCAL Open Terminal container.
 *
 * Direction rules:
 *  - client→server methods below are called by the runner;
 *  - server→client methods are sent as `req` frames ONLY on connections
 *    registered as executors — the executor replies with a standard `res`
 *    frame carrying the same request id;
 *  - NONE of these methods require an idempotency key: register is
 *    replace-on-latest, the PTY pump is a connection-scoped streaming feed
 *    (no retransmit), and server→client calls get caller-side timeouts with
 *    no auto-retry (a re-run could double-execute).
 */

// ---------------------------------------------------------------------------
// presence (client → server)
// ---------------------------------------------------------------------------

export const ExecRegisterParamsSchema = Type.Object({
  name: Type.String({ minLength: 1, description: 'Executor name, e.g. "desktop".' }),
  version: Type.String({ minLength: 1 }),
  dockerAvailable: Type.Boolean({ description: "Whether the executor's Docker daemon answered." }),
  workspaceRoot: Type.Optional(Type.String({ description: "Runner-side root dir for local workspaces (display only)." })),
});

export type ExecRegisterParams = Static<typeof ExecRegisterParamsSchema>;

export const ExecRegisterResultSchema = Type.Object(
  {
    replaced: Type.Optional(Type.Boolean({ description: "True when a previous executor for this user was displaced." })),
  },
  { $id: "ExecRegisterResult" },
);

export type ExecRegisterResult = Static<typeof ExecRegisterResultSchema>;

/** Payload of `exec.status` and of `executor.status` events (sys channel). */
export const ExecutorInfoSchema = Type.Object(
  {
    online: Type.Boolean(),
    name: Type.Optional(Type.String()),
    version: Type.Optional(Type.String()),
    dockerAvailable: Type.Optional(Type.Boolean()),
    workspaceRoot: Type.Optional(Type.String()),
    /** Why it went offline: "closed" | "replaced" | "dropped". */
    reason: Type.Optional(Type.String()),
  },
  { $id: "ExecutorInfo" },
);

export type ExecutorInfo = Static<typeof ExecutorInfoSchema>;

export const ExecStatusParamsSchema = Type.Object({}, { $id: "ExecStatusParams" });

// ---------------------------------------------------------------------------
// PTY transport (client → server, non-idempotent, ordered per connection)
// ---------------------------------------------------------------------------

export const ExecPtyDataParamsSchema = Type.Object({
  ptyId: Type.String({ minLength: 1 }),
  /** Terminal bytes, base64 (b64 flag convention). */
  data: Type.String(),
});

export type ExecPtyDataParams = Static<typeof ExecPtyDataParamsSchema>;

export const ExecPtyExitParamsSchema = Type.Object({
  ptyId: Type.String({ minLength: 1 }),
  code: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export type ExecPtyExitParams = Static<typeof ExecPtyExitParamsSchema>;

// ---------------------------------------------------------------------------
// container lifecycle (server → client)
// ---------------------------------------------------------------------------

export const ExecCapsSchema = Type.Object({
  cpus: Type.Integer({ minimum: 1 }),
  memMib: Type.Integer({ minimum: 1 }),
  pids: Type.Integer({ minimum: 1 }),
});

export type ExecCaps = Static<typeof ExecCapsSchema>;

export const ExecEnvCreateParamsSchema = Type.Object({
  /** Core-minted env id (the DB row id IS the driver envId). */
  envId: Type.String({ minLength: 1 }),
  /** Workspace-dir key on the runner side (the chat that owns this env). */
  chatId: Type.Optional(Type.String()),
  caps: ExecCapsSchema,
  image: Type.Optional(Type.String()),
});

export type ExecEnvCreateParams = Static<typeof ExecEnvCreateParamsSchema>;

export const ExecEnvCreateResultSchema = Type.Object(
  {
    containerRef: Type.Optional(Type.String()),
    /** Runner-side workspace dir (stored verbatim on the env row). */
    workspaceDir: Type.String(),
  },
  { $id: "ExecEnvCreateResult" },
);

export type ExecEnvCreateResult = Static<typeof ExecEnvCreateResultSchema>;

export const ExecEnvIdParamsSchema = Type.Object({ envId: Type.String({ minLength: 1 }) });

export type ExecEnvIdParams = Static<typeof ExecEnvIdParamsSchema>;

export const ExecEnvStatusResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("dead")]),
  },
  { $id: "ExecEnvStatusResult" },
);

export type ExecEnvStatusResult = Static<typeof ExecEnvStatusResultSchema>;

// ---------------------------------------------------------------------------
// exec (server → client)
// ---------------------------------------------------------------------------

export const ExecExecParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  command: Type.String(),
  cwd: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type ExecExecParams = Static<typeof ExecExecParamsSchema>;

export const ExecExecResultSchema = Type.Object(
  {
    exitCode: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    stdout: Type.String(),
    stderr: Type.String(),
    timedOut: Type.Boolean(),
  },
  { $id: "ExecExecResult" },
);

export type ExecExecResult = Static<typeof ExecExecResultSchema>;

export const ExecRefParamsSchema = Type.Object({ ref: Type.String({ minLength: 1 }) });

export type ExecRefParams = Static<typeof ExecRefParamsSchema>;

// ---------------------------------------------------------------------------
// PTY (server → client)
// ---------------------------------------------------------------------------

export const ExecOpenPtyParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })),
  rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })),
});

export type ExecOpenPtyParams = Static<typeof ExecOpenPtyParamsSchema>;

export const ExecOpenPtyResultSchema = Type.Object(
  { ptyId: Type.String({ minLength: 1 }) },
  { $id: "ExecOpenPtyResult" },
);

export type ExecOpenPtyResult = Static<typeof ExecOpenPtyResultSchema>;

export const ExecPtyWriteParamsSchema = Type.Object({
  ptyId: Type.String({ minLength: 1 }),
  /** Input bytes, base64. */
  data: Type.String(),
});

export type ExecPtyWriteParams = Static<typeof ExecPtyWriteParamsSchema>;

export const ExecPtyResizeParamsSchema = Type.Object({
  ptyId: Type.String({ minLength: 1 }),
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 2, maximum: 500 }),
});

export type ExecPtyResizeParams = Static<typeof ExecPtyResizeParamsSchema>;

export const ExecPtyIdParamsSchema = Type.Object({ ptyId: Type.String({ minLength: 1 }) });

export type ExecPtyIdParams = Static<typeof ExecPtyIdParamsSchema>;

// ---------------------------------------------------------------------------
// files (server → client) — mirrors the FileApi surface
// ---------------------------------------------------------------------------

export const ExecFileStatSchema = Type.Object(
  {
    path: Type.String(),
    size: Type.Integer({ minimum: 0 }),
    mtimeMs: Type.Integer({ minimum: 0 }),
    isDir: Type.Boolean(),
  },
  { $id: "ExecFileStat" },
);

export type ExecFileStat = Static<typeof ExecFileStatSchema>;

export const ExecFilesListParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  dir: Type.String(),
});

export type ExecFilesListParams = Static<typeof ExecFilesListParamsSchema>;

export const ExecFilesReadParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  path: Type.String(),
});

export type ExecFilesReadParams = Static<typeof ExecFilesReadParamsSchema>;

/** Always base64 (binary-safe across the bridge). */
export const ExecFilesReadResultSchema = Type.Object(
  { b64: Type.String(), isText: Type.Boolean() },
  { $id: "ExecFilesReadResult" },
);

export type ExecFilesReadResult = Static<typeof ExecFilesReadResultSchema>;

export const ExecFilesWriteParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  path: Type.String(),
  /** File bytes, base64; chunks after the first arrive with append:true. */
  b64: Type.String(),
  append: Type.Optional(Type.Boolean()),
});

export type ExecFilesWriteParams = Static<typeof ExecFilesWriteParamsSchema>;

export const ExecFilesPathParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  path: Type.String(),
  recursive: Type.Optional(Type.Boolean()),
});

export type ExecFilesPathParams = Static<typeof ExecFilesPathParamsSchema>;

// ---------------------------------------------------------------------------
// workspace tar pull (server → client; used by push-to-cloud + snapshots)
// ---------------------------------------------------------------------------

export const ExecTarStartParamsSchema = Type.Object({
  envId: Type.String({ minLength: 1 }),
  excludes: Type.Optional(Type.Array(Type.String())),
});

export type ExecTarStartParams = Static<typeof ExecTarStartParamsSchema>;

export const ExecTarStartResultSchema = Type.Object(
  {
    tarId: Type.String({ minLength: 1 }),
    size: Type.Integer({ minimum: 0 }),
    chunkSize: Type.Integer({ minimum: 1 }),
  },
  { $id: "ExecTarStartResult" },
);

export type ExecTarStartResult = Static<typeof ExecTarStartResultSchema>;

export const ExecTarChunkParamsSchema = Type.Object({
  tarId: Type.String({ minLength: 1 }),
  index: Type.Integer({ minimum: 0 }),
});

export type ExecTarChunkParams = Static<typeof ExecTarChunkParamsSchema>;

export const ExecTarChunkResultSchema = Type.Object(
  { index: Type.Integer({ minimum: 0 }), b64: Type.String() },
  { $id: "ExecTarChunkResult" },
);

export type ExecTarChunkResult = Static<typeof ExecTarChunkResultSchema>;

export const ExecTarFreeParamsSchema = Type.Object({ tarId: Type.String({ minLength: 1 }) });

export type ExecTarFreeParams = Static<typeof ExecTarFreeParamsSchema>;