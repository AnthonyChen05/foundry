/**
 * Executor plane barrel (ADR-015) — exported for out-of-process consumers and
 * tests: the registry + the delegating driver. PushService lands with L3.
 */
export { ExecutorRegistry, type ExecutorConn, type ExitReason } from "./registry.js";
export { LocalExecutorDriver, type DriverRegistry } from "./local_driver.js";
export type { ExecutorInfo } from "@foundry/protocol";