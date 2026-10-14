import { type Static, Type } from "@sinclair/typebox";

/**
 * Terminal-plane method params/results (protocol.md §1.3 + §4): `term.open`
 * returns a scrollback replay, `term.input`/`term.resize`/`term.close` drive a
 * live PTY; bytes stream back as `term.data` events on `term:{termId}`
 * (binary-safe via the b64 flag), death via `term.exit`.
 */

export const TermOpenParamsSchema = Type.Object({
  /** Sandbox env to open a terminal on; default = the caller's primary env. */
  envId: Type.Optional(Type.String({ minLength: 1 })),
});

export type TermOpenParams = Static<typeof TermOpenParamsSchema>;

export const TermOpenResultSchema = Type.Object(
  {
    termId: Type.String(),
    envId: Type.String(),
    /** Scrollback replay — up to 2000 lines, newest last (protocol.md §4). */
    replay: Type.String(),
  },
  { $id: "TermOpenResult" },
);

export type TermOpenResult = Static<typeof TermOpenResultSchema>;

export const TermInputParamsSchema = Type.Object({
  termId: Type.String({ minLength: 1 }),
  /** Bytes to write to the PTY (raw text, or base64 when b64:true). */
  data: Type.String(),
  b64: Type.Optional(Type.Boolean()),
});

export type TermInputParams = Static<typeof TermInputParamsSchema>;

export const TermResizeParamsSchema = Type.Object({
  termId: Type.String({ minLength: 1 }),
  cols: Type.Integer({ minimum: 2, maximum: 500 }),
  rows: Type.Integer({ minimum: 2, maximum: 500 }),
});

export type TermResizeParams = Static<typeof TermResizeParamsSchema>;

export const TermCloseParamsSchema = Type.Object({
  termId: Type.String({ minLength: 1 }),
});

export type TermCloseParams = Static<typeof TermCloseParamsSchema>;