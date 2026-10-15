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
  /**
   * Sandbox driver selection: "docker" (Open Terminal containers), "fake"
   * (deterministic in-process driver for unit tests), "auto" (docker when
   * the daemon answers, else fake with a boot warning). Default auto.
   */
  readonly sandboxDriver: "auto" | "docker" | "fake";
  /** Sandbox image the Docker driver launches (OT variants). */
  readonly sandboxImage: string;
  /**
   * Non-LLM egress control for sandbox containers (ADR-005): "allowlist"
   * installs OT's DNS-whitelist firewall (needs a Linux kernel with ipset —
   * Docker Desktop's VM lacks it and OT refuses to start there), "open" leaves
   * OT unfiltered (dev-only; the egress credential proxy still guards LLM
   * traffic). Default allowlist.
   */
  readonly sandboxEgress: "allowlist" | "open";
  /**
   * Base URL injected into sandbox envs as OPENAI_BASE_URL / ANTHROPIC_BASE_
   * URL (ADR-005: envs hold an egress token, never real keys). Must be
   * reachable FROM the container — host.docker.internal on Docker Desktop,
   * host-gateway extra on Linux.
   */
  readonly egressBaseUrl: string;
  /** Integration tests (Docker) gated on FOUNDRY_INTEGRATION=1. */
  readonly integration: boolean;
  /** True under vitest. */
  readonly isTest: boolean;
  /** Gate auto-resolution timeout in ms (P3): an open gate auto-DENIES after this. Default 900_000 (15 min). */
  readonly gateTimeoutMs: number;
  /** Scheduler tick interval in ms (P3). Default 30_000; tests shorten it. */
  readonly scheduleTickMs: number;
  /** ntfy base URL for push (P3). Undefined disables push. */
  readonly notifyNtfyUrl: string | undefined;
  /** ntfy topic (appended to the URL). Undefined disables push. */
  readonly notifyNtfyTopic: string | undefined;
  /**
   * Static web build dir (P4 SPA). FOUNDRY_WEB_DIR overrides; otherwise the
   * web module probes standard repo locations. Undefined → API-only mode.
   */
  readonly webDir: string | undefined;
  /** Username of the owner account (ADR-006). FOUNDRY_ADMIN_USER, default "admin". */
  readonly adminUser: string;
  /** Owner password for the first credential bootstrap (ADR-006). When
   * FOUNDRY_ADMIN_PASSWORD is unset, boot generates one and writes
   * admin_credentials.txt under the data dir. Ignored once credentials exist. */
  readonly adminPassword: string | undefined;
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
  const sandboxRaw = env["FOUNDRY_SANDBOX_DRIVER"]?.trim() || "auto";
  if (!["auto", "docker", "fake"].includes(sandboxRaw)) {
    throw new ConfigValidationError(
      `FOUNDRY_SANDBOX_DRIVER must be auto|docker|fake, got "${sandboxRaw}"`,
    );
  }
  // Master key is read but NOT validated here — the vault module owns that
  // check (it must error if missing) and this keeps unit tests able to vary it.
  const masterKey = env["FOUNDRY_MASTER_KEY"]?.trim() || undefined;
  const integration = env["FOUNDRY_INTEGRATION"] === "1";
  const isTest = env["VITEST"] === "true";
  return {
    port,
    host,
    dataDir,
    dbPath,
    masterKey,
    logLevel,
    envTtlS,
    integration,
    isTest,
    sandboxDriver: sandboxRaw as AppConfig["sandboxDriver"],
    gateTimeoutMs: intEnv(env, "FOUNDRY_GATE_TIMEOUT_MS", 900_000),
    scheduleTickMs: intEnv(env, "FOUNDRY_TICK_MS", 30_000),
    notifyNtfyUrl: env["FOUNDRY_NTFY_URL"]?.trim() || undefined,
    notifyNtfyTopic: env["FOUNDRY_NTFY_TOPIC"]?.trim() || undefined,
    webDir: env["FOUNDRY_WEB_DIR"]?.trim() || undefined,
    adminUser: env["FOUNDRY_ADMIN_USER"]?.trim() || "admin",
    adminPassword: env["FOUNDRY_ADMIN_PASSWORD"]?.trim() || undefined,
    sandboxImage: env["FOUNDRY_SANDBOX_IMAGE"]?.trim() || "ghcr.io/open-webui/open-terminal:slim",
    sandboxEgress: env["FOUNDRY_SANDBOX_EGRESS"]?.trim() === "open" ? "open" : "allowlist",
    egressBaseUrl: env["FOUNDRY_EGRESS_BASE_URL"]?.trim() || `http://host.docker.internal:${port}/v1/egress`,
  };
}