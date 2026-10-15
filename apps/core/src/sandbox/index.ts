/**
 * Sandbox barrel for OUT-OF-PROCESS consumers (the desktop runner, ADR-015).
 * Deliberately does NOT export snapshot.ts (needs storage/blobs.ts → the
 * better-sqlite3/DB path): the runner must stay DB-free and bundle pure-JS
 * only (dockerode is pure JS; no native modules reachable from here).
 */
export { DEFAULT_CAPS, SandboxError, SandboxPathError, resolveInWorkspace, assertInside, quoteArg } from "./types.js";
export type {
  Caps,
  CreateEnvOpts,
  DriverName,
  EnvHandle,
  ExecResult,
  FileApi,
  FileStat,
  PtyHandle,
  SandboxDriver,
} from "./types.js";
export { makeDriver, makeOtDriver, SandboxService, UnknownEnvError } from "./service.js";
export { DockerDriver, DockerLauncher, OpenTerminalDriver } from "./docker.js";
export { OtClient, OT_MOUNT_ROOT, BASE64_CHUNK, type OtExecStatus, type OtListResult } from "./ot.js";
export { FakeDriver } from "./fake.js";