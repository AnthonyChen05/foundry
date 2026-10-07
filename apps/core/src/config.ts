/**
 * Config loader. Env only, `FOUNDRY_*` prefix (CLAUDE.md conventions).
 * Values are validated once here; callers get a typed immutable object.
 * NEVER log the master key.
 */

export interface AppConfig {
  /** HTTP + WS port (one port serves both planes). Default 8787. */
  readonly port: number;
  /** Bind address. Default 127.0.0.1; set to a LAN/Tailscale interface for remote use. */
  readonly host: string;
  /** Root for all persistent state: db, blobs, workspaces. Default ./data. */
  readonly dataDir: string;
  readonly dbPath: string;
  /** Master secret for the key vault. Undefined means vault is unavailable. */
  readonly masterKey: string | undefined;
  /** pino level. */
  readonly logLevel: string;
  /** Idle env reclaim TTL in seconds (protocol.md §4). Default 7200. */
  readonly envTtlS: number;
  /** Integration tests (Docker) gated on FOUNDRY_INTEGRATION=1. */
  readonly integration: boolean;
  /** True under vitest. */
  readonly isTest: boolean;
}

export class ConfigValidationError extends Error {}

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigValidationError(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = intEnv(env, "FOUNDRY_PORT", 8787);
  const dataDir = env["FOUNDRY_DATA_DIR"]?.trim() || "./data";
  const dbPath = env["FOUNDRY_DB_PATH"]?.trim() || `${dataDir}/foundry.db`;
  const host = env["FOUNDRY_HOST"]?.trim() || "127.0.0.1";
  const logLevel = env["FOUNDRY_LOG_LEVEL"]?.trim() || "info";
  const envTtlS = intEnv(env, "FOUNDRY_ENV_TTL", 7200);
  // Master key is read but NOT validated here — the vault module owns that
  // check (it must error if missing) and this keeps unit tests able to vary it.
  const masterKey = env["FOUNDRY_MASTER_KEY"]?.trim() || undefined;
  const integration = env["FOUNDRY_INTEGRATION"] === "1";
  const isTest = env["VITEST"] === "true";
  return { port, host, dataDir, dbPath, masterKey, logLevel, envTtlS, integration, isTest };
}