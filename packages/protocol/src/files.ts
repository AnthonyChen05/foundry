import { type Static, Type } from "@sinclair/typebox";

/**
 * File-plane method params/results (protocol.md §1.3): `files.list/read/
 * write/mkdir/rm/stat` — workspace-relative paths routed through the sandbox
 * driver's FileApi (guardrail #1: never the host fs, only the driver).
 */

/** Path-bearing params shared by every files.* method. */
export const FilesPathParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
});

export type FilesPathParams = Static<typeof FilesPathParamsSchema>;

export const FilesListParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
});

export type FilesListParams = Static<typeof FilesListParamsSchema>;

export const FilesReadParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
});

export type FilesReadParams = Static<typeof FilesReadParamsSchema>;

export const FilesReadResultSchema = Type.Object(
  {
    content: Type.String(),
    /** true when `content` is base64 (binary file). */
    b64: Type.Optional(Type.Boolean()),
  },
  { $id: "FilesReadResult" },
);

export type FilesReadResult = Static<typeof FilesReadResultSchema>;

export const FilesWriteParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
  /** File content — raw text, or base64 when b64:true. */
  content: Type.String(),
  b64: Type.Optional(Type.Boolean()),
});

export type FilesWriteParams = Static<typeof FilesWriteParamsSchema>;

export const FilesMkdirParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
  recursive: Type.Optional(Type.Boolean()),
});

export type FilesMkdirParams = Static<typeof FilesMkdirParamsSchema>;

export const FilesRmParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
  recursive: Type.Optional(Type.Boolean()),
});

export type FilesRmParams = Static<typeof FilesRmParamsSchema>;

export const FilesStatParamsSchema = Type.Object({
  envId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.String({ minLength: 1 }),
});

export type FilesStatParams = Static<typeof FilesStatParamsSchema>;