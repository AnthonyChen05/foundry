import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { FoundryDb } from "./db/open.js";
import type { Vault } from "./vault/vault.js";
import type { SandboxDriver } from "./sandbox/types.js";
import { newApiKey } from "./vault/vault.js";
import { buildApp } from "./server.js";
import { AuthService, type IssuedKey } from "./auth/auth.js";
import { ProviderStore } from "./providers/store.js";
import { ChatService, type EmitFn } from "./gateway/chat.js";
import { registerRest } from "./gateway/rest.js";
import { registerEgress } from "./gateway/egress.js";
import { WsHub } from "./gateway/ws_hub.js";
import { SandboxService, makeDriver } from "./sandbox/service.js";
import { BlobStore } from "./storage/blobs.js";
import { AgentRunner } from "./agent/runtime.js";
import { McpManager } from "./agent/mcp.js";
import { GateService } from "./agent/gates.js";
import { MemoryService } from "./agent/memory.js";
import { SchedulerService } from "./agent/schedules.js";
import { NotifyService } from "./gateway/notify.js";
import { HookService } from "./gateway/hooks.js";
import { runs, envs, workspaces } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { TermService } from "./gateway/term.js";
import { FilesService } from "./gateway/files.js";
import { registerWeb, resolveWebDir } from "./gateway/web.js";
import { ExecutorRegistry } from "./executor/registry.js";
import { LocalExecutorDriver } from "./executor/local_driver.js";
import { PushService } from "./executor/push.js";
import { AuditService } from "./audit/audit.js";
import { BackupService } from "./backup/backup.js";
import { ConcurrentRunQuota, RateLimiter, type Limits } from "./gateway/limits.js";

/**
 * Wire-up shared by `main.ts`, tests, and the smoke script: services, routes,
 * and the single event router (hub.publish is THE emit path — REST runs
 * broadcast too, so every client stays consistent with server state).
 */

export interface FoundryRuntime {
  config: AppConfig;
  version: string;
  db: FoundryDb;
  vault: Vault;
  auth: AuthService;
  providers: ProviderStore;
  chat: ChatService;
  hub: WsHub;
  sandbox: SandboxService;
  agents: AgentRunner;
  /** Approval gates (P3) — gate table truth + run.approve resolution. */
  gates: GateService;
  /** Long-term memory (P3) — embeddings + top-k injection + tool. */
  memory: MemoryService;
  /** Push notifications (P3) — ntfy + notify.push events. */
  notify: NotifyService;
  /** Triggers (P3): cron/interval schedules. */
  scheduler: SchedulerService;
  /** Triggers (P3): HMAC webhooks (`POST /hook/:id`). */
  hooks: HookService;
  mcp: McpManager;
  term: TermService;
  files: FilesService;
  /** Executor plane (ADR-015) — the desktop runner's per-user registry. */
  executor: ExecutorRegistry;
  /** P5: append-only audit log + limits + the backup job. */
  audit: AuditService;
  backup: BackupService;
  limits: Limits;
  app: FastifyInstance;
  /** Stop background work (sandbox reaper, MCP transports) on shutdown. */
  shutdownServices(): Promise<void>;
}

export async function buildRuntime(deps: {
  config: AppConfig;
  version: string;
  db: FoundryDb;
  vault: Vault;
  /** pino logger (optional in tests). */
  log?: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
  /** Test hook: inject a driver instead of makeDriver(config) (liveness specs). */
  driver?: SandboxDriver;
}): Promise<FoundryRuntime> {
  const { config, version, db, vault } = deps;
  const logger = deps.log;
  const logLog = (obj: object, msg: string): void => logger?.info(obj, msg);
  // Audit needs the db only — construct first so every service built below
  // can record (auth login/password, gates, push, admin mutations via REST).
  const auditRef = new AuditService(db);
  const auth = new AuthService(db, auditRef);
  const providers = new ProviderStore(db, vault);
  const chat = new ChatService(db, providers);
  const emit: EmitFn = (event, channel, payload) => hub.publish(event, channel, payload);
  const blobs = new BlobStore(db, config.dataDir);
  const driver = deps.driver ?? await makeDriver(config, {
    warn: (o, m) => logger?.warn(o, m),
  });
  // Executor plane (ADR-015): the desktop runner's WS connection backs a
  // delegating SandboxDriver for local envs; registry status events ride the
  // sys channel so any client can show presence.
  const executorRegistry = new ExecutorRegistry();
  executorRegistry.onExecutorStatus = (info) => {
    hub.publish("executor.status", "sys", info);
  };
  // P5 hardening: rate limits, per-user concurrency quota, backups (audit is
  // built above). Buckets are in-process (ADR-007 single-writer); the quota
  // counts the runs table so a restart holds; limits accept no-limits tests.
  const limits: Limits = {
    api: new RateLimiter(config.rateApiPerMin),
    chat: new RateLimiter(config.rateChatPerMin),
    runs: new ConcurrentRunQuota((userId) => chat.activeRunCount(userId), config.maxConcurrentRuns),
  };
  const backup = new BackupService(db, config, { info: (o, m) => logLog(o, m), warn: (o, m) => logger?.warn(o, m) });
  const executorDriver = new LocalExecutorDriver({
    registry: executorRegistry,
    userFor: (envId) => {
      const row = db.db.select({ workspaceId: envs.workspaceId }).from(envs).where(eq(envs.id, envId)).get();
      if (row?.workspaceId === undefined || row.workspaceId === null) return undefined;
      return db.db.select({ userId: workspaces.userId }).from(workspaces).where(eq(workspaces.id, row.workspaceId)).get()?.userId;
    },
    log: (obj, msg) => logger?.info(obj, msg ?? ""),
  });
  const sandbox = new SandboxService(config, db, blobs, driver, {
    executorDriver,
    registry: executorRegistry,
  });
  const mcp = new McpManager({ dbx: db, log: logLog });
  const app = await buildApp({ config, db, vault });
  const hub = new WsHub({ config, dbx: db, chat, providers, auth, version });
  hub.register(app);

  // P3 autonomy services. Gates sit between the runner and run.approve; the
  // notify plane broadcasts everything to ntfy + the WS notify channel.
  const notify = new NotifyService({ config, emit, log: logLog });
  const memory = new MemoryService({ dbx: db, providers, log: logLog });
  const agentsRef: { runner?: AgentRunner } = {}; // late-bound (built below)
  const gates = new GateService({ dbx: db, chat, config, emit, notify, audit: auditRef, log: logLog }, {
    // A gate resolved but no loop is parked on it in this process (approve
    // raced the boot-resume). Wake the run via the normal resume path.
    onGateResolvedExternal: (runId) => {
      if (hub.inFlight.has(runId)) return; // loop live here — awaitGate handles it
      const row = db.db.select().from(runs).where(eq(runs.id, runId)).get();
      if (row === undefined || row.status !== "waiting_approval" || row.conversationId === null) return;
      void agentsRef.runner?.startRun({
        runId,
        userId: row.userId,
        wireModel: row.model,
        conversationId: row.conversationId,
        emit,
        signal: new AbortController().signal,
        resume: true,
      }).catch((err: unknown) => logLog({ mod: "agent", runId, err: String(err) }, "gate-wake resume failed"));
    },
  });
  const agents = new AgentRunner({
    chat,
    dbx: db,
    sandbox,
    config,
    emit,
    mcp,
    cancellations: hub.inFlight,
    gates,
    memory,
    notify,
    log: logLog,
  });
  agentsRef.runner = agents;

  const scheduler = new SchedulerService({ dbx: db, chat, providers, agents, config, emit, notify, log: logLog });
  const hooks = new HookService({ dbx: db, vault, chat, providers, agents, emit, notify, log: logLog });
  const push = new PushService({ config, dbx: db, chat, sandbox, blobs, registry: executorRegistry, agents, notify, audit: auditRef, emit, log: logLog });

  hub.wireServices({ agents, gates, audit: auditRef, limits });
  registerRest(app, {
    chat,
    providers,
    auth,
    version,
    emit,
    mcp,
    schedules: scheduler,
    hooks,
    push,
    audit: auditRef,
    apiLimiter: limits.api,
    backup,
    onMcpServersChanged: () => void mcp.reload().catch((err) => logLog({ err: String(err) }, "mcp reload after admin PUT failed")),
  });
  // Egress plane (ADR-005): sandbox containers' only route back in. P5 shares
  // the REST-plane bucket per env (ADR-016).
  registerEgress(app, { sandbox, chat, providers, emit, meter: limits.api });

  // P4: serve the SPA from the same origin when a web build is present
  // (FOUNDRY_WEB_DIR or the standard repo locations). Absent → API-only mode.
  const webDir = resolveWebDir(config.webDir);
  if (webDir !== undefined) {
    registerWeb(app, webDir);
    logLog({ mod: "web", webDir }, "serving web app");
  } else {
    logLog({ mod: "web" }, "no web build found — running API-only (set FOUNDRY_WEB_DIR to serve)");
  }
  const term = new TermService({ sandbox, emit, log: logLog });
  const files = new FilesService({ sandbox });
  hub.wireServices({ agents, gates, term, files, executor: { registry: executorRegistry, driver: executorDriver } });
  sandbox.startReaper();
  scheduler.start();
  backup.start(config.backupMin);

  // Boot resume (ADR-003): runs left status=running by a restart — plain chat
  // runs are marked failed; agent runs re-enter the loop. Fire-and-forget:
  // the server starts serving immediately, clients watch run.* events.
  void agents
    .resumeRunningRuns()
    .then((r) => {
      if (r.resumed.length > 0) logLog({ mod: "agent", resumed: r.resumed }, "resumed agent runs from event logs");
      if (r.failed.length > 0) logLog({ mod: "agent", failed: r.failed }, "marked interrupted runs failed");
    })
    .catch((err: unknown) => logger?.warn({ err }, "boot resume scan failed"));

  // MCP servers (settings-driven stdio) connect in the background; failures
  // are logged + surfaced via status()/admin REST, never fatal.
  void mcp.reload().catch((err: unknown) => logger?.warn({ err }, "MCP bootstrap failed (settings mcp.servers)"));

  const shutdownServices = async (): Promise<void> => {
    sandbox.stopReaper();
    scheduler.stop();
    backup.stop();
    await mcp.close();
  };

  return {
    config,
    version,
    db,
    vault,
    auth,
    providers,
    chat,
    hub,
    sandbox,
    agents,
    gates,
    memory,
    notify,
    scheduler,
    hooks,
    mcp,
    term,
    files,
    executor: executorRegistry,
    audit: auditRef,
    backup,
    limits,
    app,
    shutdownServices,
  };
}

export interface BootstrapResult {
  userId: string;
  /** Plaintext ONLY on first boot (root key auto-minted); undefined after. */
  rootKey?: IssuedKey;
  /** Owner credentials ONLY on the boot that initialized them (ADR-006). */
  adminCredentials?: { username: string; password: string };
}

/** Narrow log surface for bootstrap (pino or a trivial silent impl). */
export interface BootstrapLog {
  warn: (obj: object, msg?: string) => void;
}

/**
 * First-boot bootstrap: owner user + one root admin key (written to
 * admin_key.txt, whose path — never the key — is logged) + owner credentials
 * (username/password; generated password written to admin_credentials.txt,
 * whose path is logged) + the dummy provider seed. Idempotent on every later
 * boot: neither file is rewritten once the underlying rows exist.
 */
export async function bootstrapServices(
  db: FoundryDb,
  vault: Vault,
  config: AppConfig,
  log: BootstrapLog,
): Promise<BootstrapResult> {
  const auth = new AuthService(db);
  const providers = new ProviderStore(db, vault);
  const minter = (name: string): IssuedKey => ({
    id: randomBytes(4).toString("hex"),
    name,
    plaintext: newApiKey(),
  });
  const boot = await auth.ensureBootstrap(minter);
  const rootKey = boot.issuedKey;
  if (rootKey !== undefined) {
    const keyPath = join(resolve(config.dataDir), "admin_key.txt");
    // A fresh mint means no valid key exists anywhere — overwrite any stale file.
    writeFileSync(keyPath, `${rootKey.plaintext}\n`);
    log.warn({ path: keyPath }, "root admin key auto-minted at first boot — file contains the ONLY copy");
  }
  // User-facing credentials (ADR-006): backfill username+password when the
  // owner user has none. Env-provided password is used as-is and NOT written
  // to a file; a generated one goes to admin_credentials.txt (only copy).
  const initialUsername = config.adminUser;
  const initialPassword = config.adminPassword ?? randomBytes(24).toString("base64url");
  const initialized = await auth.ensureUserCredentials(initialUsername, initialPassword);
  if (initialized) {
    const credsPath = join(resolve(config.dataDir), "admin_credentials.txt");
    if (config.adminPassword === undefined) {
      writeFileSync(
        credsPath,
        `username: ${initialUsername}\npassword: ${initialPassword}\n`,
      );
      log.warn({ path: credsPath }, "admin credentials initialized — file contains the ONLY copy of the generated password");
    } else {
      log.warn({ user: initialUsername }, "admin credentials initialized from FOUNDRY_ADMIN_PASSWORD");
    }
  }
  providers.seedDummy();
  return {
    userId: boot.userId,
    ...(rootKey !== undefined ? { rootKey } : {}),
    ...(initialized ? { adminCredentials: { username: initialUsername, password: initialPassword } } : {}),
  };
}