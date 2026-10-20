import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq, inArray } from "drizzle-orm";
import type { EmitFn, ChatService } from "../gateway/chat.js";
import type { NotifyService } from "../gateway/notify.js";
import type { BlobStore } from "../storage/blobs.js";
import type { SandboxService } from "../sandbox/service.js";
import type { AgentRunner } from "../agent/runtime.js";
import type { AppConfig } from "../config.js";
import type { FoundryDb } from "../db/open.js";
import { conversations, runEvents, runs } from "../db/schema.js";
import type { ExecutorRegistry } from "./registry.js";
import type { AuditService } from "../audit/audit.js";

/**
 * PushService (ADR-015 "push to cloud"): migrates a chat that executed LOCAL
 * (desktop executor sandbox) into the backend's (cloud) sandbox.
 *
 *   re-materialize the local env
 *   → pull its workspace tar over the bridge (dependency dirs excluded — they
 *     are RECONSTRUCTED by the reconcile run, not copied)
 *   → blob + audit snapshots row
 *   → per-chat cloud workspace + cloud env (fresh egress token, normal caps)
 *   → restore into the cloud workspace dir (wiped first; symlinks dropped)
 *   → an agent run in the same conversation (trigger "manual", operator-
 *     initiated) whose synthetic user message carries the chat's shell
 *     history — the LLM inspects the workspace, reinstalls what is missing,
 *     verifies, and calls done
 *   → on done: binding flips to cloud + sys.resync + notify
 *   → on failure/cancel: binding stays local, push state cleared, notify
 */

/** Guardrail on the in-core memory buffer for the in-flight tar. */
const PUSH_TAR_CAP = 512 * 1024 * 1024;
const SHELL_HISTORY_MAX = 25;

export interface PushOutcome {
  pushRunId: string;
  cloudEnvId: string;
}

export class PushService {
  constructor(
    private readonly deps: {
      config: AppConfig;
      dbx: FoundryDb;
      chat: ChatService;
      sandbox: SandboxService;
      blobs: BlobStore;
      registry: ExecutorRegistry;
      agents: AgentRunner;
      notify?: NotifyService;
      /** P5 audit (optional). */
      audit?: AuditService;
      emit: EmitFn;
      log?: (obj: object, msg: string) => void;
    },
  ) {}

  /** Validate → migrate the workspace → reconcile deps via an agent run. */
  async pushChatToCloud(userId: string, chatId: string): Promise<PushOutcome> {
    // Multi-user-ready (P5): the caller must own the chat — 404 either way so
    // a wrong id and a foreign id are indistinguishable.
    const owned = this.deps.dbx.db.select({ userId: conversations.userId }).from(conversations).where(eq(conversations.id, chatId)).get();
    if (owned === undefined) throw new PushRejected("unknown chat", 404);
    if (owned.userId !== userId) throw new PushRejected("unknown chat", 404);
    const binding = this.deps.chat.getConversationBinding(chatId);
    if (binding === undefined || binding.location !== "local") {
      throw new PushRejected("chat is not bound to a local workspace", 400);
    }
    if (this.deps.chat.hasActiveRun(chatId)) {
      throw new PushRejected("a run is active on this chat", 409);
    }
    if (!this.deps.registry.isOnline(userId)) {
      throw new PushRejected("no local executor is connected", 503);
    }
    this.setPushState(chatId, { state: "running" });

    try {
      // 1. The local env may need re-materialization (its container died).
      const localEnv = await this.deps.sandbox.ensureEnvForRun(userId, {
        location: "local",
        chatId,
        ...(binding.envId !== undefined ? { envId: binding.envId } : {}),
      });

      // 2. Pull the workspace tar over the bridge, chunked.
      // tmpdir() = always writable; removed in the finally below.
      const tmpTar = join(tmpdir(), `foundry-push-${Date.now()}-${randomBytes(4).toString("hex")}.tar.gz`);
      try {
        const started = (await this.deps.registry.call(userId, "exec.tar.start", { envId: localEnv.envId }, 150_000)) as {
          tarId: string;
          size: number;
          chunkSize: number;
        };
        if (started.size > PUSH_TAR_CAP) {
          throw new PushRejected("workspace too large to push (512 MB cap)", 503);
        }
        let buf = Buffer.alloc(0);
        const chunkCount = Math.ceil(started.size / started.chunkSize);
        for (let i = 0; i < chunkCount; i++) {
          const c = (await this.deps.registry.call(userId, "exec.tar.chunk", { tarId: started.tarId, index: i }, 30_000)) as {
            index: number;
            b64: string;
          };
          buf = Buffer.concat([buf, Buffer.from(c.b64, "base64")]);
        }
        await this.deps.registry.call(userId, "exec.tar.free", { tarId: started.tarId }, 30_000).catch(() => undefined);
        if (buf.length !== started.size) {
          throw new PushRejected(`tar stream incomplete (${buf.length}/${started.size})`, 503);
        }
        await writeFile(tmpTar, buf);
        buf = Buffer.alloc(0); // release the big buffer

        // 3. Blob + audit snapshots row (refcount + prune protect the blob).
        const blobId = await this.deps.blobs.putFile(tmpTar, "application/gzip");
        const chatWs = this.deps.sandbox.ensureChatWorkspace(userId, chatId);
        await this.deps.blobs.snapshot(chatWs.id, localEnv.envId, blobId, "push-to-cloud source");

        // 4. Cloud env for the chat (per-chat workspace; normal egress
        // mint + caps). A retry reuses the previous cloud env.
        const cloudEnv = await this.deps.sandbox.ensureEnvForRun(userId, { location: "cloud", chatId });

        // 5. Restore into the cloud workspace dir (wiped first, links dropped).
        const restored = await this.restore(cloudEnv.workspaceDir, blobId);
        this.deps.log?.(
          { mod: "push", chatId, blobId, files: restored.files },
          "workspace restored into the cloud env",
        );

        // 6. Dependency-reconciliation run (trigger "manual": operator action).
        const convRow = this.deps.dbx.db.select().from(conversations).where(eq(conversations.id, chatId)).get();
        const model = convRow?.model ?? "dummy/scripted";
        const pushRunId = this.deps.chat.createRun({
          userId,
          conversationId: chatId,
          model,
          trigger: "manual",
          agent: true,
        });
        this.deps.dbx.db.update(runs).set({ envId: cloudEnv.envId }).where(eq(runs.id, pushRunId)).run();

        const commands = this.shellHistory(chatId);
        const lines = [
          "The workspace for this chat was just MOVED from the user's local machine into this cloud sandbox.",
          `Files were restored already (${restored.files} entries); installed package state was NOT copied.`,
          commands.length > 0 ? "Shell commands previously run locally:\n" + commands.map((c) => "- `" + c + "`").join("\n") : "No shell commands were recorded locally.",
          "",
          "Inspect the workspace, re-run/install whatever is needed to make it usable here (pip/npm/etc.),",
          "verify with quick checks, then call done with a short summary of what you installed and any failures.",
        ];
        this.deps.chat.appendMessage(chatId, { role: "user", content: lines.join("\n") }, pushRunId);

        const outcome = await this.deps.agents.startRun({
          runId: pushRunId,
          userId,
          wireModel: model,
          conversationId: chatId,
          emit: this.deps.emit,
          signal: new AbortController().signal,
          location: "cloud",
          envId: cloudEnv.envId,
        });

        if (outcome.status === "done") {
          this.deps.chat.setConversationBinding(chatId, { location: "cloud", envId: cloudEnv.envId });
          this.setPushState(chatId, { state: "done", cloudEnvId: cloudEnv.envId });
          this.deps.emit("sys.resync", `chat:${chatId}`, { reason: "push_complete" });
          this.deps.notify?.runDone(pushRunId, "workspace pushed to cloud");
          this.deps.audit?.record({ userId, action: "chat.push", target: chatId, meta: { pushRunId, cloudEnvId: cloudEnv.envId } });
        } else {
          // Keep the chat local; the tar blob stays for a retry.
          const failureReason = outcome.status === "failed" ? outcome.error : outcome.status;
          this.setPushState(chatId, { state: "failed", error: failureReason });
          this.deps.emit("sys.resync", `chat:${chatId}`, { reason: "push_failed" });
          this.deps.notify?.runFailed(pushRunId, String(failureReason ?? "push reconciliation failed"));
        }
        return { pushRunId, cloudEnvId: cloudEnv.envId };
      } finally {
        await rm(tmpTar, { force: true }).catch(() => undefined);
      }
    } catch (err) {
      this.setPushState(chatId, { state: "failed", error: err instanceof Error ? err.message : String(err) });
      this.deps.audit?.record({
        userId,
        action: "chat.push",
        target: chatId,
        outcome: "error",
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  /** The chat's LOCAL-phase shell commands (deduped, oldest→newest, capped). */
  private shellHistory(chatId: string): string[] {
    const runRows = this.deps.dbx.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.conversationId, chatId))
      .all();
    if (runRows.length === 0) return [];
    const events = this.deps.dbx.db
      .select({ type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(
        and(
          inArray(
            runEvents.runId,
            runRows.map((r) => r.id),
          ),
          eq(runEvents.type, "tool_call"),
        ),
      )
      .all();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of events) {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (payload["name"] !== "shell") continue;
      // run_events journal is FLAT: { id, name, args } (the wire event wraps
      // it in { call } — the journal does not).
      const args = (payload["args"] ?? {}) as Record<string, unknown>;
      const cmdLine = typeof args["command"] === "string" ? args["command"] : "";
      if (cmdLine === "" || seen.has(cmdLine)) continue;
      seen.add(cmdLine);
      out.push(cmdLine);
    }
    return out.slice(-SHELL_HISTORY_MAX);
  }

  /** meta.push bookkeeping (separate from the location binding). */
  private setPushState(chatId: string, state: Record<string, unknown>): void {
    const row = this.deps.dbx.db.select().from(conversations).where(eq(conversations.id, chatId)).get();
    if (row === undefined) return;
    const meta = { ...(row.meta ?? {}) };
    meta["push"] = state;
    this.deps.dbx.db
      .update(conversations)
      .set({ meta })
      .where(eq(conversations.id, chatId))
      .run();
  }

  private async restore(workspaceDir: string, blobId: string): Promise<{ files: number }> {
    const mod = await import("../sandbox/restore.js");
    return mod.restoreWorkspaceTar({ blobPath: this.deps.blobs.path(blobId), workspaceDir });
  }
}

/** HTTP-ish rejection the REST route maps onto a status code. */
export class PushRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PushRejected";
  }
}