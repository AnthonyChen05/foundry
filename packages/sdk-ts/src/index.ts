/**
 * @foundry/sdk-ts — thin client SDK: typed WS frames + REST helpers, shared
 * by the Android, Windows and web frontends and the smoke test.
 * Server-authoritative (CLAUDE.md): the SDK never owns state — it sends
 * commands, receives events, and refetches on sys.resync.
 *
 * Uses only platform primitives: global fetch (Node 22+/browsers) and
 * global WebSocket (Node 22.4+/browsers).
 */
export { FoundryClient, type McpServerConfig } from "./client.js";
export { FoundryError, type WSRequestError } from "./errors.js";
export {
  FoundrySocket,
  type ConnectResultView,
  type EventHandler,
  type SocketOptions,
  type SocketStatus,
} from "./socket.js";
export {
  PROTOCOL_VERSION,
  type ChatCreateParams,
  type ChatHistoryParams,
  type ChatSendParams,
  type ChatSendResult,
  type ChatSummary,
  type ConnectResult,
  type FileEntry,
  type FilesListParams,
  type FilesMkdirParams,
  type FilesPathParams,
  type FilesReadParams,
  type FilesReadResult,
  type FilesRmParams,
  type FilesWriteParams,
  type Gate,
  type GatePolicy,
  type GateState,
  type Hook,
  type HookCreateParams,
  type HookPayload,
  type Message,
  type Model,
  type ModelCaps,
  type Run,
  type RunApproveParams,
  type RunBudgets,
  type RunCancelParams,
  type RunEventItem,
  type RunGetParams,
  type RunStatus,
  type RunTrigger,
  type Schedule,
  type ScheduleCreateParams,
  type ScheduleKind,
  type SchedulePatchParams,
  type TermCloseParams,
  type TermInputParams,
  type TermOpenParams,
  type TermOpenResult,
  type TermResizeParams,
  type ToolCall,
} from "./types.js";