import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";
import { envs, workspaces } from "../db/schema.js";
import { ulid } from "../util/ulid.js";
import type { BlobStore } from "../storage/blobs.js";
import { DEFAULT_CAPS, resolveInWorkspace, assertInside, SandboxError, type SandboxDriver, type EnvHandle } from "./types.js";

export type { SandboxDriver, EnvHandle };

/**
 * Sandbox service (ADR-004/005/010): lifecycle owner for workspaces + sandbox
 * envs. One driver instance is built at boot (docker → Open Terminal
 * containers; fake for unit tests); every consumer — agent tools, term
 * sessions, files.* methods — goes through here; nothing else touches the
 * driver (guardrail #1).
 *
 * Envs get a scoped egress token at create (esc_*); only its sha256 hash
 * lands in the DB (guardrail #2 — the plaintext lives solely as env vars
 * inside the container, pointed at the egress proxy).
 */

const DEFAULT_WORKSPACE = "main";

export class UnknownEnvError extends SandboxError {
  constructor(envId: string) {
    super(`unknown or dead sandbox env: ${envId}`, 404);
    this.name = "UnknownEnvError";
  }
}

export class SandboxService {
  private defaultEnvId: string | undefined;
  private reaper?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AppConfig,
    private readonly dbx: FoundryDb,
    private readonly blobs: BlobStore,
    private readonly driver: SandboxDriver,
  ) {}

  get driverName(): string {
    return this.driver.name;
  }

  /** Snapshot helper for the agent/runtime end-of-run tarball. */
  get blobStore(): BlobStore {
    return this.blobs;
  }

  // -- workspaces -------------------------------------------------------------

  /** Get-or-create the primary workspace (one per user in v0). */
  ensureWorkspace(userId: string): { id: string; dir: string } {
    const row =
      this.dbx.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.userId, userId), eq(workspaces.name, DEFAULT_WORKSPACE)))
        .get() ?? undefined;
    if (row !== undefined) {
      mkdirSync(row.path, { recursive: true });
      return { id: row.id, dir: row.path };
    }
    const id = `ws_${ulid()}`;
    const dir = join(resolve(join(this.config.dataDir, "workspaces")), DEFAULT_WORKSPACE);
    mkdirSync(dir, { recursive: true });
    this.dbx.db.insert(workspaces).values({ id, userId, name: DEFAULT_WORKSPACE, path: dir, createdAt: Date.now() }).run();
    return { id, dir };
  }

  // -- envs ---------------------------------------------------------------------

  /**
   * Get-or-create the caller's primary env: one container per workspace
   * (architecture.md). `envId` targets an existing env explicitly.
   */
  async ensureEnv(userId: string, envId?: string): Promise<EnvHandle> {
    if (envId !== undefined) return this.getEnvMust(envId);
    const ws = this.ensureWorkspace(userId);
    if (this.defaultEnvId !== undefined) {
      const row = this.getEnvRow(this.defaultEnvId);
      if (row !== undefined && row.workspaceId === ws.id) return this.liveHandle(row.id);
    }
    const row = this.dbx.db
      .select()
      .from(envs)
      .where(and(eq(envs.workspaceId, ws.id), eq(envs.status, "ready")))
      .get() ?? undefined;
    if (row !== undefined) {
      this.defaultEnvId = row.id;
      return this.liveHandle(row.id);
    }
    return this.createEnv(userId, ws);
  }

  /** Create an env row + container, injecting egress env vars (ADR-005). */
  async createEnv(userId: string, ws?: { id: string; dir: string }): Promise<EnvHandle> {
    const workspace = ws ?? this.ensureWorkspace(userId);
    const egressToken = `esc_${randomBytes(24).toString("hex")}`;
    const egressHash = createHash("sha256").update(egressToken).digest("hex");
    const envVars: Record<string, string> = {
      // ADR-005: a scoped per-env token replaces any real provider key.
      OPENAI_API_KEY: egressToken,
      ANTHROPIC_API_KEY: egressToken,
      OPENAI_BASE_URL: this.config.egressBaseUrl,
      ANTHROPIC_BASE_URL: this.config.egressBaseUrl,
    };
    if (this.config.sandboxEgress === "allowlist") {
      // guardrail #3: OT's DNS-whitelist firewall passes ONLY the gateway
      // proxy (host.docker.internal); everything else is dropped at OUTPUT.
      // Kernel caveat: Docker Desktop's VM lacks ipset → OT refuses to start
      // there — FOUNDRY_SANDBOX_EGRESS=open leaves OT unfiltered (proxy still
      // holds every esc_→real-key swap). docker.spec.ts asserts both paths.
      envVars["OPEN_TERMINAL_ALLOWED_DOMAINS"] = "host.docker.internal";
    }
    const handle = await this.driver.create({
      workspaceDir: workspace.dir,
      env: envVars,
      caps: DEFAULT_CAPS,
    });
    // Row id == the driver's own envId: one id space between DB rows and
    // driver maps (envFor/liveHandle re-key by the row id on restarts).
    const envId = handle.envId;
    this.dbx.db
      .insert(envs)
      .values({
        id: envId,
        driver: this.driver.name,
        workspaceId: workspace.id,
        image: this.config.sandboxImage,
        status: "ready",
        caps: { ...DEFAULT_CAPS },
        containerRef: handle.containerRef ?? null,
        egressTokenHash: egressHash,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      })
      .run();
    this.defaultEnvId = envId;
    return handle;
  }

  getEnvRow(envId: string) {
    return this.dbx.db.select().from(envs).where(eq(envs.id, envId)).get() ?? undefined;
  }

  getEnvMust(envId: string): EnvHandle {
    const row = this.getEnvRow(envId);
    if (row === undefined || row.status === "dead") throw new UnknownEnvError(envId);
    return this.liveHandle(envId);
  }

  private liveHandle(envId: string): EnvHandle {
    const row = this.getEnvRow(envId);
    if (row === undefined) throw new UnknownEnvError(envId);
    const wsRow = row.workspaceId !== null
      ? this.dbx.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).get()
      : undefined;
    const workspaceDir = wsRow?.path ?? join(resolve(join(this.config.dataDir, "workspaces")), DEFAULT_WORKSPACE);
    return {
      envId: row.id,
      driver: this.driver,
      ...(row.containerRef !== null ? { containerRef: row.containerRef } : {}),
      workspaceDir,
      // env vars (egress token etc.) were injected at create; the DB never
      // stores the plaintext, so live handles carry a marker only.
      env: { __injected_at_create__: "1" },
    };
  }

  async destroyEnv(envId: string): Promise<void> {
    try {
      await this.driver.destroy(envId);
    } finally {
      this.dbx.db.update(envs).set({ status: "dead" }).where(eq(envs.id, envId)).run();
      if (this.defaultEnvId === envId) this.defaultEnvId = undefined;
    }
  }

  // -- egress tokens (gateway/egress.ts consumer) -------------------------------

  /** Verify an esc_* bearer token → live env + owning user, or undefined. */
  verifyEgressToken(token: string): { envId: string; workspaceId: string | null; userId: string } | undefined {
    const hash = createHash("sha256").update(token).digest("hex");
    const row = this.dbx.db.select().from(envs).where(eq(envs.egressTokenHash, hash)).get() ?? undefined;
    if (row === undefined || row.status !== "ready") return undefined;
    // Attribution: envs have no owner; the workspace does (ADR-008 — every
    // run row needs a userId, and only the workspace's owner can have sent us).
    const wsUser = row.workspaceId !== null
      ? this.dbx.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).get()?.userId
      : undefined;
    if (wsUser === undefined) return undefined;
    return { envId: row.id, workspaceId: row.workspaceId, userId: wsUser };
  }

  // -- activity + TTL -----------------------------------------------------------

  markActive(envId: string): void {
    this.dbx.db.update(envs).set({ lastActiveAt: Date.now() }).where(eq(envs.id, envId)).run();
  }

  /** Workspace-relative path resolution — rejects escapes once, here. */
  resolveWorkspacePath(envId: string, path: string): string {
    const handle = this.getEnvMust(envId);
    const abs = resolveInWorkspace(handle.workspaceDir, path);
    assertInside(handle.workspaceDir, abs);
    return abs;
  }

  startReaper(): void {
    this.stopReaper();
    this.reaper = setInterval(() => {
      void this.reapIdle().catch(() => {});
    }, 60_000);
    this.reaper.unref();
  }

  stopReaper(): void {
    if (this.reaper !== undefined) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.envTtlS * 1000;
    const rows = this.dbx.db
      .select()
      .from(envs)
      .where(and(eq(envs.status, "ready"), or(lt(envs.lastActiveAt, cutoff), isNull(envs.lastActiveAt))))
      .all();
    for (const row of rows) {
      if (row.lastActiveAt !== null && row.lastActiveAt >= cutoff) continue;
      await this.destroyEnv(row.id);
    }
  }
}

/** Driver factory (runtime wiring). Open Terminal is driver #1 (ADR-004). */
export async function makeDriver(
  config: AppConfig,
  log?: { warn: (o: object, m?: string) => void },
): Promise<SandboxDriver> {
  if (config.sandboxDriver === "fake") {
    const { FakeDriver } = await import("./fake.js");
    return new FakeDriver();
  }
  const mod = await import("./docker.js");
  if (config.sandboxDriver === "docker") {
    // Raw dockerode chosen explicitly — surface failures, no fallback.
    const d = new mod.DockerDriver(config);
    if (!(await d.daemonReachable())) throw new SandboxError("docker daemon unreachable", 503);
    return d;
  }
  // auto: driver #1 (open_terminal containers launched via dockerode), fake fallback.
  try {
    const d = new mod.OpenTerminalDriver(config);
    if (await d.daemonReachable()) return d;
    throw new Error("docker daemon unreachable");
  } catch {
    log?.warn({}, "Docker daemon unreachable — fake sandbox driver active (tests/dev only)");
    const { FakeDriver } = await import("./fake.js");
    return new FakeDriver();
  }
}