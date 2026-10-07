/**
 * Foundry wire protocol version. docs/protocol.md is the source of truth;
 * bump this (and the changelog there) for any breaking change.
 * `connect.params.protocol` must equal this value exactly (§5).
 */
export const PROTOCOL_VERSION = 0;

/** Supported protocol versions, for error messages when a client sends a mismatch. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];