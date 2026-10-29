import { randomBytes, createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";
import { envs, workspaces } from "../db/schema.js";
import { ulid } from "../util/ulid.js";
import type { BlobStore } from "../storage/blobs.js";
import { DEFAULT_CAPS, resolveInWorkspace, assertInside, SandboxError, type SandboxDriver, type EnvHandle } from "./types.js";
import { OpenTerminalDriver } from "./docker.js";

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
    /** Executor plane (ADR-015) — present when runtime wiring builds it. */
    private readonly exec?: {
      executorDriver: SandboxDriver;
      registry: { isOnline(userId: string): boolean };
    },
  ) {}

  /** The delegating driver for local (executor) envs — wired iff executor present. */
  private execDriver(): SandboxDriver {
    if (this.exec === undefined) {
      throw new SandboxError("executor plane is not wired", 500);
    }
    return this.exec.executorDriver;
  }

  get driverName(): string {
    return this.driver.name;
  }

  /** Snapshot helper for the agent/runtime end-of-run tarball. */
  get blobStore(): BlobStore {
    return this.blobs;
  }

  // -- workspaces -------------------------------------------------------------

  /**
   * Workspace dirs are bind-mounted into sandbox containers and written by
   * the OT user (uid 1000) — and by the host user / the core process, whose
   * uid may differ (compose: the core is root on a host dir that may exist
   * from an earlier or later install; Docker Desktop's 9p maps everything to
   * root). They are SHARED dirs by design: world-writable, contents
   * world-readable. Not applied to the data dir itself (db/keys stay
   * private to the owner).
   */
  private prepareWorkspaceDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o777);
    } catch {
      // read-only mounts / exotic daemons — the dirs still work when uid
      // mappings agree (host-run core on its own data dir).
    }
  }

  /** Get-or-create the primary workspace (one per user in v0). */
  ensureWorkspace(userId: string): { id: string; dir: string } {
    const row =
      this.dbx.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.userId, userId), eq(workspaces.name, DEFAULT_WORKSPACE)))
        .get() ?? undefined;
    if (row !== undefined) {
      this.prepareWorkspaceDir(row.path);
      return { id: row.id, dir: row.path };
    }
    const id = `ws_${ulid()}`;
    const dir = join(resolve(join(this.config.dataDir, "workspaces")), DEFAULT_WORKSPACE);
    this.prepareWorkspaceDir(dir);
    this.dbx.db.insert(workspaces).values({ id, userId, name: DEFAULT_WORKSPACE, path: dir, createdAt: Date.now() }).run();
    return { id, dir };
  }

  /**
   * Get-or-create a PER-CHAT workspace (ADR-015): the push-to-cloud target and
   * the bookkeeping side of chat-scoped local dirs. Name `main` remains the
   * user's primary (shared) workspace — chat workspaces keep chats separate.
   */
  ensureChatWorkspace(userId: string, chatId: string): { id: string; dir: string } {
    const name = `chat:${chatId}`;
    const row =
      this.dbx.db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.userId, userId), eq(workspaces.name, name)))
        .get() ?? undefined;
    if (row !== undefined) {
      this.prepareWorkspaceDir(row.path);
      return { id: row.id, dir: row.path };
    }
    const id = `ws_${ulid()}`;
    const dir = join(resolve(join(this.config.dataDir, "workspaces", "chats")), chatId);
    this.prepareWorkspaceDir(dir);
    this.dbx.db.insert(workspaces).values({ id, userId, name, path: dir, createdAt: Date.now() }).run();
    return { id, dir };
  }

  // -- envs ---------------------------------------------------------------------

  /**
   * Run-scoped env resolution (ADR-015). Location-aware with
   * re-materialization: an env whose container died (executor offline / local
   * container removed / cloud container gone) is recreated OVER THE SAME
   * workspace — files survive everything except an explicit destroy.
   *  - envId (resume): probe executor envs (dead → recreate, same chat dir);
   *    cloud rows keep the no-probe fast path.
   *  - location "local": per-CHAT env over a `chat:<id>` workspace; the runner
   *    owns the desktop dir; core never sees those files.
   *  - location "cloud" + chatId: per-chat cloud env (the push target).
   */
  async ensureEnvForRun(
    userId: string,
    opts?: { location?: "local" | "cloud"; envId?: string; chatId?: string },
  ): Promise<EnvHandle> {
    if (opts?.envId !== undefined) {
      const row = this.getEnvRow(opts.envId);
      if (row === undefined || row.status === "dead") throw new UnknownEnvError(opts.envId);
      if (row.driver !== "executor") return this.liveHandle(row.id);
      if ((await this.execDriver().status(row.id)) === "ready") return this.liveHandle(row.id);
      return this.recreateLocal(row, userId);
    }
    if (opts?.location === "local") {
      const chatId = opts.chatId ?? "";
      if (!this.exec?.registry.isOnline(userId) || chatId === "") {
        throw new SandboxError(
          chatId === ""
            ? "local execution requires a chat-scoped workspace"
            : "local execution requested but no local executor is connected",
          503,
        );
      }
      const ws = this.ensureChatWorkspace(userId, chatId);
      const row = this.readyEnvIn(ws.id);
      if (row !== undefined) {
        if ((await this.execDriver().status(row.id)) === "ready") return this.liveHandle(row.id);
        return this.recreateLocal(row, userId);
      }
      return this.createEnvLocal(userId, ws, chatId);
    }
    const ws = opts?.chatId !== undefined ? this.ensureChatWorkspace(userId, opts.chatId) : this.ensureWorkspace(userId);
    const row = this.readyEnvIn(ws.id);
    if (row !== undefined) {
      // Probe: a dead cloud container re-creates over the same workspace dir
      // (workspace content lives on the core's disk, so files survive).
      if ((await this.driver.status(row.id)) === "ready") return this.liveHandle(row.id);
      this.dbx.db.update(envs).set({ status: "dead" }).where(eq(envs.id, row.id)).run();
      if (this.defaultEnvId === row.id) this.defaultEnvId = undefined;
    }
    return this.createEnv(userId, ws);
  }

  /**
   * Get-or-create the caller's primary env: one container per workspace
   * (architecture.md). `envId` targets an existing env explicitly.
   *
   * Post-restart the driver's in-memory map is empty (every status probe
   * answers "dead" for an unknown id): a ready-row env must be PROBED and
   * re-created over the same workspace dir (files live on the core's disk,
   * ADR-003) — otherwise the run parses tools against a handle whose
   * container can no longer be reached ("driver has no live container").
   */
  async ensureEnv(userId: string, envId?: string): Promise<EnvHandle> {
    if (envId !== undefined) return this.getEnvMust(envId);
    const ws = this.ensureWorkspace(userId);
    if (this.defaultEnvId !== undefined) {
      const row = this.getEnvRow(this.defaultEnvId);
      if (row !== undefined && row.workspaceId === ws.id && (await this.driver.status(row.id)) === "ready") {
        return this.liveHandle(row.id);
      }
      this.defaultEnvId = undefined;
    }
    const row = this.dbx.db
      .select()
      .from(envs)
      .where(and(eq(envs.workspaceId, ws.id), eq(envs.status, "ready")))
      .get() ?? undefined;
    if (row !== undefined) {
      if ((await this.driver.status(row.id)) === "ready") {
        this.defaultEnvId = row.id;
        return this.liveHandle(row.id);
      }
      this.dbx.db.update(envs).set({ status: "dead" }).where(eq(envs.id, row.id)).run();
      this.defaultEnvId = undefined;
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
      // OT's exec-output capture writes per-process jsonl under XDG state;
      // keep it off shared-fs binds (9p/Docker Desktop) — container tmpfs is
      // fast + always writable by the sandbox user.
      XDG_STATE_HOME: "/tmp/ot-state",
    };
    if (this.config.sandboxEgress !== "open") {
      // guardrail #3: OT's DNS-whitelist firewall passes ONLY the gateway
      // proxy (host.docker.internal); everything else is dropped at OUTPUT.
      // "allowlist" is the strict mode (fails the launch when the kernel
      // lacks ipset); "auto" attempts the firewall and falls back to open
      // egress with a loud warn when the kernel can't install it (Docker
      // Desktop) — the egress proxy still holds every esc_→real-key swap.
      // docker.spec.ts asserts both paths.
      envVars["OPEN_TERMINAL_ALLOWED_DOMAINS"] = "host.docker.internal";
    }
    const handle = await this.driver.create({
      workspaceDir: workspace.dir,
      env: envVars,
      caps: DEFAULT_CAPS,
      userId,
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

  // -- executor (local) envs (ADR-015) ------------------------------------------

  /** First ready env row in a workspace, if any (single-env invariant). */
  private readyEnvIn(workspaceId: string) {
    return (
      this.dbx.db
        .select()
        .from(envs)
        .where(and(eq(envs.workspaceId, workspaceId), eq(envs.status, "ready")))
        .get() ?? undefined
    );
  }

  /** Create a per-chat LOCAL env over the executor bridge. No egress env:
   * the local container never calls an LLM (guardrail #2), and the
   * ipset-based allowlist would refuse OT start on Docker Desktop. */
  private async createEnvLocal(
    userId: string,
    ws: { id: string; dir: string },
    chatId: string,
  ): Promise<EnvHandle> {
    if (!this.exec?.registry.isOnline(userId)) {
      throw new SandboxError("local execution requested but no local executor is connected", 503);
    }
    const envId = `env_${ulid()}`;
    const handle = await this.execDriver().create({
      envId,
      workspaceDir: "", // the runner decides the desktop dir and reports it
      env: {},
      caps: DEFAULT_CAPS,
      chatId,
      userId,
    });
    this.dbx.db
      .insert(envs)
      .values({
        id: envId,
        driver: "executor",
        workspaceId: ws.id,
        image: this.config.sandboxImage,
        status: "ready",
        caps: { ...DEFAULT_CAPS },
        containerRef: handle.containerRef ?? null,
        egressTokenHash: null,
        workspaceDir: handle.workspaceDir,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      })
      .run();
    // Local envs are chat-scoped: they never become the process-wide default.
    return handle;
  }

  /** A local env's container died: fresh env over the SAME chat dir —
   * the runner-side workspace persists, so files are not lost. */
  private async recreateLocal(row: { id: string; driver: string; workspaceId: string | null }, userId: string): Promise<EnvHandle> {
    this.dbx.db.update(envs).set({ status: "dead" }).where(eq(envs.id, row.id)).run();
    const chatName = row.workspaceId !== null
      ? this.dbx.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).get()?.name
      : undefined;
    const chatId = chatName?.startsWith("chat:") ? chatName.slice(5) : "";
    if (chatId === "") throw new SandboxError("local env has no chat-scoped workspace", 500);
    const ws = this.ensureChatWorkspace(userId, chatId);
    return this.createEnvLocal(userId, ws, chatId);
  }

  getEnvRow(envId: string) {
    return this.dbx.db.select().from(envs).where(eq(envs.id, envId)).get() ?? undefined;
  }

  /**
   * P5 multi-user audit: an env's owning user via its workspace, or undefined
   * when the env/workspace is unknown. term/files resolve through this so an
   * explicit envId can no longer reach another user's sandbox.
   */
  envOwner(envId: string): string | undefined {
    const row = this.getEnvRow(envId);
    const wsId = row?.workspaceId;
    if (wsId === undefined || wsId === null) return undefined;
    return this.dbx.db.select({ userId: workspaces.userId }).from(workspaces).where(eq(workspaces.id, wsId)).get()?.userId;
  }

  getEnvMust(envId: string): EnvHandle {
    const row = this.getEnvRow(envId);
    if (row === undefined || row.status === "dead") throw new UnknownEnvError(envId);
    return this.liveHandle(envId);
  }

  /**
   * Probe the container behind a "ready" row (async — the term/files planes'
   * explicit-env access). A ready row whose container is gone (died, or the
   * driver map is empty after a restart) is closed out and answered 404:
   * a caller that NAMED its env gets an error, not a silent re-create.
   */
  async probeEnv(envId: string): Promise<EnvHandle> {
    const row = this.getEnvRow(envId);
    if (row === undefined || row.status === "dead") throw new UnknownEnvError(envId);
    const driver = row.driver === "executor" ? this.execDriver() : this.driver;
    if ((await driver.status(envId)) !== "ready") {
      this.dbx.db.update(envs).set({ status: "dead" }).where(eq(envs.id, envId)).run();
      if (this.defaultEnvId === envId) this.defaultEnvId = undefined;
      throw new UnknownEnvError(envId);
    }
    return this.liveHandle(envId);
  }

  private liveHandle(envId: string): EnvHandle {
    const row = this.getEnvRow(envId);
    if (row === undefined) throw new UnknownEnvError(envId);
    const wsRow = row.workspaceId !== null
      ? this.dbx.db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).get()
      : undefined;
    const driver = row.driver === "executor" ? this.execDriver() : this.driver;
    // Executor envs live on the runner's desktop dir (reported at create);
    // cloud envs back the core-hosted workspace dir.
    const workspaceDir = row.driver === "executor"
      ? (row.workspaceDir ?? wsRow?.path ?? join(resolve(join(this.config.dataDir, "workspaces")), DEFAULT_WORKSPACE))
      : (wsRow?.path ?? join(resolve(join(this.config.dataDir, "workspaces")), DEFAULT_WORKSPACE));
    return {
      envId: row.id,
      driver,
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
      // Route by the row's driver (executor envs destroy via the bridge when
      // online; the runner-side dir persists for re-materialization).
      if (row.driver === "executor") {
        await this.execDriver().destroy(row.id).catch(() => {});
      } else {
        await this.destroyEnv(row.id);
      }
      this.dbx.db.update(envs).set({ status: "dead" }).where(eq(envs.id, row.id)).run();
      if (this.defaultEnvId === row.id) this.defaultEnvId = undefined;
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
    const d = new mod.DockerDriver(config, log);
    if (!(await d.daemonReachable())) throw new SandboxError("docker daemon unreachable", 503);
    return d;
  }
  // auto: driver #1 (open_terminal containers launched via dockerode), fake fallback.
  try {
    const d = new mod.OpenTerminalDriver(config, log);
    if (await d.daemonReachable()) return d;
    throw new Error("docker daemon unreachable");
  } catch {
    log?.warn({}, "Docker daemon unreachable — fake sandbox driver active (tests/dev only)");
    const { FakeDriver } = await import("./fake.js");
    return new FakeDriver();
  }
}

/**
 * Standalone OpenTerminalDriver for the RUNNER process (ADR-015): the runner
 * hosts the local sandbox and needs the exact same OT driver core uses — but
 * without an AppConfig. `daemonReachable()` decides registration details
 * (dockerAvailable); when the local daemon is down the runner registers as
 * "no docker" and local sends fast-fail core-side.
 */
export async function makeOtDriver(
  sandboxImage: string,
  /** P5 hardening: opt-in OCI runtime (FOUNDRY_SANDBOX_RUNTIME / --runtime). */
  sandboxRuntime = "runc",
  /** Where the runner's OT containers' mapped port lives (default: host loopback). */
  sandboxOtHost = "127.0.0.1",
  /** Local envs run egress-open (ADR-015); the value only gates the launcher's fallback. */
  sandboxEgress: "allowlist" | "open" | "auto" = "open",
): Promise<OpenTerminalDriver> {
  return new OpenTerminalDriver({ sandboxImage, sandboxRuntime, sandboxOtHost, sandboxEgress });
}